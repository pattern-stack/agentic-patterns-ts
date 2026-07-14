/**
 * Duck-type shape guards — `isNodeShape` / `isAgentLikeShape`.
 *
 * Bundle-proof: does NOT use `instanceof` (unreliable across the built-`dist/`
 * boundary — a consumer may hold a different copy of the class), same rationale
 * as `agent-cli/src/helpers/discover.ts`'s `isAgentShape`.
 *
 * Lives in `workflows/` because that is the layer that OWNS both shapes (`Node`,
 * `AgentLike`) and the layer that discriminates them at composition time
 * (`sequentialAgent`'s stages array). `eval/target.ts` — where these two guards
 * originally landed — re-exports them, so the public `@agentic-patterns/runtime`
 * surface is unchanged.
 */

import type { AgentLike } from "../runner/agent-runner.js";
import type { Node } from "./node.js";

/**
 * A `Node`-shaped value: has a `.run` function. Check AFTER `isPromotedAgent`
 * (a promoted pipeline is deliberately AgentLike-shaped) and, where both are
 * accepted, AFTER {@link isAgentLikeShape} — an agent that happens to carry a
 * `run` method must still seat as an agent.
 */
export function isNodeShape(x: unknown): x is Node<unknown, unknown> {
  if (!x || typeof x !== "object") return false;
  return typeof (x as Record<string, unknown>).run === "function";
}

/** `AgentLike` duck-type — `role.name` + the runner-facing render/model methods. */
export function isAgentLikeShape(x: unknown): x is AgentLike {
  if (!x || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  const role = a.role as Record<string, unknown> | undefined;
  return (
    typeof role === "object" &&
    role !== null &&
    typeof role.name === "string" &&
    typeof a.getModel === "function" &&
    typeof a.renderInitialPrompt === "function"
  );
}
