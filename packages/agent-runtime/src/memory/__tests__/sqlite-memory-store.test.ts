/**
 * SqliteMemoryStore impl-specific tests — behavior NOT part of the portable
 * conformance contract (see `../conformance.ts`): the migration ladder,
 * file persistence, FTS edge cases beyond the kit, json_each scope safety,
 * the payload-serializability guard, `resolveMemoryDbPath`, and
 * `loadMemoryStore`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "../../storage/event-store.js";
import { loadMemoryStore } from "../../storage/load.js";
import {
  MEMORY_TARGET_SCHEMA_VERSION,
  SqliteMemoryStore,
  resetMemoryDegradedReadWarningsForTests,
  resolveMemoryDbPath,
} from "../sqlite-store.js";
import { InMemoryMemoryStore, type MemoryWriteInput } from "../store.js";

const fact = (content: string, overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput => ({
  scope: { tenant: "acme" },
  kind: "fact",
  content,
  ...overrides,
});

/** The v1 DDL by hand — literal SQL, deliberately NOT imported from the store
 * (conversation-store.test.ts precedent): proves a hand-built v1 file reopens. */
const HAND_BUILT_V1 = `
CREATE TABLE memory_records (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  scope         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT,
  provenance    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  invalid_at    TEXT,
  superseded_by TEXT,
  expires_at    TEXT,
  target        TEXT,
  payload       TEXT,
  supports      TEXT
);
CREATE INDEX idx_memory_records_created ON memory_records(created_at);
CREATE INDEX idx_memory_records_kind    ON memory_records(kind);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  content, tags,
  content='memory_records', content_rowid='seq'
);

CREATE TRIGGER memory_records_ai AFTER INSERT ON memory_records BEGIN
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.seq, new.content, new.tags);
END;
CREATE TRIGGER memory_records_ad AFTER DELETE ON memory_records BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.seq, old.content, old.tags);
END;
CREATE TRIGGER memory_records_au AFTER UPDATE ON memory_records BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.seq, old.content, old.tags);
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.seq, new.content, new.tags);
END;
`;

function userVersion(dbPath: string): number {
  const raw = new Database(dbPath);
  try {
    return raw.pragma("user_version", { simple: true }) as number;
  } finally {
    raw.close();
  }
}

describe("SqliteMemoryStore (impl-specific)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ap-memory-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("migration ladder", () => {
    it("reopens a hand-built v1 file with data surviving", async () => {
      const dbPath = path.join(dir, "memory.db");
      const raw = new Database(dbPath);
      raw.exec(HAND_BUILT_V1);
      // Insert AFTER trigger creation so FTS indexes the row.
      raw
        .prepare(
          `INSERT INTO memory_records (id, scope, kind, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "hand-built-1",
          '{"tenant":"acme"}',
          "fact",
          "the hand-built truth",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        );
      raw.pragma("user_version = 1");
      raw.close();

      const store = new SqliteMemoryStore({ path: dbPath, Database });
      const record = await store.get("hand-built-1");
      expect(record).not.toBeNull();
      expect(record!.content).toBe("the hand-built truth");
      const hits = await store.search({ scope: {}, query: "hand-built" });
      expect(hits.map((h) => h.record.id)).toEqual(["hand-built-1"]);
      store.close();
      expect(userVersion(dbPath)).toBe(1);
    });

    it("fresh-file boot lands at user_version 1; data survives close + reopen", async () => {
      const dbPath = path.join(dir, "memory.db");
      const store = new SqliteMemoryStore({ path: dbPath, Database });
      const [written] = await store.write([fact("durable truth", { tags: ["keep"] })]);
      store.close();
      expect(userVersion(dbPath)).toBe(MEMORY_TARGET_SCHEMA_VERSION);

      const reopened = new SqliteMemoryStore({ path: dbPath, Database });
      expect(await reopened.get(written!.id)).toEqual(written);
      const hits = await reopened.search({ scope: {}, query: "durable" });
      expect(hits.map((h) => h.record.id)).toEqual([written!.id]);
      reopened.close();
    });

    it("a future schema version throws a mismatch", () => {
      const dbPath = path.join(dir, "memory.db");
      const raw = new Database(dbPath);
      raw.pragma("user_version = 99");
      raw.close();
      expect(() => new SqliteMemoryStore({ path: dbPath, Database })).toThrow(
        /memory-store schema version mismatch/,
      );
    });

    it("memory has its own file + ladder, independent of the EventStore's", async () => {
      const memoryPath = path.join(dir, "memory.db");
      const eventsPath = path.join(dir, "events.db");
      const memory = new SqliteMemoryStore({ path: memoryPath, Database });
      const events = new EventStore({ path: eventsPath, Database });
      memory.close();
      events.close();
      expect(userVersion(memoryPath)).toBe(1);
      expect(userVersion(eventsPath)).toBe(5);

      // A store pointed at a hand-built v1 MEMORY file never creates the
      // event ladder's tables.
      const raw = new Database(memoryPath);
      const tables = (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((t) => t.name);
      raw.close();
      expect(tables).not.toContain("events");
      expect(tables).not.toContain("runs");
      expect(tables).toContain("memory_records");
    });
  });

  describe("FTS edges beyond the kit", () => {
    let store: SqliteMemoryStore;
    beforeEach(() => {
      store = new SqliteMemoryStore({ path: ":memory:", Database });
    });
    afterEach(() => {
      store.close();
    });

    it("operator/punctuation queries never throw and behave as tokens", async () => {
      const [a] = await store.write([fact("alpha content")]);
      const hits = await store.search({ scope: {}, query: 'alpha AND -x "unbalanced' });
      expect(hits.map((h) => h.record.id)).toContain(a!.id);
    });

    /**
     * The SQLite half of #462. Fixing only the in-memory side would have
     * CREATED a divergence: this store used to split the query on WHITESPACE
     * and quote each whitespace-token, so `"dark-mode"` reached FTS5 as an
     * adjacency PHRASE requiring `dark` immediately followed by `mode`, while a
     * punctuation-splitting in-memory store would have OR'd the two. Both now
     * call the same `tokenize()` and both OR the sub-tokens.
     */
    it("a punctuated query token is OR'd, never an adjacency phrase", async () => {
      const [adjacent] = await store.write([fact("Prefers dark-mode in the editor.")]);
      const [apart] = await store.write([fact("mode switch, then dark theme")]);

      const hits = await store.search({ scope: {}, query: "dark-mode" });
      // A phrase query returns only `adjacent`. An OR over sub-tokens returns
      // both — `apart` carries both tokens, just not adjacently.
      expect(hits.map((h) => h.record.id).sort()).toEqual([adjacent!.id, apart!.id].sort());
    });

    it("multi-token queries OR rather than AND (the Postgres-portability axis)", async () => {
      const [a] = await store.write([fact("Drinks espresso, no milk.")]);
      const [b] = await store.write([fact("Ships the monorepo from Denver.")]);
      // No record carries both tokens; an AND backend returns zero here.
      const hits = await store.search({ scope: {}, query: "espresso Denver" });
      expect(hits.map((h) => h.record.id).sort()).toEqual([a!.id, b!.id].sort());
    });

    it("whitespace-only query returns [] (in-memory parity)", async () => {
      await store.write([fact("present")]);
      expect(await store.search({ scope: {}, query: " " })).toEqual([]);
    });

    it("tag tokens are searchable", async () => {
      const [tagged] = await store.write([fact("content without the word", { tags: ["prefs"] })]);
      const hits = await store.search({ scope: {}, query: "prefs" });
      expect(hits.map((h) => h.record.id)).toEqual([tagged!.id]);
    });

    it("delete scrubs the FTS index", async () => {
      const [written] = await store.write([fact("ephemeral zanzibar")]);
      await store.delete(written!.id);
      expect(await store.search({ scope: {}, query: "zanzibar" })).toEqual([]);
    });

    it("supersede leaves FTS consistent — old record findable with includeInvalidated", async () => {
      const [oldRec] = await store.write([fact("original zanzibar claim")]);
      await store.write([fact("corrected claim", { supersedes: oldRec!.id })]);
      expect(await store.search({ scope: {}, query: "zanzibar" })).toEqual([]);
      const hits = await store.search({ scope: {}, query: "zanzibar", includeInvalidated: true });
      expect(hits.map((h) => h.record.id)).toEqual([oldRec!.id]);
    });
  });

  describe("scope safety (json_each strategy)", () => {
    it("keys/values with SQL-LIKE metacharacters and unicode round-trip and subset-match", async () => {
      const store = new SqliteMemoryStore({ path: ":memory:", Database });
      const scope = {
        'we"ird.key': 'va"lue.%_',
        "pct%": "under_score",
        "ünïcode.键": "日本語%値",
      };
      const [written] = await store.write([fact("scoped", { scope })]);
      expect(written!.scope).toEqual(scope);

      // Full subset-match on the hostile scope.
      const full = await store.search({ scope });
      expect(full.map((h) => h.record.id)).toEqual([written!.id]);
      // Single hostile key still matches (subset semantics).
      const partial = await store.search({ scope: { 'we"ird.key': 'va"lue.%_' } });
      expect(partial.map((h) => h.record.id)).toEqual([written!.id]);
      // A near-miss value (LIKE would wildcard-match `%`/`_`) matches nothing.
      expect(await store.search({ scope: { "pct%": "underXscore" } })).toEqual([]);
      store.close();
    });
  });

  /**
   * The OBSERVABILITY half of ADR-0009 Decision 14. The tolerance itself is
   * contractual and lives in the conformance kit (Tier 1, via the
   * `setStoredTarget` hook); what channel a backend uses to make the
   * degradation visible is a backend choice, so it is pinned here.
   *
   * This store follows the codebase's settled soft-degradation idiom — the
   * once-per-key `console.warn` from `runner/schema-guard.ts` and
   * `providers/capabilities.ts`, complete with the test-only reset those need
   * for the same reason: the `Set` is module-level, so without a reset the
   * first test in the file to degrade a row claims the warning and every later
   * one silently gets none.
   */
  describe("degraded-read observability (ADR-0009 D14)", () => {
    /** Write one targeted record, then overwrite its stored `target` column. */
    async function withStoredTarget(rawTargetColumn: string): Promise<{
      store: SqliteMemoryStore;
      id: string;
      raw: InstanceType<typeof Database>;
    }> {
      const dbPath = path.join(dir, "memory.db");
      const store = new SqliteMemoryStore({ path: dbPath, Database });
      const [record] = await store.write([
        fact("targeted", {
          target: { primitive: "background", section: "conventions", key: "theme" },
        }),
      ]);
      const raw = new Database(dbPath);
      raw
        .prepare("UPDATE memory_records SET target = ? WHERE id = ?")
        .run(rawTargetColumn, record!.id);
      return { store, id: record!.id, raw };
    }

    beforeEach(() => {
      resetMemoryDegradedReadWarningsForTests();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("warns once per reason class, naming the record and the ADR", async () => {
      const { store, id, raw } = await withStoredTarget("42");
      const warn = vi.mocked(console.warn);

      await store.get(id);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("[agentic-patterns]");
      expect(message).toContain(id);
      expect(message).toContain("ADR-0009 D14");

      // Same reason class on every subsequent read — log once, not per row.
      await store.get(id);
      await store.search({ scope: {} });
      expect(warn).toHaveBeenCalledTimes(1);

      raw.close();
      store.close();
    });

    it("does NOT warn for an unrecognised-but-readable target — that is forward compatibility, not corruption", async () => {
      const { store, id, raw } = await withStoredTarget(
        JSON.stringify({ primitive: "background", section: "userProfile", key: "name" }),
      );
      const read = await store.get(id);
      expect(read!.target).toEqual({
        primitive: "background",
        section: "userProfile",
        key: "name",
      });
      expect(console.warn).not.toHaveBeenCalled();
      raw.close();
      store.close();
    });

    it("tolerates a target column that is not even valid JSON", async () => {
      // A hand-edited column is the reproduction ADR-0009 D14 names, and
      // `JSON.parse` sits one line ABOVE the schema — so tolerance that started
      // at the schema would still have detonated here.
      const { store, id, raw } = await withStoredTarget("{not json");
      const read = await store.get(id);
      expect(read!.target).toBeUndefined();
      expect(read!.content).toBe("targeted");
      expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain("not valid JSON");
      raw.close();
      store.close();
    });

    it("one unreadable row does not take the partition's recall with it", async () => {
      // The actual defect: `_rowToRecord` runs inside `rows.map`, so a throw
      // does not skip a record — it empties the whole result set, and the
      // query-less listing is recall's always-injected profile tier.
      const dbPath = path.join(dir, "memory.db");
      const store = new SqliteMemoryStore({ path: dbPath, Database });
      const written = await store.write([
        fact("Doug ships from Denver", { kind: "profile" }),
        fact("Doug drinks espresso", {
          kind: "profile",
          target: { primitive: "background", section: "conventions", key: "theme" },
        }),
        fact("Doug runs deploys on Fridays", { kind: "profile" }),
      ]);
      const raw = new Database(dbPath);
      raw.prepare("UPDATE memory_records SET target = ? WHERE id = ?").run("42", written[1]!.id);

      const listed = await store.search({ scope: {}, kinds: ["profile"] });
      expect(listed.map((h) => h.record.id).sort()).toEqual(written.map((r) => r.id).sort());
      const queried = await store.search({ scope: {}, query: "espresso" });
      expect(queried.map((h) => h.record.id)).toEqual([written[1]!.id]);
      expect(queried[0]!.record.target).toBeUndefined();

      raw.close();
      store.close();
    });
  });

  describe("payload guard", () => {
    it("rejects a cyclic payload before any mutation", async () => {
      const store = new SqliteMemoryStore({ path: ":memory:", Database });
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      await expect(store.write([fact("boom", { payload: cyclic })])).rejects.toThrow(
        /JSON-serializable/,
      );
      expect(await store.search({ scope: {}, includeInvalidated: true })).toEqual([]);
      store.close();
    });
  });

  describe("resolveMemoryDbPath", () => {
    // Save/restore + computed-key deletes (create-runner.test.ts precedent).
    const ENV_KEYS = ["AP_MEMORY_DB_PATH", "XDG_STATE_HOME"];
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("env override wins", () => {
      process.env.AP_MEMORY_DB_PATH = "/tmp/custom-memory.db";
      expect(resolveMemoryDbPath()).toBe("/tmp/custom-memory.db");
    });

    it("default ends with /ap/memory.db and is never events.db", () => {
      const resolved = resolveMemoryDbPath();
      expect(resolved.endsWith(path.join("ap", "memory.db"))).toBe(true);
      expect(resolved).not.toContain("events.db");
    });

    it("respects XDG_STATE_HOME", () => {
      process.env.XDG_STATE_HOME = "/tmp/xdg-state";
      expect(resolveMemoryDbPath()).toBe(path.join("/tmp/xdg-state", "ap", "memory.db"));
    });

    it("treats an empty XDG_STATE_HOME as unset", () => {
      process.env.XDG_STATE_HOME = "";
      expect(path.isAbsolute(resolveMemoryDbPath())).toBe(true);
    });
  });

  describe("loadMemoryStore", () => {
    it("happy path returns a live SqliteMemoryStore (better-sqlite3 is a devDependency here)", async () => {
      const dbPath = path.join(dir, "memory.db");
      const { store, unavailable, reason } = await loadMemoryStore({ path: dbPath });
      expect(unavailable).toBe(false);
      expect(store).toBeInstanceOf(SqliteMemoryStore);
      expect(reason).toContain("better-sqlite3");
      expect(reason).toContain(dbPath);

      const [written] = await store.write([fact("loaded truth")]);
      const hits = await store.search({ scope: {}, query: "loaded" });
      expect(hits.map((h) => h.record.id)).toEqual([written!.id]);
      (store as SqliteMemoryStore).close();
    });

    it("constructor failure soft-degrades to a usable InMemoryMemoryStore with a reason", async () => {
      // A directory is not a valid SQLite file path — construction throws.
      const { store, unavailable, reason } = await loadMemoryStore({ path: dir });
      expect(unavailable).toBe(true);
      expect(store).toBeInstanceOf(InMemoryMemoryStore);
      expect(reason.length).toBeGreaterThan(0);
      // Fallback is live, not a stub.
      await store.write([fact("still works")]);
      expect(await store.search({ scope: {} })).toHaveLength(1);
    });
  });
});
