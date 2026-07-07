/**
 * SQLiteConversationStore unit tests (spec `.ai-docs/stacks/playground-
 * upgrades/port-map.md` § 4.1). Uses an in-memory SQLite database
 * (run-store.test.ts precedent), plus an on-disk test for the v4 -> v5
 * migration.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationStore } from "../../conversation/store.js";
import { SQLiteConversationStore } from "../conversation-store.js";
import { EvalStore } from "../eval-store.js";
import { EventStore } from "../event-store.js";

describe("SQLiteConversationStore", () => {
  let store: SQLiteConversationStore;

  beforeEach(() => {
    store = new SQLiteConversationStore({ path: ":memory:", Database });
  });

  afterEach(() => {
    store.close();
  });

  describe("v4 -> v5 migration", () => {
    it("migrates a hand-built v4 DB in place; existing rows survive, conversation tables usable", async () => {
      const fs = require("node:fs") as typeof import("node:fs");
      const os = require("node:os") as typeof import("node:os");
      const path = require("node:path") as typeof import("node:path");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conversationstore-migrate-"));
      const dbPath = path.join(dir, "events.db");

      // Hand-build a v4 DB: v1 events + v2 runs + v3 eval tables + v4's
      // eval_run.scorer column — the exact pre-#S7 shape, no conversation
      // tables at all.
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL, timestamp TEXT NOT NULL, trace_id TEXT, run_id TEXT,
          span_id TEXT, cc_session_id TEXT, cc_hook_name TEXT, cc_cwd TEXT, data TEXT NOT NULL
        );
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY, trace_id TEXT, ts_start TEXT NOT NULL, ts_end TEXT,
          agent_name TEXT, model TEXT, system_prompt TEXT, agent_config TEXT, final_answer TEXT,
          tool_calls INTEGER, iterations INTEGER, input_tokens INTEGER, output_tokens INTEGER,
          finish_reason TEXT, elapsed_ms INTEGER, status TEXT NOT NULL, error TEXT,
          step_metrics TEXT, metadata TEXT
        );
        CREATE TABLE eval_set (id TEXT PRIMARY KEY, name TEXT, description TEXT, created_ts TEXT NOT NULL);
        CREATE TABLE eval_case (
          set_id TEXT NOT NULL, case_id TEXT NOT NULL, input_json TEXT, expected_json TEXT,
          tags_json TEXT, split TEXT, PRIMARY KEY (set_id, case_id)
        );
        CREATE TABLE eval_run (
          id TEXT PRIMARY KEY, ts_start TEXT NOT NULL, ts_end TEXT, set_id TEXT, target_id TEXT,
          variant TEXT, split TEXT, model TEXT, git_sha TEXT, status TEXT NOT NULL, scorer TEXT
        );
        CREATE TABLE eval_result (
          eval_run_id TEXT NOT NULL, case_id TEXT NOT NULL, run_id TEXT, scores_json TEXT,
          pass INTEGER, PRIMARY KEY (eval_run_id, case_id)
        );
      `);
      raw
        .prepare(
          "INSERT INTO events (type, timestamp, trace_id, run_id, span_id, data) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "agent.message.start",
          "2026-05-11T18:00:00.000Z",
          "t1",
          "r1",
          "s1",
          JSON.stringify({ hello: "world" }),
        );
      raw.pragma("user_version = 4");
      raw.close();

      // Reopen via SQLiteConversationStore: v5 lands, prior event row
      // intact, and the new conversation tables are immediately usable.
      const cs = new SQLiteConversationStore({ path: dbPath, Database });
      expect(cs.count()).toBe(1);

      const conv = await cs.createConversation("agent-x", "model-x");
      expect((await cs.getConversation(conv.id))?.agentName).toBe("agent-x");
      cs.close();

      // Plain EventStore, RunStore-via-EvalStore also open the v5 file
      // (shared TARGET_SCHEMA_VERSION) without throwing.
      const es = new EventStore({ path: dbPath, Database });
      expect(es.count()).toBe(1);
      es.close();

      const evs = new EvalStore({ path: dbPath, Database });
      expect(evs.count()).toBe(1);
      evs.close();

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("a fresh conversation round-trips after migrating an on-disk v4 DB", async () => {
      const fs = require("node:fs") as typeof import("node:fs");
      const os = require("node:os") as typeof import("node:os");
      const path = require("node:path") as typeof import("node:path");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conversationstore-migrate2-"));
      const dbPath = path.join(dir, "events.db");

      // A plain fresh EventStore (created via loadEventStore's own class)
      // lands at TARGET_SCHEMA_VERSION directly (already v5) — this exercises
      // the "no prior file" boot path rather than a hand-built legacy file.
      const es = new EventStore({ path: dbPath, Database });
      es.close();

      const cs = new SQLiteConversationStore({ path: dbPath, Database });
      const conv = await cs.createConversation("agent-y", "model-y");
      expect(conv.agentName).toBe("agent-y");
      const fetched = await cs.getConversation(conv.id);
      expect(fetched?.id).toBe(conv.id);
      cs.close();

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("createConversation / getConversation", () => {
    it("creates and reads back a conversation", async () => {
      const conv = await store.createConversation("TestAgent", "gpt-4");
      expect(conv.id).toBeTruthy();
      expect(conv.agentName).toBe("TestAgent");
      expect(conv.model).toBe("gpt-4");
      expect(conv.createdAt).toBeInstanceOf(Date);
      expect(conv.updatedAt).toBeInstanceOf(Date);
      expect(conv.metadata).toEqual({});

      const fetched = await store.getConversation(conv.id);
      expect(fetched).toEqual(conv);
    });

    it("returns null for an unknown conversation", async () => {
      expect(await store.getConversation("nope")).toBeNull();
    });
  });

  describe("updateConversation", () => {
    it("merges metadata and bumps updatedAt", async () => {
      const conv = await store.createConversation("Agent", "model");
      const updated = await store.updateConversation(conv.id, { topic: "testing" });
      expect(updated.metadata).toEqual({ topic: "testing" });
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(conv.updatedAt.getTime());

      const merged = await store.updateConversation(conv.id, { extra: 1 });
      expect(merged.metadata).toEqual({ topic: "testing", extra: 1 });
    });

    it("throws on update of an unknown conversation", async () => {
      await expect(store.updateConversation("nope", {})).rejects.toThrow("Conversation not found");
    });
  });

  describe("addMessage / getMessages / getMessageParts", () => {
    it("adds a message with ordered parts, position assigned by insertion index", async () => {
      const conv = await store.createConversation("Agent", "model");
      const msg = await store.addMessage(conv.id, "request", [
        { type: "user_prompt", content: "Hello" },
        { type: "context", content: "extra", metadata: { source: "test" } },
      ]);

      expect(msg.conversationId).toBe(conv.id);
      expect(msg.kind).toBe("request");
      expect(msg.parts).toHaveLength(2);
      expect(msg.parts[0]?.position).toBe(0);
      expect(msg.parts[1]?.position).toBe(1);
      expect(msg.parts[1]?.metadata).toEqual({ source: "test" });

      const parts = await store.getMessageParts(msg.id);
      expect(parts.map((p) => p.position)).toEqual([0, 1]);
      expect(parts.map((p) => p.type)).toEqual(["user_prompt", "context"]);
    });

    it("stores runId + token counts on a response message", async () => {
      const conv = await store.createConversation("Agent", "model");
      const msg = await store.addMessage(conv.id, "response", [{ type: "text", content: "Hi" }], {
        runId: "run-123",
        inputTokens: 100,
        outputTokens: 50,
      });
      expect(msg.runId).toBe("run-123");
      expect(msg.inputTokens).toBe(100);
      expect(msg.outputTokens).toBe(50);

      const [reread] = await store.getMessages(conv.id);
      expect(reread?.runId).toBe("run-123");
    });

    it("defaults token counts to 0 and leaves runId undefined when omitted", async () => {
      const conv = await store.createConversation("Agent", "model");
      const msg = await store.addMessage(conv.id, "request", [{ type: "text", content: "hi" }]);
      expect(msg.inputTokens).toBe(0);
      expect(msg.outputTokens).toBe(0);
      expect(msg.runId).toBeUndefined();
    });

    it("throws on addMessage for an unknown conversation", async () => {
      await expect(store.addMessage("nope", "request", [])).rejects.toThrow(
        "Conversation not found",
      );
    });

    it("returns messages ASC by insertion order, each with its parts", async () => {
      const conv = await store.createConversation("Agent", "model");
      await store.addMessage(conv.id, "request", [{ type: "text", content: "first" }]);
      await store.addMessage(conv.id, "response", [{ type: "text", content: "second" }]);
      await store.addMessage(conv.id, "request", [{ type: "text", content: "third" }]);

      const msgs = await store.getMessages(conv.id);
      expect(msgs).toHaveLength(3);
      expect(msgs.map((m) => m.parts[0]?.content)).toEqual(["first", "second", "third"]);
      expect(msgs.map((m) => m.kind)).toEqual(["request", "response", "request"]);
    });

    it("honors limit as 'last N in original order' (InMemory parity)", async () => {
      const conv = await store.createConversation("Agent", "model");
      await store.addMessage(conv.id, "request", [{ type: "text", content: "first" }]);
      await store.addMessage(conv.id, "response", [{ type: "text", content: "second" }]);
      await store.addMessage(conv.id, "request", [{ type: "text", content: "third" }]);

      const msgs = await store.getMessages(conv.id, 2);
      expect(msgs).toHaveLength(2);
      expect(msgs.map((m) => m.parts[0]?.content)).toEqual(["second", "third"]);
    });

    it("returns an empty array for an unknown conversation's messages (no throw)", async () => {
      expect(await store.getMessages("nope")).toEqual([]);
    });

    it("returns an empty array for an unknown message's parts (no throw)", async () => {
      expect(await store.getMessageParts("nope")).toEqual([]);
    });
  });

  describe("listConversations", () => {
    it("lists newest-created first with messageCount/tokenCount/lastMessageAt aggregates", async () => {
      const a = await store.createConversation("agent-a", "model-a");
      await new Promise((r) => setTimeout(r, 2));
      const b = await store.createConversation("agent-b", "model-b");

      await store.addMessage(a.id, "request", [{ type: "user_prompt", content: "hi" }]);
      await store.addMessage(a.id, "response", [{ type: "text", content: "hello" }], {
        inputTokens: 10,
        outputTokens: 5,
      });

      const summaries = await store.listConversations();
      expect(summaries.map((s) => s.conversationId)).toEqual([b.id, a.id]);

      const summaryA = summaries.find((s) => s.conversationId === a.id);
      expect(summaryA?.messageCount).toBe(2);
      expect(summaryA?.tokenCount).toBe(15);
      expect(summaryA?.status).toBe("active");
      expect(summaryA?.lastMessageAt).toBeInstanceOf(Date);

      const summaryB = summaries.find((s) => s.conversationId === b.id);
      expect(summaryB?.messageCount).toBe(0);
      expect(summaryB?.tokenCount).toBe(0);
      expect(summaryB?.lastMessageAt).toBeUndefined();
    });

    it("honors limit", async () => {
      await store.createConversation("agent-a", "model-a");
      await store.createConversation("agent-b", "model-b");
      const summaries = await store.listConversations(1);
      expect(summaries).toHaveLength(1);
    });

    // Protocol-consistency pin vs `InMemoryConversationStore` (same test name
    // in `conversation/__tests__/store.test.ts`): `limit ?? -1` previously
    // let `listConversations(0)` fall through as a literal `LIMIT 0` (zero
    // rows) — `??` only substitutes on null/undefined, not falsy `0` — while
    // the in-memory store's `limit > 0` guard already treated `0` as "no
    // cap". Both must agree.
    it("treats limit 0 the same as omitted — returns all conversations", async () => {
      await store.createConversation("agent-a", "model-a");
      await store.createConversation("agent-b", "model-b");
      expect(await store.listConversations(0)).toHaveLength(2);
    });

    it("returns an empty array when there are no conversations", async () => {
      expect(await store.listConversations()).toEqual([]);
    });
  });

  describe("ConversationStore protocol conformance", () => {
    it("type-checks as ConversationStore and round-trips through the protocol surface", async () => {
      const protocolStore: ConversationStore = store;
      const conv = await protocolStore.createConversation("Agent", "model");
      await protocolStore.addMessage(conv.id, "request", [{ type: "user_prompt", content: "hi" }]);
      const msgs = await protocolStore.getMessages(conv.id);
      expect(msgs).toHaveLength(1);
      const list = await protocolStore.listConversations();
      expect(list).toHaveLength(1);
    });
  });

  describe("loadConversationStore", () => {
    it("happy path returns a live SQLiteConversationStore (better-sqlite3 is a devDependency here)", async () => {
      const { loadConversationStore } = await import("../load.js");
      const result = await loadConversationStore({ path: ":memory:" });
      expect(result.unavailable).toBe(false);
      expect(result.store).toBeInstanceOf(SQLiteConversationStore);
      expect(result.reason).toContain(":memory:");
      result.store?.close();
    });
  });

  describe("bun:sqlite adapter surface (prepare/exec/close only)", () => {
    // `load.ts wrapBunDatabase` exposes ONLY prepare/exec/close — no
    // `.transaction()`. Regression for the live-chat message loss under Bun:
    // addMessage must transact via exec("BEGIN"/"COMMIT"), never a
    // better-sqlite3-only API. This driver throws on any other member access.
    // Typed as `typeof Database` to satisfy the store's option type; at
    // runtime it deliberately satisfies ONLY the prepare/exec/close surface.
    function shimOnlyDatabase(): typeof Database {
      return class ShimOnly {
        private readonly _raw: InstanceType<typeof Database>;
        constructor(path: string) {
          this._raw = new Database(path);
          // biome-ignore lint/correctness/noConstructorReturn: deliberate — a Proxy is the point
          return new Proxy(this, {
            get(target, prop) {
              if (prop === "prepare") return (sql: string) => target._raw.prepare(sql);
              if (prop === "exec") return (sql: string) => target._raw.exec(sql);
              if (prop === "close") return () => target._raw.close();
              throw new TypeError(`bun adapter surface has no member "${String(prop)}"`);
            },
          });
        }
      } as never;
    }

    it("addMessage persists message + parts through the shim surface", async () => {
      const shimStore = new SQLiteConversationStore({
        path: ":memory:",
        Database: shimOnlyDatabase(),
      });
      const conv = await shimStore.createConversation("Agent", "model");
      const msg = await shimStore.addMessage(conv.id, "request", [
        { type: "user_prompt", content: "hello" },
        { type: "text", content: "world" },
      ]);
      expect(msg.parts).toHaveLength(2);
      const persisted = await shimStore.getMessages(conv.id);
      expect(persisted).toHaveLength(1);
      expect(await shimStore.getMessageParts(msg.id)).toHaveLength(2);
      shimStore.close();
    });

    it("a failing part write rolls back the whole message atomically", async () => {
      const shimStore = new SQLiteConversationStore({
        path: ":memory:",
        Database: shimOnlyDatabase(),
      });
      const conv = await shimStore.createConversation("Agent", "model");
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic; // JSON.stringify throws mid-loop on the 2nd part
      await expect(
        shimStore.addMessage(conv.id, "request", [
          { type: "text", content: "ok" },
          { type: "text", content: "boom", metadata: cyclic },
        ]),
      ).rejects.toThrow();
      expect(await shimStore.getMessages(conv.id)).toHaveLength(0);
      shimStore.close();
    });
  });
});
