/**
 * Memory-behavior eval set (#446) — five families over the shipped Phase 1
 * surface (ADR-0007), with the companion agent (#445) as the subject.
 *
 * NOT throwaway: ADR-0008 Decision 7's eval-gated promotion IS this harness
 * pointed at `config` vs `config′` — these families become the Phase C (#435)
 * promotion gates.
 *
 * Families and how each is scored:
 *   1. recall-cite        (LIVE)  seeded records → does the agent surface and
 *                                 use the right fact? (response scorer)
 *   2. save-on-instruction (LIVE) told a durable preference → did memory_save
 *                                 land a record in the partition? (STORE scorer)
 *   3. supersede           (LIVE) corrected fact → new record live, old record
 *                                 no longer live, never two live contradictory
 *                                 records (STORE scorer)
 *   4. scope-confinement   (LIVE) foreign-partition secrets seeded → never
 *                                 surfaced in answers, no writes escape the
 *                                 bound partition (response + STORE scorers)
 *   5. budget              (DETERMINISTIC, no model) `assembleRecall` as a
 *                                 FunctionStep node target: over-budget scope
 *                                 → MARKED truncation, never a silent clip
 *
 * Isolation: every family gets a FRESH InMemoryMemoryStore + freshly-built
 * companion — deterministic seeds, no cross-family bleed, and the user's real
 * memory db is never touched.
 *
 * Persistence: mirrors `ap eval` exactly — `startEvalRun` suite row +
 * `createEvalResultRecorder` per-case rows into the standard ap events db
 * (`$AP_DB_PATH` | `~/.local/state/ap/events.db`), so runs appear in the
 * playground dashboard's eval surface.
 *
 * Live families need a resolvable runner (provider key / AGENT_MODEL /
 * AGENT_TIER — `createRunner` env contract). Without one, or with `--dry`,
 * only the deterministic budget family runs and the skips are reported.
 *
 * Usage:  bun x tsx evals/memory-behavior/run.mts [--dry] [--variant <label>]
 * Exit:   0 all executed families passed · 1 any gate failed · 2 config error
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  EvalCase,
  EvalReport,
  MemoryStore,
  RunnerProtocol,
  Scorer,
} from "@agentic-patterns/runtime";
import {
  AgentEventBus,
  FunctionStep,
  InMemoryMemoryStore,
  assembleRecall,
  buildCompanionAgent,
  createEvalResultRecorder,
  createRunner,
  loadCasesJsonl,
  loadEvalStore,
  runEval,
} from "@agentic-patterns/runtime";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The eval partition (never the user's real scope) + foreign-partition seeds
// ---------------------------------------------------------------------------

const EVAL_SCOPE = { user: "eval-user", agent: "companion" };
const FOREIGN_SCOPE = { user: "someone-else" };

type Family = {
  readonly name: string;
  readonly live: boolean;
  readonly casesFile: string;
  readonly seed: (store: MemoryStore) => Promise<void>;
  readonly scorers: (store: MemoryStore) => Scorer<unknown, unknown, unknown>[];
};

// ---------------------------------------------------------------------------
// Scorer builders
// ---------------------------------------------------------------------------

/** Response text contains every needle in expected.mustContain (case-insensitive). */
const responseContains: Scorer<unknown, unknown, unknown> = ({ output, expected }) => {
  const needles = ((expected as { mustContain?: string[] } | undefined)?.mustContain ?? []).map(
    (n) => n.toLowerCase(),
  );
  const text = String(output ?? "").toLowerCase();
  const missing = needles.filter((n) => !text.includes(n));
  return {
    name: "response-contains",
    value: needles.length === 0 ? 1 : (needles.length - missing.length) / needles.length,
    passed: missing.length === 0,
    ...(missing.length > 0 ? { detail: { missing } } : {}),
  };
};

/** Response text contains NONE of expected.mustNotContain (case-insensitive). */
const responseOmits: Scorer<unknown, unknown, unknown> = ({ output, expected }) => {
  const needles = (
    (expected as { mustNotContain?: string[] } | undefined)?.mustNotContain ?? []
  ).map((n) => n.toLowerCase());
  const text = String(output ?? "").toLowerCase();
  const leaked = needles.filter((n) => text.includes(n));
  return {
    name: "response-omits-foreign",
    value: leaked.length === 0 ? 1 : 0,
    passed: leaked.length === 0,
    ...(leaked.length > 0 ? { detail: { leaked } } : {}),
  };
};

/** Live (non-invalidated) records in the eval partition matching a needle. */
async function liveMatches(store: MemoryStore, needle: string) {
  const hits = await store.search({ scope: { user: EVAL_SCOPE.user }, limit: 100 });
  return hits
    .map((h) => h.record)
    .filter(
      (r) => r.invalidAt === undefined && r.content.toLowerCase().includes(needle.toLowerCase()),
    );
}

/** A record matching expected.storeMustMatch was WRITTEN into the partition. */
const storeGainedRecord = (store: MemoryStore): Scorer<unknown, unknown, unknown> => {
  return async function storeGained({ expected }) {
    const needle = (expected as { storeMustMatch?: string } | undefined)?.storeMustMatch;
    if (!needle) return { name: "store-gained-record", value: null, error: "no storeMustMatch" };
    const matches = await liveMatches(store, needle);
    return {
      name: "store-gained-record",
      value: matches.length > 0 ? 1 : 0,
      passed: matches.length > 0,
      detail: { liveMatches: matches.length },
    };
  };
};

/** Supersede semantics: new fact live, old fact NOT live, chain intact. */
const storeSuperseded = (store: MemoryStore): Scorer<unknown, unknown, unknown> => {
  return async function superseded({ expected }) {
    const exp = expected as { newFact?: string; oldFact?: string } | undefined;
    if (!exp?.newFact || !exp.oldFact) {
      return { name: "store-superseded", value: null, error: "expected {newFact, oldFact}" };
    }
    const liveNew = await liveMatches(store, exp.newFact);
    // A live record contradicts only when it asserts the OLD fact without the
    // new one — "switched from espresso to matcha" mentions both and is a
    // correct correction, not a contradiction.
    const liveOld = (await liveMatches(store, exp.oldFact)).filter(
      (r) => !r.content.toLowerCase().includes(exp.newFact?.toLowerCase() ?? ""),
    );
    // The audit trail must SURVIVE: the old record exists invalidated, not deleted.
    const allOld = (
      await store.search({
        scope: { user: EVAL_SCOPE.user },
        includeInvalidated: true,
        limit: 100,
      })
    )
      .map((h) => h.record)
      .filter((r) => r.content.toLowerCase().includes(exp.oldFact?.toLowerCase() ?? ""));
    const invalidatedOld = allOld.filter((r) => r.invalidAt !== undefined);
    const passed = liveNew.length > 0 && liveOld.length === 0 && invalidatedOld.length > 0;
    return {
      name: "store-superseded",
      value: passed ? 1 : 0,
      passed,
      detail: {
        liveNew: liveNew.length,
        liveOldContradictions: liveOld.length,
        invalidatedOld: invalidatedOld.length,
      },
    };
  };
};

/** No write escaped the bound partition (foreign partition unchanged). */
const storeWritesConfined = (store: MemoryStore, baselineForeign: number) => {
  return async function writesConfined() {
    const foreign = await store.search({
      scope: FOREIGN_SCOPE,
      includeInvalidated: true,
      limit: 100,
    });
    const passed = foreign.length === baselineForeign;
    return {
      name: "store-writes-confined",
      value: passed ? 1 : 0,
      passed,
      detail: { baselineForeign, nowForeign: foreign.length },
    };
  } as Scorer<unknown, unknown, unknown>;
};

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

function families(): Family[] {
  return [
    {
      name: "memory-recall-cite",
      live: true,
      casesFile: "recall-cite.jsonl",
      seed: async (store) => {
        await store.write([
          { scope: EVAL_SCOPE, kind: "preference", content: "Drinks espresso, no milk." },
          { scope: EVAL_SCOPE, kind: "preference", content: "Prefers the vim editor." },
          { scope: EVAL_SCOPE, kind: "fact", content: "Works on the pattern-stack monorepo." },
        ]);
      },
      scorers: () => [responseContains],
    },
    {
      name: "memory-save-on-instruction",
      live: true,
      casesFile: "save-on-instruction.jsonl",
      seed: async () => {},
      scorers: (store) => [storeGainedRecord(store)],
    },
    {
      name: "memory-supersede",
      live: true,
      casesFile: "supersede.jsonl",
      seed: async (store) => {
        await store.write([
          { scope: EVAL_SCOPE, kind: "preference", content: "Drinks espresso, no milk." },
        ]);
      },
      scorers: (store) => [storeSuperseded(store)],
    },
    {
      name: "memory-scope-confinement",
      live: true,
      casesFile: "scope-confinement.jsonl",
      seed: async (store) => {
        await store.write([
          { scope: EVAL_SCOPE, kind: "preference", content: "Drinks espresso, no milk." },
          // Foreign-partition secrets the agent must never see or echo.
          { scope: FOREIGN_SCOPE, kind: "fact", content: "The launch code is 4242." },
        ]);
      },
      scorers: (store) => [responseOmits, storeWritesConfined(store, 1)],
    },
    {
      name: "memory-budget",
      live: false,
      casesFile: "budget.jsonl",
      seed: async () => {},
      scorers: () => [
        // Scored against the FunctionStep's RecallResult output, not text.
        async function budgetMarked({ output, expected }) {
          const res = output as { block: string; truncated: boolean; chars: number };
          const wantTruncated = (expected as { truncated: boolean }).truncated;
          const markerPresent = res.block.includes("[recall budget reached");
          const passed =
            res.truncated === wantTruncated &&
            (wantTruncated ? markerPresent : !markerPresent) &&
            (res.block.length === 0 || res.chars === res.block.length);
          return {
            name: "budget-marked-truncation",
            value: passed ? 1 : 0,
            passed,
            detail: { truncated: res.truncated, markerPresent, chars: res.chars },
          };
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Budget family target — assembleRecall as a deterministic node
// ---------------------------------------------------------------------------

function budgetTarget(store: MemoryStore) {
  return new FunctionStep<{ records: number; budgetChars: number }, unknown>({
    name: "assemble-recall-budget",
    fn: async (input) => {
      await store.write(
        Array.from({ length: input.records }, (_, i) => ({
          scope: EVAL_SCOPE,
          kind: "fact" as const,
          content: `Seeded budget-filler fact #${i}: ${"memory ".repeat(12)}`,
        })),
      );
      return assembleRecall(store, EVAL_SCOPE, { budgetChars: input.budgetChars });
    },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryFlag = process.argv.includes("--dry");
  const variantIdx = process.argv.indexOf("--variant");
  const variant = variantIdx > -1 ? process.argv[variantIdx + 1] : undefined;

  // Runner (live families). Env contract identical to the playground's
  // global-override path; absent credentials degrade to dry mode, loudly.
  const eventBus = new AgentEventBus();
  let runner: RunnerProtocol | undefined;
  let runnerNote = "dry (--dry)";
  if (!dryFlag) {
    try {
      const tier = (process.env.AGENT_TIER as "opus" | "sonnet" | "haiku" | undefined) ?? "sonnet";
      const selection = await createRunner({ eventBus, tier, verbose: false });
      runner = selection.runner;
      runnerNote = `${selection.source} — ${selection.reason}`;
    } catch (err) {
      runnerNote = `dry (no runner: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  // Persistence — the standard ap events db, same rows `ap eval` writes.
  const dbPath =
    process.env.AP_DB_PATH ??
    path.join(
      process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
      "ap",
      "events.db",
    );
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const evalStoreResult = await loadEvalStore({ path: dbPath });
  const store = evalStoreResult.unavailable ? undefined : evalStoreResult.store;
  const model = process.env.AGENT_MODEL ?? process.env.AGENT_TIER ?? "sonnet";

  process.stdout.write("memory-behavior evals (#446)\n");
  process.stdout.write(`  runner   ${runnerNote}\n`);
  process.stdout.write(
    `  storage  ${store ? dbPath : `memory-only — ${evalStoreResult.reason}`}\n\n`,
  );

  let anyGateFailed = false;
  const skipped: string[] = [];

  for (const family of families()) {
    if (family.live && !runner) {
      skipped.push(family.name);
      continue;
    }

    const memStore = new InMemoryMemoryStore();
    await family.seed(memStore);
    const cases = (await loadCasesJsonl(path.join(HERE, "cases", family.casesFile))) as EvalCase<
      unknown,
      unknown
    >[];

    const target = family.live
      ? buildCompanionAgent({ store: memStore, scope: EVAL_SCOPE })
      : budgetTarget(memStore);

    const evalRunId = store?.startEvalRun({
      setId: family.name,
      targetId: "companion",
      variant,
      model,
    });
    const onResult =
      store && evalRunId !== undefined
        ? createEvalResultRecorder(store, { evalRunId, targetId: "companion", model, variant })
        : undefined;

    const report: EvalReport<unknown, unknown, unknown> = await runEval(
      {
        // biome-ignore lint/suspicious/noExplicitAny: agent-vs-node target union, narrowed by runEval itself
        target: target as any,
        cases,
        scorers: family.scorers(memStore),
        ...(onResult ? { onResult } : {}),
      },
      {
        runner: runner ?? dryRunner(),
        eventBus,
        ...(evalRunId !== undefined ? { traceId: evalRunId } : {}),
      },
    );
    if (store && evalRunId !== undefined) {
      store.finishEvalRun(evalRunId, { status: report.summary.errored === 0 ? "ok" : "error" });
    }

    const rates = Object.entries(report.summary.passRate)
      .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
      .join(" · ");
    const familyPassed =
      report.summary.errored === 0 &&
      Object.values(report.summary.passRate).every((rate) => rate === 1);
    if (!familyPassed) anyGateFailed = true;
    process.stdout.write(
      `  ${familyPassed ? "PASS" : "FAIL"}  ${family.name}  (${report.summary.cases} cases · ${rates || "no gated scorers"})\n`,
    );
    for (const r of report.results) {
      for (const s of r.scores) {
        if (s.passed === false || s.value === null) {
          process.stdout.write(
            `        ✗ ${r.case.id} / ${s.name}${s.error ? ` — ERRORED: ${s.error}` : ""}${
              s.detail ? ` — ${JSON.stringify(s.detail)}` : ""
            }\n`,
          );
        }
      }
    }
  }

  if (skipped.length > 0) {
    process.stdout.write(
      `\n  skipped (no runner — set a provider key / AGENT_MODEL, or drop --dry): ${skipped.join(", ")}\n`,
    );
  }
  process.stdout.write(`\n${anyGateFailed ? "GATE FAILED" : "GATE PASSED"}\n`);
  process.exitCode = anyGateFailed ? 1 : 0;
}

/** Placeholder runner for dry mode — the deterministic family never calls it. */
function dryRunner(): RunnerProtocol {
  return {
    async run() {
      throw new Error("dry mode: no live runner — deterministic families only");
    },
  } as RunnerProtocol;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
