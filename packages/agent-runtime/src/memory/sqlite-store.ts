/**
 * SqliteMemoryStore — the durable SQLite reference backend for memory.
 *
 * Implements [ADR-0007](../../../../docs/adr/0007-memory-store.md) Decisions
 * 1 and 5: memory is a **system of record, not telemetry**, so it lives in its
 * OWN SQLite file with its OWN `PRAGMA user_version` ladder starting at 1 —
 * never the EventStore ladder file (`events.db`), never
 * `TARGET_SCHEMA_VERSION`, never retention-pruned. Search is FTS5
 * external-content over `content` + `tags` with bm25 relevance ordering for
 * query searches and recency ordering for query-less listings.
 *
 * Driver contract (conversation-store precedent): `.exec` / `.prepare` only —
 * no `.pragma()`, no `.transaction()` — explicit `BEGIN`/`COMMIT`, and bare-`@`
 * named params so `load.ts`'s bun:sqlite adapter (`wrapBunDatabase`) works
 * unchanged. Consumers should not import this module unless a SQLite driver is
 * installed — see `loadMemoryStore()` in `../storage/load.js` for the
 * optional-dep entry that soft-degrades to `InMemoryMemoryStore`.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type MemoryHit,
  type MemoryRecord,
  type MemorySearchQueryInput,
  MemorySearchQuerySchema,
  type MemoryStoreCapabilities,
  memoryRecord,
} from "@agentic-patterns/core";
import type DatabaseConstructor from "better-sqlite3";
import type { Database, Statement } from "better-sqlite3";
import { type MemoryStore, type MemoryWriteInput, MemoryWriteInputSchema } from "./store.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * `AP_MEMORY_DB_PATH` env override, else `XDG_STATE_HOME|~/.local/state` +
 * `/ap/memory.db`. Deliberately NOT `events.db` — memory is a system of
 * record, not telemetry (ADR-0007 D1).
 */
export function resolveMemoryDbPath(): string {
  if (process.env.AP_MEMORY_DB_PATH) return process.env.AP_MEMORY_DB_PATH;
  const base = process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
  return path.join(base, "ap", "memory.db");
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SqliteMemoryStoreOptions {
  /**
   * Path to the memory SQLite file. Defaults to {@link resolveMemoryDbPath}.
   * `:memory:` is supported for tests. Parent directories are created
   * (best-effort) automatically. MUST NOT be the EventStore ladder file.
   */
  readonly path?: string;
  /** Injected SQLite Database constructor — better-sqlite3, or load.ts's wrapped bun:sqlite. */
  readonly Database: typeof DatabaseConstructor;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** The memory ladder's own target version — independent of storage/event-store.ts. */
export const MEMORY_TARGET_SCHEMA_VERSION = 1;

/**
 * v1 — the memory record table + FTS5 external-content index + sync triggers.
 * External-content FTS5 + triggers is the standard sync pattern: every write
 * path (insert / supersede-update / delete) stays indexed with zero imperative
 * bookkeeping. The update trigger is belt-and-braces — v1 updates never touch
 * `content`/`tags`, only invalidation columns. `tags` is indexed as its JSON
 * text; the default unicode61 tokenizer treats `[`,`"`,`,` as separators, so
 * `["ui","prefs"]` tokenizes to `ui`, `prefs` — the same tokens as the
 * in-memory store's haystack join.
 */
const MEMORY_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS memory_records (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,  -- FTS content_rowid + tie-break; never leaves the store
  id            TEXT NOT NULL UNIQUE,               -- public UUID (conversation_messages precedent)
  scope         TEXT NOT NULL,                      -- canonical sorted-key JSON object (ADR-0007 D3)
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT,                               -- JSON array | NULL = absent
  provenance    TEXT,                               -- JSON | NULL
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  invalid_at    TEXT,
  superseded_by TEXT,
  expires_at    TEXT,
  target        TEXT,                               -- JSON | NULL (stored untouched, ADR-0007 D7)
  payload       TEXT,                               -- JSON | NULL
  supports      TEXT                                -- JSON | NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_records_created ON memory_records(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_records_kind    ON memory_records(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content, tags,
  content='memory_records', content_rowid='seq'
);

CREATE TRIGGER IF NOT EXISTS memory_records_ai AFTER INSERT ON memory_records BEGIN
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.seq, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memory_records_ad AFTER DELETE ON memory_records BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.seq, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memory_records_au AFTER UPDATE ON memory_records BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.seq, old.content, old.tags);
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.seq, new.content, new.tags);
END;
`;

/**
 * Shared filter fragment — fully parameterized, no string interpolation of
 * user data anywhere. Scope subset-match (ADR-0007 D3) runs through
 * `json_each` — injection-proof for scope keys containing `.`/`"`/unicode,
 * no LIKE escaping needed. `@scope = {}` matches all records.
 */
const FILTER_SQL = `
  AND NOT EXISTS (
    SELECT 1 FROM json_each(@scope) fk
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(m.scope) sk WHERE sk.key = fk.key AND sk.value = fk.value
    )
  )
  AND (@kinds IS NULL OR m.kind IN (SELECT value FROM json_each(@kinds)))
  AND (@tags IS NULL OR NOT EXISTS (
    SELECT 1 FROM json_each(@tags) tk
    WHERE NOT EXISTS (SELECT 1 FROM json_each(COALESCE(m.tags, '[]')) mt WHERE mt.value = tk.value)
  ))
  AND (@includeInvalidated = 1 OR m.invalid_at IS NULL)
  AND (m.expires_at IS NULL OR m.expires_at > @now)
`;

// ---------------------------------------------------------------------------
// ID generation (local copy of the memory/store.ts pattern)
// ---------------------------------------------------------------------------

let _counter = 0;
function generateId(): string {
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Raw row shape as it comes back from SQLite (event-store precedent). */
interface RawRow {
  seq: number;
  id: string;
  scope: string;
  kind: string;
  content: string;
  tags: string | null;
  provenance: string | null;
  created_at: string;
  updated_at: string;
  invalid_at: string | null;
  superseded_by: string | null;
  expires_at: string | null;
  target: string | null;
  payload: string | null;
  supports: string | null;
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly _db: Database;
  private readonly _insertStmt: Statement;
  private readonly _getStmt: Statement;
  private readonly _supersedeStmt: Statement;
  private readonly _invalidateStmt: Statement;
  private readonly _deleteStmt: Statement;
  private readonly _listStmt: Statement;
  private readonly _ftsStmt: Statement;

  constructor(opts: SqliteMemoryStoreOptions) {
    const dbPath = opts.path ?? resolveMemoryDbPath();
    if (dbPath !== ":memory:") {
      try {
        mkdirSync(path.dirname(dbPath), { recursive: true });
      } catch {
        // Best effort — the driver surfaces the real error if open fails.
      }
    }
    this._db = new opts.Database(dbPath);
    // Driver-agnostic PRAGMAs: `.exec("PRAGMA …")` is supported by every SQLite
    // binding (better-sqlite3 AND bun:sqlite), whereas `.pragma()` is a
    // better-sqlite3-only method. Using `.exec` makes the injected-`Database`
    // seam honestly driver-agnostic — a Bun consumer can inject `bun:sqlite`'s
    // Database with no native dep.
    this._db.exec("PRAGMA journal_mode = WAL");
    this._db.exec("PRAGMA synchronous = NORMAL");
    this._db.exec("PRAGMA foreign_keys = ON");

    this._migrate();

    this._insertStmt = this._db.prepare(`
      INSERT INTO memory_records (
        id, scope, kind, content, tags, provenance,
        created_at, updated_at, target, payload, supports
      ) VALUES (
        @id, @scope, @kind, @content, @tags, @provenance,
        @now, @now, @target, @payload, @supports
      )
    `);

    this._getStmt = this._db.prepare("SELECT * FROM memory_records WHERE id = @id");

    this._supersedeStmt = this._db.prepare(`
      UPDATE memory_records
      SET invalid_at = COALESCE(invalid_at, @now), superseded_by = @newId, updated_at = @now
      WHERE id = @oldId
    `);

    this._invalidateStmt = this._db.prepare(`
      UPDATE memory_records SET invalid_at = @now, updated_at = @now WHERE id = @id
    `);

    this._deleteStmt = this._db.prepare("DELETE FROM memory_records WHERE id = @id");

    this._listStmt = this._db.prepare(`
      SELECT m.* FROM memory_records m WHERE 1 = 1 ${FILTER_SQL}
      ORDER BY m.created_at DESC, m.seq DESC
      LIMIT @limit
    `);

    // bm25 is smaller-is-better; ASC puts the best hit first, and a record
    // matching more of the OR'd terms always outranks a subset match (per-term
    // scores sum). Ordering-tie note (unpinned by the conformance kit): ties in
    // `created_at` resolve by `seq DESC` here vs. insertion order in the
    // in-memory store — the kit tick()s around every ordering assertion, so
    // this divergence is outside the contract.
    this._ftsStmt = this._db.prepare(`
      SELECT m.*, bm25(memory_fts) AS bm25_rank
      FROM memory_fts JOIN memory_records m ON m.seq = memory_fts.rowid
      WHERE memory_fts MATCH @match ${FILTER_SQL}
      ORDER BY bm25_rank ASC, m.created_at DESC, m.seq DESC
      LIMIT @limit
    `);
  }

  /** {@inheritDoc MemoryStore.write} — all-or-nothing batch, one `now` per batch. */
  async write(inputs: MemoryWriteInput[]): Promise<MemoryRecord[]> {
    const now = new Date().toISOString();

    // Phase 1 — validate + serialize everything, NO db writes (mirrors
    // InMemoryMemoryStore.write phase 1): any failure throws here, before any
    // mutation.
    const staged: Array<{
      record: MemoryRecord;
      supersedes?: string;
      binds: Record<string, unknown>;
    }> = [];
    for (const input of inputs) {
      const parsed = MemoryWriteInputSchema.parse(input);
      const record = memoryRecord({
        id: generateId(),
        scope: parsed.scope,
        kind: parsed.kind,
        content: parsed.content,
        ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
        ...(parsed.provenance !== undefined ? { provenance: parsed.provenance } : {}),
        ...(parsed.target !== undefined ? { target: parsed.target } : {}),
        ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}),
        createdAt: now,
        updatedAt: now,
      });
      let payloadJson: string | null = null;
      if (record.payload !== undefined) {
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(record.payload);
        } catch {
          serialized = undefined;
        }
        if (serialized === undefined) {
          throw new Error("memory payload must be JSON-serializable for the SQLite backend");
        }
        payloadJson = serialized;
      }
      const binds: Record<string, unknown> = {
        id: record.id,
        scope: JSON.stringify(record.scope), // already canonical sorted-key
        kind: record.kind,
        content: record.content,
        tags: record.tags !== undefined ? JSON.stringify(record.tags) : null,
        provenance: record.provenance !== undefined ? JSON.stringify(record.provenance) : null,
        now,
        target: record.target !== undefined ? JSON.stringify(record.target) : null,
        payload: payloadJson,
        supports: record.supports !== undefined ? JSON.stringify(record.supports) : null,
      };
      staged.push(
        parsed.supersedes !== undefined
          ? { record, supersedes: parsed.supersedes, binds }
          : { record, binds },
      );
    }

    // Phase 2 — transaction. Explicit BEGIN/COMMIT via `.exec` only (the
    // driver contract is prepare/exec/close — `.transaction()` is
    // better-sqlite3-only and would throw under the bun adapter).
    this._db.exec("BEGIN");
    try {
      // (a) resolve ALL supersedes ids against PRE-BATCH state first: a record
      // cannot supersede a sibling created in the same batch (in-memory parity).
      for (const { supersedes } of staged) {
        if (supersedes !== undefined) {
          const row = this._getStmt.get({ id: supersedes }) as RawRow | undefined;
          if (row === undefined) {
            throw new Error(`Memory record not found: ${supersedes}`);
          }
        }
      }
      // (b) insert every staged row (insert trigger indexes FTS).
      for (const { binds } of staged) {
        this._insertStmt.run(binds);
      }
      // (c) invalidate superseded records atomically with the write
      // (ADR-0007 D4). Already-invalidated old records keep their original
      // invalidAt via COALESCE (in-memory parity).
      for (const { record, supersedes } of staged) {
        if (supersedes !== undefined) {
          this._supersedeStmt.run({ now, newId: record.id, oldId: supersedes });
        }
      }
      this._db.exec("COMMIT");
    } catch (err) {
      try {
        this._db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }

    return staged.map(({ record }) => record);
  }

  /** {@inheritDoc MemoryStore.search} — bm25 relevance for queries, recency for listings. */
  async search(query: MemorySearchQueryInput): Promise<MemoryHit[]> {
    const q = MemorySearchQuerySchema.parse(query);
    const now = new Date().toISOString();
    const filterBinds = {
      scope: JSON.stringify(q.scope),
      kinds: q.kinds !== undefined ? JSON.stringify(q.kinds) : null,
      tags: q.tags !== undefined ? JSON.stringify(q.tags) : null,
      // Bind ints, never booleans — better-sqlite3 rejects booleans.
      includeInvalidated: q.includeInvalidated ? 1 : 0,
      now,
      limit: q.limit,
    };

    if (q.query === undefined) {
      const rows = this._listStmt.all(filterBinds) as RawRow[];
      // Hits are `{ record }` — no score (in-memory parity).
      return rows.map((row) => ({ record: this._rowToRecord(row) }));
    }

    // Tokenize exactly like the in-memory store. Zero tokens (whitespace-only
    // query) ⇒ zero score ⇒ no hits — without touching the db.
    const tokens = q.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    // OR-joined quoted tokens, internal double quotes doubled. OR (not FTS5's
    // implicit AND) is required for kit parity: "alpha beta" must return the
    // record containing only `alpha`, ranked below the record containing both.
    // Quoting makes FTS5 operators/punctuation in user text (NEAR, -, (,
    // unbalanced ") inert — a query string must never raise an FTS syntax error.
    const match = tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
    const rows = this._ftsStmt.all({ ...filterBinds, match }) as Array<
      RawRow & { bm25_rank: number }
    >;
    // score is higher-is-better and advisory only (the kit never asserts
    // values, only `typeof`), so negate the smaller-is-better bm25 rank.
    return rows.map((row) => ({ record: this._rowToRecord(row), score: -row.bm25_rank }));
  }

  /** {@inheritDoc MemoryStore.get} */
  async get(id: string): Promise<MemoryRecord | null> {
    const row = this._getStmt.get({ id }) as RawRow | undefined;
    return row === undefined ? null : this._rowToRecord(row);
  }

  /**
   * {@inheritDoc MemoryStore.invalidate}
   * `reason` is accepted and unrecorded in v1 — reserved for the memory events
   * issue; backends may audit-log it.
   */
  async invalidate(id: string, _reason?: string): Promise<void> {
    this._db.exec("BEGIN");
    try {
      const row = this._getStmt.get({ id }) as RawRow | undefined;
      if (row === undefined) {
        throw new Error(`Memory record not found: ${id}`);
      }
      // Idempotent: already-invalidated ⇒ no-op, updatedAt untouched (the kit
      // pins this).
      if (row.invalid_at === null) {
        const now = new Date().toISOString();
        this._invalidateStmt.run({ now, id });
      }
      this._db.exec("COMMIT");
    } catch (err) {
      try {
        this._db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /** {@inheritDoc MemoryStore.delete} — the delete trigger scrubs FTS; unknown id resolves silently. */
  async delete(id: string): Promise<void> {
    this._deleteStmt.run({ id });
  }

  /** {@inheritDoc MemoryStore.capabilities} */
  async capabilities(): Promise<MemoryStoreCapabilities> {
    return { search: "keyword" };
  }

  /** Close the underlying database handle. */
  close(): void {
    this._db.close();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _migrate(): void {
    // `PRAGMA user_version` read via prepare/get (portable across both
    // drivers); `.pragma("…", { simple: true })` is better-sqlite3-only. Both
    // drivers return a single `{ user_version: N }` row.
    const row = this._db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    let version = typeof row?.user_version === "number" ? row.user_version : 0;

    if (version < 1) {
      this._db.exec(MEMORY_SCHEMA_V1);
      version = 1;
    }

    if (version !== MEMORY_TARGET_SCHEMA_VERSION) {
      throw new Error(
        `memory-store schema version mismatch: db is ${version}, expected ${MEMORY_TARGET_SCHEMA_VERSION}`,
      );
    }
    this._db.exec(`PRAGMA user_version = ${MEMORY_TARGET_SCHEMA_VERSION}`);
  }

  /**
   * Rebuild a frozen {@link MemoryRecord} from a raw row. Conditional spreads
   * for every optional field (`exactOptionalPropertyTypes` discipline — NULL
   * column ⇒ key absent, never `undefined`-valued); `memoryRecord()` on the
   * way out so every read path re-validates + deep-freezes (round-trip
   * equality with the frozen write-side records).
   */
  private _rowToRecord(row: RawRow): MemoryRecord {
    return memoryRecord({
      id: row.id,
      scope: JSON.parse(row.scope),
      kind: row.kind as MemoryRecord["kind"],
      content: row.content,
      ...(row.tags !== null ? { tags: JSON.parse(row.tags) } : {}),
      ...(row.provenance !== null ? { provenance: JSON.parse(row.provenance) } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.invalid_at !== null ? { invalidAt: row.invalid_at } : {}),
      ...(row.superseded_by !== null ? { supersededBy: row.superseded_by } : {}),
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
      ...(row.target !== null ? { target: JSON.parse(row.target) } : {}),
      ...(row.payload !== null ? { payload: JSON.parse(row.payload) } : {}),
      ...(row.supports !== null ? { supports: JSON.parse(row.supports) } : {}),
    });
  }
}
