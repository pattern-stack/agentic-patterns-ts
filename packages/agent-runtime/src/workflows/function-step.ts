/**
 * `FunctionStep<TIn, TOut>` — the deterministic leaf node (DESIGN §5.2).
 *
 * input → async fn → typed output, with NO LLM call. Genuinely new: deterministic
 * glue (data fetch, join, consolidation) that may read AND write slots via the
 * `SlotAccess` it receives — the canonical "consolidate into a Backpack slot" path.
 *
 * Failure contract is IDENTICAL to {@link AgentStep} (§5.3, Open-Q3): the leaf
 * ALWAYS catches and returns `{ succeeded: false, error }`; the composite decides
 * continue-vs-abort. Token counts are always zero (no model call).
 *
 * ADDITIVE: new file.
 */

import type { Node, NodeResult, NodeRunContext } from "./node.js";
import { type SlotAccess, createSlotStore } from "./slot.js";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export interface FunctionStepSpec<TIn, TOut> {
  readonly name?: string;
  /** Deterministic glue: data fetch, join, consolidation. May read/write slots. */
  readonly fn: (input: TIn, slots: SlotAccess, ctx: NodeRunContext) => TOut | Promise<TOut>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read/write slot view; an empty ephemeral store when the ctx carries no slots. */
function slotAccess(slots: NodeRunContext["slots"]): SlotAccess {
  return slots ?? createSlotStore();
}

// ---------------------------------------------------------------------------
// FunctionStep
// ---------------------------------------------------------------------------

export class FunctionStep<TIn, TOut> implements Node<TIn, TOut> {
  readonly name?: string;

  constructor(private readonly spec: FunctionStepSpec<TIn, TOut>) {
    this.name = spec.name;
  }

  async run(input: TIn, ctx: NodeRunContext): Promise<NodeResult<TOut>> {
    try {
      const output = await this.spec.fn(input, slotAccess(ctx.slots), ctx);
      return { output, succeeded: true, totalInputTokens: 0, totalOutputTokens: 0 };
    } catch (error) {
      return {
        output: undefined as TOut,
        succeeded: false,
        error: error as Error,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      };
    }
  }
}
