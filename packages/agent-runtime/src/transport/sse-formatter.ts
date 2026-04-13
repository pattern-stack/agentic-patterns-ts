/**
 * SSE (Server-Sent Events) formatter for agent events.
 *
 * Converts internal AgentEvent types to SSE-formatted strings
 * for streaming to clients over HTTP. Maps all 20 canonical events.
 */

import type {
  AgentEvent,
  AgentEventType,
  ConversationEndEvent,
  ConversationStartEvent,
  ErrorEvent,
  IterationEndEvent,
  IterationStartEvent,
  LLMCallEndEvent,
  LLMCallStartEvent,
  MessageCancelEvent,
  MessageChunkEvent,
  MessageCompleteEvent,
  MessageStartEvent,
  ReasoningEvent,
  ToolCallEndEvent,
  ToolCallIntent,
  ToolCallRejectedEvent,
  ToolCallStartEvent,
  ToolProgressEvent,
} from "../events/types.js";

// ---------------------------------------------------------------------------
// Event name mapping
// ---------------------------------------------------------------------------

/** Maps internal event types to SSE event names. */
export const SSE_EVENT_NAMES: Partial<Readonly<Record<AgentEventType, string>>> = {
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
} as const;

// ---------------------------------------------------------------------------
// SSEFormatter class
// ---------------------------------------------------------------------------

/**
 * Formats AgentEvents as SSE frames with canonical event names.
 *
 * All 20 canonical events are supported. The reasoning event
 * maps to either "thinking" or "thinking.complete" based on isComplete.
 */
export class SSEFormatter {
  /**
   * Format an AgentEvent as an SSE frame string.
   * Returns `null` for events that have no SSE mapping.
   */
  format(event: AgentEvent): string | null {
    let eventName = SSE_EVENT_NAMES[event.type];
    if (!eventName) return null;

    // Special case: reasoning with isComplete maps to thinking.complete
    if (event.type === "agent.reasoning" && (event as ReasoningEvent).isComplete) {
      eventName = "thinking.complete";
    }

    const data = SSEFormatter.extractPayload(event);
    if (!data) return null;

    // Include trace context in every payload
    data.traceId = event.traceId;
    data.timestamp = event.timestamp.toISOString();

    return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /**
   * Extract the payload from an event using canonical snake_case field names.
   * Static so StdioAdapter and other consumers can reuse.
   */
  static extractPayload(event: AgentEvent): Record<string, unknown> | null {
    switch (event.type) {
      case "agent.conversation.start": {
        const e = event as ConversationStartEvent;
        return { conversation_id: e.conversationId, agent_name: e.agentName };
      }
      case "agent.conversation.end": {
        const e = event as ConversationEndEvent;
        return { conversation_id: e.conversationId, reason: e.reason };
      }
      case "agent.message.start": {
        const e = event as MessageStartEvent;
        return { agent_name: e.agentName };
      }
      case "agent.message.chunk": {
        const e = event as MessageChunkEvent;
        return { delta: e.delta, chunk_index: e.chunkIndex };
      }
      case "agent.message.complete": {
        const e = event as MessageCompleteEvent;
        return {
          content: e.content,
          input_tokens: e.inputTokens,
          output_tokens: e.outputTokens,
          model: e.model,
        };
      }
      case "agent.message.cancel": {
        const e = event as MessageCancelEvent;
        return { reason: e.reason };
      }
      case "agent.thinking.start": {
        return {};
      }
      case "agent.reasoning": {
        const e = event as ReasoningEvent;
        return { content: e.content };
      }
      case "agent.tool.intent": {
        const e = event as ToolCallIntent;
        return {
          tool_call_id: e.toolCallId,
          tool_name: e.toolName,
          arguments: e.arguments,
        };
      }
      case "agent.tool.start": {
        const e = event as ToolCallStartEvent;
        return {
          tool_call_id: e.toolCallId,
          tool_name: e.toolName,
          arguments: e.arguments,
        };
      }
      case "agent.tool.progress": {
        const e = event as ToolProgressEvent;
        return {
          tool_call_id: e.toolCallId,
          progress: e.progress,
          status_text: e.statusText,
        };
      }
      case "agent.tool.end": {
        const e = event as ToolCallEndEvent;
        const data: Record<string, unknown> = {
          tool_call_id: e.toolCallId,
          tool_name: e.toolName,
          result: e.result,
          duration_ms: e.durationMs,
        };
        if (e.error !== undefined) {
          data.error = e.error;
        }
        return data;
      }
      case "agent.tool.rejected": {
        const e = event as ToolCallRejectedEvent;
        return {
          tool_name: e.toolName,
          reason: e.reason,
          gate_name: e.gateName,
        };
      }
      case "agent.iteration.start": {
        const e = event as IterationStartEvent;
        return { iteration: e.iteration, max_iterations: e.maxIterations };
      }
      case "agent.iteration.end": {
        const e = event as IterationEndEvent;
        return {
          iteration: e.iteration,
          tool_calls_count: e.toolCallsCount,
          has_more: e.hasMore,
        };
      }
      case "agent.llm.start": {
        const e = event as LLMCallStartEvent;
        return {
          model: e.model,
          message_count: e.messageCount,
          has_tools: e.hasTools,
        };
      }
      case "agent.llm.end": {
        const e = event as LLMCallEndEvent;
        return {
          model: e.model,
          input_tokens: e.inputTokens,
          output_tokens: e.outputTokens,
          duration_ms: e.durationMs,
          finish_reason: e.finishReason,
        };
      }
      case "agent.error": {
        const e = event as ErrorEvent;
        return {
          error_type: e.errorType,
          message: e.message,
          recoverable: e.recoverable,
        };
      }
      default:
        return null;
    }
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
