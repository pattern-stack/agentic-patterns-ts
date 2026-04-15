/**
 * SSE formatting for Hono streaming.
 *
 * Converts AgentEvents to `{ event, data }` objects compatible with Hono's
 * streamSSE writeSSE() method.
 *
 * Delegates wire-name and payload mapping to the runtime's canonical
 * `toSSEMapping` so the server stays in sync with the 20-event vocabulary
 * defined in the spec. Only internal observability events (iteration.* and
 * llm.*) are filtered here — they remain available over the admin SSE
 * stream (SSEExporter) for operators.
 */

import type { AgentEvent, AgentEventType } from "@pattern-stack/agent-runtime";
import { toSSEMapping } from "@pattern-stack/agent-runtime";

/** SSE message shape for Hono's writeSSE(). */
export interface SSEMessage {
  event: string;
  data: string;
}

/**
 * Internal observability events not surfaced to end clients. They remain
 * available over the admin SSE stream for operators.
 */
const INTERNAL_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  "agent.iteration.start",
  "agent.iteration.end",
  "agent.llm.start",
  "agent.llm.end",
]);

/**
 * Convert an AgentEvent to an SSE message for Hono streaming.
 *
 * Returns `null` for events that are not part of the client-facing
 * protocol (internal observability events, or events with no SSE mapping).
 */
export function agentEventToSSE(event: AgentEvent): SSEMessage | null {
  if (INTERNAL_EVENT_TYPES.has(event.type)) return null;
  const mapping = toSSEMapping(event);
  if (!mapping) return null;
  return { event: mapping.name, data: JSON.stringify(mapping.payload) };
}
