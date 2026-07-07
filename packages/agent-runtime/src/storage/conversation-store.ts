/**
 * SQLiteConversationStore — durable `ConversationStore` over the shared
 * SQLite ladder, extends `EvalStore`.
 *
 * "Extends" is literal inheritance (same idiom as `RunStore extends
 * EventStore` and `EvalStore extends RunStore`): same SQLite file, same
 * injected better-sqlite3-shaped constructor, same WAL pragmas. The schema
 * itself lands in `EventStore`'s migration ladder as v5 (`./event-store.js`)
 * so plain `EventStore`/`RunStore`/`EvalStore` and this class stay
 * interchangeable on the same file — a project that only wires `EvalStore`
 * still opens (and silently migrates) a conversation-capable v5 file; it
 * just can't read the new tables without this class.
 *
 * `StoredMessage.runId` links a conversation turn to its `runs` row (same
 * no-hard-FK, indexed-TEXT-column convention as `eval_result.run_id` —
 * insert order is not load-bearing, and the run + message are written by
 * two different call sites in practice: `Conversation._persistExchange`
 * lands the message after the run has already finished streaming).
 *
 * Zero coupling to `conversation/conversation.ts` is a kept invariant (same
 * as run-store.ts/eval-store.ts's precedent) — this class only implements
 * the structurally-typed `ConversationStore` protocol from
 * `conversation/store.ts`.
 */

import type { Statement } from "better-sqlite3";
import type {
  ConversationStore,
  StoredConversation,
  StoredConversationSummary,
  StoredMessage,
  StoredMessagePart,
} from "../conversation/store.js";
import { EvalStore } from "./eval-store.js";
import type { EventStoreOptions } from "./event-store.js";

// ---------------------------------------------------------------------------
// ID generation (mirrors run-store.ts/eval-store.ts's local generateId —
// deliberately not shared; see run-store.ts:26-32 precedent)
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

export class SQLiteConversationStore extends EvalStore implements ConversationStore {
  private readonly _createConvStmt: Statement;
  private readonly _getConvStmt: Statement;
  private readonly _touchConvStmt: Statement;
  private readonly _updateConvStmt: Statement;
  private readonly _listConvStmt: Statement;
  private readonly _addMessageStmt: Statement;
  private readonly _addPartStmt: Statement;
  private readonly _getMessagesStmt: Statement;
  private readonly _getMessagesLimitStmt: Statement;
  private readonly _getPartsStmt: Statement;

  constructor(opts: EventStoreOptions) {
    super(opts);

    this._createConvStmt = this._db.prepare(`
      INSERT INTO conversations (id, agent_name, model, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this._getConvStmt = this._db.prepare("SELECT * FROM conversations WHERE id = ?");

    this._touchConvStmt = this._db.prepare(`
      UPDATE conversations SET updated_at = ? WHERE id = ?
    `);

    this._updateConvStmt = this._db.prepare(`
      UPDATE conversations SET metadata = ?, updated_at = ? WHERE id = ?
    `);

    // Aggregates computed inline via correlated subqueries (RunStore's
    // listRuns answerLength/hasPrompt precedent) — no denormalized counters
    // to keep in sync on every addMessage().
    this._listConvStmt = this._db.prepare(`
      SELECT
        c.id                                                                   AS conversationId,
        c.agent_name                                                          AS agentName,
        c.model                                                               AS model,
        c.created_at                                                          AS startedAt,
        (SELECT COUNT(*) FROM conversation_messages m
          WHERE m.conversation_id = c.id)                                     AS messageCount,
        (SELECT COALESCE(SUM(m.input_tokens + m.output_tokens), 0) FROM conversation_messages m
          WHERE m.conversation_id = c.id)                                     AS tokenCount,
        (SELECT MAX(m.created_at) FROM conversation_messages m
          WHERE m.conversation_id = c.id)                                     AS lastMessageAt
      FROM conversations c
      ORDER BY c.created_at DESC
      LIMIT @limit
    `);

    this._addMessageStmt = this._db.prepare(`
      INSERT INTO conversation_messages (
        id, conversation_id, kind, run_id, input_tokens, output_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this._addPartStmt = this._db.prepare(`
      INSERT INTO conversation_message_parts (id, message_id, type, content, metadata, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // "limit" mirrors InMemoryConversationStore's slice(-limit) semantics —
    // the LAST N messages, in original (ASC) order: take the newest N by
    // seq DESC, then re-sort ASC.
    this._getMessagesStmt = this._db.prepare(`
      SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY seq ASC
    `);

    this._getMessagesLimitStmt = this._db.prepare(`
      SELECT * FROM (
        SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?
      ) sub
      ORDER BY seq ASC
    `);

    // Parts have no own created_at column — they're written atomically with
    // their owning message and always share its timestamp; the join pulls it
    // in rather than duplicating a column that could never legitimately drift.
    this._getPartsStmt = this._db.prepare(`
      SELECT p.*, m.created_at AS message_created_at
      FROM conversation_message_parts p
      JOIN conversation_messages m ON m.id = p.message_id
      WHERE p.message_id = ?
      ORDER BY p.position ASC, p.seq ASC
    `);
  }

  async createConversation(agentName: string, model: string): Promise<StoredConversation> {
    const id = generateId();
    const now = new Date();
    const nowIso = now.toISOString();
    this._createConvStmt.run(id, agentName, model, "{}", nowIso, nowIso);
    return { id, agentName, model, createdAt: now, updatedAt: now, metadata: {} };
  }

  async getConversation(conversationId: string): Promise<StoredConversation | null> {
    const row = this._getConvStmt.get(conversationId) as RawConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  async updateConversation(
    conversationId: string,
    updates: Record<string, unknown>,
  ): Promise<StoredConversation> {
    const existing = await this.getConversation(conversationId);
    if (!existing) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    const merged = { ...existing.metadata, ...updates };
    const now = new Date();
    this._updateConvStmt.run(JSON.stringify(merged), now.toISOString(), conversationId);
    return { ...existing, metadata: merged, updatedAt: now };
  }

  async addMessage(
    conversationId: string,
    kind: "request" | "response",
    parts: Array<{ type: string; content?: string; metadata?: Record<string, unknown> }>,
    options?: { runId?: string; inputTokens?: number; outputTokens?: number },
  ): Promise<StoredMessage> {
    const existing = await this.getConversation(conversationId);
    if (!existing) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const messageId = generateId();
    const now = new Date();
    const nowIso = now.toISOString();
    const inputTokens = options?.inputTokens ?? 0;
    const outputTokens = options?.outputTokens ?? 0;

    // One message INSERT + N part INSERTs + the conversation's `touch` UPDATE
    // must land atomically. Transactions run via explicit `exec("BEGIN")` /
    // `COMMIT` / `ROLLBACK`, NOT `db.transaction()`: the driver contract the
    // stores are written against is prepare/exec/close only (see `load.ts`
    // `wrapBunDatabase` — the bun:sqlite adapter exposes exactly that surface,
    // and `.transaction()` would throw at runtime under Bun even though
    // better-sqlite3 tests pass under Node). All statements are synchronous,
    // so nothing can interleave between BEGIN and COMMIT.
    this._db.exec("BEGIN");
    let storedParts: StoredMessagePart[];
    try {
      this._addMessageStmt.run(
        messageId,
        conversationId,
        kind,
        options?.runId ?? null,
        inputTokens,
        outputTokens,
        nowIso,
      );

      storedParts = parts.map((p, index) => {
        const partId = generateId();
        const metadata = p.metadata ?? {};
        this._addPartStmt.run(
          partId,
          messageId,
          p.type,
          p.content ?? null,
          JSON.stringify(metadata),
          index,
        );
        return {
          id: partId,
          messageId,
          type: p.type,
          content: p.content,
          metadata,
          position: index,
          createdAt: now,
        };
      });

      this._touchConvStmt.run(nowIso, conversationId);
      this._db.exec("COMMIT");
    } catch (err) {
      this._db.exec("ROLLBACK");
      throw err;
    }

    return {
      id: messageId,
      conversationId,
      kind,
      runId: options?.runId,
      inputTokens,
      outputTokens,
      createdAt: now,
      parts: storedParts,
    };
  }

  async getMessages(conversationId: string, limit?: number): Promise<StoredMessage[]> {
    const rows =
      limit !== undefined && limit > 0
        ? (this._getMessagesLimitStmt.all(conversationId, limit) as RawMessageRow[])
        : (this._getMessagesStmt.all(conversationId) as RawMessageRow[]);

    const out: StoredMessage[] = [];
    for (const row of rows) {
      const parts = await this.getMessageParts(row.id);
      out.push(rowToMessage(row, parts));
    }
    return out;
  }

  async getMessageParts(messageId: string): Promise<StoredMessagePart[]> {
    const rows = this._getPartsStmt.all(messageId) as RawPartRow[];
    return rows.map(rowToPart);
  }

  async listConversations(limit?: number): Promise<StoredConversationSummary[]> {
    // `limit ?? -1` is WRONG here: `??` only substitutes on null/undefined, so
    // `listConversations(0)` would pass `{ limit: 0 }` straight through to
    // `LIMIT @limit` → zero rows — diverging from `InMemoryConversationStore`
    // (below), which treats `0` (falsy, not just absent) as "no cap" via its
    // `limit > 0` guard. `limit && limit > 0` normalizes both falsy cases
    // (`0` and `undefined`) to "all" (`-1`), matching the in-memory contract.
    const effectiveLimit = limit && limit > 0 ? limit : -1;
    const rows = this._listConvStmt.all({ limit: effectiveLimit }) as RawSummaryRow[];
    return rows.map((r) => ({
      conversationId: r.conversationId,
      agentName: r.agentName,
      model: r.model,
      status: "active" as const,
      messageCount: r.messageCount,
      tokenCount: r.tokenCount,
      startedAt: new Date(r.startedAt),
      lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt) : undefined,
    }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RawConversationRow {
  id: string;
  agent_name: string;
  model: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

function rowToConversation(r: RawConversationRow): StoredConversation {
  return {
    id: r.id,
    agentName: r.agent_name,
    model: r.model,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    metadata: parseJsonRecord(r.metadata),
  };
}

interface RawMessageRow {
  seq: number;
  id: string;
  conversation_id: string;
  kind: "request" | "response";
  run_id: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

function rowToMessage(r: RawMessageRow, parts: StoredMessagePart[]): StoredMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    kind: r.kind,
    runId: r.run_id ?? undefined,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    createdAt: new Date(r.created_at),
    parts,
  };
}

interface RawPartRow {
  seq: number;
  id: string;
  message_id: string;
  type: string;
  content: string | null;
  metadata: string;
  position: number;
  message_created_at: string;
}

function rowToPart(r: RawPartRow): StoredMessagePart {
  return {
    id: r.id,
    messageId: r.message_id,
    type: r.type,
    content: r.content ?? undefined,
    metadata: parseJsonRecord(r.metadata),
    position: r.position,
    createdAt: new Date(r.message_created_at),
  };
}

interface RawSummaryRow {
  conversationId: string;
  agentName: string;
  model: string;
  startedAt: string;
  messageCount: number;
  tokenCount: number;
  lastMessageAt: string | null;
}

function parseJsonRecord(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
