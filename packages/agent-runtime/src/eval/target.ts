/**
 * Target adapter — `resolveEvalTarget` (spec § Key finding, § Approach step 3).
 *
 * The one place the three eval targets converge: a bare `Node<TIn,TOut>`, a bare
 * `Agent`/`AgentLike`, and an `asAgent`-promoted pipeline are all reducible to a
 * `Node<TIn,TOut>` — possible only because #97 (`asAgent`) closed composition.
 *
 * Reuses `isPromotedAgent` from `workflows/as-agent.ts`; defines local
 * `isNodeShape`/`isAgentLikeShape` duck-type guards (bundle-proof — `instanceof`
 * is unreliable across the built-`dist/` boundary), same rationale as
 * `agent-cli/src/helpers/discover.ts`'s `isAgentShape`.
 *
 * ADDITIVE: new file.
 */

import type { AgentLike } from "../runner/agent-runner.js";
import { AgentStep } from "../workflows/agent-step.js";
import { type PromotedAgent, isPromotedAgent } from "../workflows/as-agent.js";
import type { Node } from "../workflows/node.js";
import type { EvalTargetKind } from "./types.js";

export type { EvalTargetKind } from "./types.js";

export type EvalTarget<TIn, TOut> = Node<TIn, TOut> | AgentLike | PromotedAgent<TIn, TOut>;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** A `Node`-shaped value: has a `.run` function. Checked AFTER `isPromotedAgent`. */
export function isNodeShape(x: unknown): x is Node<unknown, unknown> {
  if (!x || typeof x !== "object") return false;
  return typeof (x as Record<string, unknown>).run === "function";
}

/**
 * `AgentLike` duck-type — `role.name` + the runner-facing render/model methods.
 * Bundle-proof: does NOT use `instanceof` (unreliable across the built-`dist/`
 * boundary, same rationale as `discover.ts`'s `isAgentShape`).
 */
export function isAgentLikeShape(x: unknown): x is AgentLike {
  if (!x || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  const role = a.role as Record<string, unknown> | undefined;
  return (
    typeof role === "object" &&
    role !== null &&
    typeof role.name === "string" &&
    typeof a.getModel === "function" &&
    typeof a.getSystemPrompt === "function" &&
    typeof a.renderInitialPrompt === "function"
  );
}

// ---------------------------------------------------------------------------
// resolveEvalTarget
// ---------------------------------------------------------------------------

/**
 * Reduce any target to a `Node<TIn,TOut>`. The one place the three paths converge.
 *
 * Detection order matters: a `PromotedAgent` is ALSO `AgentLike`-shaped (it carries
 * `role`/`getModel`/etc. so the runner treats it as an agent), so `isPromotedAgent`
 * is checked first. A bare `Node` has no `role`, so `isNodeShape` cannot false-match
 * an `AgentLike`.
 */
export function resolveEvalTarget<TIn, TOut>(
  target: EvalTarget<TIn, TOut>,
): { readonly node: Node<TIn, TOut>; readonly kind: EvalTargetKind } {
  if (isPromotedAgent(target)) {
    return { node: target.__promotedNode as Node<TIn, TOut>, kind: "promoted" };
  }
  if (isNodeShape(target)) {
    return { node: target as Node<TIn, TOut>, kind: "node" };
  }
  if (isAgentLikeShape(target)) {
    // Bare-Agent adapter is string-in only in v1 (spec § Decisions #3 / Open
    // questions): wrap in the existing AgentStep bridge with `prompt: (i) =>
    // String(i)`. A non-string TIn agent eval needs a custom prompt builder —
    // deferred (`promptFor?` extension, not v1).
    const node = new AgentStep<string, string>({
      name: target.role.name,
      agent: target,
      prompt: (input) => String(input),
    });
    return { node: node as unknown as Node<TIn, TOut>, kind: "agent" };
  }
  throw new Error(
    "resolveEvalTarget: target is neither a Node, AgentLike, nor PromotedAgent (see EvalTarget).",
  );
}
