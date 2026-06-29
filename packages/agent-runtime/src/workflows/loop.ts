/**
 * `Loop<TState>` — repeat a body until a predicate on its typed output holds
 * (DESIGN §6.6, Open-Q2 §8.2).
 *
 * `state = input`; loop: `state = (await body.run(state)).output`; if
 * `until(state, i)` → exit `predicate_met`; if `i + 1 >= maxIterations` → exit
 * `max_iterations` returning the LAST state. On cap-hit `succeeded` stays `true`
 * (it produced a usable value) — the caller branches on `exitReason`. No
 * scoring knob. Replaces the four deleted loop classes.
 */

import type { PatternHooks } from "./base.js";
import type { Node, NodeResult, NodeRunContext } from "./node.js";
import { createSlotStore } from "./slot.js";

// ---------------------------------------------------------------------------
// Spec + result
// ---------------------------------------------------------------------------

export interface LoopSpec<TState> {
  readonly name?: string;
  /** The repeated body; its output feeds the next iteration's input. */
  readonly body: Node<TState, TState>;
  readonly until: (output: TState, iteration: number) => boolean;
  /** REQUIRED safety cap. */
  readonly maxIterations: number;
}

export type LoopExitReason = "predicate_met" | "max_iterations";

export interface LoopResult<TState> extends NodeResult<TState> {
  readonly iterations: number;
  readonly exitReason: LoopExitReason;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export class Loop<TState> implements Node<TState, TState> {
  readonly name?: string;

  constructor(private readonly spec: LoopSpec<TState>) {
    if (!Number.isInteger(spec.maxIterations) || spec.maxIterations < 1) {
      throw new Error("Loop requires a positive integer `maxIterations`.");
    }
    this.name = spec.name;
  }

  async run(input: TState, ctx: NodeRunContext): Promise<LoopResult<TState>> {
    const hooks: PatternHooks | undefined = ctx.hooks;
    const patternName = this.name ?? "Loop";
    const childCtx: NodeRunContext = { ...ctx, slots: ctx.slots ?? createSlotStore() };

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName,
      timestamp: new Date(),
    });

    let state: TState = input;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let succeeded = true;
    let error: Error | undefined;
    let iterations = 0;
    let exitReason: LoopExitReason = "max_iterations";

    for (let i = 0; i < this.spec.maxIterations; i++) {
      iterations = i + 1;

      await hooks?.onIterationStart?.({
        type: "pattern.iteration.start",
        iteration: i,
        timestamp: new Date(),
      });

      const res = await this.spec.body.run(state, childCtx);
      totalInputTokens += res.totalInputTokens;
      totalOutputTokens += res.totalOutputTokens;
      state = res.output;
      if (!res.succeeded) {
        succeeded = false;
        error = res.error;
      }

      await hooks?.onIterationComplete?.({
        type: "pattern.iteration.complete",
        iteration: i,
        timestamp: new Date(),
      });

      if (this.spec.until(state, i)) {
        exitReason = "predicate_met";
        break;
      }
    }

    const result: LoopResult<TState> = Object.freeze({
      output: state,
      succeeded,
      error,
      totalInputTokens,
      totalOutputTokens,
      iterations,
      exitReason,
    });

    await hooks?.onPatternComplete?.({
      type: "pattern.complete",
      patternName,
      result,
      timestamp: new Date(),
    });

    return result;
  }
}
