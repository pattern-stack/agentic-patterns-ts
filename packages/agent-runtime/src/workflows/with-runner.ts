/**
 * `withRunner` — declare a whole subtree's runner override (#116).
 *
 * ADDITIVE: new file. Does not touch `Node`/`NodeRunContext`.
 */

import type { RunnerProtocol } from "../runner/types.js";
import type { Node, NodeResult, NodeRunContext } from "./node.js";

/**
 * Run a whole subtree on a specific runner — the declared form of the
 * `{ ...ctx, runner }` closure hack. Transparent by DEFAULT: the wrapper
 * exposes the inner node's name (hooks/events attribute to the real node) and
 * passes the result through untouched. Pass `{ name }` to label the wrapper
 * instead, making the override boundary visible in `NodeOutcome.nodeName` /
 * hooks. Precedence: a leaf's own `spec.runner` still wins inside the
 * subtree; nesting `withRunner` lets the innermost wrapper win. Does NOT
 * cross the agent-as-tool seam (a NodeToolbox keeps its construction-time
 * runner — #124 threads scratchpad/deps only).
 */
export function withRunner<TIn, TOut>(
  inner: Node<TIn, TOut>,
  runner: RunnerProtocol,
  opts?: { name?: string },
): Node<TIn, TOut> {
  return {
    name: opts?.name ?? inner.name,
    run: (input: TIn, ctx: NodeRunContext): Promise<NodeResult<TOut>> =>
      inner.run(input, { ...ctx, runner }),
  };
}
