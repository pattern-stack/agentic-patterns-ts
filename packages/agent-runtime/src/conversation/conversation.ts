/**
 * Conversation runtime - stateful multi-turn conversation management.
 *
 * Ported from Python: systems/conversation.py
 */

import type { AgentEventBus } from "../events/agent-event-bus.js";
import { getAgentEventBus } from "../events/agent-event-bus.js";
import type { AgentEvent } from "../events/types.js";
import { createEvent } from "../events/types.js";
import type {
  AgentLike,
  CanonicalMessage,
  CanonicalMessagePart,
  RunResult,
  RunnerProtocol,
  ToolExecutor,
} from "../runner/types.js";
import type { ConversationStore } from "./store.js";

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

/** A single tool call record within an exchange. */
export interface ToolCallRecord {
  readonly name: string;
  readonly id?: string;
  readonly arguments?: Record<string, unknown>;
}

/** A complete user->assistant exchange in a conversation. */
export interface Exchange {
  readonly number: number;
  readonly invocationId: string;
  readonly user: string;
  readonly assistant: string;
  readonly toolCalls: ToolCallRecord[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly timestamp: Date;
}

/**
 * Total tokens for an exchange.
 */
export function exchangeTotalTokens(exchange: Exchange): number {
  return exchange.inputTokens + exchange.outputTokens;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/**
 * A live conversation that can be continued.
 *
 * Core runtime abstraction for multi-turn conversations.
 * Tracks state, history, and manages execution.
 *
 * Example:
 *   const conversation = new Conversation(agent, runner);
 *   const exchange = await conversation.send("Hello!");
 *   console.log(exchange.assistant);
 */
export class Conversation {
  readonly id: string;
  readonly agent: AgentLike;
  readonly runner: RunnerProtocol;

  private _store: ConversationStore | undefined;
  private _storeConversationId: string | undefined;
  private _toolExecutor: ToolExecutor | undefined;
  private _state: Record<string, unknown>;
  private _history: Exchange[] = [];
  private _exchangeCount = 0;

  constructor(
    agent: AgentLike,
    runner: RunnerProtocol,
    options?: {
      id?: string;
      store?: ConversationStore;
      toolExecutor?: ToolExecutor;
      state?: Record<string, unknown>;
      history?: Exchange[];
    },
  ) {
    this.agent = agent;
    this.runner = runner;
    this.id = options?.id ?? generateUUID();
    this._store = options?.store;
    this._toolExecutor = options?.toolExecutor;
    this._state = options?.state ?? {};
    if (options?.history) {
      this._history = [...options.history];
      this._exchangeCount = this._history.length;
    }
  }

  /** String session ID for SDK compatibility. */
  get sessionId(): string {
    return this.id;
  }

  /** Number of completed exchanges. */
  get exchangeCount(): number {
    return this._exchangeCount;
  }

  /** All completed exchanges (copy). */
  get history(): Exchange[] {
    return [...this._history];
  }

  /** Alias for history — matches spec's `exchanges` getter. */
  get exchanges(): Exchange[] {
    return this.history;
  }

  /** Working state. */
  get state(): Record<string, unknown> {
    return { ...this._state };
  }

  /** Aggregate token usage across all exchanges. */
  get totalTokens(): { input: number; output: number; total: number } {
    const input = this._history.reduce((s, e) => s + e.inputTokens, 0);
    const output = this._history.reduce((s, e) => s + e.outputTokens, 0);
    return { input, output, total: input + output };
  }

  /** Most recent exchange, or undefined if no history. */
  get lastExchange(): Exchange | undefined {
    return this._history.length > 0 ? this._history[this._history.length - 1] : undefined;
  }

  /** Clear conversation history. */
  clear(): void {
    this._history = [];
    this._exchangeCount = 0;
  }

  /** Rollback conversation to a specific exchange (inclusive). */
  rollback(toExchange: number): void {
    this._history = this._history.filter((e) => e.number <= toExchange);
    this._exchangeCount = this._history.length;
  }

  /**
   * Send a message and get a response.
   */
  async send(message: string): Promise<Exchange> {
    this._exchangeCount += 1;
    const invocationId = generateUUID();

    const messageHistory = this._toMessageHistory();

    const result: RunResult = await this.runner.run(this.agent, message, {
      messageHistory,
      toolExecutor: this._toolExecutor,
    });

    const exchange: Exchange = {
      number: this._exchangeCount,
      invocationId,
      user: message,
      assistant: result.response,
      toolCalls: [],
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      timestamp: new Date(),
    };

    this._history.push(exchange);

    if (this._store) {
      await this._persistExchange(exchange);
    }

    return exchange;
  }

  /**
   * Send a message and stream the response.
   *
   * Yields AgentEvents as they arrive. After streaming completes,
   * the exchange is recorded in history.
   */
  async *stream(
    message: string,
    options?: { eventBus?: AgentEventBus; maxIterations?: number },
  ): AsyncGenerator<AgentEvent> {
    if (!this.runner.stream) {
      throw new Error("Runner does not support streaming");
    }

    this._exchangeCount += 1;
    const invocationId = generateUUID();
    const messageHistory = this._toMessageHistory();
    const eventBus = options?.eventBus ?? getAgentEventBus();

    // Get trace ID from message.start event (will be emitted by runner)
    // For now, generate one
    const traceId = invocationId;
    const runId = generateUUID();

    // Emit conversation start
    const convStartEvent = createEvent("agent.conversation.start", {
      traceId,
      runId,
      conversationId: this.id,
      agentName: this.agent.role.name,
    });
    yield convStartEvent;
    await eventBus.publish(convStartEvent);

    let fullResponse = "";
    let totalInput = 0;
    let totalOutput = 0;
    let error: Error | undefined;

    try {
      for await (const event of this.runner.stream(this.agent, message, {
        messageHistory,
        toolExecutor: this._toolExecutor,
        eventBus: options?.eventBus,
        ...(options?.maxIterations != null ? { maxIterations: options.maxIterations } : {}),
      })) {
        yield event;

        // Accumulate response data from events
        if (event.type === "agent.message.chunk") {
          fullResponse += event.delta;
        }
        if (event.type === "agent.message.complete") {
          fullResponse = event.content;
          totalInput = event.inputTokens;
          totalOutput = event.outputTokens;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }

    const exchange: Exchange = {
      number: this._exchangeCount,
      invocationId,
      user: message,
      assistant: fullResponse,
      toolCalls: [],
      inputTokens: totalInput,
      outputTokens: totalOutput,
      timestamp: new Date(),
    };

    this._history.push(exchange);

    if (this._store) {
      await this._persistExchange(exchange);
    }

    // Emit conversation end
    const convEndEvent = createEvent("agent.conversation.end", {
      traceId,
      runId,
      conversationId: this.id,
      reason: error ? "error" : "completed",
    });
    yield convEndEvent;
    await eventBus.publish(convEndEvent);

    // Rethrow error after emitting conversation.end
    if (error) {
      throw error;
    }
  }

  /**
   * Create a new conversation branch.
   *
   * @param atExchange - Exchange number to branch from (undefined = current)
   */
  async fork(atExchange?: number): Promise<Conversation> {
    const branchPoint = atExchange ?? this._exchangeCount;

    const forked = new Conversation(this.agent, this.runner, {
      store: this._store,
      toolExecutor: this._toolExecutor,
      state: { ...this._state },
    });

    forked._history = this._history.filter((e) => e.number <= branchPoint);
    forked._exchangeCount = forked._history.length;

    return forked;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Persist an exchange to the store using the new protocol.
   */
  private async _persistExchange(exchange: Exchange): Promise<void> {
    if (!this._store) return;

    if (!this._storeConversationId) {
      const conv = await this._store.createConversation(
        this.agent.role.name,
        this.agent.getModel(),
      );
      this._storeConversationId = conv.id;
    }

    await this._store.addMessage(this._storeConversationId, "request", [
      { type: "user_prompt", content: exchange.user },
    ]);

    await this._store.addMessage(
      this._storeConversationId,
      "response",
      [{ type: "text", content: exchange.assistant }],
      {
        inputTokens: exchange.inputTokens,
        outputTokens: exchange.outputTokens,
      },
    );
  }

  /**
   * Convert history to canonical message format for runners.
   */
  private _toMessageHistory(): CanonicalMessage[] {
    const messages: CanonicalMessage[] = [];
    for (const exchange of this._history) {
      messages.push({
        kind: "request",
        parts: [{ type: "user_prompt", content: exchange.user }],
      });
      const parts: CanonicalMessagePart[] = [{ type: "text", content: exchange.assistant }];
      for (const tc of exchange.toolCalls) {
        parts.push({
          type: "tool_call",
          tool_name: tc.name,
          tool_call_id: tc.id,
          arguments: tc.arguments,
        });
      }
      messages.push({
        kind: "response",
        parts,
      });
    }
    return messages;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _counter = 0;
function generateUUID(): string {
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}
