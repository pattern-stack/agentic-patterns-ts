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
  | {
      name: "input.request";
      data: {
        correlation_id: string;
        kind: "approval" | "select" | "text";
        prompt: string;
        options?: string[];
        tool_name?: string;
        tool_call_id?: string;
        arguments?: unknown;
      };
    }
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
      name: "step.start";
      data: {
        span_id: string;
        parent_span_id?: string;
        step_name: string;
        agent_name?: string;
        arguments: unknown;
      };
    }
  | {
      name: "step.end";
      data: {
        span_id: string;
        parent_span_id?: string;
        step_name: string;
        agent_name?: string;
        arguments: unknown;
        result: unknown;
        duration_ms: number;
        error?: string;
      };
    }
  | {
      name: "error";
      data: { error_type: string; message: string; recoverable: boolean };
    }
  | { name: "done"; data: Record<string, never> };

export type ClientEventName = ClientEvent["name"];

/**
 * A decoded SSE frame: an event `name` + its JSON `data`, with NO name allowlist.
 *
 * Deliberately permissive. The transport (`chat-client.parseFrame`) is a dumb
 * decoder — it never drops a frame by name; the reducer (`applyParts` in
 * chat/model.ts) is the SINGLE authority on what renders, folding the events it
 * knows and ignoring the rest. An allowlist HERE was the footgun that silently
 * ate `agent.step.*` (steps ran server-side but never reached the chat). Keeping
 * the parser dumb means a new server event can never again vanish in transit —
 * it flows to the reducer, which renders it or ignores it, but never drops it
 * invisibly. `ClientEvent` above remains the typed documentation of KNOWN
 * payload shapes; it is not a gate.
 */
export interface WireFrame {
  name: string;
  data: Record<string, unknown>;
}
