/**
 * AgentRegistry — the runtime-tier "named agent" protocol (#437 M2).
 *
 * Before this, agent identity lived only ABOVE the runtime: the CLI's
 * discovery (`DiscoveredAgent.id`) and the server's `AgentRegistration.id`
 * both know `dealbrain/pm`; the runtime knew nothing but `role.name`. A
 * daemon-tier caller (`runFromTrigger`, M3's AgencyHost) cannot import
 * either, so the runtime defines the minimal structural protocol and the
 * hosts adapt to it — the same posture as `ToolExecutor`, `ConversationStore`,
 * and `SessionScopeLike` (duck-typed; never `instanceof` across the dist
 * boundary).
 *
 * `resolve` is the load-bearing method and it carries the ADR-0004 delivered-
 * instance contract: an implementation MUST validate the scope against the
 * registration's declared `SessionScope` (`scope.parse`) and go through the
 * registration's `instantiate` seam — never hand back the declared agent
 * with a pinned scope (#268's bug class, still live in `POST /eval/runs`).
 */

import type { AgentLike } from "../runner/types.js";

/** A registry row — what a caller can list and address. */
export interface AgentRef {
  /** The registration id (`dealbrain/pm`) — the canonical "named agent" handle. */
  readonly id: string;
  /** Human-facing name. */
  readonly name: string;
  readonly description?: string;
}

/**
 * Minimal registry protocol: enumerate agents, and resolve a name + scope to
 * a runnable instance. Implemented by hosts over whatever registration store
 * they own (the server's `AgentRegistration[]`, the CLI's `DiscoveredAgent[]`,
 * an app's DB rows — swe-brain's `agent_definitions` loader is exactly this
 * shape already).
 */
export interface AgentRegistry {
  list(): readonly AgentRef[];
  /**
   * `id` + optional raw scope → a runnable agent. Contract: parse the scope
   * against the registration's declared schema (reject, don't coerce), then
   * instantiate through the registration's own seam. Reject unknown ids.
   */
  resolve(id: string, scope?: Record<string, unknown>): Promise<AgentLike>;
}
