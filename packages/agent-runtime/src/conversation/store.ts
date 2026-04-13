/**
 * ConversationStoreProtocol — structured persistence for conversations.
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
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Structured conversation persistence protocol. */
export interface ConversationStoreProtocol {
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
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

/** In-memory implementation of ConversationStoreProtocol. */
export class MemoryStore implements ConversationStoreProtocol {
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
    const storedParts: StoredMessagePart[] = parts.map((p) => ({
      id: generateId(),
      messageId,
      type: p.type,
      content: p.content,
      metadata: p.metadata ?? {},
    }));

    const msg: StoredMessage = {
      id: messageId,
      conversationId,
      kind,
      runId: options?.runId,
      inputTokens: options?.inputTokens ?? 0,
      outputTokens: options?.outputTokens ?? 0,
      createdAt: new Date(),
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
}
