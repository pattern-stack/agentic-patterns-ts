/**
 * `Parallel<TIn, TBranch, TConsolidated = TBranch[]>` — N named branches at once
 * over a shared input (DESIGN §6.3).
 *
 * The single typed `Parallel` (replaces the legacy string-pinned class). Every
 * branch receives the SAME `input` (an explicit value, not a context snapshot);
 * each branch gets a forked branch-scoped slot store (§7.3); outputs are
 * collected in branch order. With `consolidate` → return `consolidate(outputs)`;
 * else → `TBranch[]`. Now typed, nestable, and its consolidated output threads.
 */

import type { PatternHooks } from "./base.js";
import type { Consolidate } from "./consolidate.js";
import type { Node, NodeOutcome, NodeResult, NodeRunContext } from "./node.js";
import { type SlotStore, createSlotStore } from "./slot.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParallelOpts<TBranch, TC> {
  readonly name?: string;
  /** Reduce N branch outputs into one. Omit → the result is the array `TBranch[]`. */
  readonly consolidate?: Consolidate<TBranch, TC>;
  /** Bound concurrency (reuses {@link runWithConcurrency}). Unbounded when unset. */
  readonly maxConcurrency?: number;
  /** Collect failed branches and proceed. Default `true` (§5.3). */
  readonly continueOnError?: boolean;
}

/** A named, hand-authored branch over the shared input. */
export interface ParallelBranch<TIn, TBranch> {
  readonly name: string;
  readonly node: Node<TIn, TBranch>;
}

// ---------------------------------------------------------------------------
// Parallel
// ---------------------------------------------------------------------------

export class Parallel<TIn, TBranch, TC = TBranch[]> implements Node<TIn, TC> {
  readonly name?: string;
  private readonly branches: ReadonlyArray<ParallelBranch<TIn, TBranch>>;
  private readonly consolidate?: Consolidate<TBranch, TC>;
  private readonly maxConcurrency?: number;
  /**
   * Collect failed branches and proceed (default `true`, §5.3). All branches
   * are dispatched concurrently, so this only documents intent; a failed branch
   * surfaces via `result.succeeded === false` and its sibling outputs remain.
   */
  private readonly continueOnError: boolean;

  constructor(
    branches: ReadonlyArray<ParallelBranch<TIn, TBranch>>,
    opts?: ParallelOpts<TBranch, TC>,
  ) {
    this.branches = branches;
    this.name = opts?.name;
    this.consolidate = opts?.consolidate;
    this.maxConcurrency = opts?.maxConcurrency;
    this.continueOnError = opts?.continueOnError ?? true;
  }

  async run(input: TIn, ctx: NodeRunContext): Promise<NodeResult<TC>> {
    const hooks: PatternHooks | undefined = ctx.hooks;
    const patternName = this.name ?? "Parallel";
    const parentSlots: SlotStore = ctx.slots ?? createSlotStore();

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName,
      timestamp: new Date(),
    });

    const outputs = new Array<TBranch>(this.branches.length);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let succeeded = true;
    let firstError: Error | undefined;

    const executeOne = async (index: number): Promise<void> => {
      const branch = this.branches[index]!;
      const branchCtx: NodeRunContext = { ...ctx, slots: parentSlots.fork() };

      await hooks?.onStepStart?.({
        type: "pattern.step.start",
        stepName: branch.name,
        stepIndex: index,
        timestamp: new Date(),
      });

      const res = await branch.node.run(input, branchCtx);
      totalInputTokens += res.totalInputTokens;
      totalOutputTokens += res.totalOutputTokens;
      outputs[index] = res.output;
      parentSlots.join(branchCtx.slots as SlotStore);

      if (res.succeeded) {
        const outcome: NodeOutcome<unknown> = {
          nodeName: branch.name,
          output: res.output,
          succeeded: true,
          inputTokens: res.totalInputTokens,
          outputTokens: res.totalOutputTokens,
        };
        await hooks?.onStepComplete?.({
          type: "pattern.step.complete",
          stepName: branch.name,
          stepIndex: index,
          result: outcome,
          timestamp: new Date(),
        });
      } else {
        succeeded = false;
        firstError ??= res.error;
        await hooks?.onStepError?.({
          type: "pattern.step.error",
          stepName: branch.name,
          stepIndex: index,
          error: res.error ?? new Error(`Branch "${branch.name}" failed`),
          timestamp: new Date(),
        });
      }
    };

    if (this.maxConcurrency && this.maxConcurrency > 0) {
      await runWithConcurrency(
        this.branches.map((_, i) => () => executeOne(i)),
        this.maxConcurrency,
      );
    } else {
      await Promise.all(this.branches.map((_, i) => executeOne(i)));
    }

    const consolidated: TC = this.consolidate
      ? this.consolidate(outputs)
      : (outputs as unknown as TC);

    // `continueOnError` is collect-and-continue by construction here (all branches
    // are dispatched). Reading it keeps intent explicit and the field consumed.
    void this.continueOnError;

    const result: NodeResult<TC> = Object.freeze({
      output: consolidated,
      succeeded,
      error: firstError,
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

// ---------------------------------------------------------------------------
// Concurrency pool — shared by Parallel and FanOut
// ---------------------------------------------------------------------------

export async function runWithConcurrency(
  tasks: ReadonlyArray<() => Promise<void>>,
  maxConcurrency: number,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const task of tasks) {
    const p = task().then(() => {
      executing.delete(p);
    });
    executing.add(p);
    if (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
