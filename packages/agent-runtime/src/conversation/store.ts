/**
 * ConversationStore — structured persistence for conversations.
 *
 * Ported from Python: systems/stores/base.py
 */

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _counter = 0;
function generateId(): string {
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Stored record types
// ---------------------------------------------------------------------------

/** A stored conversation record. */
export interface StoredConversation {
  readonly id: string;
  readonly agentName: string;
  readonly model: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly metadata: Record<string, unknown>;
}

/** A stored message within a conversation. */
export interface StoredMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly kind: "request" | "response";
  readonly runId?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: Date;
  readonly parts: StoredMessagePart[];
}

/** A part of a stored message. */
export interface StoredMessagePart {
  readonly id: string;
  readonly messageId: string;
  readonly type: string;
  readonly content?: string;
  readonly metadata: Record<string, unknown>;
  /**
   * Ordinal position within the owning message (0-based insertion order).
   * The dashboard sorts parts by this column (`ConversationMessagePart.position`,
   * `agent-dashboard/src/api/types.ts`); optional so pre-#S7 producers of this
   * protocol (and any other implementation) aren't forced to supply it.
   */
  readonly position?: number;
  /** Creation time — shares the owning message's `createdAt` (written atomically). */
  readonly createdAt?: Date;
}

/** Cheap list projection for `listConversations` — no message/part blobs. */
export interface StoredConversationSummary {
  readonly conversationId: string;
  readonly agentName: string;
  readonly model: string;
  readonly status: "active" | "completed" | "error";
  readonly messageCount: number;
  readonly tokenCount: number;
  readonly startedAt: Date;
  readonly lastMessageAt?: Date;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Structured conversation persistence protocol. */
export interface ConversationStore {
  createConversation(agentName: string, model: string): Promise<StoredConversation>;

  getConversation(conversationId: string): Promise<StoredConversation | null>;

  updateConversation(
    conversationId: string,
    updates: Record<string, unknown>,
  ): Promise<StoredConversation>;

  addMessage(
    conversationId: string,
    kind: "request" | "response",
    parts: Array<{
      type: string;
      content?: string;
      metadata?: Record<string, unknown>;
    }>,
    options?: {
      runId?: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): Promise<StoredMessage>;

  getMessages(conversationId: string, limit?: number): Promise<StoredMessage[]>;

  getMessageParts(messageId: string): Promise<StoredMessagePart[]>;

  /**
   * All conversations, newest first (by `createdAt`), with cheap aggregates
   * (`messageCount`/`tokenCount`/`lastMessageAt`) folded in — the projection
   * `GET /admin/conversations` serves. `limit` omitted -> all.
   */
  listConversations(limit?: number): Promise<StoredConversationSummary[]>;
}

// ---------------------------------------------------------------------------
// InMemoryConversationStore
// ---------------------------------------------------------------------------

/** In-memory implementation of ConversationStore. */
export class InMemoryConversationStore implements ConversationStore {
  private _conversations = new Map<string, StoredConversation>();
  private _messages = new Map<string, StoredMessage[]>();
  private _parts = new Map<string, StoredMessagePart[]>();

  async createConversation(agentName: string, model: string): Promise<StoredConversation> {
    const now = new Date();
    const conv: StoredConversation = {
      id: generateId(),
      agentName,
      model,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };
    this._conversations.set(conv.id, conv);
    this._messages.set(conv.id, []);
    return conv;
  }

  async getConversation(conversationId: string): Promise<StoredConversation | null> {
    return this._conversations.get(conversationId) ?? null;
  }

  async updateConversation(
    conversationId: string,
    updates: Record<string, unknown>,
  ): Promise<StoredConversation> {
    const existing = this._conversations.get(conversationId);
    if (!existing) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    const updated: StoredConversation = {
      ...existing,
      metadata: { ...existing.metadata, ...updates },
      updatedAt: new Date(),
    };
    this._conversations.set(conversationId, updated);
    return updated;
  }

  async addMessage(
    conversationId: string,
    kind: "request" | "response",
    parts: Array<{
      type: string;
      content?: string;
      metadata?: Record<string, unknown>;
    }>,
    options?: {
      runId?: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): Promise<StoredMessage> {
    const convMessages = this._messages.get(conversationId);
    if (!convMessages) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const messageId = generateId();
    const now = new Date();
    const storedParts: StoredMessagePart[] = parts.map((p, index) => ({
      id: generateId(),
      messageId,
      type: p.type,
      content: p.content,
      metadata: p.metadata ?? {},
      position: index,
      createdAt: now,
    }));

    const msg: StoredMessage = {
      id: messageId,
      conversationId,
      kind,
      runId: options?.runId,
      inputTokens: options?.inputTokens ?? 0,
      outputTokens: options?.outputTokens ?? 0,
      createdAt: now,
      parts: storedParts,
    };

    convMessages.push(msg);
    this._parts.set(messageId, storedParts);
    return msg;
  }

  async getMessages(conversationId: string, limit?: number): Promise<StoredMessage[]> {
    const msgs = this._messages.get(conversationId) ?? [];
    if (limit !== undefined && limit > 0) {
      return msgs.slice(-limit);
    }
    return [...msgs];
  }

  async getMessageParts(messageId: string): Promise<StoredMessagePart[]> {
    return this._parts.get(messageId) ?? [];
  }

  async listConversations(limit?: number): Promise<StoredConversationSummary[]> {
    const all = [...this._conversations.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const sliced = limit !== undefined && limit > 0 ? all.slice(0, limit) : all;
    return sliced.map((conv) => {
      const msgs = this._messages.get(conv.id) ?? [];
      const tokenCount = msgs.reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0);
      const lastMessageAt = msgs.length > 0 ? msgs[msgs.length - 1]?.createdAt : undefined;
      return {
        conversationId: conv.id,
        agentName: conv.agentName,
        model: conv.model,
        status: "active" as const,
        messageCount: msgs.length,
        tokenCount,
        startedAt: conv.createdAt,
        lastMessageAt,
      };
    });
  }
}
