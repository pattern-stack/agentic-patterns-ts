/**
 * SSE formatting for Hono streaming.
 *
 * Converts AgentEvents to { event, data } objects compatible
 * with Hono's streamSSE writeSSE() method.
 */

import type { AgentEvent } from "@agentic-patterns/runtime";

/**
 * SSE message shape for Hono's writeSSE().
 */
export interface SSEMessage {
  event: string;
  data: string;
}

/**
 * Convert an AgentEvent to an SSE message for Hono streaming.
 *
 * Returns null for internal events (iteration, llm, intent, message.start)
 * that are not part of the client-facing SSE protocol.
 */
export function agentEventToSSE(event: AgentEvent): SSEMessage | null {
  switch (event.type) {
    case "agent.message.chunk":
      return {
        event: "message.delta",
        data: JSON.stringify({ delta: event.delta }),
      };
    case "agent.message.complete":
      return {
        event: "message.complete",
        data: JSON.stringify({
          content: event.content,
          input_tokens: event.inputTokens,
          output_tokens: event.outputTokens,
        }),
      };
    case "agent.reasoning":
      return {
        event: "thinking",
        data: JSON.stringify({ content: event.content }),
      };
    case "agent.tool.start":
      return {
        event: "tool.start",
        data: JSON.stringify({
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          arguments: event.arguments,
        }),
      };
    case "agent.tool.end":
      return {
        event: "tool.end",
        data: JSON.stringify({
          tool_call_id: event.toolCallId,
          result: event.result,
          error: event.error ?? null,
          duration_ms: event.durationMs,
        }),
      };
    case "agent.tool.rejected":
      return {
        event: "tool.rejected",
        data: JSON.stringify({
          tool_name: event.toolName,
          reason: event.reason,
        }),
      };
    case "agent.error":
      return {
        event: "error",
        data: JSON.stringify({
          error_type: event.errorType,
          message: event.message,
        }),
      };
    default:
      return null;
  }
}
