/**
 * `Accumulate<TIn, TItem, TAcc>` — ONE step over a runtime list IN ORDER,
 * threading an accumulator (DESIGN §6.5).
 *
 * `acc = initial(input)`; for each item IN ORDER, `acc = (await step.run({ acc,
 * item, index })).output`; return the final `acc`. Sequential by construction —
 * there is deliberately NO `maxConcurrency` field, so nobody can set `>1` and
 * corrupt the fold. The threaded accumulator IS its consolidation.
 */

import type { PatternHooks } from "./base.js";
import type { Node, NodeOutcome, NodeResult, NodeRunContext } from "./node.js";
import { type SlotReader, createSlotStore } from "./slot.js";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export interface AccumulateStepInput<TItem, TAcc> {
  readonly acc: TAcc;
  readonly item: TItem;
  readonly index: number;
}

export interface AccumulateSpec<TIn, TItem, TAcc> {
  readonly name?: string;
  readonly over: (input: TIn, slots: SlotReader) => readonly TItem[];
  readonly initial: (input: TIn) => TAcc;
  /** For EACH item, read prior accumulator + item → next accumulator. */
  readonly step: Node<AccumulateStepInput<TItem, TAcc>, TAcc>;
}

// ---------------------------------------------------------------------------
// Accumulate
// ---------------------------------------------------------------------------

export class Accumulate<TIn, TItem, TAcc> implements Node<TIn, TAcc> {
  readonly name?: string;

  constructor(private readonly spec: AccumulateSpec<TIn, TItem, TAcc>) {
    this.name = spec.name;
  }

  async run(input: TIn, ctx: NodeRunContext): Promise<NodeResult<TAcc>> {
    const hooks: PatternHooks | undefined = ctx.hooks;
    const patternName = this.name ?? "Accumulate";
    const childCtx: NodeRunContext = { ...ctx, slots: ctx.slots ?? createSlotStore() };

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName,
      timestamp: new Date(),
    });

    const items = this.spec.over(input, childCtx.slots!.reader());
    let acc: TAcc = this.spec.initial(input);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let succeeded = true;
    let error: Error | undefined;

    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      const stepName = `${this.spec.step.name ?? "fold"}_${index}`;

      await hooks?.onStepStart?.({
        type: "pattern.step.start",
        stepName,
        stepIndex: index,
        timestamp: new Date(),
      });

      const res = await this.spec.step.run({ acc, item, index }, childCtx);
      totalInputTokens += res.totalInputTokens;
      totalOutputTokens += res.totalOutputTokens;
      acc = res.output;

      if (res.succeeded) {
        const outcome: NodeOutcome<unknown> = {
          nodeName: stepName,
          output: res.output,
          succeeded: true,
          inputTokens: res.totalInputTokens,
          outputTokens: res.totalOutputTokens,
        };
        await hooks?.onStepComplete?.({
          type: "pattern.step.complete",
          stepName,
          stepIndex: index,
          result: outcome,
          timestamp: new Date(),
        });
      } else {
        // Order-dependent fold: a failed step stops the accumulation.
        succeeded = false;
        error = res.error;
        await hooks?.onStepError?.({
          type: "pattern.step.error",
          stepName,
          stepIndex: index,
          error: res.error ?? new Error(`Accumulate step ${index} failed`),
          timestamp: new Date(),
        });
        break;
      }
    }

    const result: NodeResult<TAcc> = Object.freeze({
      output: acc,
      succeeded,
      error,
      totalInputTokens,
      totalOutputTokens,
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
