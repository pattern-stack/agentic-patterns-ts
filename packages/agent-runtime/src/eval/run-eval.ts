/**
 * The harness — `runEval(spec, ctx)` (spec § Approach step 4).
 *
 * Resolves the target to a `Node`, runs each case through it, scores the output,
 * and aggregates a typed `EvalReport`. Never throws: a failed node is scored (not
 * thrown), and a throwing scorer is recorded as ERRORED per the Gate-1 binding
 * refinement (`Score.value: null` + `Score.error`, excluded from aggregate math,
 * surfaced in `summary.scoreErrors`) — see `types.ts` module doc.
 *
 * Sequential execution in v1 (deterministic, simplest; a `concurrency` option is a
 * noted extension). No wall-clock in the summary (Decisions #5) — counts/means/
 * tokens only.
 *
 * ADDITIVE: new file.
 */

import type { RunnerProtocol, ToolExecutor } from "../runner/types.js";
import type { PatternHooks } from "../workflows/base.js";
import { createScratchpad } from "../workflows/slot.js";
import type { Scorer } from "./scorer.js";
import { type EvalTarget, resolveEvalTarget } from "./target.js";
import {
  type EvalCase,
  EvalCaseSchema,
  type EvalReport,
  type EvalResult,
  type Score,
} from "./types.js";

// ---------------------------------------------------------------------------
// Spec / context
// ---------------------------------------------------------------------------

export interface EvalRunContext {
  readonly runner: RunnerProtocol; // INJECTED — MockRunner in tests
  readonly hooks?: PatternHooks;
  readonly toolExecutor?: ToolExecutor;
  readonly traceId?: string;
}

export interface EvalSpec<TIn, TOut, TExpected = unknown> {
  readonly target: EvalTarget<TIn, TOut>;
  readonly cases: readonly EvalCase<TIn, TExpected>[];
  readonly scorers: readonly Scorer<TIn, TOut, TExpected>[];
  /** Optional per-result seam — persistence/streaming hook (no built-in store in v1). */
  readonly onResult?: (r: EvalResult<TIn, TOut, TExpected>) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Run every scorer over a succeeded case's output; a throwing scorer is caught and ERRORED. */
async function runScorers<TIn, TOut, TExpected>(
  scorers: readonly Scorer<TIn, TOut, TExpected>[],
  args: {
    readonly input: TIn;
    readonly output: TOut;
    readonly expected?: TExpected;
    readonly case: EvalCase<TIn, TExpected>;
  },
): Promise<Score[]> {
  const scores: Score[] = [];
  for (let i = 0; i < scorers.length; i++) {
    const scorer = scorers[i] as Scorer<TIn, TOut, TExpected>;
    try {
      const result = await scorer(args);
      scores.push(...(Array.isArray(result) ? result : [result]));
    } catch (error) {
      // Gate-1 binding refinement: ERRORED, not a silent 0. `scorer.name` is the JS
      // function name when available; built-ins (exactMatch/predicateScorer) return
      // anonymous closures, so fall back to a positional identifier.
      const name = scorer.name || `scorer-${i}`;
      scores.push({
        name,
        value: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return scores;
}

interface Aggregate {
  succeeded: number;
  errored: number;
  scoreErrors: number;
  scoreSums: Record<string, { sum: number; count: number }>;
  passCounts: Record<string, { passed: number; total: number }>;
  totalInputTokens: number;
  totalOutputTokens: number;
}

function newAggregate(): Aggregate {
  return {
    succeeded: 0,
    errored: 0,
    scoreErrors: 0,
    scoreSums: {},
    passCounts: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

function fold(agg: Aggregate, result: EvalResult<unknown, unknown, unknown>): void {
  agg.totalInputTokens += result.inputTokens;
  agg.totalOutputTokens += result.outputTokens;
  if (result.succeeded) {
    agg.succeeded++;
  } else {
    agg.errored++;
  }

  for (const score of result.scores) {
    if (score.value === null) {
      agg.scoreErrors++;
      continue;
    }
    const sumBucket = agg.scoreSums[score.name] ?? { sum: 0, count: 0 };
    sumBucket.sum += score.value;
    sumBucket.count += 1;
    agg.scoreSums[score.name] = sumBucket;

    if (score.passed !== undefined) {
      const passBucket = agg.passCounts[score.name] ?? { passed: 0, total: 0 };
      passBucket.total += 1;
      if (score.passed) passBucket.passed += 1;
      agg.passCounts[score.name] = passBucket;
    }
  }
}

function summarize(
  agg: Aggregate,
  cases: number,
): EvalReport<unknown, unknown, unknown>["summary"] {
  const scoreMeans: Record<string, number> = {};
  for (const [name, { sum, count }] of Object.entries(agg.scoreSums)) {
    scoreMeans[name] = count > 0 ? sum / count : 0;
  }
  const passRate: Record<string, number> = {};
  for (const [name, { passed, total }] of Object.entries(agg.passCounts)) {
    passRate[name] = total > 0 ? passed / total : 0;
  }
  return Object.freeze({
    cases,
    succeeded: agg.succeeded,
    errored: agg.errored,
    scoreErrors: agg.scoreErrors,
    scoreMeans: Object.freeze(scoreMeans),
    passRate: Object.freeze(passRate),
    totalInputTokens: agg.totalInputTokens,
    totalOutputTokens: agg.totalOutputTokens,
  });
}

// ---------------------------------------------------------------------------
// runEval
// ---------------------------------------------------------------------------

export async function runEval<TIn, TOut, TExpected = unknown>(
  spec: EvalSpec<TIn, TOut, TExpected>,
  ctx: EvalRunContext,
): Promise<EvalReport<TIn, TOut, TExpected>> {
  // Validate every case ENVELOPE (id/tags — input/expected stay z.unknown()
  // passthrough, the caller owns those shapes) up front, before any node runs.
  // A malformed case must fail fast at the boundary — reject the whole
  // runEval() call — rather than flow bad keys into onResult/the report.
  for (let i = 0; i < spec.cases.length; i++) {
    const parsed = EvalCaseSchema.safeParse(spec.cases[i]);
    if (!parsed.success) {
      throw new Error(
        `runEval: invalid case envelope at index ${i} (id=${String((spec.cases[i] as { id?: unknown } | undefined)?.id)}): ${parsed.error.message}`,
      );
    }
  }

  const { node, kind } = resolveEvalTarget(spec.target);

  const agg = newAggregate();
  const results: EvalResult<TIn, TOut, TExpected>[] = [];

  for (const evalCase of spec.cases) {
    const nodeCtx = {
      runner: ctx.runner,
      hooks: ctx.hooks,
      toolExecutor: ctx.toolExecutor,
      traceId: ctx.traceId,
      scratchpad: createScratchpad(),
    };

    let nodeResult: Awaited<ReturnType<typeof node.run>>;
    try {
      nodeResult = await node.run(evalCase.input, nodeCtx);
    } catch (error) {
      // Node.run() contractually never throws (§5.3), but the harness must not
      // throw either way — an errored question must hurt the metrics, not crash.
      nodeResult = {
        output: undefined as TOut,
        succeeded: false,
        error: error instanceof Error ? error : new Error(String(error)),
        totalInputTokens: 0,
        totalOutputTokens: 0,
      };
    }

    const scores = nodeResult.succeeded
      ? await runScorers(spec.scorers, {
          input: evalCase.input,
          output: nodeResult.output,
          expected: evalCase.expected,
          case: evalCase,
        })
      : [];

    const result: EvalResult<TIn, TOut, TExpected> = {
      case: evalCase,
      output: nodeResult.succeeded ? nodeResult.output : undefined,
      scores,
      succeeded: nodeResult.succeeded,
      error: nodeResult.succeeded ? undefined : (nodeResult.error?.message ?? "unknown error"),
      inputTokens: nodeResult.totalInputTokens,
      outputTokens: nodeResult.totalOutputTokens,
    };

    if (spec.onResult) {
      await spec.onResult(result);
    }

    fold(agg, result as EvalResult<unknown, unknown, unknown>);
    results.push(result);
  }

  const report: EvalReport<TIn, TOut, TExpected> = Object.freeze({
    target: kind,
    results: Object.freeze(results),
    summary: summarize(agg, results.length),
  });

  return report;
}
