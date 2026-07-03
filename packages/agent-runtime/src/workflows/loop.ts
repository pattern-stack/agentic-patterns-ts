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
import { createScratchpad } from "./slot.js";

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

export type LoopExitReason = "predicate_met" | "max_iterations" | "error";

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
    const childCtx: NodeRunContext = { ...ctx, scratchpad: ctx.scratchpad ?? createScratchpad() };

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

      if (!res.succeeded) {
        // Body failed — stop. Do NOT thread the failed (possibly undefined)
        // output forward or evaluate the predicate on it. `output` stays the
        // last good state; the caller branches on exitReason === "error".
        succeeded = false;
        error = res.error;
        exitReason = "error";
        await hooks?.onIterationComplete?.({
          type: "pattern.iteration.complete",
          iteration: i,
          timestamp: new Date(),
        });
        break;
      }

      state = res.output;

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

// ---------------------------------------------------------------------------
// AccumulatingLoop
// ---------------------------------------------------------------------------

/**
 * `AccumulatingLoop<TState, TAcc>` — `Loop` plus a typed accumulator seam
 * (DESIGN #101). A sibling combinator, NOT an overload of `Loop<TState>`:
 * the body must read `acc` (a second threaded channel), and the output type
 * flips from `TState` to `TAcc`. Co-located here to reuse `LoopExitReason`
 * and the loop family's iteration semantics; `Loop` itself is unchanged.
 *
 * Field order/naming echoes `Accumulate`'s `{ acc, item, index }` vocabulary
 * so the two fold primitives read as a matched pair (see spec §Positioning).
 */

/** Field order echoes `Accumulate`'s `AccumulateStepInput { acc, item, index }`. */
export interface AccumulatingLoopStepInput<TState, TAcc> {
  readonly acc: TAcc;
  /** Replaces `Accumulate`'s `item` — the threaded loop state, not a list draw. */
  readonly state: TState;
  /** Loop-family name for `Accumulate`'s `index`. */
  readonly iteration: number;
}

export interface AccumulatingLoopSpec<TState, TAcc> {
  readonly name?: string;
  /** Body reads BOTH the threaded state and the current accumulator. */
  readonly body: Node<AccumulatingLoopStepInput<TState, TAcc>, TState>;
  /** Seed the accumulator once from the loop input. */
  readonly initial: (input: TState) => TAcc;
  /** Fold this iteration's body output into the accumulator. MUST return a new value. */
  readonly fold: (acc: TAcc, output: TState, iteration: number) => TAcc;
  /** Continue-predicate — sees the folded accumulator, latest state, and iteration index. */
  readonly until: (acc: TAcc, state: TState, iteration: number) => boolean;
  /** REQUIRED safety cap (positive integer). */
  readonly maxIterations: number;
}

export interface AccumulatingLoopResult<TState, TAcc> extends NodeResult<TAcc> {
  /** `output` is the accumulator; `state` is the last body output, for callers who want it. */
  readonly state: TState;
  readonly iterations: number;
  /** Reused from `Loop` — same three exit reasons. */
  readonly exitReason: LoopExitReason;
}

export class AccumulatingLoop<TState, TAcc> implements Node<TState, TAcc> {
  readonly name?: string;

  constructor(private readonly spec: AccumulatingLoopSpec<TState, TAcc>) {
    if (!Number.isInteger(spec.maxIterations) || spec.maxIterations < 1) {
      throw new Error("AccumulatingLoop requires a positive integer `maxIterations`.");
    }
    this.name = spec.name;
  }

  async run(input: TState, ctx: NodeRunContext): Promise<AccumulatingLoopResult<TState, TAcc>> {
    const hooks: PatternHooks | undefined = ctx.hooks;
    const patternName = this.name ?? "AccumulatingLoop";
    const childCtx: NodeRunContext = { ...ctx, scratchpad: ctx.scratchpad ?? createScratchpad() };

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName,
      timestamp: new Date(),
    });

    let state: TState = input;
    let acc: TAcc = this.spec.initial(input);
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

      const res = await this.spec.body.run({ acc, state, iteration: i }, childCtx);
      totalInputTokens += res.totalInputTokens;
      totalOutputTokens += res.totalOutputTokens;

      if (!res.succeeded) {
        // Body failed — stop. Do NOT fold the failed output or evaluate the
        // predicate on it. `acc`/`state` stay LAST-GOOD (Loop parity).
        succeeded = false;
        error = res.error;
        exitReason = "error";
        await hooks?.onIterationComplete?.({
          type: "pattern.iteration.complete",
          iteration: i,
          timestamp: new Date(),
        });
        break;
      }

      state = res.output;
      acc = Object.freeze(this.spec.fold(acc, state, i));

      await hooks?.onIterationComplete?.({
        type: "pattern.iteration.complete",
        iteration: i,
        timestamp: new Date(),
      });

      if (this.spec.until(acc, state, i)) {
        exitReason = "predicate_met";
        break;
      }
    }

    const result: AccumulatingLoopResult<TState, TAcc> = Object.freeze({
      output: acc,
      state,
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
