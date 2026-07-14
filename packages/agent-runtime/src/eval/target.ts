/**
 * Target adapter — `resolveEvalTarget` (spec § Key finding, § Approach step 3).
 *
 * The one place the three eval targets converge: a bare `Node<TIn,TOut>`, a bare
 * `Agent`/`AgentLike`, and an `asAgent`-promoted pipeline are all reducible to a
 * `Node<TIn,TOut>` — possible only because #97 (`asAgent`) closed composition.
 *
 * Reuses `isPromotedAgent` from `workflows/as-agent.ts` and the
 * `isNodeShape`/`isAgentLikeShape` duck-type guards from `workflows/shapes.ts`
 * (bundle-proof — `instanceof` is unreliable across the built-`dist/`
 * boundary), same rationale as `agent-cli/src/helpers/discover.ts`'s
 * `isAgentShape`. The guards MOVED to `workflows/` (where both shapes live and
 * where `sequentialAgent` discriminates them too) and are re-exported here, so
 * this module's public surface is unchanged.
 *
 * ADDITIVE: new file.
 */

import type { AgentLike } from "../runner/agent-runner.js";
import { AgentStep } from "../workflows/agent-step.js";
import { type PromotedAgent, isPromotedAgent } from "../workflows/as-agent.js";
import type { Node } from "../workflows/node.js";
import { isAgentLikeShape, isNodeShape } from "../workflows/shapes.js";
import type { EvalTargetKind } from "./types.js";

export type { EvalTargetKind } from "./types.js";
export { isAgentLikeShape, isNodeShape } from "../workflows/shapes.js";

export type EvalTarget<TIn, TOut> = Node<TIn, TOut> | AgentLike | PromotedAgent<TIn, TOut>;

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
    // questions): wrap in the existing AgentStep bridge. A non-string TIn
    // agent eval needs a custom prompt builder — deferred (`promptFor?`
    // extension, not v1). FAIL LOUD on non-string input rather than silently
    // stringifying an object to "[object Object]" (a poisoned, garbage eval
    // case that would otherwise look like a normal run).
    const node = new AgentStep<string, string>({
      name: target.role.name,
      agent: target,
      prompt: (input) => {
        if (typeof input !== "string") {
          throw new Error(
            `Eval agent target requires string input (got ${typeof input}); wrap non-string pipelines via asAgent or use a Node target.`,
          );
        }
        return input;
      },
    });
    return { node: node as unknown as Node<TIn, TOut>, kind: "agent" };
  }
  throw new Error(
    "resolveEvalTarget: target is neither a Node, AgentLike, nor PromotedAgent (see EvalTarget).",
  );
}
