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
  | IterationStartEvent
  | IterationEndEvent
  | LLMCallStartEvent
  | LLMCallEndEvent
  | ErrorEvent
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
