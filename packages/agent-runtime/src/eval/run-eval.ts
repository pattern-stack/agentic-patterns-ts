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

import { generateId } from "ai";
import type { AgentEventBus } from "../events/agent-event-bus.js";
import type { RunOptions, RunnerProtocol, ToolExecutor } from "../runner/types.js";
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
// Trace-id convention
// ---------------------------------------------------------------------------

/**
 * Marker prefix on every per-case traceId runEval mints when an `eventBus` is
 * set: `eval:${traceBase}:${case.id}`. THE documented convention for
 * recognizing eval-owned runner activity on a shared bus — hosts that attach
 * bus-driven writers (e.g. the playground's `RunStoreExporter`) use
 * `traceId.startsWith(EVAL_TRACE_PREFIX)` to skip eval sub-runs, because
 * eval cases already persist their own `runs` row via
 * `createEvalResultRecorder` (a second bus-driven row would be a double-write).
 * The full traceId (prefix included) is stamped on `EvalResult.traceId`, the
 * recorder's `runs` row, and every bus event of the case — one consistent
 * value end-to-end, so trace drill-downs (events-by-traceId) keep joining.
 */
export const EVAL_TRACE_PREFIX = "eval:";

// ---------------------------------------------------------------------------
// Spec / context
// ---------------------------------------------------------------------------

export interface EvalRunContext {
  readonly runner: RunnerProtocol; // INJECTED — MockRunner in tests
  readonly hooks?: PatternHooks;
  readonly toolExecutor?: ToolExecutor;
  /** Suite-level trace base. With `eventBus` set, per-case ids are
   *  `eval:${traceId}:${case.id}` (base minted via generateId() when absent) —
   *  see {@link EVAL_TRACE_PREFIX} for the marker convention. Without a bus it
   *  threads to every node.run unchanged, exactly as before #133. E4 passes
   *  the eval_run id here. */
  readonly traceId?: string;
  /**
   * NEW (#133, doc §5): observability bus for eval runs. When set, runEval mints a
   * per-case traceId (`eval:`-prefixed — {@link EVAL_TRACE_PREFIX}), delivers bus +
   * traceId into each LLM leaf's RunOptions (via a per-case runner wrapper —
   * AgentRunner honors RunOptions.eventBus), and stamps the traceId onto the
   * EvalResult. Attach a RunStoreExporter to this bus and each case also lands
   * RunStore `runs` row(s) — the E2 fusion. If your host ALSO persists cases via
   * `createEvalResultRecorder` (the playground), give the exporter
   * `shouldTrack: (e) => !e.traceId?.startsWith(EVAL_TRACE_PREFIX)` or each case
   * writes two rows. Absent → byte-identical to pre-#133 behavior. NOTE:
   * AgentRunner rebinds its instance bus to a per-call RunOptions.eventBus
   * (agent-runner.ts:283) — pass the runner's own shared bus (the playground
   * pattern) unless you intend that redirect.
   */
  readonly eventBus?: AgentEventBus;
}

// ---------------------------------------------------------------------------
// Bus delivery — per-case runner wrapper
// ---------------------------------------------------------------------------

/** Per-case runner wrapper: injects the eval bus + case traceId into RunOptions.
 *  Preserves absence of optional protocol methods (AgentStep's
 *  StructuredOutputUnsupported check must still fire). Not exported. */
function withEvalBus(
  runner: RunnerProtocol,
  eventBus: AgentEventBus,
  caseTraceId: string,
): RunnerProtocol {
  const opts = (o?: RunOptions): RunOptions => ({
    ...o,
    eventBus,
    traceId: o?.traceId ?? caseTraceId,
  });
  const wrapped: {
    run: RunnerProtocol["run"];
    runStructured?: RunnerProtocol["runStructured"];
    stream?: RunnerProtocol["stream"];
  } = {
    run: (agent, message, o) => runner.run(agent, message, opts(o)),
  };
  if (runner.runStructured) {
    wrapped.runStructured = (agent, message, schema, o) =>
      // biome/TS: non-null is safe — guarded one line up
      runner.runStructured!(agent, message, schema, opts(o));
  }
  if (runner.stream) {
    wrapped.stream = (agent, message, o) => runner.stream!(agent, message, opts(o));
  }
  return wrapped;
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

  const bus = ctx.eventBus;
  const traceBase = bus ? (ctx.traceId ?? generateId()) : undefined;

  for (const evalCase of spec.cases) {
    // `eval:`-prefixed per-case id — see EVAL_TRACE_PREFIX for the convention.
    const caseTraceId =
      traceBase === undefined ? undefined : `${EVAL_TRACE_PREFIX}${traceBase}:${evalCase.id}`;
    const nodeCtx = {
      runner: bus && caseTraceId ? withEvalBus(ctx.runner, bus, caseTraceId) : ctx.runner,
      hooks: ctx.hooks,
      toolExecutor: ctx.toolExecutor,
      traceId: caseTraceId ?? ctx.traceId,
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
      ...(caseTraceId === undefined ? {} : { traceId: caseTraceId }),
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
