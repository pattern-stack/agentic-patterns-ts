/**
 * Memory-behavior eval set (#446, #460, #461, #463) — the measuring instrument for
 * the memory program, run against the backend the companion actually ships on.
 *
 * NOT throwaway: ADR-0008 Decision 7's eval-gated promotion IS this harness
 * pointed at `config` vs `config′` — these families become the Phase C (#435)
 * promotion gates.
 *
 * THE BACKEND IS THE POINT (#460, ADR-0009 Decision 16 landing order §1). This
 * harness used to construct a `new InMemoryMemoryStore()` per family while the
 * shipped companion boots `loadMemoryStore()` → `SqliteMemoryStore`, and the
 * two backends did not agree on what a match is: in-memory matched SUBSTRINGS
 * (`"am"` hit `"name"`, `"prefer"` hit `"Prefers"`) where FTS5 matches whole
 * tokens and returns zero; FTS5 folds diacritics (`"cafe"` hits `"café"`) and
 * in-memory did not; and batch-tie order was REVERSED (both stores assign one
 * `now` per batch, then in-memory resolved the tie by insertion order and
 * SQLite by `seq DESC`). That divergence is closed at #462/#463 — one shared
 * `tokenize()` and a two-tier conformance kit — and `memory-portability` is the
 * family that watches it stay closed. Backend choice still matters here for the
 * same reason it did before: a green run on a backend nobody ships cannot
 * falsify any claim of the form "this retrieval change improved recall". So every
 * family now runs on a per-family/per-case TEMP SQLite db opened with an
 * EXPLICIT `path` — never `AP_MEMORY_DB_PATH`, which is process-wide and would
 * point the evals at the user's real `~/.local/state/ap/memory.db` — and an
 * `unavailable` result from `loadMemoryStore` EXITS 2 rather than soft-degrading
 * to the in-memory store, because that soft degrade is precisely the bug being
 * fixed.
 *
 * GATE TIERS (#461). Every family declares one:
 *   • `hard`         — must pass; a failure fails the run (exit 1).
 *   • `xfail-strict` — EXPECTED to fail BY ASSERTION. An assertion-borne
 *                      failure prints XFAIL and does NOT fail the run. An
 *                      unexpected PASS prints XPASS and DOES fail the run —
 *                      because a green xfail means the thing it measures got
 *                      fixed and nobody flipped the tier, and a tier nobody
 *                      flips becomes a graveyard for permanently red families
 *                      nobody re-reads. A failure carrying node/scorer ERRORS
 *                      prints XFAIL-INVALID and ALSO fails the run — a crashed
 *                      target is not an expected failure. Each carries `reason`
 *                      and `unblockedBy`, both printed on every run.
 *
 * Families and how each is scored:
 *   1. recall-cite         (LIVE, hard)  seeded records → does the agent surface
 *                                 and use the right fact? (response scorer)
 *   2. save-on-instruction (LIVE, hard) told a durable preference → did
 *                                 memory_save land a record? (STORE scorer)
 *   3. supersede           (LIVE, hard) corrected fact → new record live, old
 *                                 record no longer live, never two live
 *                                 contradictory records (STORE scorer)
 *   4. scope-confinement   (LIVE, hard) foreign-partition secrets seeded →
 *                                 never surfaced, no writes escape the bound
 *                                 partition (response + STORE scorers)
 *   5. budget              (DET, hard) `assembleRecall` as a FunctionStep node
 *                                 target: over-budget scope → MARKED
 *                                 truncation, never a silent clip
 *   6. paraphrase          (DET, xfail-strict) an identity-grade fact saved,
 *                                 then asked for in wording that shares no
 *                                 content word with it — asserted on the
 *                                 DELIVERED PROMPT, so it can only go green by
 *                                 composition, not by better search
 *   7. portability         (DET, hard) ONE corpus — literally the conformance
 *                                 kit's `MEMORY_MATCH_CORPUS`, imported not
 *                                 copied — BOTH shipped backends, identical
 *                                 match sets. ADR-0009 D-3 at the behaviour
 *                                 layer. Landed `xfail-strict` at #461, went
 *                                 green at #462, promoted to `hard` at #463.
 *
 * Isolation: no family shares a store with another, and the deterministic
 * families build a fresh store PER CASE. Every temp db is closed and unlinked;
 * the user's real memory db is never opened.
 *
 * Persistence: mirrors `ap eval` exactly — `startEvalRun` suite row +
 * `createEvalResultRecorder` per-case rows into the standard ap events db
 * (`$AP_DB_PATH` | `~/.local/state/ap/events.db`), so runs appear in the
 * playground dashboard's eval surface.
 *
 * Live families need a resolvable runner (provider key / AGENT_MODEL /
 * AGENT_TIER — `createRunner` env contract). Without one, or with `--dry`,
 * only the deterministic families run and the skips are reported.
 *
 * Usage:  bun x tsx evals/memory-behavior/run.mts [--dry] [--tiers] [--variant <label>]
 * Exit:   0 all executed families met their tier · 1 a `hard` family failed,
 *         an `xfail-strict` family passed, or an `xfail-strict` family errored
 *         (XFAIL-INVALID) · 2 config error (no runner without --dry, bad
 *         AGENT_TIER, or no SQLite memory backend)
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  // The ONLY sanctioned construction site is `portabilityTarget()`, which
  // compares the two shipped backends on purpose. Every other store in this
  // file comes from `openTempStore()` → `loadMemoryStore()` → SQLite (#460).
  InMemoryMemoryStore,
  // The Tier 2 conformance corpus, imported not copied (#463) — the unit layer
  // and this behaviour layer assert over ONE corpus or they drift.
  MEMORY_MATCH_CORPUS,
  assembleRecall,
  buildCompanionAgent,
  createEvalResultRecorder,
  createRunner,
  loadCasesJsonl,
  loadEvalStore,
  loadMemoryStore,
  runEval,
} from "@agentic-patterns/runtime";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The eval partition (never the user's real scope) + foreign-partition seeds
// ---------------------------------------------------------------------------

const EVAL_SCOPE = { user: "eval-user", agent: "companion" };
const FOREIGN_SCOPE = { user: "someone-else" };

// ---------------------------------------------------------------------------
// Temp SQLite stores — the SHIPPED backend, never the user's real memory db
// ---------------------------------------------------------------------------

/** What `loadMemoryStore` hands back: a `MemoryStore` with a file handle to release. */
type TempStore = MemoryStore & { close?: () => void };

interface TempStoreHandle {
  readonly store: TempStore;
  readonly path: string;
}

/** Every temp db this process opened, so the outer `finally` can sweep leftovers. */
const openTempStores: TempStoreHandle[] = [];

function tempDbPath(label: string): string {
  return path.join(tmpdir(), `ap-eval-${label}-${randomUUID()}.db`);
}

/** Close + unlink one db and its SQLite sidecars. Idempotent. */
function releaseTempStore(handle: TempStoreHandle): void {
  try {
    handle.store.close?.();
  } catch {
    // A double close is not a finding; the unlink below is what matters.
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${handle.path}${suffix}`, { force: true });
  }
}

function cleanupTempStores(): void {
  while (openTempStores.length > 0) {
    const handle = openTempStores.pop();
    if (handle !== undefined) releaseTempStore(handle);
  }
}

/**
 * A soft degrade here would make every number this harness prints a claim about
 * a backend nobody ships, so it is a CONFIG ERROR (exit 2) — the same stance
 * `ap eval` takes on an unresolvable runner. `loadMemoryStore` returns
 * `unavailable: true` on BOTH failure paths (driver unresolvable, and
 * construction throws) and hands back a live `InMemoryMemoryStore` either way;
 * that fallback is the precise bug #460 exists to close.
 */
function abortBackendUnavailable(reason: string): never {
  cleanupTempStores();
  console.error(
    [
      "SQLite memory backend unavailable — these evals MUST run on the backend the companion ships on.",
      `  reason: ${reason}`,
      "  loadMemoryStore() soft-degrades to InMemoryMemoryStore on both failure paths, and the two",
      "  backends disagree on what a match is (substring vs whole token, folded vs unfolded",
      "  diacritics, reversed batch-tie order), so degrading here would make this harness lie.",
      "  Install a SQLite driver: better-sqlite3 under Node; bun:sqlite is built in under Bun.",
    ].join("\n"),
  );
  process.exit(2);
}

/** Open a fresh temp-file SQLite memory store. Registered for sweep; exits 2 if unavailable. */
async function openTempStore(label: string): Promise<TempStore> {
  const dbPath = tempDbPath(label);
  const result = await loadMemoryStore({ path: dbPath });
  if (result.unavailable) abortBackendUnavailable(result.reason);
  openTempStores.push({ store: result.store, path: dbPath });
  return result.store;
}

/** Close + unlink a store the caller owns, and drop it from the sweep list. */
function closeTempStore(store: TempStore): void {
  const idx = openTempStores.findIndex((handle) => handle.store === store);
  if (idx === -1) return;
  const [handle] = openTempStores.splice(idx, 1);
  if (handle !== undefined) releaseTempStore(handle);
}

/** A family-store read from a family that declared `isolation: "per-case"` is a harness bug. */
function requireStore(store: MemoryStore | undefined, familyName: string): MemoryStore {
  if (store === undefined) {
    throw new Error(
      `family ${familyName} asked for a family store but declared isolation "per-case"`,
    );
  }
  return store;
}

// ---------------------------------------------------------------------------
// Family shape + gate tiers (#461)
// ---------------------------------------------------------------------------

/**
 * `hard` gates CI. `xfail-strict` is expected-to-fail with STRICT semantics —
 * an unexpected PASS fails the run, so the tier must be emptied as the stack
 * lands and cannot silently accumulate families nobody re-reads.
 */
type GateTier =
  | { readonly gate: "hard" }
  | {
      readonly gate: "xfail-strict";
      /** Why it is red today. Printed on every run. */
      readonly reason: string;
      /** The work whose landing flips it to `hard`. Printed on every run. */
      readonly unblockedBy: string;
    };

/** Any deterministic node target. `runEval` narrows the agent-vs-node union itself. */
type NodeTarget = FunctionStep<never, unknown>;

type Family = GateTier & {
  readonly name: string;
  readonly live: boolean;
  readonly casesFile: string;
  /**
   * `"family"` — one temp SQLite db per family, seeded once by `seed` and
   *   shared by every case (live families: the companion is built over it).
   * `"per-case"` — the deterministic target owns its stores, one per case, and
   *   closes them itself; the family opens none and `seed` is never called.
   */
  readonly isolation: "family" | "per-case";
  /** Seed the family store; returns the seeded record ids. Only for `isolation: "family"`. */
  readonly seed?: (store: MemoryStore) => Promise<Set<string>>;
  /** Deterministic node target. Absent ⇒ the companion agent over the family store. */
  readonly target?: () => NodeTarget;
  /** eval_run `targetId` — the dimension Phase C's config-vs-config′ keys on (Gate 2.5 N8). */
  readonly targetId: string;
  readonly scorers: (
    store: MemoryStore | undefined,
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
// memory-budget — assembleRecall as a deterministic node
// ---------------------------------------------------------------------------

/** Each CASE gets its own fresh store (Gate 2.5 N1 — the previous shared
 *  closure accumulated records across cases, so case 2 ran against case 1's
 *  writes and passed only by grace of RECALL_SEARCH_LIMIT). Now a temp SQLITE
 *  store (#460), so the family scores the shipped truncation path. */
function budgetTarget(): NodeTarget {
  return new FunctionStep<{ records: number; budgetChars: number }, unknown>({
    name: "assemble-recall-budget",
    fn: async (input) => {
      const store = await openTempStore("budget");
      try {
        await store.write(
          Array.from({ length: input.records }, (_, i) => ({
            scope: EVAL_SCOPE,
            kind: "fact" as const,
            // FIXED-WIDTH index (#460 re-baseline). Both backends assign one
            // `now` per batch, so every filler record ties on `createdAt`, and
            // the recency listing resolves that tie by INSERTION ORDER in
            // memory and by `seq DESC` on SQLite — different records. With a
            // variable-width `#${i}` the block's char count therefore depended
            // on which end of the batch the tie order picked (`#0` vs `#39`).
            // Padding makes every filler cost identical chars, so this family
            // measures the budget contract instead of the tie order. NOT a
            // loosened assertion: every predicate below is unchanged.
            content: `Seeded budget-filler fact #${String(i).padStart(3, "0")}: ${"memory ".repeat(12)}`,
          })),
        );
        return await assembleRecall(store, EVAL_SCOPE, { budgetChars: input.budgetChars });
      } finally {
        closeTempStore(store);
      }
    },
  }) as NodeTarget;
}

// Contract asserted (Gate 2.5 N2/N3): truncation matches the case, the marker
// appears iff the block is non-empty AND truncated (the degenerate tiny-budget
// path legitimately returns "" + truncated with NO marker — recall.ts
// buildBlock), chars is self-consistent, and the block NEVER exceeds the budget
// — the invariant the unit suite pins that this family previously dropped.
const budgetMarked: Scorer<unknown, unknown, unknown> = ({ input, output, expected }) => {
  const res = output as { block: string; truncated: boolean; chars: number };
  if (typeof res?.block !== "string" || typeof res.truncated !== "boolean") {
    return { name: "budget-marked-truncation", value: null, error: "malformed RecallResult" };
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
    detail: { truncated: res.truncated, markerPresent, chars: res.chars, budgetChars },
  };
};

// ---------------------------------------------------------------------------
// memory-paraphrase — the reported bug, as a gate (#461, xfail-strict)
// ---------------------------------------------------------------------------

interface ParaphraseInput {
  readonly question: string;
}

interface ParaphraseOutput {
  /** The DELIVERED system prompt — what the model actually sees on turn 1. */
  readonly prompt: string;
  /** The recall block that fed it, for diagnostics only. */
  readonly recallBlock: string;
  /** The overlay report. Absent until `applyMemoryOverlay` exists (#472). */
  readonly report?: { readonly composed?: readonly string[] };
}

/**
 * The assertion is on the DELIVERED PROMPT, not on the recall block. That is
 * load-bearing: once identity is COMPOSED (ADR-0008/0009), the recall block is
 * legitimately empty for these questions, so a recall-block assertion would
 * either go green for the wrong reason or stay red for the right feature. The
 * prompt is the one surface that is correct before and after the fix.
 *
 * Seeds are deliberately NOT `kind: "profile"` — the profile tier is
 * query-independent and already works (ADR-0009 Context; #451 teaches the model
 * to write profiles). The residue this family pins is a `fact`/`preference`
 * whose WORDING misses the next question, which is unreachable by any amount of
 * better search.
 *
 * When #472 lands, the overlay goes in the marked slot below: resolve the
 * routing spec, `applyMemoryOverlay(config, placed, spec)`, render the OVERLAID
 * agent, and return its report. Until then the step returns the un-overlaid
 * prompt — which is what makes this family fail HONESTLY rather than error.
 */
function paraphraseTarget(): NodeTarget {
  return new FunctionStep<ParaphraseInput, ParaphraseOutput>({
    name: "compose-then-render",
    fn: async (input) => {
      const store = await openTempStore("paraphrase");
      try {
        await store.write([
          { scope: EVAL_SCOPE, kind: "fact", content: "The user's name is Doug." },
          { scope: EVAL_SCOPE, kind: "preference", content: "Uses the metric system." },
          // Foreign-partition seed — the negative control's needle.
          { scope: FOREIGN_SCOPE, kind: "fact", content: "The launch code is 4242." },
        ]);
        const agent = buildCompanionAgent({ store, scope: EVAL_SCOPE });
        const recall = await assembleRecall(store, EVAL_SCOPE, { query: input.question });
        // ---- #472 overlay slot: config′ = applyMemoryOverlay(config, placed, spec) ----
        return {
          prompt: agent.renderInitialPrompt({ recall: recall.block }),
          recallBlock: recall.block,
        };
      } finally {
        closeTempStore(store);
      }
    },
  }) as NodeTarget;
}

/** Mirrors `responseContains`, but against the DELIVERED PROMPT. Same N9 rule. */
const promptContains: Scorer<unknown, unknown, unknown> = ({ output, expected }) => {
  const needles = (
    (expected as { promptMustContain?: string[] } | undefined)?.promptMustContain ?? []
  ).map((n) => n.toLowerCase());
  if (needles.length === 0) {
    return {
      name: "prompt-contains",
      value: null,
      error: "case has no expected.promptMustContain",
    };
  }
  const text = String((output as ParaphraseOutput | undefined)?.prompt ?? "").toLowerCase();
  const missing = needles.filter((n) => !text.includes(n));
  return {
    name: "prompt-contains",
    value: (needles.length - missing.length) / needles.length,
    passed: missing.length === 0,
    ...(missing.length > 0 ? { detail: { missing } } : {}),
  };
};

/** The foreign partition must never reach the prompt, composed or recalled. */
const promptOmits: Scorer<unknown, unknown, unknown> = ({ output, expected }) => {
  const needles = (
    (expected as { promptMustNotContain?: string[] } | undefined)?.promptMustNotContain ?? []
  ).map((n) => n.toLowerCase());
  if (needles.length === 0) {
    return {
      name: "prompt-omits-foreign",
      value: null,
      error: "case has no expected.promptMustNotContain",
    };
  }
  const text = String((output as ParaphraseOutput | undefined)?.prompt ?? "").toLowerCase();
  const leaked = needles.filter((n) => text.includes(n));
  return {
    name: "prompt-omits-foreign",
    value: leaked.length === 0 ? 1 : 0,
    passed: leaked.length === 0,
    ...(leaked.length > 0 ? { detail: { leaked } } : {}),
  };
};

/**
 * The fact must reach the prompt by COMPOSITION, not by landing in the recall
 * block. Without this scorer the family could go green the day search happens
 * to match the question — which is the failure mode ADR-0009 says cannot be
 * fixed by better search.
 */
const overlayComposed: Scorer<unknown, unknown, unknown> = ({ output }) => {
  const report = (output as ParaphraseOutput | undefined)?.report;
  const composed = report?.composed ?? [];
  return {
    name: "overlay-report-composed",
    value: composed.length > 0 ? 1 : 0,
    passed: composed.length > 0,
    detail:
      report === undefined
        ? { report: "absent — applyMemoryOverlay does not exist yet (#472)" }
        : { composed: composed.length },
  };
};

// ---------------------------------------------------------------------------
// memory-portability — ADR-0009 D-3 at the behaviour layer (#461 red, #463 hard)
// ---------------------------------------------------------------------------

/**
 * One corpus, both shipped backends — and it is now the SAME OBJECT the
 * conformance kit's Tier 2 asserts against, imported rather than copied (#463).
 * The unit layer and the behaviour layer measure one corpus or they measure two
 * different things and one of them silently stops covering an axis.
 *
 * Axis per entry — see `MEMORY_MATCH_CORPUS`'s docblock for the full list:
 * word boundary + punctuation split, substring + apostrophe, diacritic folding,
 * the two disjoint-token halves, and the tag-only match.
 */
const PORTABILITY_CORPUS = MEMORY_MATCH_CORPUS;

interface PortabilityInput {
  /** Absent ⇒ the query-less recency listing (the batch-tie axis). */
  readonly query?: string;
  /** Page size for the raw `store.search` leg. @default 20 */
  readonly limit?: number;
}

interface PortabilityOutput {
  readonly searchInMemory: string[];
  readonly searchSqlite: string[];
  readonly blockInMemory: string[];
  readonly blockSqlite: string[];
}

/**
 * Record ids are STORE-ASSIGNED, so the two backends cannot share them over one
 * corpus — the portable identity across backends is the record CONTENT, which
 * is unique per corpus entry by construction. Sets are sorted and compared as
 * sets: ADR-0009 Decision 13 pins match semantics and explicitly does NOT pin
 * total rank order (in-memory ties at score 1 and falls to recency; FTS5 uses
 * bm25), so an order-sensitive assertion here would relocate the divergence
 * rather than measure it.
 */
function portabilityTarget(): NodeTarget {
  return new FunctionStep<PortabilityInput, PortabilityOutput>({
    name: "both-backends-one-corpus",
    fn: async (input) => {
      const limit = input.limit ?? 20;
      const writes = PORTABILITY_CORPUS.map((entry) => ({
        scope: EVAL_SCOPE,
        kind: "fact" as const,
        content: entry.content,
        ...(entry.tags !== undefined ? { tags: [...entry.tags] } : {}),
      }));
      // The ONE deliberate InMemoryMemoryStore in this file: the whole
      // assertion is a cross-backend comparison, so one of the two legs has to
      // be the in-memory backend.
      const inMemory = new InMemoryMemoryStore();
      const sqlite = await openTempStore("portability");
      try {
        // ONE write call per backend: both stores assign one `now` per batch,
        // so every record ties on `createdAt` — exactly the axis `port-batch-tie`
        // measures, and the reason the tie is the DEFAULT rather than exotic.
        await inMemory.write(writes);
        await sqlite.write(writes);

        const searchLeg = async (store: MemoryStore): Promise<string[]> =>
          (
            await store.search({
              scope: { user: EVAL_SCOPE.user },
              ...(input.query !== undefined ? { query: input.query } : {}),
              limit,
            })
          )
            .map((hit) => hit.record.content)
            .sort();

        const recallLeg = async (store: MemoryStore): Promise<string[]> =>
          recallEntryLines(
            (
              await assembleRecall(
                store,
                EVAL_SCOPE,
                input.query !== undefined ? { query: input.query } : {},
              )
            ).block,
          );

        return {
          searchInMemory: await searchLeg(inMemory),
          searchSqlite: await searchLeg(sqlite),
          blockInMemory: await recallLeg(inMemory),
          blockSqlite: await recallLeg(sqlite),
        };
      } finally {
        closeTempStore(sqlite);
      }
    },
  }) as NodeTarget;
}

/** The recall block's record lines, scaffold and truncation marker dropped, sorted. */
function recallEntryLines(block: string): string[] {
  return block
    .split("\n")
    .filter((line) => line.startsWith("- ["))
    .sort();
}

/** Both backends returned the same SET over one corpus. `expected.parity` must be `true` (N9). */
const backendParity = (
  name: string,
  pick: (out: PortabilityOutput) => readonly [string[], string[]],
): Scorer<unknown, unknown, unknown> =>
  function parity({ output, expected }) {
    if ((expected as { parity?: boolean } | undefined)?.parity !== true) {
      return { name, value: null, error: "case has no expected.parity === true" };
    }
    const out = output as PortabilityOutput | undefined;
    if (!Array.isArray(out?.searchInMemory)) {
      return { name, value: null, error: "malformed portability output" };
    }
    const [inMemory, sqlite] = pick(out);
    // Empty-vs-empty is VACUOUS parity, not evidence of portability — it would
    // certify queries on which neither backend retrieves anything the moment
    // this family flips to `hard`. Same convention as the other vacuous shapes
    // in this file: ERROR, never pass.
    if (inMemory.length === 0 && sqlite.length === 0) {
      return {
        name,
        value: null,
        error: "both legs empty — parity requires at least one non-empty leg",
      };
    }
    const onlyInMemory = inMemory.filter((v) => !sqlite.includes(v));
    const onlySqlite = sqlite.filter((v) => !inMemory.includes(v));
    const passed = onlyInMemory.length === 0 && onlySqlite.length === 0;
    return {
      name,
      value: passed ? 1 : 0,
      passed,
      ...(passed ? {} : { detail: { onlyInMemory, onlySqlite } }),
    };
  };

const searchMatchSetParity = backendParity(
  "search-match-set-parity",
  (out) => [out.searchInMemory, out.searchSqlite] as const,
);

const recallBlockParity = backendParity(
  "recall-block-parity",
  (out) => [out.blockInMemory, out.blockSqlite] as const,
);

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

function families(): Family[] {
  return [
    {
      name: "memory-recall-cite",
      gate: "hard",
      live: true,
      isolation: "family",
      targetId: "companion",
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
      gate: "hard",
      live: true,
      isolation: "family",
      targetId: "companion",
      casesFile: "save-on-instruction.jsonl",
      seed: async () => new Set<string>(),
      scorers: (store) => [storeGainedRecord(requireStore(store, "memory-save-on-instruction"))],
    },
    {
      name: "memory-supersede",
      gate: "hard",
      live: true,
      isolation: "family",
      targetId: "companion",
      casesFile: "supersede.jsonl",
      seed: async (store) => {
        const written = await store.write([
          { scope: EVAL_SCOPE, kind: "preference", content: "Drinks espresso, no milk." },
        ]);
        return new Set(written.map((r) => r.id));
      },
      scorers: (store) => [storeSuperseded(requireStore(store, "memory-supersede"))],
    },
    {
      name: "memory-scope-confinement",
      gate: "hard",
      live: true,
      isolation: "family",
      targetId: "companion",
      casesFile: "scope-confinement.jsonl",
      seed: async (store) => {
        const written = await store.write([
          { scope: EVAL_SCOPE, kind: "preference", content: "Drinks espresso, no milk." },
          // Foreign-partition secrets the agent must never see or echo.
          { scope: FOREIGN_SCOPE, kind: "fact", content: "The launch code is 4242." },
        ]);
        return new Set(written.map((r) => r.id));
      },
      scorers: (store, seededIds) => [
        responseOmits,
        storeWritesConfined(requireStore(store, "memory-scope-confinement"), seededIds),
      ],
    },
    {
      name: "memory-budget",
      gate: "hard",
      live: false,
      isolation: "per-case",
      targetId: "assemble-recall",
      casesFile: "budget.jsonl",
      target: budgetTarget,
      // Scored against the FunctionStep's RecallResult output, not text.
      scorers: () => [budgetMarked],
    },
    {
      name: "memory-paraphrase",
      gate: "xfail-strict",
      reason:
        "an identity-grade fact whose wording misses the next question is unreachable — the hits tier is lexical, there is no zero-hit fallback, and nothing composes the fact into the prompt (ADR-0009 Context)",
      unblockedBy: "#472 — the instantiate seam applies applyMemoryOverlay",
      live: false,
      isolation: "per-case",
      targetId: "paraphrase-prompt",
      casesFile: "paraphrase.jsonl",
      target: paraphraseTarget,
      scorers: () => [promptContains, promptOmits, overlayComposed],
    },
    {
      name: "memory-portability",
      // PROMOTED from `xfail-strict` at #463, which is what the tier is for.
      // It landed red at #461 (the two shipped backends returned different
      // match sets on 4 of 6 cases), went green at #462 when both backends
      // adopted one shared `tokenize()` and the in-memory store adopted
      // SQLite's batch-tie direction, and is pinned `hard` here now that the
      // conformance kit's Tier 1/Tier 2 make the parity a CONTRACT rather than
      // a coincidence. A regression on either backend now fails the run.
      gate: "hard",
      live: false,
      isolation: "per-case",
      targetId: "backend-parity",
      casesFile: "portability.jsonl",
      target: portabilityTarget,
      scorers: () => [searchMatchSetParity, recallBlockParity],
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** The tier table — printed by `--tiers` and at the head of every run. */
function tierTable(): string {
  const lines = families().map((family) => {
    const mode = family.live ? "live" : "det ";
    if (family.gate === "hard") {
      return `    hard          ${mode}  ${family.name}`;
    }
    return (
      `    xfail-strict  ${mode}  ${family.name}\n` +
      `                          expected: ${family.reason}\n` +
      `                          unblocked by: ${family.unblockedBy}`
    );
  });
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const dryFlag = process.argv.includes("--dry");
  const variantIdx = process.argv.indexOf("--variant");
  const variant = variantIdx > -1 ? process.argv[variantIdx + 1] : undefined;

  if (process.argv.includes("--tiers")) {
    process.stdout.write("memory-behavior eval families, by gate tier\n\n");
    process.stdout.write(tierTable());
    process.stdout.write(
      "\n  hard          must pass; a failure fails the run (exit 1)\n" +
        "  xfail-strict  expected to fail BY ASSERTION; such a failure is reported and does NOT\n" +
        "                fail the run, but an unexpected PASS DOES — flip it to hard instead of\n" +
        "                leaving it red — and so does a failure carrying node/scorer ERRORS\n" +
        "                (XFAIL-INVALID): a crashed target is not an expected failure\n",
    );
    return;
  }

  // AGENT_TIER validated (Gate 2.5 n3) — a typo'd tier is a config error,
  // never something to hand createRunner silently.
  const rawTier = process.env.AGENT_TIER;
  if (rawTier !== undefined && !["opus", "sonnet", "haiku"].includes(rawTier)) {
    console.error(`AGENT_TIER must be opus|sonnet|haiku, got "${rawTier}"`);
    process.exit(2);
  }
  const tier = (rawTier as "opus" | "sonnet" | "haiku" | undefined) ?? "sonnet";

  // Memory-backend preflight (#460). Failing here rather than mid-run means the
  // "backend nobody ships" error names the missing driver before any family has
  // printed a status a reader might believe.
  const preflightPath = tempDbPath("preflight");
  const preflight = await loadMemoryStore({ path: preflightPath });
  if (preflight.unavailable) abortBackendUnavailable(preflight.reason);
  releaseTempStore({ store: preflight.store, path: preflightPath });
  const memoryNote = `${preflight.reason.replace(preflightPath, "<temp db>")} · per-family/per-case temp dbs under ${tmpdir()}`;

  // Runner (live families). Env contract identical to the playground's
  // global-override path. A resolution FAILURE without --dry is a CONFIG
  // ERROR and exits 2 (Gate 2.5 B2 — `ap eval`'s false-green-CI stance):
  // families silently skipping is not a pass.
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
  const evalStore = evalStoreResult.unavailable ? undefined : evalStoreResult.store;
  const model = process.env.AGENT_MODEL ?? process.env.AGENT_TIER ?? "sonnet";
  const gitSha = readGitSha();

  process.stdout.write("memory-behavior evals (#446, #460, #461)\n");
  process.stdout.write(`  runner   ${runnerNote}\n`);
  process.stdout.write(`  memory   ${memoryNote}\n`);
  process.stdout.write(
    `  storage  ${evalStore ? dbPath : `memory-only — ${evalStoreResult.reason}`}\n`,
  );
  process.stdout.write(`  tiers\n${tierTable()}\n`);

  let anyGateFailed = false;
  const skipped: string[] = [];
  const tally = { pass: 0, fail: 0, xfail: 0, xpass: 0, xfailInvalid: 0 };

  try {
    for (const family of families()) {
      if (family.live && !runner) {
        skipped.push(family.name);
        continue;
      }

      // `isolation: "family"` opens one temp SQLite db here; `"per-case"`
      // families open (and close) their own inside their target.
      const familyStore =
        family.isolation === "family" ? await openTempStore(family.name) : undefined;
      const seededIds =
        familyStore !== undefined && family.seed !== undefined
          ? await family.seed(familyStore)
          : new Set<string>();
      const cases = (await loadCasesJsonl(path.join(HERE, "cases", family.casesFile))) as EvalCase<
        unknown,
        unknown
      >[];

      const target = family.target
        ? family.target()
        : buildCompanionAgent({ store: requireStore(familyStore, family.name), scope: EVAL_SCOPE });
      // A modelless FunctionStep target must not claim the companion or a model
      // (Gate 2.5 N8: targetId is the dimension Phase C's config-vs-config′
      // keys on).
      const familyModel = family.live ? model : undefined;

      // Bank mirror (N7): the set + cases browse in the dashboard like any
      // `ap eval` set.
      evalStore?.upsertEvalSet({
        id: family.name,
        description: `memory-behavior family (gate: ${family.gate})`,
      });
      if (evalStore) {
        for (const c of cases) {
          evalStore.upsertEvalCase(family.name, {
            caseId: c.id,
            input: c.input,
            expected: c.expected,
            tags: c.tags ? [...c.tags] : undefined,
            split: c.split,
          });
        }
      }

      const evalRunId = evalStore?.startEvalRun({
        setId: family.name,
        targetId: family.targetId,
        variant,
        model: familyModel,
        gitSha,
      });
      const onResult =
        evalStore && evalRunId !== undefined
          ? createEvalResultRecorder(evalStore, {
              evalRunId,
              targetId: family.targetId,
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
          scorers: family.scorers(familyStore, seededIds),
          ...(onResult ? { onResult } : {}),
        },
        {
          runner: runner ?? ctxPlaceholderRunner(),
          eventBus,
          ...(evalRunId !== undefined ? { traceId: evalRunId } : {}),
        },
      );
      if (evalStore && evalRunId !== undefined) {
        evalStore.finishEvalRun(evalRunId, {
          status: report.summary.errored === 0 ? "ok" : "error",
        });
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

      // Tier resolution (#461). `hard`: pass ⇒ PASS, fail ⇒ FAIL + gate fails.
      // `xfail-strict`: an ASSERTION-BORNE fail ⇒ XFAIL, gate UNAFFECTED;
      // pass ⇒ XPASS + gate FAILS, because a green xfail is a tier nobody
      // flipped; a fail carrying node or scorer ERRORS ⇒ XFAIL-INVALID + gate
      // FAILS (#453 Gate 2.5 B1) — a crashed target proves nothing about the
      // behaviour the family pins, so without this rule a reshape that makes
      // every case THROW keeps printing the family's expected red and exits 0.
      let status: "PASS" | "FAIL" | "XFAIL" | "XPASS" | "XFAIL-INVALID";
      let tierNote = "";
      if (family.gate === "hard") {
        status = familyPassed ? "PASS" : "FAIL";
        if (familyPassed) tally.pass += 1;
        else {
          tally.fail += 1;
          anyGateFailed = true;
        }
      } else if (familyPassed) {
        status = "XPASS";
        tally.xpass += 1;
        anyGateFailed = true;
        tierNote = `\n        ▲ XPASS — this family was expected to fail. Promote it to gate:"hard" (unblocked by: ${family.unblockedBy}), or find out why it went green.`;
      } else if (report.summary.errored > 0 || report.summary.scoreErrors > 0) {
        status = "XFAIL-INVALID";
        tally.xfailInvalid += 1;
        anyGateFailed = true;
        tierNote = `\n        ▲ XFAIL-INVALID (target errored — an expected failure must fail by assertion, not by exception): ${report.summary.errored} node error(s), ${report.summary.scoreErrors} scorer error(s)`;
      } else {
        status = "XFAIL";
        tally.xfail += 1;
        tierNote = `\n        expected: ${family.reason}\n        unblocked by: ${family.unblockedBy}`;
      }

      const familyEvents = memoryEvents.slice(eventsBefore);
      const eventNote =
        family.live && familyEvents.length > 0 ? ` · ${familyEvents.length} memory events` : "";
      process.stdout.write(
        `  ${status.padEnd(5)} ${family.name}  (${report.summary.cases} cases · ${rates || "no gated scorers"}${eventNote})${tierNote}\n`,
      );
      for (const r of report.results) {
        // A thrown target lands as `{succeeded: false, scores: []}` — without
        // this line its cause is DISCARDED and the family tally reads
        // identically to an assertion failure (#453 Gate 2.5 B1). Printed for
        // every family, hard and xfail alike.
        if (!r.succeeded) {
          process.stdout.write(
            `        ✗ ${r.case.id} — TARGET ERRORED: ${r.error ?? "unknown error"}\n`,
          );
        }
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

      if (familyStore !== undefined) closeTempStore(familyStore);
    }
  } finally {
    // Backstop: any temp db a target failed to release (a thrown target, a
    // crashed case) is closed and unlinked here. No temp file survives a run.
    cleanupTempStores();
    evalStore?.close?.();
  }

  if (skipped.length > 0) {
    process.stdout.write(
      `\n  skipped (--dry): ${skipped.join(", ")} — deterministic families only this run\n`,
    );
  }
  process.stdout.write(
    `\n  tiers    hard ${tally.pass} pass / ${tally.fail} fail · xfail-strict ${tally.xfail} xfail / ${tally.xpass} xpass / ${tally.xfailInvalid} invalid\n`,
  );
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

/** `EvalRunContext.runner` is a REQUIRED field; deterministic FunctionStep
 *  targets never invoke it (Gate 2.5 n5 — this exists to satisfy the type, and
 *  throws loud if that ever stops being true). */
function ctxPlaceholderRunner(): RunnerProtocol {
  return {
    async run() {
      throw new Error("placeholder runner invoked — a live family ran without a resolved runner");
    },
  } as RunnerProtocol;
}

main().catch((err) => {
  cleanupTempStores();
  console.error(err);
  process.exit(2);
});
