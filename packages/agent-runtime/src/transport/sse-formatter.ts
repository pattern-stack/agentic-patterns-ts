/**
 * SSE (Server-Sent Events) formatter for agent events.
 *
 * Converts internal AgentEvent types to SSE-formatted strings for streaming
 * to clients over HTTP. Maps all 20 canonical events via a single typed
 * discriminated-union switch (`toSSEMapping`) so event name, payload, and
 * exhaustiveness live in one place.
 */

import type { AgentEvent, AgentEventType } from "../events/types.js";

// ---------------------------------------------------------------------------
// Canonical wire event names (string union)
// ---------------------------------------------------------------------------

/**
 * Client-facing SSE event name. Matches the 20 canonical events defined in
 * the admin-observability spec. Used anywhere an SSE frame is produced so
 * the compiler catches typos like `"thinking.complete"` vs `"thinking"`.
 */
export type SSEEventName =
  | "conversation.start"
  | "conversation.end"
  | "message.start"
  | "message.delta"
  | "message.complete"
  | "message.cancel"
  | "thinking.start"
  | "thinking"
  | "thinking.complete"
  | "tool.intent"
  | "tool.start"
  | "tool.progress"
  | "tool.end"
  | "tool.rejected"
  | "iteration.start"
  | "iteration.end"
  | "llm.start"
  | "llm.end"
  | "error"
  | "claude_code.hook"
  | "done";

/** Result of mapping an AgentEvent to its canonical SSE shape. */
export interface SSEMapping {
  readonly name: SSEEventName;
  readonly payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Single source of truth — event -> wire name + payload
// ---------------------------------------------------------------------------

/**
 * Map an `AgentEvent` to its canonical SSE wire name and payload. The
 * discriminated-union switch narrows `event` automatically so field access
 * is fully typed without casts. The `never` default is a compile-time
 * exhaustiveness check — adding a new variant to `AgentEvent` fails
 * typechecking here until a branch is added.
 *
 * Returns `null` only when a non-AgentEvent slips through at runtime
 * (e.g., a hand-constructed event with an unrecognised `type`).
 */
export function toSSEMapping(event: AgentEvent): SSEMapping | null {
  switch (event.type) {
    case "agent.conversation.start":
      return {
        name: "conversation.start",
        payload: { conversation_id: event.conversationId, agent_name: event.agentName },
      };
    case "agent.conversation.end":
      return {
        name: "conversation.end",
        payload: { conversation_id: event.conversationId, reason: event.reason },
      };
    case "agent.message.start":
      return { name: "message.start", payload: { agent_name: event.agentName } };
    case "agent.message.chunk":
      return {
        name: "message.delta",
        payload: { delta: event.delta, chunk_index: event.chunkIndex },
      };
    case "agent.message.complete":
      return {
        name: "message.complete",
        payload: {
          content: event.content,
          input_tokens: event.inputTokens,
          output_tokens: event.outputTokens,
          model: event.model,
        },
      };
    case "agent.message.cancel":
      return { name: "message.cancel", payload: { reason: event.reason } };
    case "agent.thinking.start":
      return { name: "thinking.start", payload: {} };
    case "agent.reasoning":
      return {
        name: event.isComplete ? "thinking.complete" : "thinking",
        payload: { content: event.content },
      };
    case "agent.tool.intent":
      return {
        name: "tool.intent",
        payload: {
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          arguments: event.arguments,
        },
      };
    case "agent.tool.start":
      return {
        name: "tool.start",
        payload: {
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          arguments: event.arguments,
        },
      };
    case "agent.tool.progress":
      return {
        name: "tool.progress",
        payload: {
          tool_call_id: event.toolCallId,
          progress: event.progress,
          status_text: event.statusText,
        },
      };
    case "agent.tool.end": {
      const payload: Record<string, unknown> = {
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        result: event.result,
        duration_ms: event.durationMs,
      };
      if (event.error !== undefined) payload.error = event.error;
      return { name: "tool.end", payload };
    }
    case "agent.tool.rejected":
      return {
        name: "tool.rejected",
        payload: {
          tool_name: event.toolName,
          reason: event.reason,
          gate_name: event.gateName,
        },
      };
    case "agent.iteration.start":
      return {
        name: "iteration.start",
        payload: { iteration: event.iteration, max_iterations: event.maxIterations },
      };
    case "agent.iteration.end":
      return {
        name: "iteration.end",
        payload: {
          iteration: event.iteration,
          tool_calls_count: event.toolCallsCount,
          has_more: event.hasMore,
        },
      };
    case "agent.llm.start":
      return {
        name: "llm.start",
        payload: {
          model: event.model,
          message_count: event.messageCount,
          has_tools: event.hasTools,
        },
      };
    case "agent.llm.end":
      return {
        name: "llm.end",
        payload: {
          model: event.model,
          input_tokens: event.inputTokens,
          output_tokens: event.outputTokens,
          duration_ms: event.durationMs,
          finish_reason: event.finishReason,
        },
      };
    case "agent.error":
      return {
        name: "error",
        payload: {
          error_type: event.errorType,
          message: event.message,
          recoverable: event.recoverable,
        },
      };
    case "claude_code.hook":
      return {
        name: "claude_code.hook",
        payload: {
          hook_name: event.hookName,
          session_id: event.sessionId,
          cwd: event.cwd,
          tool_name: event.toolName,
          tool_input: event.toolInput,
          tool_response: event.toolResponse,
          tool_use_id: event.toolUseId,
          permission_mode: event.permissionMode,
          transcript_path: event.transcriptPath,
          runner_correlation_id: event.runnerCorrelationId,
          payload: event.payload,
        },
      };
    default: {
      // Exhaustiveness check — a new AgentEvent variant without a branch here
      // is a compile-time error.
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Derived: name map and payload extractor (thin wrappers around toSSEMapping)
// ---------------------------------------------------------------------------

/**
 * Map from internal `AgentEvent.type` to canonical SSE wire name. Useful
 * when a consumer only needs the name (routing, logging) and not the
 * payload. For `agent.reasoning` the default entry is `"thinking"`; the
 * `isComplete=true` variant produces `"thinking.complete"` via
 * `toSSEMapping` — consumers that care should use that directly.
 */
export const SSE_EVENT_NAMES: Readonly<Record<AgentEventType, SSEEventName>> = {
  "agent.conversation.start": "conversation.start",
  "agent.conversation.end": "conversation.end",
  "agent.message.start": "message.start",
  "agent.message.chunk": "message.delta",
  "agent.message.complete": "message.complete",
  "agent.message.cancel": "message.cancel",
  "agent.thinking.start": "thinking.start",
  "agent.reasoning": "thinking",
  "agent.tool.intent": "tool.intent",
  "agent.tool.start": "tool.start",
  "agent.tool.progress": "tool.progress",
  "agent.tool.end": "tool.end",
  "agent.tool.rejected": "tool.rejected",
  "agent.iteration.start": "iteration.start",
  "agent.iteration.end": "iteration.end",
  "agent.llm.start": "llm.start",
  "agent.llm.end": "llm.end",
  "agent.error": "error",
  "claude_code.hook": "claude_code.hook",
} as const;

// ---------------------------------------------------------------------------
// SSEFormatter class
// ---------------------------------------------------------------------------

/**
 * Formats `AgentEvent`s as SSE frames with canonical event names.
 *
 * Delegates all mapping to `toSSEMapping`; this class exists to carry the
 * trace-context enrichment (traceId + timestamp) onto the payload so the
 * runtime's admin SSE broadcast stays self-describing.
 */
export class SSEFormatter {
  /** Format an AgentEvent as an SSE frame string, or `null` if unmappable. */
  format(event: AgentEvent): string | null {
    const mapping = toSSEMapping(event);
    if (!mapping) return null;
    const enriched = {
      ...mapping.payload,
      traceId: event.traceId,
      timestamp: event.timestamp.toISOString(),
    };
    return `event: ${mapping.name}\ndata: ${JSON.stringify(enriched)}\n\n`;
  }

  /**
   * Extract the payload from an event using canonical snake_case field
   * names. Static so StdioAdapter and other consumers can reuse it without
   * instantiating a formatter. Returns `null` if the event has no mapping.
   */
  static extractPayload(event: AgentEvent): Record<string, unknown> | null {
    return toSSEMapping(event)?.payload ?? null;
  }

  /** Format a stream-terminator "done" event. */
  static formatDone(): string {
    return "event: done\ndata: {}\n\n";
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible function API
// ---------------------------------------------------------------------------

const _defaultFormatter = new SSEFormatter();

/**
 * Format an AgentEvent as an SSE frame string.
 *
 * @deprecated Use `new SSEFormatter().format(event)` instead.
 */
export function formatSSE(event: AgentEvent): string | null {
  return _defaultFormatter.format(event);
}
