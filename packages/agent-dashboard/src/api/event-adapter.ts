// event-adapter.ts — the ONE transport seam between the framework's named SSE
// vocabulary and the ported cockpit folds.
//
// The cockpit folds (`deriveChain` in graph/composition.ts, `eventsToSteps` in
// graph/trace-from-events.ts) all consume a flat `EventLike` shape:
// `{ type: string, ...payloadFields }`, where fields may be camelCase (live
// cockpit objects) OR snake_case (persisted rows). They tolerate both via their
// internal `str()` / `bareType()` accessors.
//
// The framework streams TYPED named SSE — `streamMessage` (api/chat-client.ts)
// yields `ClientEvent { name, data }` where `data` is the snake_case payload.
// The adapter flattens that into EventLike: `name` → `type`, and the payload is
// spread to the top level (so `tool_name`, `agent_name`, `delta`, `duration_ms`,
// `result`, `tool_call_id`, … land exactly where the fold accessors look first).
//
// This is the ENTIRE seam. All vocabulary deltas (message.delta vs message.chunk,
// bare vs `agent.`-prefixed names, missing iteration.*/llm.*) are fixed IN THE
// FOLDS, never hacked around here.

import type { EventLike } from "../graph/trace-from-events";
import type { ClientEvent } from "./sse-events";

/**
 * Flatten one typed framework SSE event into the flat `EventLike` the cockpit
 * folds expect. `ev.name` becomes `type`; the snake_case `ev.data` payload is
 * spread to the top level. Lossless and stateless — one event in, one out.
 *
 * Examples:
 *   { name: "tool.start",  data: { tool_call_id, tool_name, arguments } }
 *     -> { type: "tool.start",  tool_call_id, tool_name, arguments }
 *   { name: "message.start", data: { agent_name } }
 *     -> { type: "message.start", agent_name }
 *   { name: "message.delta", data: { delta, chunk_index } }
 *     -> { type: "message.delta", delta, chunk_index }
 */
export function toEventLike(ev: ClientEvent): EventLike {
  return { type: ev.name, ...ev.data };
}
