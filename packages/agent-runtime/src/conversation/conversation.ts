/**
 * Conversation runtime - stateful multi-turn conversation management.
 *
 * Ported from Python: systems/conversation.py
 */

import type { AgentEventBus } from "../events/agent-event-bus.js";
import { getAgentEventBus } from "../events/agent-event-bus.js";
import type { AgentEvent, AgentEventType } from "../events/types.js";
import { createEvent } from "../events/types.js";
import type {
  AgentLike,
  CanonicalMessage,
  CanonicalMessagePart,
  RunResult,
  RunnerProtocol,
  ToolExecutor,
} from "../runner/types.js";
import { toSSEMapping } from "../transport/sse-formatter.js";
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
  /**
   * The underlying `RunStore` run id this exchange's execution landed under
   * (the runner's internally-generated `runId`, captured off the first
   * streamed event — `RunOptions` has no slot to hand a runId IN, only
   * `traceId`/`parentSpanId`). Only populated by `stream()` (the SSE/live
   * path `RunStoreExporter` observes); `send()` has no event stream to read
   * it from. Threaded onto `StoredMessage.runId` so the Console trace rail
   * can jump straight to `GET /admin/runs/:runId/events`.
   */
  readonly runId?: string;
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
  /**
   * Opaque `RunOptions.host` payload, fixed at construction (conversation
   * lifetime, not per-message) and forwarded verbatim into every `send()`/
   * `stream()` run's options. Carries a server-parsed `SessionScope` value
   * (`host.scope`, #308) across every run this conversation makes.
   */
  private _host: unknown;

  constructor(
    agent: AgentLike,
    runner: RunnerProtocol,
    options?: {
      id?: string;
      store?: ConversationStore;
      toolExecutor?: ToolExecutor;
      state?: Record<string, unknown>;
      history?: Exchange[];
      host?: unknown;
    },
  ) {
    this.agent = agent;
    this.runner = runner;
    this.id = options?.id ?? generateUUID();
    this._store = options?.store;
    this._toolExecutor = options?.toolExecutor;
    this._state = options?.state ?? {};
    this._host = options?.host;
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
      host: this._host,
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
    // The runner's OWN internally-generated runId (distinct from this
    // method's local `runId` above, which only labels Conversation's own
    // conversation.start/end events) — RunOptions has no slot to pass a
    // runId IN, so it's captured off the first event the runner yields.
    // Every AgentEvent carries `runId` (BaseEvent), so the first one wins.
    let capturedRunId: string | undefined;
    // State-delta events (#226) captured during the run, persisted as
    // `state_delta` parts on the response message so session replay can
    // rebuild Delta Frames. Streamed order == persisted order (position).
    const stateDeltas: StateDeltaPart[] = [];

    try {
      for await (const event of this.runner.stream(this.agent, message, {
        messageHistory,
        toolExecutor: this._toolExecutor,
        host: this._host,
        eventBus: options?.eventBus,
        // traceId fix: without this, the runner falls back to `effectiveTraceId
        // = options?.traceId ?? runId` and stamps every run event with ITS OWN
        // runId as the trace id — disjoint from this method's `agent.conversation.
        // start/end` events (traceId = invocationId, above). Passing traceId
        // here joins both event families onto one trace.
        traceId,
        ...(options?.maxIterations != null ? { maxIterations: options.maxIterations } : {}),
      })) {
        yield event;
        capturedRunId ??= event.runId;

        if (STATE_DELTA_EVENT_TYPES.has(event.type)) {
          const part = toStateDeltaPart(event);
          if (part) stateDeltas.push(part);
        }

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

    // D5: a turn that errored with zero output text produced nothing worth
    // replaying — recording it would feed a phantom empty assistant turn
    // back into every subsequent `_toMessageHistory()` call. Skip the
    // Exchange build/push/persist entirely and revert the `_exchangeCount`
    // bump from above so numbering stays dense. Partial-text errored turns
    // (fullResponse !== "") keep recording — the user saw those tokens.
    if (error !== undefined && fullResponse === "") {
      this._exchangeCount -= 1;
    } else {
      const exchange: Exchange = {
        number: this._exchangeCount,
        invocationId,
        user: message,
        assistant: fullResponse,
        toolCalls: [],
        inputTokens: totalInput,
        outputTokens: totalOutput,
        timestamp: new Date(),
        runId: capturedRunId,
      };

      this._history.push(exchange);

      if (this._store) {
        await this._persistExchange(exchange, stateDeltas);
      }
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
      host: this._host,
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
   *
   * `stateDeltas` (#226, `stream()` only — `send()` has no event stream to
   * capture them from) are written as `state_delta` parts BEFORE the terminal
   * `text` part, mirroring run order: the frames happened during the run, the
   * answer text is terminal. Readers without a `state_delta` case degrade to
   * labeled text via their unknown-type default (the dashboard's
   * `stored-parts.ts` contract) — the parts never crash an old reader.
   */
  private async _persistExchange(
    exchange: Exchange,
    stateDeltas?: readonly StateDeltaPart[],
  ): Promise<void> {
    if (!this._store) return;

    if (!this._storeConversationId) {
      const conv = await this._store.createConversation(
        this.agent.role.name,
        this.agent.getModel() ?? "",
      );
      this._storeConversationId = conv.id;
    }

    await this._store.addMessage(
      this._storeConversationId,
      "request",
      [{ type: "user_prompt", content: exchange.user }],
      { runId: exchange.runId },
    );

    await this._store.addMessage(
      this._storeConversationId,
      "response",
      [...(stateDeltas ?? []), { type: "text", content: exchange.assistant }],
      {
        runId: exchange.runId,
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
// State-delta persistence (#226)
// ---------------------------------------------------------------------------

/** A `state_delta` stored part — `content` stays empty so message previews
 * (`derivePreviewContent`, `routes/conversations.ts`) never pick frames up. */
interface StateDeltaPart {
  readonly type: "state_delta";
  readonly metadata: Record<string, unknown>;
}

/** The state-delta event vocabulary persisted for replay (#226). */
const STATE_DELTA_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  "agent.backpack.drop",
  "agent.backpack.read",
  "agent.backpack.absorb",
  "agent.scratchpad.write",
  "agent.scratchpad.read",
  "agent.scratchpad.fork",
  "agent.scratchpad.join",
]);

/**
 * Map a state-delta event to its stored part: the canonical SSE wire payload
 * (snake_case, via `toSSEMapping` — persisted bytes == streamed bytes) plus
 * the wire event name under `event`.
 *
 * Redaction: an INNATE `agent.scratchpad.read` preview is the EXACT injected
 * prompt text (`sequential-agents.ts`'s prompt builder). Persisted replay
 * follows thinking's posture — reasoning content streams live but is never
 * stored — so the frame survives (key/ordinal/origin) while the text is
 * dropped, with an explicit `preview_redacted` marker (never silently).
 */
function toStateDeltaPart(event: AgentEvent): StateDeltaPart | null {
  const mapping = toSSEMapping(event);
  if (!mapping) return null;
  if (event.type === "agent.scratchpad.read" && event.origin === "innate") {
    const { preview: _redacted, ...rest } = mapping.payload;
    return {
      type: "state_delta",
      metadata: { event: mapping.name, ...rest, preview_redacted: true },
    };
  }
  return { type: "state_delta", metadata: { event: mapping.name, ...mapping.payload } };
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
