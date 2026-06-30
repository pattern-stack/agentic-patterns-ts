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
import { type Scratchpad, createScratchpad } from "./slot.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParallelOpts<TBranch, TC> {
  readonly name?: string;
  /** Reduce N branch outputs into one. Omit → the result is the array `TBranch[]`. */
  readonly consolidate?: Consolidate<TBranch, TC>;
  /** Bound concurrency (reuses {@link runWithConcurrency}). Unbounded when unset. */
  readonly maxConcurrency?: number;
}

/** A named, hand-authored branch over the shared input. */
export interface ParallelBranch<TIn, TBranch> {
  readonly name: string;
  readonly node: Node<TIn, TBranch>;
}

/**
 * Parallel's result extends {@link NodeResult} with a per-branch failure
 * channel — `[branchIndex, error]` for EVERY failed branch (not just the first),
 * in branch-index order. Empty when all branches succeed. `error` stays the
 * first failure (NodeResult contract); `failed` is the full diagnostic list.
 */
export interface ParallelResult<TC> extends NodeResult<TC> {
  readonly failed: ReadonlyArray<readonly [number, Error]>;
}

// ---------------------------------------------------------------------------
// Parallel
// ---------------------------------------------------------------------------

export class Parallel<TIn, TBranch, TC = TBranch[]> implements Node<TIn, TC> {
  readonly name?: string;
  private readonly branches: ReadonlyArray<ParallelBranch<TIn, TBranch>>;
  private readonly consolidate?: Consolidate<TBranch, TC>;
  private readonly maxConcurrency?: number;

  constructor(
    branches: ReadonlyArray<ParallelBranch<TIn, TBranch>>,
    opts?: ParallelOpts<TBranch, TC>,
  ) {
    this.branches = branches;
    this.name = opts?.name;
    this.consolidate = opts?.consolidate;
    this.maxConcurrency = opts?.maxConcurrency;
  }

  async run(input: TIn, ctx: NodeRunContext): Promise<ParallelResult<TC>> {
    const hooks: PatternHooks | undefined = ctx.hooks;
    const patternName = this.name ?? "Parallel";
    const parentSlots: Scratchpad = ctx.scratchpad ?? createScratchpad();

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
    const failed: Array<readonly [number, Error]> = [];
    // Captured per-branch forks, merged into the parent in INDEX order after all
    // branches settle — deterministic fan-in, not completion order.
    const branchPads = new Array<Scratchpad | undefined>(this.branches.length);

    const executeOne = async (index: number): Promise<void> => {
      const branch = this.branches[index]!;
      const branchCtx: NodeRunContext = { ...ctx, scratchpad: parentSlots.fork() };
      branchPads[index] = branchCtx.scratchpad as Scratchpad;

      await hooks?.onStepStart?.({
        type: "pattern.step.start",
        stepName: branch.name,
        stepIndex: index,
        timestamp: new Date(),
      });

      try {
        const res = await branch.node.run(input, branchCtx);
        totalInputTokens += res.totalInputTokens;
        totalOutputTokens += res.totalOutputTokens;
        outputs[index] = res.output;

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
          const e = res.error ?? new Error(`Branch "${branch.name}" failed`);
          firstError ??= e;
          failed.push([index, e] as const);
          await hooks?.onStepError?.({
            type: "pattern.step.error",
            stepName: branch.name,
            stepIndex: index,
            error: e,
            timestamp: new Date(),
          });
        }
      } catch (err) {
        // A well-behaved Node never throws (leaves catch internally), but a
        // nested/third-party node might. Convert a throw into a failed branch so
        // one bad branch can't reject the pool and abort its siblings.
        succeeded = false;
        const e = err instanceof Error ? err : new Error(String(err));
        firstError ??= e;
        failed.push([index, e] as const);
        await hooks?.onStepError?.({
          type: "pattern.step.error",
          stepName: branch.name,
          stepIndex: index,
          error: e,
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

    // Deterministic fan-in: merge each branch's forked scratchpad in INDEX order,
    // so a slot's `merge` reducer combines partials identically every run,
    // regardless of which branch finished first.
    for (let i = 0; i < branchPads.length; i++) {
      const pad = branchPads[i];
      if (pad) parentSlots.join(pad);
    }

    const consolidated: TC = this.consolidate
      ? this.consolidate(outputs)
      : (outputs as unknown as TC);

    const result: ParallelResult<TC> = Object.freeze({
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

// ---------------------------------------------------------------------------
// Concurrency pool — shared by Parallel and FanOut
// ---------------------------------------------------------------------------

export async function runWithConcurrency(
  tasks: ReadonlyArray<() => Promise<void>>,
  maxConcurrency: number,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const task of tasks) {
    // `.finally` deletes on settle (fulfil OR reject), so a rejecting task can't
    // leave a stale entry in the pool; the rejection still propagates.
    const p = task().finally(() => {
      executing.delete(p);
    });
    executing.add(p);
    if (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
