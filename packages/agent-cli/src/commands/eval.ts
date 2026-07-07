/**
 * `ap eval` — run a suite from the CLI, persisted to `EvalStore`, gate exit code
 * (spec `.ai-docs/stacks/eval-surface/specs/135.md`, E4).
 *
 * Discovers agents (the caller — `cli.ts` — owns discovery, same as every other
 * command), resolves ONE target, loads a case bank (file via #134's loaders, or
 * a stored set id via #132's `listEvalCases`), applies the `--split` filter with
 * the held-out guard, runs `runEval` with an `EvalStore`-backed `onResult` (suite
 * row + per-case run row + `eval_result` annotation — #132's persistence seam,
 * verbatim), captures per-case traces through the shared bus (#133:
 * `ctx.eventBus` + `ctx.traceId = evalRunId` ⇒ per-case ids
 * `eval:${evalRunId}:${caseId}` — runEval's `EVAL_TRACE_PREFIX` marker),
 * prints a live per-case line plus an aggregate with per-split pass rates,
 * and exits non-zero on gate failure (CI-friendly).
 *
 * Exit-code taxonomy: 0 gate pass · 1 gate failure (`process.exitCode`) ·
 * 2 usage/config error (`process.exit`). `--judge` (E6/#141) appends the
 * deterministic set-membership scorer + the LLM judge (5-axis rubric) on the
 * SAME runner; without `--judge` the scorer array construction is untouched
 * (byte-identical behavior — spec `.ai-docs/stacks/eval-surface/specs/141.md`
 * acceptance #3).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  AgentEventBus,
  CaseBankLoadError,
  EvalSplitSchema,
  type EvalStore,
  HeldOutSplitError,
  JUDGE_AXES,
  SQLiteExporter,
  assertSplitSelectable,
  createEvalResultRecorder,
  derivePass,
  exactMatch,
  filterBySplit,
  judgeScorer,
  loadCasesJsonl,
  loadEvalStore,
  loadGold,
  runEval,
  setMembership,
} from "@agentic-patterns/runtime";
import type {
  EvalCase,
  EvalCaseRow,
  EvalReport,
  EvalResult,
  EvalSplit,
  JudgeAxis,
  JudgeThresholds,
  RunnerProtocol,
  Scorer,
} from "@agentic-patterns/runtime";
import { ensureParentDir, resolveDbPath } from "../helpers/db.js";
import type { DiscoveredAgent } from "../helpers/discover.js";
import { ExecutionService } from "../services/execution-service.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EvalCommandOptions {
  /** All discovered agents; the caller (cli.ts) owns discovery — every command's shape. */
  agents: DiscoveredAgent[];
  /** --set: existing file path ⇒ jsonl file mode; else stored-set id. Required. */
  set?: string;
  /** --gold: gold overlay file (file mode only). */
  gold?: string;
  /** --target: agent id; resolution per the flag table when omitted. */
  target?: string;
  /** --variant: free A/B label → eval_run.variant + run metadata. */
  variant?: string;
  /** --split: raw value; validated inside with EvalSplitSchema. */
  split?: string;
  /** --allow-test → SplitSelectOptions.allowTest (held-out opt-in). */
  allowTest?: boolean;
  /** --db: SQLite path; default resolveDbPath() (helpers/db.ts). */
  db?: string;
  /**
   * --judge: append the deterministic set-membership scorer + the LLM judge
   * (5-axis rubric) on the SAME runner. Without it, scorer construction is
   * untouched (byte-identical behavior).
   */
  judge?: boolean;
  /** --judge-model: judge model id. Default: AGENT_MODEL ?? tier (eval.ts:233). */
  judgeModel?: string;
  /** --judge-thresholds: comma list `axis=n` (0-5); axes: the five kebab axis names or `mean`. */
  judgeThresholds?: string;
  /** Test seam — injected runner skips createRunner(). Default: createRunner({eventBus,…}). */
  runner?: RunnerProtocol;
  /** Project root for `.env` (credential preflight). Defaults to cwd. */
  configRoot?: string;
}

// ---------------------------------------------------------------------------
// --judge-thresholds parsing
// ---------------------------------------------------------------------------

/** `hazardAvoidance` -> `hazard-avoidance`; CLI axis names are kebab-case,
 *  `JudgeThresholds` keys are camelCase (single-sourced from `JUDGE_AXES`). */
function toKebabAxis(axis: JudgeAxis): string {
  return axis.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

const KEBAB_TO_AXIS: Record<string, JudgeAxis> = Object.fromEntries(
  JUDGE_AXES.map((axis) => [toKebabAxis(axis), axis]),
);

const JUDGE_THRESHOLD_AXES_TEXT = `${JUDGE_AXES.map(toKebabAxis).join("|")}|mean`;

/** `accuracy=3,grounding=3,mean=3.5` → `{accuracy: 3, grounding: 3, mean: 3.5}`. Exits 2 on any malformed entry. */
function parseJudgeThresholds(raw: string): JudgeThresholds {
  const thresholds: JudgeThresholds = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      errExit2(
        `error: invalid --judge-thresholds entry "${trimmed}" — expected axis=n (${JUDGE_THRESHOLD_AXES_TEXT})`,
      );
    }
    const key = trimmed.slice(0, eq).trim();
    const valueRaw = trimmed.slice(eq + 1).trim();
    const value = Number(valueRaw);
    if (!Number.isFinite(value) || value < 0 || value > 5) {
      errExit2(
        `error: invalid --judge-thresholds value "${valueRaw}" for "${key}" — expected a number 0-5`,
      );
    }

    if (key === "mean") {
      thresholds.mean = value;
      continue;
    }
    const axis = KEBAB_TO_AXIS[key];
    if (!axis) {
      errExit2(
        `error: unknown --judge-thresholds axis "${key}" — expected one of ${JUDGE_THRESHOLD_AXES_TEXT}`,
      );
    }
    thresholds[axis] = value;
  }
  return thresholds;
}

/** Exit codes: 0 gate pass · 1 gate failure (process.exitCode) · 2 usage/config (process.exit). */
export async function runEvalCommand(opts: EvalCommandOptions): Promise<void> {
  // -------------------------------------------------------------------------
  // Step 1 — validate flags (order matters: the held-out refusal must be free —
  // callable before any file/store/runner work).
  // -------------------------------------------------------------------------

  const setArg = opts.set;
  if (setArg === undefined) {
    errExit2("error: ap eval requires --set <path|id>");
  }

  let split: EvalSplit | undefined;
  if (opts.split !== undefined) {
    const parsed = EvalSplitSchema.safeParse(opts.split);
    if (!parsed.success) {
      errExit2(`error: invalid --split "${opts.split}" — expected train | dev | test`);
    }
    split = parsed.data;
  }

  const allowTest = opts.allowTest === true;
  if (split !== undefined) {
    try {
      assertSplitSelectable(split, { allowTest });
    } catch (error) {
      if (error instanceof HeldOutSplitError) {
        errExit2(error.message, "pass --allow-test to run it deliberately");
      }
      throw error;
    }
  }

  // --judge-model / --judge-thresholds without --judge is a silent no-op that
  // hides typos — refuse it. --judge-thresholds is parsed HERE (before any
  // file/store/runner work) so a malformed list exits 2 immediately.
  const judgeEnabled = opts.judge === true;
  if (!judgeEnabled && (opts.judgeModel !== undefined || opts.judgeThresholds !== undefined)) {
    errExit2("error: --judge-model / --judge-thresholds require --judge");
  }
  const judgeThresholds: JudgeThresholds =
    judgeEnabled && opts.judgeThresholds !== undefined
      ? parseJudgeThresholds(opts.judgeThresholds)
      : {};

  // -------------------------------------------------------------------------
  // Step 2 — resolve target. `reg.agent` is the eval target handed to runEval
  // as-is: resolveEvalTarget (engine) handles Node/AgentLike/PromotedAgent —
  // no NodeBackedRunner wrapper here (that's for chat-style Conversations).
  // -------------------------------------------------------------------------

  const reg = resolveTarget(opts.agents, opts.target);
  const targetId = reg.id;

  // -------------------------------------------------------------------------
  // Mode detection + --gold misuse guard
  // -------------------------------------------------------------------------

  const resolvedSetPath = path.resolve(process.cwd(), setArg);
  const isFileMode = existsSync(resolvedSetPath);

  if (opts.gold !== undefined && !isFileMode) {
    errExit2("error: --gold requires a file --set");
  }

  // -------------------------------------------------------------------------
  // Persistence — attached before case loading: stored-set mode needs the
  // store to load cases at all. Mirrors playground.ts's maybeAttachPersistence.
  // -------------------------------------------------------------------------

  const dbPath = opts.db ?? resolveDbPath();
  const persistence = await attachEvalPersistence(dbPath);
  const store = persistence.store;
  if (!store) {
    process.stderr.write(`${yellow(`warning: ${persistence.banner} — running unpersisted`)}\n`);
  }

  // -------------------------------------------------------------------------
  // Step 3 — load cases
  // -------------------------------------------------------------------------

  let setId: string;
  let cases: EvalCase<unknown, unknown>[];

  if (isFileMode) {
    setId = path.parse(resolvedSetPath).name;
    try {
      cases =
        opts.gold !== undefined
          ? loadGold(resolvedSetPath, path.resolve(process.cwd(), opts.gold))
          : loadCasesJsonl(resolvedSetPath);
    } catch (error) {
      if (error instanceof CaseBankLoadError) {
        errExit2(error.message);
      }
      throw error;
    }
  } else {
    setId = setArg;
    if (!store) {
      errExit2(`error: --set "${setArg}" requires persistence`);
    }
    const knownSets = store.listEvalSets();
    if (!knownSets.some((s) => s.id === setId)) {
      const available = knownSets.map((s) => s.id).join(", ") || "(none)";
      errExit2(`error: eval set "${setId}" not found — available: ${available}`);
    }
    cases = store.listEvalCases(setId).map(storedCaseToEvalCase);
  }

  // -------------------------------------------------------------------------
  // Mirror the bank (file mode + store only) — the WHOLE loaded bank, post-gold
  // overlay, PRE-split-filter (the split is run-level, not bank-level).
  // Idempotent by construction (#132 upserts).
  // -------------------------------------------------------------------------

  if (isFileMode && store) {
    store.upsertEvalSet({ id: setId, name: setId });
    for (const c of cases) {
      store.upsertEvalCase(setId, {
        caseId: c.id,
        input: c.input,
        expected: c.expected,
        tags: c.tags,
        split: c.split,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 4 — split filter. Empty selection is a usage error (an empty suite
  // exiting 0 would be a false-green CI pass).
  // -------------------------------------------------------------------------

  if (split !== undefined) {
    cases = filterBySplit(cases, split, { allowTest });
    if (cases.length === 0) {
      errExit2(`error: no cases in split "${split}" of set "${setId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 7 — bus + runner. The SAME bus goes to createRunner() and ctx.eventBus
  // (#133's anti-rebind pattern) — AgentRunner otherwise rebinds to a per-call
  // RunOptions.eventBus.
  // -------------------------------------------------------------------------

  const bus = new AgentEventBus();
  if (store) {
    new SQLiteExporter({ store }).attach(bus);
  }

  const tier = (process.env.AGENT_TIER as "opus" | "sonnet" | "haiku" | undefined) ?? "sonnet";
  let runner: RunnerProtocol;
  let runnerBanner: string;
  if (opts.runner) {
    runner = opts.runner;
    runnerBanner = "injected runner (test seam)";
  } else {
    const svc = new ExecutionService({ configRoot: opts.configRoot ?? process.cwd() });
    const selection = await svc.resolveRunner({ eventBus: bus, tier, verbose: false }, opts.agents);
    runner = selection.runner;
    runnerBanner = `${selection.source} — ${selection.reason}`;
  }

  // Provenance is best-effort — RunnerSelection exposes {runner, reason, source}
  // only, no resolved model id.
  const model = process.env.AGENT_MODEL ?? tier;
  const gitSha = readGitSha();

  // -------------------------------------------------------------------------
  // Step 8 — suite row
  // -------------------------------------------------------------------------

  const evalRunId = store?.startEvalRun({
    setId,
    targetId,
    variant: opts.variant,
    split,
    model,
    gitSha,
  });

  const judgeModel = opts.judgeModel ?? model;
  const judgeBannerLine = judgeEnabled
    ? `on — model ${judgeModel}  thresholds ${
        Object.keys(judgeThresholds).length > 0 ? JSON.stringify(judgeThresholds) : "(defaults)"
      }`
    : undefined;

  printBanner({
    setId,
    targetId,
    variant: opts.variant,
    split,
    storageLine:
      store && evalRunId !== undefined ? `${dbPath} (eval run ${evalRunId})` : persistence.banner,
    runnerBanner,
    judgeLine: judgeBannerLine,
  });

  // -------------------------------------------------------------------------
  // Step 3 (scorer) — expected-gated exact-match default. A case WITH expected
  // is gated by deep-equality; a case WITHOUT stays un-scored ([] → derivePass
  // → null → un-gated) rather than auto-failing.
  //
  // --judge (E6/#141) appends the deterministic set-membership scorer + the
  // LLM judge (5-axis rubric) on the SAME runner (incl. the opts.runner test
  // seam) — zero new runner construction. Without --judge this array is
  // exactly `[defaultScorer]`, untouched (byte-identical behavior).
  // -------------------------------------------------------------------------

  const exact = exactMatch<unknown>();
  const defaultScorer: Scorer<unknown, unknown, unknown> = (args) =>
    args.expected === undefined ? [] : exact(args);

  const scorers: Scorer<unknown, unknown, unknown>[] = judgeEnabled
    ? [
        defaultScorer,
        setMembership(),
        judgeScorer({ runner, model: judgeModel, thresholds: judgeThresholds }),
      ]
    : [defaultScorer];

  // -------------------------------------------------------------------------
  // Step 9 — run. The persistence seam is #139's extracted recorder (the
  // exact #132 shape, now shared with the server's POST /eval/runs route) —
  // onResult here is just printCaseLine + recorder?.(r), behavior-identical.
  // -------------------------------------------------------------------------

  const recorder =
    store && evalRunId !== undefined
      ? createEvalResultRecorder(store, {
          evalRunId,
          targetId,
          model,
          variant: opts.variant,
          split,
        })
      : undefined;

  const onResult = (r: EvalResult<unknown, unknown, unknown>): void => {
    printCaseLine(r);
    recorder?.(r);
  };

  let report: EvalReport<unknown, unknown, unknown>;
  try {
    report = await runEval(
      { target: reg.agent, cases, scorers, onResult },
      { runner, eventBus: bus, ...(evalRunId !== undefined ? { traceId: evalRunId } : {}) },
    );
    if (store && evalRunId !== undefined) {
      store.finishEvalRun(evalRunId, { status: "ok" });
    }
  } catch (error) {
    if (store && evalRunId !== undefined) {
      store.finishEvalRun(evalRunId, { status: "error" });
    }
    throw error;
  } finally {
    store?.close();
  }

  // -------------------------------------------------------------------------
  // Step 11 — print + gate
  // -------------------------------------------------------------------------

  const gateFailed = printAggregateAndGate(report);
  if (gateFailed) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Target resolution (run.ts:44-49 shape)
// ---------------------------------------------------------------------------

function resolveTarget(agents: DiscoveredAgent[], targetId: string | undefined): DiscoveredAgent {
  if (targetId !== undefined) {
    const found = agents.find((a) => a.id === targetId);
    if (!found) {
      const available = agents.map((a) => a.id).join(", ") || "(none)";
      errExit2(`error: agent "${targetId}" not found`, `available: ${available}`);
    }
    return found;
  }
  if (agents.length === 0) {
    errExit2("error: no agents discovered");
  }
  if (agents.length > 1) {
    const available = agents.map((a) => a.id).join(", ");
    errExit2("error: multiple agents discovered — pass --target <id>", `available: ${available}`);
  }
  return agents[0] as DiscoveredAgent;
}

// ---------------------------------------------------------------------------
// Persistence wiring — mirrors playground.ts's maybeAttachPersistence, but for
// EvalStore. AP_PERSISTENCE=0 skips before ensureParentDir (no db file
// created); "unavailable" is the exceptional path (better-sqlite3 is a direct
// dep of agent-cli) and warns loudly while continuing unpersisted.
// ---------------------------------------------------------------------------

interface EvalPersistence {
  readonly store: EvalStore | undefined;
  readonly banner: string;
}

async function attachEvalPersistence(dbPath: string): Promise<EvalPersistence> {
  if (process.env.AP_PERSISTENCE === "0") {
    return { store: undefined, banner: "disabled (AP_PERSISTENCE=0)" };
  }

  ensureParentDir(dbPath);

  const result = await loadEvalStore({ path: dbPath });
  if (result.unavailable || !result.store) {
    return { store: undefined, banner: `unavailable — ${result.reason}` };
  }
  return { store: result.store, banner: dbPath };
}

/** `EvalCaseRow` → `EvalCase`, normalizing `null` → `undefined` for expected/tags/split
 *  (`parseJsonUnknown(null)` returns `null` — an un-normalized `expected: null` would
 *  make the default scorer gate an expected-less case). */
function storedCaseToEvalCase(row: EvalCaseRow): EvalCase<unknown, unknown> {
  return {
    id: row.caseId,
    input: row.input,
    expected: row.expected === null ? undefined : row.expected,
    tags: row.tags === null ? undefined : row.tags,
    split: row.split === null ? undefined : row.split,
  };
}

function readGitSha(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function printBanner(info: {
  readonly setId: string;
  readonly targetId: string;
  readonly variant: string | undefined;
  readonly split: EvalSplit | undefined;
  readonly storageLine: string;
  readonly runnerBanner: string;
  /** Present only when --judge is set — byte-identical banner without it. */
  readonly judgeLine?: string;
}): void {
  const variantText = info.variant ?? "(none)";
  const splitText = info.split ?? "(none)";
  const lines = [
    "",
    `  ${bold("eval")}     ${info.setId} → ${info.targetId}   variant=${variantText}  split=${splitText}`,
    `  storage  ${info.storageLine}`,
    `  runner   ${info.runnerBanner}`,
    ...(info.judgeLine !== undefined ? [`  judge    ${info.judgeLine}`] : []),
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printCaseLine(r: EvalResult<unknown, unknown, unknown>): void {
  const tokens = dim(`${r.inputTokens}↓ ${r.outputTokens}↑`);
  if (!r.succeeded) {
    process.stdout.write(
      `  ${yellow("⚠")} ${r.case.id}  node error: ${r.error ?? "unknown error"}\n`,
    );
    return;
  }
  const pass = derivePass(r.scores);
  const symbol = pass === false ? red("✗") : pass === true ? green("✓") : dim("•");
  const scoreText =
    r.scores.map((s) => `${s.name} ${s.value === null ? "ERR" : s.value.toFixed(2)}`).join("  ") ||
    "(unscored)";
  process.stdout.write(`  ${symbol} ${r.case.id}  ${scoreText}   ${tokens}\n`);
}

/** Prints the aggregate + per-split rows; returns whether the gate FAILED. */
function printAggregateAndGate(report: EvalReport<unknown, unknown, unknown>): boolean {
  const { summary, results } = report;

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const pass = derivePass(r.scores);
    if (pass === true) passed++;
    else if (pass === false) failed++;
  }

  process.stdout.write(
    `\n  cases ${summary.cases} · passed ${passed} · failed ${failed} · errored ${summary.errored} · score-errors ${summary.scoreErrors}\n`,
  );

  const gateCounts = new Map<string, { passed: number; total: number }>();
  for (const r of results) {
    for (const s of r.scores) {
      if (s.passed === undefined) continue;
      const bucket = gateCounts.get(s.name) ?? { passed: 0, total: 0 };
      bucket.total++;
      if (s.passed) bucket.passed++;
      gateCounts.set(s.name, bucket);
    }
  }
  for (const [name, mean] of Object.entries(summary.scoreMeans)) {
    const counts = gateCounts.get(name);
    const passText = counts ? `${counts.passed}/${counts.total}` : "—";
    process.stdout.write(`  ${name}   mean ${mean.toFixed(2)}   pass ${passText}\n`);
  }

  // Per-split rows — computed from report.results, NOT store.splitAggregates()
  // (that aggregates across historical runs matching a filter, not just this
  // invocation, and must work store-less).
  const bySplit = new Map<
    string,
    { cases: number; gatedPassed: number; gatedTotal: number; errors: number }
  >();
  for (const r of results) {
    const key = r.case.split ?? "(untagged)";
    const row = bySplit.get(key) ?? { cases: 0, gatedPassed: 0, gatedTotal: 0, errors: 0 };
    row.cases++;
    if (!r.succeeded) row.errors++;
    const pass = derivePass(r.scores);
    if (pass !== null) {
      row.gatedTotal++;
      if (pass) row.gatedPassed++;
    }
    bySplit.set(key, row);
  }

  if (bySplit.size > 0) {
    process.stdout.write("\n  split        cases  pass   errors  rate\n");
    for (const [split, row] of bySplit) {
      const rate =
        row.gatedTotal > 0 ? `${Math.round((row.gatedPassed / row.gatedTotal) * 100)}%` : "—";
      process.stdout.write(
        `  ${split.padEnd(12)} ${String(row.cases).padEnd(6)} ${`${row.gatedPassed}/${row.gatedTotal}`.padEnd(6)} ${String(row.errors).padEnd(7)} ${rate}\n`,
      );
    }
  }

  const gateFailed = summary.errored > 0 || failed > 0 || summary.scoreErrors > 0;
  const reasons: string[] = [];
  if (failed > 0) reasons.push(`${failed} scorer-failed`);
  if (summary.errored > 0) reasons.push(`${summary.errored} errored`);
  if (summary.scoreErrors > 0) reasons.push(`${summary.scoreErrors} score-errors`);

  if (gateFailed) {
    process.stdout.write(`\n  ${red(`gate FAIL (${reasons.join(", ")}) → exit 1`)}\n`);
  } else {
    process.stdout.write(`\n  ${green("gate PASS → exit 0")}\n`);
  }

  return gateFailed;
}

// ---------------------------------------------------------------------------
// Usage-error exit (code 2)
// ---------------------------------------------------------------------------

function errExit2(message: string, hint?: string): never {
  process.stderr.write(`${red(message)}\n`);
  if (hint !== undefined) {
    process.stderr.write(`  ${hint}\n`);
  }
  process.exit(2);
}

// ---------------------------------------------------------------------------
// ANSI (no chalk dep — same convention as agents.ts/run.ts/tools.ts)
// ---------------------------------------------------------------------------

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
