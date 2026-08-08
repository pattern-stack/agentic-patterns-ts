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

import { execSync } from "node:child_process";
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
  /** Seed the family's fresh store; returns the seeded record ids (empty set when none). */
  readonly seed: (store: MemoryStore) => Promise<Set<string>>;
  readonly scorers: (
    store: MemoryStore,
    seededIds: Set<string>,
  ) => Scorer<unknown, unknown, unknown>[];
};

// ---------------------------------------------------------------------------
// Scorer builders
// ---------------------------------------------------------------------------

/** Response text contains every needle in expected.mustContain (case-insensitive).
 *  A missing/empty needle list ERRORS (Gate 2.5 N9) — a typo'd expectation must
 *  never read as a clean pass. */
const responseContains: Scorer<unknown, unknown, unknown> = ({ output, expected }) => {
  const needles = ((expected as { mustContain?: string[] } | undefined)?.mustContain ?? []).map(
    (n) => n.toLowerCase(),
  );
  if (needles.length === 0) {
    return { name: "response-contains", value: null, error: "case has no expected.mustContain" };
  }
  const text = String(output ?? "").toLowerCase();
  const missing = needles.filter((n) => !text.includes(n));
  return {
    name: "response-contains",
    value: (needles.length - missing.length) / needles.length,
    passed: missing.length === 0,
    ...(missing.length > 0 ? { detail: { missing } } : {}),
  };
};

/** Response text contains NONE of expected.mustNotContain (case-insensitive).
 *  Same N9 rule: an absent needle list ERRORS rather than passing vacuously. */
const responseOmits: Scorer<unknown, unknown, unknown> = ({ output, expected }) => {
  const needles = (
    (expected as { mustNotContain?: string[] } | undefined)?.mustNotContain ?? []
  ).map((n) => n.toLowerCase());
  if (needles.length === 0) {
    return {
      name: "response-omits-foreign",
      value: null,
      error: "case has no expected.mustNotContain",
    };
  }
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

/** Supersede semantics: EXACTLY one live new-fact record (>1 = the duplicate
 *  the family exists to forbid), old fact not live-asserted alone, and the
 *  invalidation CHAIN intact — the invalidated record carries `supersededBy`
 *  (audit trail, ADR-0007 D4), never a bare invalidate or delete. */
const storeSuperseded = (store: MemoryStore): Scorer<unknown, unknown, unknown> => {
  return async function superseded({ expected }) {
    const exp = expected as { newFact?: string; oldFact?: string } | undefined;
    if (!exp?.newFact || !exp.oldFact) {
      return { name: "store-superseded", value: null, error: "expected {newFact, oldFact}" };
    }
    // Hoisted (Gate 2.5 n4): no `?? ""` fallback can silently no-op a filter.
    const newFact = exp.newFact.toLowerCase();
    const oldFact = exp.oldFact.toLowerCase();
    const liveNew = await liveMatches(store, newFact);
    // A live record contradicts only when it asserts the OLD fact without the
    // new one — "switched from espresso to matcha" mentions both and is a
    // correct correction, not a contradiction. (Substring-grade check; the
    // lexical window is documented in the README.)
    const liveOld = (await liveMatches(store, oldFact)).filter(
      (r) => !r.content.toLowerCase().includes(newFact),
    );
    // The audit trail must SURVIVE with the chain linked.
    const allOld = (
      await store.search({
        scope: { user: EVAL_SCOPE.user },
        includeInvalidated: true,
        limit: 100,
      })
    )
      .map((h) => h.record)
      .filter((r) => r.content.toLowerCase().includes(oldFact));
    const invalidatedOld = allOld.filter((r) => r.invalidAt !== undefined);
    const chainLinked = invalidatedOld.some((r) => r.supersededBy !== undefined);
    const passed =
      liveNew.length === 1 && liveOld.length === 0 && invalidatedOld.length > 0 && chainLinked;
    return {
      name: "store-superseded",
      value: passed ? 1 : 0,
      passed,
      detail: {
        liveNew: liveNew.length,
        liveOldContradictions: liveOld.length,
        invalidatedOld: invalidatedOld.length,
        chainLinked,
      },
    };
  };
};

/** UNIVERSAL write confinement (Gate 2.5 N5): after the run, every record in
 *  the WHOLE store that wasn't seeded must live inside the bound partition
 *  (`user` = the eval user; `agent`, when set, = "companion"). Catches any
 *  escape — a foreign user, a different agent key, a novel partition — not
 *  just one hardcoded foreign scope. */
const storeWritesConfined = (store: MemoryStore, seededIds: Set<string>) => {
  return async function writesConfined() {
    const all = (await store.search({ scope: {}, includeInvalidated: true, limit: 500 })).map(
      (h) => h.record,
    );
    const escaped = all.filter(
      (r) =>
        !seededIds.has(r.id) &&
        (r.scope.user !== EVAL_SCOPE.user ||
          (r.scope.agent !== undefined && r.scope.agent !== EVAL_SCOPE.agent)),
    );
    return {
      name: "store-writes-confined",
      value: escaped.length === 0 ? 1 : 0,
      passed: escaped.length === 0,
      detail: {
        totalRecords: all.length,
        seeded: seededIds.size,
        escaped: escaped.map((r) => r.scope),
      },
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
        const written = await store.write([
          { scope: EVAL_SCOPE, kind: "preference", content: "Drinks espresso, no milk." },
          { scope: EVAL_SCOPE, kind: "preference", content: "Prefers the vim editor." },
          { scope: EVAL_SCOPE, kind: "fact", content: "Works on the pattern-stack monorepo." },
        ]);
        return new Set(written.map((r) => r.id));
      },
      scorers: () => [responseContains],
    },
    {
      name: "memory-save-on-instruction",
      live: true,
      casesFile: "save-on-instruction.jsonl",
      seed: async () => new Set<string>(),
      scorers: (store) => [storeGainedRecord(store)],
    },
    {
      name: "memory-supersede",
      live: true,
      casesFile: "supersede.jsonl",
      seed: async (store) => {
        const written = await store.write([
          { scope: EVAL_SCOPE, kind: "preference", content: "Drinks espresso, no milk." },
        ]);
        return new Set(written.map((r) => r.id));
      },
      scorers: (store) => [storeSuperseded(store)],
    },
    {
      name: "memory-scope-confinement",
      live: true,
      casesFile: "scope-confinement.jsonl",
      seed: async (store) => {
        const written = await store.write([
          { scope: EVAL_SCOPE, kind: "preference", content: "Drinks espresso, no milk." },
          // Foreign-partition secrets the agent must never see or echo.
          { scope: FOREIGN_SCOPE, kind: "fact", content: "The launch code is 4242." },
        ]);
        return new Set(written.map((r) => r.id));
      },
      scorers: (store, seededIds) => [responseOmits, storeWritesConfined(store, seededIds)],
    },
    {
      name: "memory-budget",
      live: false,
      casesFile: "budget.jsonl",
      seed: async () => new Set<string>(),
      scorers: () => [
        // Scored against the FunctionStep's RecallResult output, not text.
        // Contract asserted (Gate 2.5 N2/N3): truncation matches the case,
        // the marker appears iff the block is non-empty AND truncated (the
        // degenerate tiny-budget path legitimately returns "" + truncated
        // with NO marker — recall.ts buildBlock), chars is self-consistent,
        // and the block NEVER exceeds the budget — the invariant the unit
        // suite pins that this family previously dropped.
        async function budgetMarked({ input, output, expected }) {
          const res = output as { block: string; truncated: boolean; chars: number };
          if (typeof res?.block !== "string" || typeof res.truncated !== "boolean") {
            return {
              name: "budget-marked-truncation",
              value: null,
              error: "malformed RecallResult",
            };
          }
          const budgetChars = (input as { budgetChars: number }).budgetChars;
          const wantTruncated = (expected as { truncated: boolean }).truncated;
          const markerPresent = res.block.includes("[recall budget reached");
          const markerOk =
            res.truncated && res.block.length > 0
              ? markerPresent
              : res.truncated
                ? !markerPresent // degenerate "" + truncated: no marker is correct
                : !markerPresent;
          const passed =
            res.truncated === wantTruncated &&
            markerOk &&
            res.chars === res.block.length &&
            res.block.length <= budgetChars;
          return {
            name: "budget-marked-truncation",
            value: passed ? 1 : 0,
            passed,
            detail: {
              truncated: res.truncated,
              markerPresent,
              chars: res.chars,
              budgetChars,
            },
          };
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Budget family target — assembleRecall as a deterministic node
// ---------------------------------------------------------------------------

/** Each CASE gets its own fresh store (Gate 2.5 N1 — the previous shared
 *  closure accumulated records across cases, so case 2 ran against case 1's
 *  writes and passed only by grace of RECALL_SEARCH_LIMIT). */
function budgetTarget() {
  return new FunctionStep<{ records: number; budgetChars: number }, unknown>({
    name: "assemble-recall-budget",
    fn: async (input) => {
      const store = new InMemoryMemoryStore();
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

  // AGENT_TIER validated (Gate 2.5 n3) — a typo'd tier is a config error,
  // never something to hand createRunner silently.
  const rawTier = process.env.AGENT_TIER;
  if (rawTier !== undefined && !["opus", "sonnet", "haiku"].includes(rawTier)) {
    console.error(`AGENT_TIER must be opus|sonnet|haiku, got "${rawTier}"`);
    process.exit(2);
  }
  const tier = (rawTier as "opus" | "sonnet" | "haiku" | undefined) ?? "sonnet";

  // Runner (live families). Env contract identical to the playground's
  // global-override path. A resolution FAILURE without --dry is a CONFIG
  // ERROR and exits 2 (Gate 2.5 B2 — `ap eval`'s false-green-CI stance):
  // four of five families silently skipping is not a pass.
  const eventBus = new AgentEventBus();
  let runner: RunnerProtocol | undefined;
  let runnerNote = "dry (--dry) — live families out of scope for this run";
  if (!dryFlag) {
    try {
      const selection = await createRunner({ eventBus, tier, verbose: false });
      runner = selection.runner;
      runnerNote = `${selection.source} — ${selection.reason}`;
    } catch (err) {
      console.error(
        `runner resolution failed (config error — pass --dry to run only the deterministic families): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exit(2);
    }
  }

  // Event diagnostics (Gate 2.5 N6): collect agent.memory.* traffic per run.
  // Deliberately NOT gated — tool-event emission is runner-dependent (the
  // claude-CLI fallback executes tools without a ToolExecutionContext, #445
  // Gate 2.5 B3), so gating on events would flake by runner. Reported so a
  // human can see whether the agent actually searched/saved.
  const memoryEvents: string[] = [];
  for (const type of ["agent.memory.write", "agent.memory.search", "agent.memory.recall"]) {
    eventBus.subscribe(type, (e) => {
      memoryEvents.push((e as { type: string }).type);
    });
  }

  // Persistence — the standard ap events db; suite + per-case rows AND the
  // set/case bank via the same calls `ap eval` makes, so the dashboard's
  // eval surface can browse these sets. gitSha stamps promotion provenance
  // (Gate 2.5 N7).
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
  const gitSha = readGitSha();

  process.stdout.write("memory-behavior evals (#446)\n");
  process.stdout.write(`  runner   ${runnerNote}\n`);
  process.stdout.write(
    `  storage  ${store ? dbPath : `memory-only — ${evalStoreResult.reason}`}\n\n`,
  );

  let anyGateFailed = false;
  const skipped: string[] = [];

  try {
    for (const family of families()) {
      if (family.live && !runner) {
        skipped.push(family.name);
        continue;
      }

      const memStore = new InMemoryMemoryStore();
      const seededIds = await family.seed(memStore);
      const cases = (await loadCasesJsonl(path.join(HERE, "cases", family.casesFile))) as EvalCase<
        unknown,
        unknown
      >[];

      const target = family.live
        ? buildCompanionAgent({ store: memStore, scope: EVAL_SCOPE })
        : budgetTarget();
      // The budget family's target is a modelless FunctionStep — its rows must
      // not claim the companion or a model (Gate 2.5 N8: targetId is the
      // dimension Phase C's config-vs-config′ keys on).
      const targetId = family.live ? "companion" : "assemble-recall";
      const familyModel = family.live ? model : undefined;

      // Bank mirror (N7): the set + cases browse in the dashboard like any
      // `ap eval` set.
      store?.upsertEvalSet({ id: family.name, description: "memory-behavior family (#446)" });
      if (store) {
        for (const c of cases) {
          store.upsertEvalCase(family.name, {
            caseId: c.id,
            input: c.input,
            expected: c.expected,
            tags: c.tags ? [...c.tags] : undefined,
            split: c.split,
          });
        }
      }

      const evalRunId = store?.startEvalRun({
        setId: family.name,
        targetId,
        variant,
        model: familyModel,
        gitSha,
      });
      const onResult =
        store && evalRunId !== undefined
          ? createEvalResultRecorder(store, {
              evalRunId,
              targetId,
              model: familyModel,
              variant,
            })
          : undefined;

      const eventsBefore = memoryEvents.length;
      const report: EvalReport<unknown, unknown, unknown> = await runEval(
        {
          // biome-ignore lint/suspicious/noExplicitAny: agent-vs-node target union, narrowed by runEval itself
          target: target as any,
          cases,
          scorers: family.scorers(memStore, seededIds),
          ...(onResult ? { onResult } : {}),
        },
        {
          runner: runner ?? ctxPlaceholderRunner(),
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
      // The gate (Gate 2.5 B1, `ap eval` parity): node errors, SCORER errors,
      // and an empty passRate all fail — "no gated scorers" must never read
      // as PASS.
      const familyPassed =
        report.summary.errored === 0 &&
        report.summary.scoreErrors === 0 &&
        Object.keys(report.summary.passRate).length > 0 &&
        Object.values(report.summary.passRate).every((rate) => rate === 1);
      if (!familyPassed) anyGateFailed = true;
      const familyEvents = memoryEvents.slice(eventsBefore);
      const eventNote =
        family.live && familyEvents.length > 0 ? ` · ${familyEvents.length} memory events` : "";
      process.stdout.write(
        `  ${familyPassed ? "PASS" : "FAIL"}  ${family.name}  (${report.summary.cases} cases · ${rates || "no gated scorers"}${eventNote})\n`,
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
  } finally {
    store?.close?.();
  }

  if (skipped.length > 0) {
    process.stdout.write(
      `\n  skipped (--dry): ${skipped.join(", ")} — deterministic families only this run\n`,
    );
  }
  process.stdout.write(`\n${anyGateFailed ? "GATE FAILED" : "GATE PASSED"}\n`);
  process.exitCode = anyGateFailed ? 1 : 0;
}

/** Best-effort HEAD sha for eval_run provenance — mirrors `ap eval`'s readGitSha. */
function readGitSha(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/** `EvalRunContext.runner` is a REQUIRED field; the budget family's
 *  FunctionStep target never invokes it (Gate 2.5 n5 — this exists to satisfy
 *  the type, and throws loud if that ever stops being true). */
function ctxPlaceholderRunner(): RunnerProtocol {
  return {
    async run() {
      throw new Error("placeholder runner invoked — a live family ran without a resolved runner");
    },
  } as RunnerProtocol;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
