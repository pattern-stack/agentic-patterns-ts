/**
 * SSE (Server-Sent Events) formatter for agent events.
 *
 * Converts internal AgentEvent types to SSE-formatted strings
 * for streaming to clients over HTTP.
 */

import type {
  AgentEvent,
  AgentEventType,
  ErrorEvent,
  MessageChunkEvent,
  MessageCompleteEvent,
  ReasoningEvent,
  ToolCallEndEvent,
  ToolCallRejectedEvent,
  ToolCallStartEvent,
} from "../events/types.js";

// ---------------------------------------------------------------------------
// Event name mapping
// ---------------------------------------------------------------------------

/** Maps internal event types to SSE event names. */
export const SSE_EVENT_NAMES: Partial<Readonly<Record<AgentEventType, string>>> = {
  "agent.message.chunk": "message.delta",
  "agent.message.complete": "message.complete",
  "agent.reasoning": "thinking",
  "agent.tool.start": "tool.start",
  "agent.tool.end": "tool.end",
  "agent.tool.rejected": "tool.rejected",
  "agent.error": "error",
} as const;

// ---------------------------------------------------------------------------
// Data payload extraction
// ---------------------------------------------------------------------------

function extractData(event: AgentEvent): Record<string, unknown> | null {
  switch (event.type) {
    case "agent.message.chunk": {
      const e = event as MessageChunkEvent;
      return { delta: e.delta, chunkIndex: e.chunkIndex };
    }
    case "agent.message.complete": {
      const e = event as MessageCompleteEvent;
      return {
        content: e.content,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        model: e.model,
      };
    }
    case "agent.reasoning": {
      const e = event as ReasoningEvent;
      return { content: e.content, isComplete: e.isComplete };
    }
    case "agent.tool.start": {
      const e = event as ToolCallStartEvent;
      return {
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        arguments: e.arguments,
      };
    }
    case "agent.tool.end": {
      const e = event as ToolCallEndEvent;
      const data: Record<string, unknown> = {
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        result: e.result,
        durationMs: e.durationMs,
      };
      if (e.error !== undefined) {
        data.error = e.error;
      }
      return data;
    }
    case "agent.tool.rejected": {
      const e = event as ToolCallRejectedEvent;
      return {
        toolName: e.toolName,
        reason: e.reason,
        gateName: e.gateName,
      };
    }
    case "agent.error": {
      const e = event as ErrorEvent;
      return {
        errorType: e.errorType,
        message: e.message,
        recoverable: e.recoverable,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format an AgentEvent as an SSE frame string.
 *
 * Returns `null` for events that are not part of the SSE protocol
 * (iteration, llm, intent, message.start events).
 */
export function formatSSE(event: AgentEvent): string | null {
  const eventName = SSE_EVENT_NAMES[event.type];
  if (!eventName) return null;

  const data = extractData(event);
  if (!data) return null;

  // Include trace context in every payload
  data.traceId = event.traceId;
  data.timestamp = event.timestamp.toISOString();

  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}
