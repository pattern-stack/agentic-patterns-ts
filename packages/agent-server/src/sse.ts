/**
 * SSE formatting for Hono streaming.
 *
 * Converts AgentEvents to `{ event, data }` objects compatible with Hono's
 * streamSSE writeSSE() method.
 *
 * Delegates wire-name and payload mapping to the runtime's canonical
 * `toSSEMapping` so the server stays in sync with the canonical event
 * vocabulary with zero changes here — new runtime events (e.g. the #226
 * `backpack.*`/`scratchpad.*` state deltas) flow through automatically.
 *
 * The FULL vocabulary is forwarded, including `iteration.*` and `llm.*`.
 * Those were previously filtered as "internal observability" — which starved
 * the dashboard's chat trace rail of its model-call steps (durations, ctx/out
 * tokens, iteration grouping) while the very same events flowed to SQLite and
 * the admin stream. The chat client's reducer is the single authority on what
 * renders (`sse-events.ts` WireFrame doc) — curation belongs there, not in
 * transit.
 */

import type { AgentEvent } from "@agentic-patterns/runtime";
import { toSSEMapping } from "@agentic-patterns/runtime";

/** SSE message shape for Hono's writeSSE(). */
export interface SSEMessage {
  event: string;
  data: string;
}

/**
 * Convert an AgentEvent to an SSE message for Hono streaming.
 *
 * Returns `null` for events with no SSE mapping (a non-AgentEvent that
 * slips through at runtime).
 */
export function agentEventToSSE(event: AgentEvent): SSEMessage | null {
  const mapping = toSSEMapping(event);
  if (!mapping) return null;
  return { event: mapping.name, data: JSON.stringify(mapping.payload) };
}
