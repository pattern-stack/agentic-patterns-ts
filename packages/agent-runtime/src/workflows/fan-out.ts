/**
 * `FanOut<TIn, TItem, TOut, TConsolidated = TOut[]>` — ONE step over a RUNTIME
 * list, concurrently (DESIGN §6.4).
 *
 * Genuinely new: no map-over-data primitive exists in the legacy layer. Compute
 * `items = over(input, slots)`; run `step.run(item, branchCtx)` per item,
 * concurrently (bounded). Branches are INDEPENDENT — no item sees another's
 * output (that is `Accumulate`'s job); independence is what licenses
 * concurrency. Each branch gets a forked branch-scoped slot store (§7.3).
 * Outputs are collected in ITEM order; `consolidate` or `TOut[]`.
 */

import type { PatternHooks } from "./base.js";
import type { Consolidate } from "./consolidate.js";
import type { Node, NodeOutcome, NodeResult, NodeRunContext } from "./node.js";
import { runWithConcurrency } from "./parallel.js";
import { type SlotReader, type SlotStore, createSlotStore } from "./slot.js";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export interface FanOutSpec<TIn, TItem, TOut, TC = TOut[]> {
  readonly name?: string;
  /** Produce the list at runtime from upstream input + slots. List is DATA, not steps. */
  readonly over: (input: TIn, slots: SlotReader) => readonly TItem[];
  /** The operation as an uncalled VALUE; FanOut invokes it per item. Branches are INDEPENDENT. */
  readonly step: Node<TItem, TOut>;
  /** Reduce N item outputs into one. Omit → `TOut[]`. */
  readonly consolidate?: Consolidate<TOut, TC>;
  /** Bound concurrency (reuses {@link runWithConcurrency}). Unbounded when unset. */
  readonly maxConcurrency?: number;
}

/**
 * FanOut's result extends {@link NodeResult} with a per-item failure channel —
 * `[itemIndex, error]` for EVERY failed item, in item-index order. Empty when
 * all items succeed. `error` stays the first failure; `failed` is the full list.
 */
export interface FanOutResult<TC> extends NodeResult<TC> {
  readonly failed: ReadonlyArray<readonly [number, Error]>;
}

// ---------------------------------------------------------------------------
// FanOut
// ---------------------------------------------------------------------------

export class FanOut<TIn, TItem, TOut, TC = TOut[]> implements Node<TIn, TC> {
  readonly name?: string;

  constructor(private readonly spec: FanOutSpec<TIn, TItem, TOut, TC>) {
    this.name = spec.name;
  }

  async run(input: TIn, ctx: NodeRunContext): Promise<FanOutResult<TC>> {
    const hooks: PatternHooks | undefined = ctx.hooks;
    const patternName = this.name ?? "FanOut";
    const parentSlots: SlotStore = ctx.slots ?? createSlotStore();

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName,
      timestamp: new Date(),
    });

    const items = this.spec.over(input, parentSlots.reader());
    const outputs = new Array<TOut>(items.length);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let succeeded = true;
    let firstError: Error | undefined;
    const failed: Array<readonly [number, Error]> = [];

    const executeOne = async (index: number): Promise<void> => {
      const item = items[index]!;
      const stepName = `${this.spec.step.name ?? "item"}_${index}`;
      const branchCtx: NodeRunContext = { ...ctx, slots: parentSlots.fork() };

      await hooks?.onStepStart?.({
        type: "pattern.step.start",
        stepName,
        stepIndex: index,
        timestamp: new Date(),
      });

      try {
        const res = await this.spec.step.run(item, branchCtx);
        totalInputTokens += res.totalInputTokens;
        totalOutputTokens += res.totalOutputTokens;
        outputs[index] = res.output;
        parentSlots.join(branchCtx.slots as SlotStore);

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
          succeeded = false;
          const e = res.error ?? new Error(`FanOut item ${index} failed`);
          firstError ??= e;
          failed.push([index, e] as const);
          await hooks?.onStepError?.({
            type: "pattern.step.error",
            stepName,
            stepIndex: index,
            error: e,
            timestamp: new Date(),
          });
        }
      } catch (err) {
        // A well-behaved Node never throws (leaves catch internally), but a
        // nested/third-party node might. Convert a throw into a failed item so
        // one bad item can't reject the pool and abort its siblings.
        succeeded = false;
        const e = err instanceof Error ? err : new Error(String(err));
        firstError ??= e;
        failed.push([index, e] as const);
        await hooks?.onStepError?.({
          type: "pattern.step.error",
          stepName,
          stepIndex: index,
          error: e,
          timestamp: new Date(),
        });
      }
    };

    if (this.spec.maxConcurrency && this.spec.maxConcurrency > 0) {
      await runWithConcurrency(
        items.map((_, i) => () => executeOne(i)),
        this.spec.maxConcurrency,
      );
    } else {
      await Promise.all(items.map((_, i) => executeOne(i)));
    }

    const consolidated: TC = this.spec.consolidate
      ? this.spec.consolidate(outputs)
      : (outputs as unknown as TC);

    const result: FanOutResult<TC> = Object.freeze({
      output: consolidated,
      succeeded,
      error: firstError,
      totalInputTokens,
      totalOutputTokens,
      failed: Object.freeze([...failed].sort((a, b) => a[0] - b[0])),
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
