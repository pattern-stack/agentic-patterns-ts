/**
 * Typed client-side view of the canonical SSE vocabulary emitted by
 * `@agentic-patterns/server` on `POST /conversations/:id/messages`.
 *
 * Mirrors the runtime's `SSEEventName` + `toSSEMapping` so the dashboard
 * can stay standalone (no workspace dep on runtime/server) while still
 * pattern-matching on typed event names and payloads. If a new event is
 * added to the runtime vocabulary, update the union here to match.
 */

export type ClientEvent =
  | { name: "conversation.start"; data: { conversation_id: string; agent_name: string } }
  | { name: "conversation.end"; data: { conversation_id: string; reason: string } }
  | { name: "message.start"; data: { agent_name: string } }
  | { name: "message.delta"; data: { delta: string; chunk_index: number } }
  | {
      name: "message.complete";
      data: {
        content: string;
        input_tokens: number;
        output_tokens: number;
        model: string;
      };
    }
  | { name: "message.cancel"; data: { reason: string } }
  | { name: "thinking.start"; data: Record<string, never> }
  | { name: "thinking"; data: { content: string } }
  | { name: "thinking.complete"; data: { content: string } }
  | {
      name: "tool.intent";
      data: { tool_call_id: string; tool_name: string; arguments: unknown };
    }
  | {
      name: "tool.start";
      data: { tool_call_id: string; tool_name: string; arguments: unknown };
    }
  | {
      name: "tool.progress";
      data: { tool_call_id: string; progress: number; status_text?: string };
    }
  | {
      name: "tool.end";
      data: {
        tool_call_id: string;
        tool_name: string;
        result: unknown;
        duration_ms: number;
        error?: string;
      };
    }
  | {
      name: "tool.rejected";
      data: { tool_name: string; reason: string; gate_name: string };
    }
  | {
      name: "error";
      data: { error_type: string; message: string; recoverable: boolean };
    }
  | { name: "done"; data: Record<string, never> };

export type ClientEventName = ClientEvent["name"];

/** Narrow helper so consumers can match-and-use without inline `as` casts. */
export function isClientEventName(name: string): name is ClientEventName {
  return (
    name === "conversation.start" ||
    name === "conversation.end" ||
    name === "message.start" ||
    name === "message.delta" ||
    name === "message.complete" ||
    name === "message.cancel" ||
    name === "thinking.start" ||
    name === "thinking" ||
    name === "thinking.complete" ||
    name === "tool.intent" ||
    name === "tool.start" ||
    name === "tool.progress" ||
    name === "tool.end" ||
    name === "tool.rejected" ||
    name === "error" ||
    name === "done"
  );
}
