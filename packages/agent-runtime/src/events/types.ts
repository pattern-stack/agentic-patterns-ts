/**
 * Core event types for runner observability.
 *
 * All events use a discriminated union on the `type` field.
 * Trace fields (traceId, runId, spanId, parentSpanId, timestamp) on every event.
 */

import type { ClaudeCodeHookEvent } from "./claude-code.js";

/**
 * Generate a unique ID string.
 *
 * Uses crypto.randomUUID() when available (Node 19+, modern browsers),
 * falls back to a timestamp+counter approach.
 */
let _counter = 0;
function generateId(): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    // Safe to use: `crypto` is present at runtime in Node 19+ and browsers.
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Base event interface
// ---------------------------------------------------------------------------

export interface BaseEvent {
  readonly type: string;
  readonly traceId: string;
  readonly runId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly timestamp: Date;
}

// ---------------------------------------------------------------------------
// Message events
// ---------------------------------------------------------------------------

export interface MessageStartEvent extends BaseEvent {
  readonly type: "agent.message.start";
  readonly agentName: string;
  readonly agentConfig?: Record<string, unknown>;
  /** #117: the rendered system prompt (agent.renderInitialPrompt()) — no other event carries it. */
  readonly systemPrompt?: string;
}

export interface MessageChunkEvent extends BaseEvent {
  readonly type: "agent.message.chunk";
  readonly delta: string;
  readonly chunkIndex: number;
}

export interface MessageCompleteEvent extends BaseEvent {
  readonly type: "agent.message.complete";
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
  /** #117: authoritative run finish reason ("stop" | "max_iterations" | …). */
  readonly finishReason?: string;
}

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

export interface ReasoningEvent extends BaseEvent {
  readonly type: "agent.reasoning";
  readonly content: string;
  readonly isComplete: boolean;
}

// ---------------------------------------------------------------------------
// Tool call events
// ---------------------------------------------------------------------------

export interface ToolCallIntent extends BaseEvent {
  readonly type: "agent.tool.intent";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolCallRejectedEvent extends BaseEvent {
  readonly type: "agent.tool.rejected";
  readonly toolName: string;
  readonly reason: string;
  readonly gateName: string;
  readonly gateCategory: string;
  readonly originalIntent: ToolCallIntent;
}

export interface ToolCallStartEvent extends BaseEvent {
  readonly type: "agent.tool.start";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly parentEventId?: string;
}

export interface ToolCallEndEvent extends BaseEvent {
  readonly type: "agent.tool.end";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly result: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly resultTokens: number;
}

// ---------------------------------------------------------------------------
// Step / delegation events
// ---------------------------------------------------------------------------
// A promoted multi-step node (a pipeline promoted via `asAgent`) publishes one
// start/end pair per STAGE it delegates to a sub-agent — distinct from
// `agent.tool.*` (a tool the model calls). The transport renders a step as an
// AGENT delegation and nests any `agent.tool.*` the delegated agent makes under
// it (by `parentSpanId`). `arguments` is the stage INPUT, `result` the OUTPUT.

export interface StepStartEvent extends BaseEvent {
  readonly type: "agent.step.start";
  readonly stepName: string;
  /** The delegated sub-agent's display name, when known (e.g. "Retrieval Interpreter"). */
  readonly agentName?: string;
  /** The stage's input — the delegated agent's `run(input)`. */
  readonly arguments: Record<string, unknown>;
}

export interface StepEndEvent extends BaseEvent {
  readonly type: "agent.step.end";
  readonly stepName: string;
  readonly agentName?: string;
  readonly arguments: Record<string, unknown>;
  /** The stage's output — what the delegated agent returned. */
  readonly result: unknown;
  readonly error?: string;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Iteration events
// ---------------------------------------------------------------------------

export interface IterationStartEvent extends BaseEvent {
  readonly type: "agent.iteration.start";
  readonly iteration: number;
  readonly maxIterations: number;
}

export interface IterationEndEvent extends BaseEvent {
  readonly type: "agent.iteration.end";
  readonly iteration: number;
  readonly toolCallsCount: number;
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// LLM call events
// ---------------------------------------------------------------------------

export interface LLMCallStartEvent extends BaseEvent {
  readonly type: "agent.llm.start";
  readonly model: string;
  readonly messageCount: number;
  readonly hasTools: boolean;
}

export interface LLMCallEndEvent extends BaseEvent {
  readonly type: "agent.llm.end";
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly hasToolCalls: boolean;
  readonly finishReason: string;
}

// ---------------------------------------------------------------------------
// Conversation events
// ---------------------------------------------------------------------------

export interface ConversationStartEvent extends BaseEvent {
  readonly type: "agent.conversation.start";
  readonly conversationId: string;
  readonly agentName: string;
}

export interface ConversationEndEvent extends BaseEvent {
  readonly type: "agent.conversation.end";
  readonly conversationId: string;
  readonly reason: "completed" | "error" | "cancelled";
}

// ---------------------------------------------------------------------------
// Message cancel event
// ---------------------------------------------------------------------------

export interface MessageCancelEvent extends BaseEvent {
  readonly type: "agent.message.cancel";
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Thinking lifecycle events
// ---------------------------------------------------------------------------

export interface ThinkingStartEvent extends BaseEvent {
  readonly type: "agent.thinking.start";
}

// ---------------------------------------------------------------------------
// Tool progress event
// ---------------------------------------------------------------------------

export interface ToolProgressEvent extends BaseEvent {
  readonly type: "agent.tool.progress";
  readonly toolCallId: string;
  readonly progress?: number;
  readonly statusText?: string;
}

// ---------------------------------------------------------------------------
// Error event
// ---------------------------------------------------------------------------

export interface ErrorEvent extends BaseEvent {
  readonly type: "agent.error";
  readonly errorType: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly stackTrace?: string;
  readonly context: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// State-delta events (#226) — Backpack / Scratchpad mutations made visible.
// Published ONLY by the observed emission layer (`workflows/observed-*.ts`);
// a run with no event bus emits none of these. Payload previews are
// byte-capped AT CONSTRUCTION (512B/row, 2KB/frame, explicit "(preview only)"
// marker) — the formatter and every exporter pass them through verbatim.
// ---------------------------------------------------------------------------

/**
 * Who initiated a state mutation: `"innate"` = the framework's own machinery
 * (a sequentialAgent stage emission, a FanOut fork/join), `"explicit"` =
 * consumer code (a tool drop, an `onEmit` slot write, a custom prompt read).
 */
export type StateOrigin = "innate" | "explicit";

/** Fields shared by every state-delta event. */
export interface StateEventBase extends BaseEvent {
  readonly origin: StateOrigin;
  /**
   * Monotonic per-run state ordinal — ONE stream across backpack + scratchpad,
   * minted at the emission layer. Keys UI ordering, coalescing, and the rail's
   * delta animation.
   */
  readonly ordinal: number;
  /** The causing tool call, when the mutation happened inside a tool dispatch. */
  readonly toolCallId?: string;
}

/**
 * Per-BackpackSpec display metadata threaded verbatim onto `agent.backpack.*`
 * payloads (structural twin of `BackpackSpec.display` — the type is duplicated
 * so `backpack.ts` stays import-free and events stay a lower layer).
 */
export interface BackpackDisplay {
  readonly caption?: string;
  readonly attribution?: string;
}

/** One byte-capped row preview in a {@link BackpackDropEvent}. */
export interface BackpackRowPreview {
  /** Canonical 1-based [#N] index (append-only, never renumbered). */
  readonly index: number;
  /** How this drop touched the row: net-new identity vs folded into an existing one. */
  readonly op: "added" | "merged";
  readonly preview: string;
}

export interface BackpackDropEvent extends StateEventBase {
  readonly type: "agent.backpack.drop";
  /** The pack's slot key (`backpack.<spec.key>`) — the mono join key across UI surfaces. */
  readonly key: string;
  /** New identities (mirrors `DropReceipt.accepted`). */
  readonly accepted: number;
  /** Re-dropped identities folded via merge (mirrors `DropReceipt.merged`). */
  readonly merged: number;
  /** Raws skipped by `expand()` (mirrors `DropReceipt.skipped`). */
  readonly skipped: number;
  /** Canonical [#N] indexes touched, raw order, skips omitted (mirrors `DropReceipt.indexes`). */
  readonly indexes: readonly number[];
  readonly sizeBefore: number;
  readonly sizeAfter: number;
  /** Byte-capped per-row previews of touched entries (512B/row, 2KB/frame total). */
  readonly previews: readonly BackpackRowPreview[];
  /** Rows left out of `previews` by the per-frame preview budget — never silently clipped. */
  readonly previewsOmitted: number;
  /** Byte-capped preview of the caller-supplied drop tag, when one was given. */
  readonly tag?: string;
  readonly display?: BackpackDisplay;
}

export interface BackpackReadEvent extends StateEventBase {
  readonly type: "agent.backpack.read";
  readonly key: string;
  /** True when `finalized()` was served from the per-write-generation memo. */
  readonly memoHit: boolean;
  /** Pack size at read time. */
  readonly size: number;
  /** Byte-capped preview of the finalized value. */
  readonly preview: string;
  readonly display?: BackpackDisplay;
}

export interface BackpackAbsorbEvent extends StateEventBase {
  readonly type: "agent.backpack.absorb";
  readonly key: string;
  /** Entries in the absorbed (child) pack. */
  readonly childSize: number;
  /** New identities appended to the parent by this absorb. */
  readonly accepted: number;
  /** Identities folded into existing parent entries. */
  readonly merged: number;
  readonly sizeBefore: number;
  readonly sizeAfter: number;
  /** Canonical [#N] indexes appended by this absorb (`sizeBefore+1 .. sizeAfter`). */
  readonly appendedIndexes: readonly number[];
  readonly display?: BackpackDisplay;
}

export interface ScratchpadWriteEvent extends StateEventBase {
  readonly type: "agent.scratchpad.write";
  /** The slot key written (e.g. `agents.retrieve`, `brief.highlights`). */
  readonly key: string;
  readonly op: "set" | "update";
  /** True when the slot had been materialized before this write. */
  readonly hadValue: boolean;
  /** Byte-capped preview of the previous value; absent when `hadValue` is false. */
  readonly before?: string;
  /** Byte-capped preview of the new value. */
  readonly after: string;
}

export interface ScratchpadReadEvent extends StateEventBase {
  readonly type: "agent.scratchpad.read";
  readonly key: string;
  /** Byte-capped preview of the value read. */
  readonly preview: string;
}

export interface ScratchpadForkEvent extends StateEventBase {
  readonly type: "agent.scratchpad.fork";
  /** Run-scoped slot keys shared (by reference) into the fork at fork time. */
  readonly sharedKeys: readonly string[];
}

export interface ScratchpadJoinEvent extends StateEventBase {
  readonly type: "agent.scratchpad.join";
  /** Branch-scoped keys folded into the parent via their `Slot.merge` reducer. */
  readonly mergedKeys: readonly string[];
  /**
   * Branch-scoped keys DISCARDED at join (no merge reducer) — the classic
   * silent-loss debugging trap, made visible.
   */
  readonly discardedKeys: readonly string[];
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type AgentEvent =
  | ConversationStartEvent
  | ConversationEndEvent
  | MessageStartEvent
  | MessageChunkEvent
  | MessageCompleteEvent
  | MessageCancelEvent
  | ReasoningEvent
  | ThinkingStartEvent
  | ToolCallIntent
  | ToolCallRejectedEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | ToolProgressEvent
  | StepStartEvent
  | StepEndEvent
  | IterationStartEvent
  | IterationEndEvent
  | LLMCallStartEvent
  | LLMCallEndEvent
  | ErrorEvent
  | BackpackDropEvent
  | BackpackReadEvent
  | BackpackAbsorbEvent
  | ScratchpadWriteEvent
  | ScratchpadReadEvent
  | ScratchpadForkEvent
  | ScratchpadJoinEvent
  | ClaudeCodeHookEvent;

/** All possible agent event type strings. */
export type AgentEventType = AgentEvent["type"];

/** Subset of events for backward-compatible StreamEvent alias. */
export type StreamEvent =
  | ConversationStartEvent
  | ConversationEndEvent
  | MessageStartEvent
  | MessageChunkEvent
  | MessageCompleteEvent
  | MessageCancelEvent
  | ReasoningEvent
  | ThinkingStartEvent
  | ToolCallIntent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | ToolProgressEvent
  | IterationStartEvent
  | IterationEndEvent
  | LLMCallStartEvent
  | LLMCallEndEvent;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an event with auto-filled timestamp and optional spanId.
 *
 * @param type - The event type discriminant
 * @param data - Event fields (excluding type, timestamp; spanId optional)
 * @returns A fully-formed event
 */
export function createEvent<T extends AgentEventType>(
  type: T,
  data: Omit<Extract<AgentEvent, { type: T }>, "type" | "timestamp" | "spanId"> & {
    spanId?: string;
  },
): Extract<AgentEvent, { type: T }> {
  return {
    ...data,
    type,
    timestamp: new Date(),
    spanId: data.spanId ?? generateId(),
  } as Extract<AgentEvent, { type: T }>;
}
