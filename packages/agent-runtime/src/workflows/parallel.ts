/**
 * Parallel — Fan-out agents in parallel with optional concurrency limiting.
 *
 * Ported from Python: workflows/compositions/parallel.py
 */

import type {
  PatternContext,
  PatternProtocol,
  PatternResult,
  PatternRunOptions,
  Step,
  StepResult,
} from "./base.js";
import { createStepResult, makeStepName, resolveMessage } from "./base.js";

// ---------------------------------------------------------------------------
// Consolidator
// ---------------------------------------------------------------------------

/** Consolidator: reduce step results to a single value. */
export type Consolidator = (results: StepResult[]) => unknown;

/** Collect all step contents into an array. */
export function collectContents(results: StepResult[]): string[] {
  return results.map((r) => r.content);
}

/** Collect step contents keyed by step name. */
export function collectByName(results: StepResult[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of results) {
    out[r.stepName] = r.content;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ParallelResult
// ---------------------------------------------------------------------------

export interface ParallelResult extends PatternResult {
  readonly results: ReadonlyArray<StepResult | Error>;
  readonly successful: ReadonlyArray<StepResult>;
  readonly failed: ReadonlyArray<readonly [number, Error]>;
  readonly consolidatedOutput: Readonly<Record<string, unknown>>;
  readonly allSucceeded: boolean;
}

// ---------------------------------------------------------------------------
// ParallelOptions
// ---------------------------------------------------------------------------

export interface ParallelOptions {
  readonly outputKey?: string;
  readonly consolidator?: Consolidator;
  readonly returnExceptions?: boolean;
  readonly maxConcurrency?: number;
}

// ---------------------------------------------------------------------------
// Parallel
// ---------------------------------------------------------------------------

/**
 * Fan-out agents in parallel with optional concurrency limiting.
 *
 * All steps receive the same context snapshot.
 * Results preserve input order.
 *
 * Example:
 *   const par = new Parallel([
 *     { agent: analyst1, messageTemplate: "Analyze data" },
 *     { agent: analyst2, messageTemplate: "Analyze data" },
 *   ], { maxConcurrency: 2 });
 */
export class Parallel implements PatternProtocol {
  private readonly steps: ReadonlyArray<Step>;
  private readonly outputKey: string | undefined;
  private readonly consolidator: Consolidator | undefined;
  private readonly returnExceptions: boolean;
  private readonly maxConcurrency: number | undefined;

  constructor(steps: Step[], options?: ParallelOptions) {
    this.steps = steps;
    this.outputKey = options?.outputKey;
    this.consolidator = options?.consolidator;
    this.returnExceptions = options?.returnExceptions ?? true;
    this.maxConcurrency = options?.maxConcurrency;
  }

  async run(context: PatternContext = {}, options?: PatternRunOptions): Promise<ParallelResult> {
    const runner = options?.runner;
    const hooks = options?.hooks;
    const toolExecutor = options?.toolExecutor;

    if (!runner) {
      throw new Error("Runner is required for Parallel execution");
    }

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName: "Parallel",
      timestamp: new Date(),
    });

    const contextSnapshot = { ...context };
    const orderedResults: Array<StepResult | Error> = new Array(this.steps.length);

    const executeOne = async (index: number): Promise<void> => {
      const step = this.steps[index]!;
      const stepName = makeStepName(step.name, index);

      await hooks?.onStepStart?.({
        type: "pattern.step.start",
        stepName,
        stepIndex: index,
        timestamp: new Date(),
      });

      try {
        const message = resolveMessage(step.messageTemplate, contextSnapshot);
        const runResult = await runner.run(step.agent, message, { toolExecutor });
        const stepResult = createStepResult(stepName, runResult);
        orderedResults[index] = stepResult;

        await hooks?.onStepComplete?.({
          type: "pattern.step.complete",
          stepName,
          stepIndex: index,
          result: stepResult,
          timestamp: new Date(),
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        orderedResults[index] = err;

        await hooks?.onStepError?.({
          type: "pattern.step.error",
          stepName,
          stepIndex: index,
          error: err,
          timestamp: new Date(),
        });

        if (!this.returnExceptions) {
          throw err;
        }
      }
    };

    if (this.maxConcurrency && this.maxConcurrency > 0) {
      await runWithConcurrency(
        this.steps.map((_, i) => () => executeOne(i)),
        this.maxConcurrency,
      );
    } else {
      await Promise.all(this.steps.map((_, i) => executeOne(i)));
    }

    const successful: StepResult[] = [];
    const failed: Array<readonly [number, Error]> = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let i = 0; i < orderedResults.length; i++) {
      const r = orderedResults[i]!;
      if (r instanceof Error) {
        failed.push([i, r] as const);
      } else {
        successful.push(r);
        totalInputTokens += r.inputTokens;
        totalOutputTokens += r.outputTokens;
      }
    }

    let consolidatedOutput: Record<string, unknown> = {};
    if (this.consolidator && successful.length > 0) {
      const consolidated = this.consolidator(successful);
      if (this.outputKey) {
        consolidatedOutput[this.outputKey] = consolidated;
      } else {
        consolidatedOutput = { consolidated };
      }
    }

    const allSucceeded = failed.length === 0;
    const finalContent = successful.length > 0 ? successful[successful.length - 1]!.content : "";

    const result: ParallelResult = Object.freeze({
      results: Object.freeze(orderedResults),
      successful: Object.freeze(successful),
      failed: Object.freeze(failed),
      consolidatedOutput: Object.freeze(consolidatedOutput),
      allSucceeded,
      totalInputTokens,
      totalOutputTokens,
      succeeded: allSucceeded,
      finalContent,
    });

    await hooks?.onPatternComplete?.({
      type: "pattern.complete",
      patternName: "Parallel",
      result,
      timestamp: new Date(),
    });

    return result;
  }
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
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
