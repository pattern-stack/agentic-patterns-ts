/**
 * Slice-3 seed fixtures: one realistic eval run per family (renderer / sdc /
 * curation) plus an answer-bank set and a question-bundle set, written through
 * the slice-2 store API so every dashboard family screen (slices 5-10) can be
 * built and demoed against real-shaped data with zero external dependencies.
 *
 * Shape contract: `packages/agent-dashboard/docs/eval-family-contract.md`.
 * The dashboard's detail-payload TS types live inside `agent-dashboard` and are
 * deliberately NOT imported across packages — the shapes here mirror the
 * contract doc structurally (the established cross-repo pattern).
 *
 * Consumer-shape notes (where shipped consumers diverge from the doc sketch):
 * - `score-map` details carry BOTH `scores` and `axes` (same record):
 *   `ScoreMapDetail` reads only `axes`; `sdcAxisMeans` reads `scores ?? axes`.
 * - `curation-facts` details are FLAT (`survival` / `outboundTokens` /
 *   `typeCoverage` at top level, no `metrics` nesting): `curationFrontier` and
 *   `CurationFactsDetail` read top-level fields; `curationConfigTable`
 *   tolerates flat via its `d.metrics ?? d` fallback.
 * - `temporalSpreadDays` is a record with a `kept` field (config table reads
 *   `temporal.kept`).
 * - `report.pass` (top-level boolean) is required: the variant scoreboard's
 *   det lens is `report.pass === true`.
 * - Each judged case also carries a score literally named `judge` so
 *   `twoLensRollup`'s judge lens lights up (independent of detail payloads).
 *
 * DETERMINISM: every id, timestamp, and metric below is a fixed literal (all
 * timestamps in 2026-07; no `Date.now()` / `Math.random()`), and run-level
 * `meta.summary` numbers are COMPUTED from the per-case rows at seed time so
 * they can never drift from the data. Combined with the store's idempotent
 * write semantics (`upsertEvalSet` / `upsertEvalCase` ON CONFLICT,
 * `ingestEvalRun` transactional delete-then-insert full replacement),
 * re-running the seed is a clean no-op replacement.
 */

import type { EvalScoreLike, EvalStore, IngestEvalRunInput } from "@agentic-patterns/runtime";

// ---------------------------------------------------------------------------
// Fixed identity (exported so tests/consumers can address the seeded rows)
// ---------------------------------------------------------------------------

export const BANK_SET_ID = "bank:render-bench@v3";
export const BUNDLE_SET_ID = "bundle:cache:sdc-bench@v2";
export const RENDERER_RUN_ID = "seed-renderer-01";
export const SDC_RUN_ID = "seed-sdc-01";
export const CURATION_RUN_ID = "seed-curation-01";

export interface SeedSetSummary {
  readonly id: string;
  readonly family: string;
  readonly cases: number;
}
export interface SeedRunSummary {
  readonly id: string;
  readonly family: string;
  readonly results: number;
}
export interface SeedSummary {
  readonly sets: readonly SeedSetSummary[];
  readonly runs: readonly SeedRunSummary[];
}

// ---------------------------------------------------------------------------
// Small deterministic math helpers (mirror the dashboard's aggregation rules)
// ---------------------------------------------------------------------------

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return values.length > 0 ? sum / values.length : 0;
}

function p50(values: readonly number[]): number {
  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = Math.floor(xs.length / 2);
  const lo = xs[mid - 1];
  const hi = xs[mid];
  if (xs.length % 2 === 0 && lo !== undefined && hi !== undefined) return (lo + hi) / 2;
  return hi ?? 0;
}

// ---------------------------------------------------------------------------
// Answer bank (renderer source set) — frozen deal states + golden responses
// ---------------------------------------------------------------------------

interface BankCase {
  readonly fid: string;
  readonly title: string;
  readonly state: string;
  readonly golden: string;
}

const BANK_CASES: readonly BankCase[] = [
  {
    fid: "fid-001",
    title: "Northwind renewal — pricing commitment",
    state: [
      "## Deal state — Northwind Traders renewal (opp-2214)",
      "",
      "Stage: Negotiation · Owner: Priya Raman · Close date: 2026-08-14.",
      "On the 2026-06-12 pricing call [evidence-1] Dana Fuentes (VP Procurement) accepted the",
      "3-year term at $118k/yr with a 6% uplift cap [evidence-2]. Legal redlines returned",
      "2026-06-19 with two open items: liability cap language and a data-residency addendum",
      "[evidence-3].",
      "",
      "Risk: the incumbent BI vendor offered a 22% discount to retain the analytics seat",
      "[evidence-4]. Champion Marco Silva confirmed budget is approved through FY27",
      "[evidence-5].",
    ].join("\n"),
    golden: [
      "Northwind accepted a 3-year renewal at $118k/yr with a 6% uplift cap on the June 12",
      "pricing call [evidence-1][evidence-2]. Two legal items remain open (liability cap,",
      "data-residency addendum) [evidence-3]; the incumbent's 22% retention discount is the",
      "main competitive risk [evidence-4], but budget is approved through FY27 [evidence-5].",
    ].join("\n"),
  },
  {
    fid: "fid-002",
    title: "Acme expansion — economic buyer + blockers",
    state: [
      "## Deal state — Acme Corp expansion (opp-1873)",
      "",
      "Stage: Proposal · Owner: Jordan Blake · Close date: 2026-09-02.",
      "Economic buyer is CFO Elena Marsh [evidence-1]; she asked for a 3-year TCO model on",
      "2026-06-25 [evidence-2]. The security questionnaire (247 items) is 60% complete and",
      "gated on the SOC 2 Type II bridge letter [evidence-3].",
      "",
      "Procurement flagged that the MSA must move to Acme paper [evidence-4]. Next step:",
      "TCO review with Elena on 2026-07-22 [evidence-5].",
    ].join("\n"),
    golden: [
      "The economic buyer is CFO Elena Marsh [evidence-1]. Signature is blocked on the TCO",
      "model she requested [evidence-2], the SOC 2 bridge letter gating the security",
      "questionnaire [evidence-3], and procurement's requirement to move to Acme paper",
      "[evidence-4]. The TCO review is set for 2026-07-22 [evidence-5].",
    ].join("\n"),
  },
  {
    fid: "fid-003",
    title: "Globex pilot — conversion criteria",
    state: [
      "## Deal state — Globex pilot conversion (opp-2051)",
      "",
      "Stage: Pilot · Owner: Priya Raman · Close date: 2026-08-30.",
      "Pilot success criteria signed 2026-06-05: 30% reduction in triage time and adoption by",
      "12 of 15 analysts [evidence-1]. Week-4 readout shows 26% reduction and 11 active",
      "analysts [evidence-2]. Champion Kim Osei wants an exec readout before renewal budget",
      "review on 2026-07-28 [evidence-3].",
      "",
      "Open risk: the data-ingestion connector for their ticketing system slipped a sprint",
      "[evidence-4].",
    ].join("\n"),
    golden: [
      "Globex converts if the pilot hits 30% triage reduction and 12/15 analyst adoption",
      "[evidence-1]; week 4 stands at 26% and 11 analysts [evidence-2]. The exec readout must",
      "land before the 2026-07-28 budget review [evidence-3], and the ticketing connector",
      "slip is the open delivery risk [evidence-4].",
    ].join("\n"),
  },
  {
    fid: "fid-004",
    title: "Initech migration — timeline + owners",
    state: [
      "## Deal state — Initech platform migration (opp-1990)",
      "",
      "Stage: Commit · Owner: Jordan Blake · Close date: 2026-07-31.",
      "Order form signed by COO Ravi Nair 2026-07-01 [evidence-1]. Migration kickoff",
      "2026-07-15 with a 6-week cutover plan [evidence-2]; Initech assigns two platform",
      "engineers half-time [evidence-3]. Invoice terms are net-45 against the Q3 PO",
      "[evidence-4].",
      "",
      "Watch item: their staging environment refresh is scheduled mid-cutover [evidence-5].",
    ].join("\n"),
    golden: [
      "Initech signed on 2026-07-01 [evidence-1] and kicks off migration 2026-07-15 on a",
      "6-week cutover [evidence-2] with two half-time platform engineers assigned",
      "[evidence-3]. Billing is net-45 on the Q3 PO [evidence-4]; the mid-cutover staging",
      "refresh is the watch item [evidence-5].",
    ].join("\n"),
  },
  {
    fid: "fid-005",
    title: "Umbrella security review — status",
    state: [
      "## Deal state — Umbrella Health security review (opp-2103)",
      "",
      "Stage: Evaluation · Owner: Sam Whitfield · Close date: 2026-10-15.",
      "HIPAA architecture review passed 2026-06-20 [evidence-1]. Pen-test report delivered",
      "with two medium findings; remediation plan accepted 2026-07-03 [evidence-2]. BAA",
      "redlines are with our counsel [evidence-3].",
      "",
      "CISO Angela Duarte is the approver and meets quarterly — next window is the week of",
      "2026-08-10 [evidence-4].",
    ].join("\n"),
    golden: [
      "Umbrella's HIPAA review passed [evidence-1] and the pen-test remediation plan was",
      "accepted 2026-07-03 [evidence-2]. BAA redlines sit with our counsel [evidence-3], and",
      "CISO approval must catch the 2026-08-10 quarterly window [evidence-4].",
    ].join("\n"),
  },
  {
    fid: "fid-006",
    title: "Stark upsell — usage-triggered expansion",
    state: [
      "## Deal state — Stark Industries upsell (opp-2166)",
      "",
      "Stage: Discovery · Owner: Sam Whitfield · Close date: 2026-09-20.",
      "Usage crossed 92% of licensed seats in June [evidence-1]. Platform lead Maya Chen",
      "asked for API rate-limit tiers and SSO group mapping [evidence-2]. A 40-seat",
      "expansion at current unit price would land ~$64k ARR [evidence-3].",
      "",
      "Champion note: expansion must ride the existing MSA — no new legal cycle",
      "[evidence-4].",
    ].join("\n"),
    golden: [
      "Stark is at 92% seat utilization [evidence-1] and Maya Chen's asks are API rate-limit",
      "tiers plus SSO group mapping [evidence-2]. A 40-seat expansion is ~$64k ARR at current",
      "pricing [evidence-3] and must ride the existing MSA [evidence-4].",
    ].join("\n"),
  },
];

// ---------------------------------------------------------------------------
// Question bundle (sdc + curation source set) — gold expectations per fixture
// ---------------------------------------------------------------------------

interface GoldExpectation {
  readonly id: string;
  readonly kind: "deterministic" | "judge";
  readonly required: boolean;
  readonly weight: number;
  readonly text: string;
  readonly source: string;
}

interface BundleFixture {
  readonly fixtureId: string;
  readonly question: string;
  readonly scope: string;
  readonly asOf: string;
  readonly expectations: readonly GoldExpectation[];
  readonly goldenResponse: string;
}

function exp(
  id: string,
  kind: "deterministic" | "judge",
  required: boolean,
  weight: number,
  text: string,
  source: string,
): GoldExpectation {
  return { id, kind, required, weight, text, source };
}

const BUNDLE_FIXTURES: readonly BundleFixture[] = [
  {
    fixtureId: "fx-001",
    question: "What pricing did Northwind commit to on the renewal, and what is still open?",
    scope: "deal:opp-2214",
    asOf: "2026-07-10",
    expectations: [
      exp(
        "exp-001-a",
        "deterministic",
        true,
        3,
        "States the $118k/yr renewal price",
        "Pricing call 2026-06-12",
      ),
      exp(
        "exp-001-b",
        "deterministic",
        true,
        2,
        "States the 3-year term with 6% uplift cap",
        "Pricing call 2026-06-12",
      ),
      exp(
        "exp-001-c",
        "deterministic",
        true,
        2,
        "Names the two open legal items",
        "Legal redlines 2026-06-19",
      ),
      exp(
        "exp-001-d",
        "judge",
        false,
        1,
        "Flags the incumbent's 22% retention discount as a risk",
        "Competitive note 2026-06-16",
      ),
      exp(
        "exp-001-e",
        "judge",
        false,
        1,
        "Notes budget approved through FY27",
        "Champion sync 2026-06-24",
      ),
    ],
    goldenResponse:
      "Northwind committed to $118k/yr on a 3-year term with a 6% uplift cap; liability-cap " +
      "language and the data-residency addendum remain open in legal.",
  },
  {
    fixtureId: "fx-002",
    question: "Who is the economic buyer on the Acme expansion and what is blocking signature?",
    scope: "deal:opp-1873",
    asOf: "2026-07-10",
    expectations: [
      exp(
        "exp-002-a",
        "deterministic",
        true,
        3,
        "Identifies CFO Elena Marsh as economic buyer",
        "Exec intro email 2026-06-18",
      ),
      exp(
        "exp-002-b",
        "deterministic",
        true,
        2,
        "Lists the pending 3-year TCO model",
        "CFO call 2026-06-25",
      ),
      exp(
        "exp-002-c",
        "deterministic",
        true,
        2,
        "Lists the SOC 2 bridge letter gating security review",
        "Security thread 2026-06-30",
      ),
      exp(
        "exp-002-d",
        "judge",
        false,
        1,
        "Mentions the move to Acme paper for the MSA",
        "Procurement note 2026-07-02",
      ),
    ],
    goldenResponse:
      "CFO Elena Marsh is the economic buyer; signature is blocked on the 3-year TCO model, " +
      "the SOC 2 bridge letter, and moving the MSA to Acme paper.",
  },
  {
    fixtureId: "fx-003",
    question: "Summarize security-review status across the open enterprise deals.",
    scope: "portfolio:enterprise",
    asOf: "2026-07-10",
    expectations: [
      exp(
        "exp-003-a",
        "deterministic",
        true,
        3,
        "Reports Umbrella HIPAA review passed",
        "HIPAA review 2026-06-20",
      ),
      exp(
        "exp-003-b",
        "deterministic",
        true,
        2,
        "Reports Acme questionnaire at 60% gated on SOC 2 letter",
        "Security thread 2026-06-30",
      ),
      exp(
        "exp-003-c",
        "judge",
        true,
        2,
        "Characterizes pen-test findings as remediated/accepted",
        "Pen-test report 2026-07-03",
      ),
      exp(
        "exp-003-d",
        "judge",
        false,
        1,
        "Notes the BAA redlines with counsel",
        "Legal update 2026-07-05",
      ),
    ],
    goldenResponse:
      "Umbrella passed HIPAA review and accepted the pen-test remediation plan; Acme's " +
      "questionnaire is 60% done pending the SOC 2 bridge letter; BAA redlines are with counsel.",
  },
  {
    fixtureId: "fx-004",
    question: "Is the Globex pilot on track to convert, and what must happen before 2026-07-28?",
    scope: "deal:opp-2051",
    asOf: "2026-07-10",
    expectations: [
      exp(
        "exp-004-a",
        "deterministic",
        true,
        3,
        "Compares week-4 metrics to the signed success criteria",
        "Week-4 readout 2026-07-01",
      ),
      exp(
        "exp-004-b",
        "deterministic",
        true,
        2,
        "States the exec readout must precede the budget review",
        "Champion note 2026-07-02",
      ),
      exp(
        "exp-004-c",
        "judge",
        false,
        1,
        "Flags the ticketing connector slip",
        "Delivery standup 2026-07-06",
      ),
    ],
    goldenResponse:
      "Globex is close but short of criteria (26% vs 30% triage reduction, 11/12 analysts); " +
      "the exec readout must land before the 2026-07-28 budget review.",
  },
  {
    fixtureId: "fx-005",
    question: "What are the commercial terms and watch items on the Initech migration?",
    scope: "deal:opp-1990",
    asOf: "2026-07-10",
    expectations: [
      exp(
        "exp-005-a",
        "deterministic",
        true,
        3,
        "States the signed order form and 6-week cutover",
        "Order form 2026-07-01",
      ),
      exp(
        "exp-005-b",
        "deterministic",
        true,
        2,
        "States net-45 terms on the Q3 PO",
        "Finance email 2026-07-03",
      ),
      exp(
        "exp-005-c",
        "judge",
        false,
        1,
        "Flags the mid-cutover staging refresh",
        "Kickoff prep 2026-07-08",
      ),
    ],
    goldenResponse:
      "Initech signed 2026-07-01 with a 6-week cutover from 2026-07-15; billing is net-45 " +
      "against the Q3 PO. Watch the staging refresh scheduled mid-cutover.",
  },
  {
    fixtureId: "fx-006",
    question: "Which accounts show expansion signals this quarter and what would they be worth?",
    scope: "portfolio:all",
    asOf: "2026-07-10",
    expectations: [
      exp(
        "exp-006-a",
        "deterministic",
        true,
        3,
        "Surfaces Stark's 92% seat utilization",
        "Usage report 2026-07-01",
      ),
      exp(
        "exp-006-b",
        "deterministic",
        true,
        2,
        "Sizes the Stark expansion (~$64k ARR)",
        "Pricing worksheet 2026-07-05",
      ),
      exp(
        "exp-006-c",
        "judge",
        false,
        1,
        "Notes the no-new-legal-cycle constraint",
        "Champion note 2026-07-07",
      ),
    ],
    goldenResponse:
      "Stark Industries is the clear expansion signal: 92% seat utilization, a 40-seat add " +
      "worth ~$64k ARR, executable under the existing MSA.",
  },
];

function fixtureById(fixtureId: string): BundleFixture {
  const fx = BUNDLE_FIXTURES.find((f) => f.fixtureId === fixtureId);
  if (!fx) throw new Error(`seed: unknown fixture ${fixtureId}`);
  return fx;
}

// ---------------------------------------------------------------------------
// Renderer run — 3 variants x 4 fids = 12 render-grade cases
// ---------------------------------------------------------------------------

interface RendererVariantSpec {
  readonly key: string;
  readonly variant: {
    readonly shape: string;
    readonly verbosity: string;
    readonly tone: string;
    readonly citationMode: string;
    readonly model: string;
  };
}

const RENDER_VARIANTS: readonly RendererVariantSpec[] = [
  {
    key: "prose-brief-inline",
    variant: {
      shape: "prose",
      verbosity: "brief",
      tone: "plain",
      citationMode: "inline",
      model: "gpt-4o-mini",
    },
  },
  {
    key: "prose-standard-footnote",
    variant: {
      shape: "prose",
      verbosity: "standard",
      tone: "warm",
      citationMode: "footnote",
      model: "gpt-4o-mini",
    },
  },
  {
    key: "table-dense-inline",
    variant: {
      shape: "table",
      verbosity: "dense",
      tone: "plain",
      citationMode: "inline",
      model: "gpt-4o",
    },
  },
];

interface RenderJudge {
  readonly readability: number;
  readonly faithful_emphasis: number;
  readonly tone_differentiation: number;
}

interface RenderCaseSpec {
  readonly fid: string;
  readonly variantIdx: number;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedUsd: number;
  readonly ratio: number;
  readonly stateWords: number;
  /** null = judge skipped for this render (exercises the judge-less row). */
  readonly judge: RenderJudge | null;
  readonly status: "ok" | "presentation_fallback";
  readonly fidelityFailure: boolean;
  readonly retriedForLength: boolean;
  readonly coverage: {
    readonly status: "honest" | "dishonest" | "not_declared";
    readonly carried: number;
    readonly total: number;
  };
  /** inventedIds gate failure payload (gate passes when absent). */
  readonly inventedIds?: readonly string[];
  /** droppedIds gate failure payload (gate passes when absent). */
  readonly dropped?: { readonly ids: readonly string[]; readonly dropRatio: number };
}

// The failure coverage the family screens need: one invented-ids gate failure
// (fid-001 x table), one dishonest coverage declaration (fid-003 x footnote),
// one dropped-ids failure (fid-004 x table), one length retry, one
// presentation fallback, one judge-less render.
const RENDER_CASES: readonly RenderCaseSpec[] = [
  {
    fid: "fid-001",
    variantIdx: 0,
    latencyMs: 1450,
    inputTokens: 940,
    outputTokens: 210,
    estimatedUsd: 0.0028,
    ratio: 0.34,
    stateWords: 128,
    judge: { readability: 0.86, faithful_emphasis: 0.82, tone_differentiation: 0.58 },
    status: "ok",
    fidelityFailure: false,
    retriedForLength: false,
    coverage: { status: "honest", carried: 5, total: 5 },
  },
  {
    fid: "fid-002",
    variantIdx: 0,
    latencyMs: 1290,
    inputTokens: 905,
    outputTokens: 195,
    estimatedUsd: 0.0026,
    ratio: 0.31,
    stateWords: 117,
    judge: { readability: 0.84, faithful_emphasis: 0.79, tone_differentiation: 0.55 },
    status: "ok",
    fidelityFailure: false,
    retriedForLength: false,
    coverage: { status: "not_declared", carried: 5, total: 5 },
  },
  {
    fid: "fid-003",
    variantIdx: 0,
    latencyMs: 1520,
    inputTokens: 918,
    outputTokens: 224,
    estimatedUsd: 0.0029,
    ratio: 0.38,
    stateWords: 121,
    judge: null, // judge skipped (budget) — exercises judge:null + judged<n rollups
    status: "ok",
    fidelityFailure: false,
    retriedForLength: false,
    coverage: { status: "honest", carried: 4, total: 4 },
  },
  {
    fid: "fid-004",
    variantIdx: 0,
    latencyMs: 1180,
    inputTokens: 880,
    outputTokens: 182,
    estimatedUsd: 0.0025,
    ratio: 0.29,
    stateWords: 109,
    judge: { readability: 0.81, faithful_emphasis: 0.85, tone_differentiation: 0.61 },
    status: "ok",
    fidelityFailure: false,
    retriedForLength: false,
    coverage: { status: "honest", carried: 5, total: 5 },
  },
  {
    fid: "fid-001",
    variantIdx: 1,
    latencyMs: 2340,
    inputTokens: 990,
    outputTokens: 410,
    estimatedUsd: 0.0041,
    ratio: 0.58,
    stateWords: 128,
    judge: { readability: 0.88, faithful_emphasis: 0.84, tone_differentiation: 0.66 },
    status: "ok",
    fidelityFailure: false,
    retriedForLength: true, // first pass ran long
    coverage: { status: "honest", carried: 5, total: 5 },
  },
  {
    fid: "fid-002",
    variantIdx: 1,
    latencyMs: 2100,
    inputTokens: 954,
    outputTokens: 380,
    estimatedUsd: 0.0038,
    ratio: 0.52,
    stateWords: 117,
    judge: { readability: 0.9, faithful_emphasis: 0.86, tone_differentiation: 0.6 },
    status: "ok",
    fidelityFailure: false,
    retriedForLength: false,
    coverage: { status: "honest", carried: 5, total: 5 },
  },
  {
    fid: "fid-003",
    variantIdx: 1,
    latencyMs: 2260,
    inputTokens: 962,
    outputTokens: 395,
    estimatedUsd: 0.0039,
    ratio: 0.55,
    stateWords: 121,
    judge: { readability: 0.72, faithful_emphasis: 0.44, tone_differentiation: 0.57 },
    status: "ok",
    fidelityFailure: false,
    retriedForLength: false,
    // Claimed full coverage while carrying 3 of 8. Note buildReport also sets
    // coverageHonesty.pass=false for dishonest, so this trips BOTH arms of the
    // gate-failure rule (pass===false || status==='dishonest'), not the
    // status-only arm in isolation.
    coverage: { status: "dishonest", carried: 3, total: 8 },
  },
  {
    fid: "fid-004",
    variantIdx: 1,
    latencyMs: 1980,
    inputTokens: 930,
    outputTokens: 360,
    estimatedUsd: 0.0036,
    ratio: 0.49,
    stateWords: 109,
    judge: { readability: 0.87, faithful_emphasis: 0.88, tone_differentiation: 0.63 },
    status: "ok",
    fidelityFailure: false,
    retriedForLength: false,
    coverage: { status: "honest", carried: 5, total: 5 },
  },
  {
    fid: "fid-001",
    variantIdx: 2,
    latencyMs: 3120,
    inputTokens: 1105,
    outputTokens: 520,
    estimatedUsd: 0.0104,
    ratio: 0.71,
    stateWords: 128,
    judge: { readability: 0.65, faithful_emphasis: 0.4, tone_differentiation: 0.7 },
    status: "ok",
    fidelityFailure: true,
    retriedForLength: false,
    coverage: { status: "honest", carried: 5, total: 5 },
    inventedIds: ["evidence-9", "evidence-12"], // cited evidence that does not exist
  },
  {
    fid: "fid-002",
    variantIdx: 2,
    latencyMs: 2870,
    inputTokens: 1080,
    outputTokens: 465,
    estimatedUsd: 0.0096,
    ratio: 0.64,
    stateWords: 117,
    judge: { readability: 0.78, faithful_emphasis: 0.8, tone_differentiation: 0.42 },
    status: "presentation_fallback", // table shape fell back to prose; gates still pass
    fidelityFailure: false,
    retriedForLength: false,
    coverage: { status: "honest", carried: 5, total: 5 },
  },
  {
    fid: "fid-003",
    variantIdx: 2,
    latencyMs: 3040,
    inputTokens: 1092,
    outputTokens: 498,
    estimatedUsd: 0.0101,
    ratio: 0.68,
    stateWords: 121,
    judge: { readability: 0.83, faithful_emphasis: 0.77, tone_differentiation: 0.72 },
    status: "ok",
    fidelityFailure: false,
    retriedForLength: false,
    coverage: { status: "honest", carried: 4, total: 4 },
  },
  {
    fid: "fid-004",
    variantIdx: 2,
    latencyMs: 2950,
    inputTokens: 1064,
    outputTokens: 471,
    estimatedUsd: 0.0098,
    ratio: 0.66,
    stateWords: 109,
    judge: { readability: 0.7, faithful_emphasis: 0.52, tone_differentiation: 0.68 },
    status: "ok",
    fidelityFailure: false,
    retriedForLength: false,
    coverage: { status: "honest", carried: 3, total: 5 },
    dropped: { ids: ["evidence-4", "evidence-7", "evidence-8"], dropRatio: 0.375 },
  },
];

function variantOf(spec: RenderCaseSpec): RendererVariantSpec {
  const v = RENDER_VARIANTS[spec.variantIdx];
  if (!v) throw new Error(`seed: bad variantIdx ${spec.variantIdx}`);
  return v;
}

/** Deterministic rendered markdown per (fid, variant) — carries [evidence-N] markers. */
function renderedTextFor(spec: RenderCaseSpec): string {
  const bank = BANK_CASES.find((b) => b.fid === spec.fid);
  const body = bank ? bank.golden : "";
  const v = variantOf(spec);
  if (v.variant.shape === "table" && spec.status !== "presentation_fallback") {
    return [
      `### ${bank?.title ?? spec.fid}`,
      "",
      "| Fact | Evidence |",
      "| --- | --- |",
      "| Headline commitment | [evidence-1] [evidence-2] |",
      "| Open items | [evidence-3] |",
      "| Risk | [evidence-4] |",
      "",
      body,
    ].join("\n");
  }
  return [`### ${bank?.title ?? spec.fid}`, "", body].join("\n");
}

/** The de-facto RenderGradeReport shape the dashboard consumes (no shared TS type exists). */
function buildReport(spec: RenderCaseSpec): Record<string, unknown> {
  const inventedFail = spec.inventedIds !== undefined;
  const droppedFail = spec.dropped !== undefined;
  const dishonest = spec.coverage.status === "dishonest";
  const pass = !inventedFail && !droppedFail && !dishonest;
  return {
    pass, // top-level report gate — the scoreboard's det lens
    inventedIds: inventedFail
      ? { pass: false, inventedIds: [...(spec.inventedIds ?? [])] }
      : { pass: true, inventedIds: [] },
    droppedIds: droppedFail
      ? {
          pass: false,
          droppedIds: [...(spec.dropped?.ids ?? [])],
          dropRatio: spec.dropped?.dropRatio,
        }
      : { pass: true, droppedIds: [], dropRatio: 0 },
    inventedDates: { pass: true, invented: [] },
    inventedMoney: { pass: true, invented: [] },
    coverageHonesty: {
      status: spec.coverage.status,
      pass: !dishonest,
      actualCarried: spec.coverage.carried,
      actualTotal: spec.coverage.total,
    },
    tableIntegrity: { pass: true, strayPipeLines: [], unbalancedRowLines: [] },
    relativeLength: {
      ratio: spec.ratio,
      stateWords: spec.stateWords,
      renderedWords: Math.round(spec.stateWords * spec.ratio),
    },
  };
}

function buildRendererRun(): IngestEvalRunInput {
  const results: IngestEvalRunInput["results"][number][] = [];
  const latencies: number[] = [];
  const readabilities: number[] = [];
  let passed = 0;
  let flags = 0;
  let fallbacks = 0;
  let retries = 0;
  let costUsd = 0;

  for (const spec of RENDER_CASES) {
    const v = variantOf(spec);
    const report = buildReport(spec);
    const pass = report.pass === true;
    if (pass) passed += 1;
    if (spec.fidelityFailure || spec.status === "presentation_fallback") flags += 1;
    if (spec.status === "presentation_fallback") fallbacks += 1;
    if (spec.retriedForLength) retries += 1;
    costUsd += spec.estimatedUsd;
    latencies.push(spec.latencyMs);
    if (spec.judge) readabilities.push(spec.judge.readability);

    const carried = Math.min(spec.coverage.carried, spec.coverage.total);
    const detail: Record<string, unknown> = {
      kind: "render-grade",
      fid: spec.fid,
      variant: { ...v.variant },
      effective: {
        verbosity: v.variant.verbosity,
        tone: v.variant.tone,
        citationMode: v.variant.citationMode,
      },
      variantKey: v.key,
      regime: "grounded",
      status: spec.status,
      fidelityFailure: spec.fidelityFailure,
      retriedForLength: spec.retriedForLength,
      report,
      judge: spec.judge ? { ...spec.judge } : null,
      cost: {
        inputTokens: spec.inputTokens,
        outputTokens: spec.outputTokens,
        estimatedUsd: spec.estimatedUsd,
      },
      latencyMs: spec.latencyMs,
      renderedText: renderedTextFor(spec),
      carriedIds: Array.from({ length: carried }, (_, i) => `evidence-${i + 1}`),
      coverage: { carried: spec.coverage.carried, total: spec.coverage.total },
    };

    const scores: EvalScoreLike[] = [
      {
        name: "render-grade",
        value: pass ? 1 : 0,
        passed: pass,
        detail,
      },
      // twoLensRollup's judge lens reads a score literally named "judge".
      { name: "judge", value: spec.judge ? spec.judge.readability : null },
    ];

    results.push({ caseId: `${spec.fid}#${v.key}`, pass, scores });
  }

  const n = RENDER_CASES.length;
  const judgeMean = round(mean(readabilities), 4);

  return {
    run: {
      id: RENDERER_RUN_ID,
      setId: BANK_SET_ID,
      targetId: "answer-renderer",
      gitSha: "a1b2c3d4e5f6",
      tsStart: "2026-07-15T10:00:00.000Z",
      tsEnd: "2026-07-15T10:12:30.000Z",
      status: "ok",
      meta: {
        family: "renderer",
        benchmark: "render-bench",
        judgeModel: "claude-sonnet-4-5",
        gitBranch: "bench/render-grid",
        // Summary numbers are COMPUTED from the case rows above — the home
        // table and the per-case data can never disagree.
        summary: {
          detPassRate: round(passed / n, 4),
          judgeLens: { kind: "mean", value: judgeMean },
          costUsd: round(costUsd, 4),
          judgeCostUsd: 0.0112, // judge billed separately; authored constant
          latencyP50: p50(latencies),
          flagsRate: round(flags / n, 4),
          fallbackRate: round(fallbacks / n, 4),
          retriesRate: round(retries / n, 4),
        },
        renderer: {
          bankSetId: BANK_SET_ID,
          orderingChecks: ["stage-before-risks", "citations-follow-claims"],
          gridArgs: {
            states: 4,
            judgeMode: "full",
            models: ["gpt-4o-mini", "gpt-4o"],
          },
        },
      },
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// SDC run — 5 graded fixtures + 1 crashed fixture (meta.sdc.failures only)
// ---------------------------------------------------------------------------

interface SdcCaseSpec {
  readonly fixtureId: string;
  readonly axes: Readonly<Record<string, number>>;
  readonly hybrid: number;
  readonly dealIds: readonly string[];
  readonly missingContext: boolean;
  readonly citationCount: number;
  readonly retrievedSourceCount: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** Gold expectation ids whose judge verdict FAILED for this fixture. */
  readonly failedExpectations: readonly string[];
}

// Axes deliberately span several ScoreMapDetail buckets (Headline / Retrieval /
// Citations / Response quality / Hygiene) plus one unknown axis so the
// "Other axes" catch-all renders.
const SDC_CASES: readonly SdcCaseSpec[] = [
  {
    fixtureId: "fx-001",
    axes: {
      answer_correctness: 0.92,
      evidence_seen_recall: 0.88,
      citation_claim_support: 0.9,
      response_completeness: 0.86,
      missing_context_hygiene: 1,
      facet_decomposition_depth: 0.74,
    },
    hybrid: 0.89,
    dealIds: ["opp-2214"],
    missingContext: false,
    citationCount: 6,
    retrievedSourceCount: 14,
    costUsd: 0.041,
    latencyMs: 9200,
    failedExpectations: [],
  },
  {
    fixtureId: "fx-002",
    axes: {
      answer_correctness: 0.84,
      evidence_seen_recall: 0.8,
      citation_claim_support: 0.82,
      response_completeness: 0.78,
      missing_context_hygiene: 1,
      facet_decomposition_depth: 0.7,
    },
    hybrid: 0.81,
    dealIds: ["opp-1873"],
    missingContext: false,
    citationCount: 5,
    retrievedSourceCount: 12,
    costUsd: 0.038,
    latencyMs: 8700,
    failedExpectations: ["exp-002-d"], // optional miss — still passes
  },
  {
    fixtureId: "fx-003",
    axes: {
      answer_correctness: 0.76,
      evidence_seen_recall: 0.71,
      citation_claim_support: 0.74,
      response_completeness: 0.7,
      missing_context_hygiene: 0.5,
      facet_decomposition_depth: 0.66,
    },
    hybrid: 0.72,
    dealIds: ["opp-2103", "opp-1873"],
    missingContext: true,
    citationCount: 7,
    retrievedSourceCount: 21,
    costUsd: 0.057,
    latencyMs: 13400,
    failedExpectations: ["exp-003-d"], // optional miss — still passes
  },
  {
    fixtureId: "fx-004",
    axes: {
      answer_correctness: 0.58,
      evidence_seen_recall: 0.62,
      citation_claim_support: 0.55,
      response_completeness: 0.52,
      missing_context_hygiene: 1,
      facet_decomposition_depth: 0.6,
    },
    hybrid: 0.57,
    dealIds: ["opp-2051"],
    missingContext: false,
    citationCount: 3,
    retrievedSourceCount: 9,
    costUsd: 0.033,
    latencyMs: 7900,
    failedExpectations: ["exp-004-a", "exp-004-c"], // required miss — case FAILS
  },
  {
    fixtureId: "fx-005",
    axes: {
      answer_correctness: 0.9,
      evidence_seen_recall: 0.85,
      citation_claim_support: 0.87,
      response_completeness: 0.83,
      missing_context_hygiene: 1,
      facet_decomposition_depth: 0.72,
    },
    hybrid: 0.86,
    dealIds: ["opp-1990"],
    missingContext: false,
    citationCount: 5,
    retrievedSourceCount: 11,
    costUsd: 0.036,
    latencyMs: 8100,
    failedExpectations: [],
  },
];

const SDC_CRASHED_FIXTURE = {
  fixtureId: "fx-006",
  error: "resolver timeout after 90s (portfolio-scope deal-universe fanout)",
} as const;

function sdcAnswerMd(fx: BundleFixture, spec: SdcCaseSpec): string {
  const cites = Array.from({ length: spec.citationCount }, (_, i) => `[evidence-${i + 1}]`);
  return [
    `**Q:** ${fx.question}`,
    "",
    `${fx.goldenResponse} ${cites.slice(0, 3).join(" ")}`,
    "",
    `Grounding: ${spec.retrievedSourceCount} sources retrieved across ` +
      `${spec.dealIds.join(", ")} ${cites.slice(3).join(" ")}`,
  ].join("\n");
}

function buildSdcRun(): IngestEvalRunInput {
  const results: IngestEvalRunInput["results"][number][] = [];
  const latencies: number[] = [];
  const axisSums = new Map<string, { sum: number; n: number }>();
  let passed = 0;
  let verdictNum = 0;
  let verdictDen = 0;
  let costUsd = 0;

  for (const spec of SDC_CASES) {
    const fx = fixtureById(spec.fixtureId);
    const failed = new Set(spec.failedExpectations);
    const verdicts = fx.expectations.map((e) => ({
      expectationId: e.id,
      passed: !failed.has(e.id),
      reason: failed.has(e.id)
        ? `Answer does not establish: ${e.text.toLowerCase()}`
        : `Covered — ${e.text.toLowerCase()} (${e.source})`,
      evidence: failed.has(e.id) ? undefined : `[evidence-${(e.weight % 4) + 1}]`,
    }));
    const passedVerdicts = verdicts.filter((v) => v.passed).length;
    verdictNum += passedVerdicts;
    verdictDen += verdicts.length;

    // Deterministic gate: every REQUIRED expectation's verdict passed.
    const pass = fx.expectations.every((e) => !e.required || !failed.has(e.id));
    if (pass) passed += 1;
    costUsd += spec.costUsd;
    latencies.push(spec.latencyMs);
    for (const [k, v] of Object.entries(spec.axes)) {
      const acc = axisSums.get(k) ?? { sum: 0, n: 0 };
      acc.sum += v;
      acc.n += 1;
      axisSums.set(k, acc);
    }

    const axes: Record<string, number> = { ...spec.axes, hybrid: spec.hybrid };
    const scores: EvalScoreLike[] = [
      {
        name: "score-map",
        value: spec.hybrid,
        passed: pass,
        detail: {
          kind: "score-map",
          // Emit BOTH keys: ScoreMapDetail reads only `axes`; sdcAxisMeans
          // reads `scores ?? axes`. Same record on both.
          scores: axes,
          axes,
          hybrid: spec.hybrid,
          answerMd: sdcAnswerMd(fx, spec),
          dealIds: [...spec.dealIds],
          missingContext: spec.missingContext,
          citationCount: spec.citationCount,
          retrievedSourceCount: spec.retrievedSourceCount,
          costUsd: spec.costUsd,
          latencyMs: spec.latencyMs,
        },
      },
      {
        name: "judge-verdicts",
        value: round(passedVerdicts / verdicts.length, 4),
        passed: pass,
        detail: { kind: "judge-verdicts", verdicts },
      },
      { name: "judge", value: round(passedVerdicts / verdicts.length, 4) },
    ];

    results.push({ caseId: spec.fixtureId, pass, scores });
  }

  // Canonical run-level axis map: the bench's declared scores.json. The values
  // are DELIBERATELY offset (+0.02, rounded) from the per-case client means so
  // the dashboard's declared-wins-else-compute path is visibly exercised.
  const declaredScores: Record<string, number> = {};
  for (const [k, { sum, n }] of axisSums) declaredScores[k] = round(sum / n + 0.02, 2);

  return {
    run: {
      id: SDC_RUN_ID,
      setId: BUNDLE_SET_ID,
      targetId: "sdc-pipeline",
      model: "claude-sonnet-4-5",
      gitSha: "b2c3d4e5f6a7",
      tsStart: "2026-07-16T09:30:00.000Z",
      tsEnd: "2026-07-16T09:41:12.000Z",
      status: "ok",
      meta: {
        family: "sdc",
        benchmark: "sdc-bench",
        judgeModel: "claude-sonnet-4-5",
        gitBranch: "bench/sdc-nightly",
        summary: {
          detPassRate: round(passed / SDC_CASES.length, 4),
          judgeLens: {
            kind: "ratio",
            value: round(verdictNum / verdictDen, 4),
            num: verdictNum,
            den: verdictDen,
          },
          costUsd: round(costUsd, 4),
          judgeCostUsd: 0.0287,
          latencyP50: p50(latencies),
          crashedCount: 1,
        },
        sdc: {
          scores: declaredScores,
          failures: [SDC_CRASHED_FIXTURE], // fx-006 crashed: absent from results
        },
      },
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// Curation run — 4 configs x 3 fixtures; one config Pareto-dominated
// ---------------------------------------------------------------------------

interface CurationFixtureSpec {
  readonly fixtureId: string;
  /** Gold expectation ids whose content did NOT survive curation. */
  readonly droppedExpectations: readonly string[];
  readonly outboundTokens: number;
  readonly typeCoverage: Readonly<Record<string, { rowsKept: number; rowsAvail: number }>>;
  readonly temporalSpreadDays: { readonly kept: number; readonly available: number };
}

interface CurationConfigSpec {
  readonly configId: string;
  readonly knobs: Readonly<Record<string, unknown>>;
  readonly compressionPct: number;
  readonly nearDupRate: number;
  readonly deadRowRate: number;
  readonly dealCoverage: { readonly minShare: number; readonly zeroRowDeals: number };
  readonly temporalAlignment: number;
  readonly fixtures: readonly CurationFixtureSpec[];
}

// Pareto layout (survival mean vs mean outbound tokens):
//   cfg-baseline    1.000 / 9800   — on the computed front (max survival)
//   cfg-dedup       0.917 / 6400   — on the computed front
//   cfg-lopsided    0.850 / 6900   — DOMINATED by cfg-dedup (>= survival, <= tokens)
//   cfg-aggressive  0.767 / 3100   — on the computed front (min tokens)
// Declared frontier (meta.curation.frontier) lists only baseline + dedup, so
// declared-wins-else-compute is visible: cfg-aggressive flips to off-front.
const CURATION_CONFIGS: readonly CurationConfigSpec[] = [
  {
    configId: "cfg-baseline",
    knobs: { maxRows: 400, dedup: false, temporalWindow: "all", minRelevance: 0 },
    compressionPct: 18,
    nearDupRate: 0.21,
    deadRowRate: 0.09,
    dealCoverage: { minShare: 0.18, zeroRowDeals: 0 },
    temporalAlignment: 0.94,
    fixtures: [
      {
        fixtureId: "fx-001",
        droppedExpectations: [],
        outboundTokens: 9600,
        typeCoverage: {
          transcript: { rowsKept: 42, rowsAvail: 42 },
          email: { rowsKept: 31, rowsAvail: 31 },
          observation: { rowsKept: 26, rowsAvail: 26 },
          artifact: { rowsKept: 9, rowsAvail: 9 },
        },
        temporalSpreadDays: { kept: 142, available: 142 },
      },
      {
        fixtureId: "fx-002",
        droppedExpectations: [],
        outboundTokens: 10100,
        typeCoverage: {
          transcript: { rowsKept: 38, rowsAvail: 38 },
          email: { rowsKept: 44, rowsAvail: 44 },
          observation: { rowsKept: 22, rowsAvail: 22 },
          artifact: { rowsKept: 12, rowsAvail: 12 },
        },
        temporalSpreadDays: { kept: 128, available: 128 },
      },
      {
        fixtureId: "fx-003",
        droppedExpectations: [],
        outboundTokens: 9700,
        typeCoverage: {
          transcript: { rowsKept: 35, rowsAvail: 35 },
          email: { rowsKept: 40, rowsAvail: 40 },
          observation: { rowsKept: 30, rowsAvail: 30 },
          artifact: { rowsKept: 14, rowsAvail: 14 },
        },
        temporalSpreadDays: { kept: 151, available: 151 },
      },
    ],
  },
  {
    configId: "cfg-dedup",
    knobs: { maxRows: 250, dedup: true, temporalWindow: "all", minRelevance: 0.2 },
    compressionPct: 46,
    nearDupRate: 0.03,
    deadRowRate: 0.05,
    dealCoverage: { minShare: 0.14, zeroRowDeals: 0 },
    temporalAlignment: 0.91,
    fixtures: [
      {
        fixtureId: "fx-001",
        droppedExpectations: [],
        outboundTokens: 6200,
        typeCoverage: {
          transcript: { rowsKept: 30, rowsAvail: 42 },
          email: { rowsKept: 22, rowsAvail: 31 },
          observation: { rowsKept: 19, rowsAvail: 26 },
          artifact: { rowsKept: 8, rowsAvail: 9 },
        },
        temporalSpreadDays: { kept: 137, available: 142 },
      },
      {
        fixtureId: "fx-002",
        droppedExpectations: [],
        outboundTokens: 6600,
        typeCoverage: {
          transcript: { rowsKept: 27, rowsAvail: 38 },
          email: { rowsKept: 30, rowsAvail: 44 },
          observation: { rowsKept: 16, rowsAvail: 22 },
          artifact: { rowsKept: 10, rowsAvail: 12 },
        },
        temporalSpreadDays: { kept: 121, available: 128 },
      },
      {
        fixtureId: "fx-003",
        droppedExpectations: ["exp-003-d"],
        outboundTokens: 6400,
        typeCoverage: {
          transcript: { rowsKept: 24, rowsAvail: 35 },
          email: { rowsKept: 28, rowsAvail: 40 },
          observation: { rowsKept: 21, rowsAvail: 30 },
          artifact: { rowsKept: 11, rowsAvail: 14 },
        },
        temporalSpreadDays: { kept: 140, available: 151 },
      },
    ],
  },
  {
    configId: "cfg-lopsided",
    knobs: { maxRows: 200, dedup: false, temporalWindow: "90d", minRelevance: 0.35 },
    compressionPct: 42,
    nearDupRate: 0.19,
    deadRowRate: 0.11,
    dealCoverage: { minShare: 0.07, zeroRowDeals: 0 },
    temporalAlignment: 0.78,
    fixtures: [
      {
        fixtureId: "fx-001",
        droppedExpectations: ["exp-001-e"],
        outboundTokens: 6800,
        typeCoverage: {
          transcript: { rowsKept: 33, rowsAvail: 42 },
          email: { rowsKept: 12, rowsAvail: 31 },
          observation: { rowsKept: 20, rowsAvail: 26 },
          artifact: { rowsKept: 3, rowsAvail: 9 },
        },
        temporalSpreadDays: { kept: 84, available: 142 },
      },
      {
        fixtureId: "fx-002",
        droppedExpectations: [],
        outboundTokens: 7100,
        typeCoverage: {
          transcript: { rowsKept: 30, rowsAvail: 38 },
          email: { rowsKept: 18, rowsAvail: 44 },
          observation: { rowsKept: 17, rowsAvail: 22 },
          artifact: { rowsKept: 4, rowsAvail: 12 },
        },
        temporalSpreadDays: { kept: 79, available: 128 },
      },
      {
        fixtureId: "fx-003",
        droppedExpectations: ["exp-003-d"],
        outboundTokens: 6800,
        typeCoverage: {
          transcript: { rowsKept: 28, rowsAvail: 35 },
          email: { rowsKept: 15, rowsAvail: 40 },
          observation: { rowsKept: 24, rowsAvail: 30 },
          artifact: { rowsKept: 5, rowsAvail: 14 },
        },
        temporalSpreadDays: { kept: 88, available: 151 },
      },
    ],
  },
  {
    configId: "cfg-aggressive",
    knobs: { maxRows: 120, dedup: true, temporalWindow: "180d", minRelevance: 0.5 },
    compressionPct: 74,
    nearDupRate: 0.02,
    deadRowRate: 0.02,
    dealCoverage: { minShare: 0.05, zeroRowDeals: 1 },
    temporalAlignment: 0.83,
    fixtures: [
      {
        fixtureId: "fx-001",
        droppedExpectations: ["exp-001-d"],
        outboundTokens: 3000,
        typeCoverage: {
          transcript: { rowsKept: 14, rowsAvail: 42 },
          email: { rowsKept: 9, rowsAvail: 31 },
          observation: { rowsKept: 8, rowsAvail: 26 },
          artifact: { rowsKept: 2, rowsAvail: 9 },
        },
        temporalSpreadDays: { kept: 96, available: 142 },
      },
      {
        fixtureId: "fx-002",
        droppedExpectations: ["exp-002-c"],
        outboundTokens: 3200,
        typeCoverage: {
          transcript: { rowsKept: 12, rowsAvail: 38 },
          email: { rowsKept: 13, rowsAvail: 44 },
          observation: { rowsKept: 6, rowsAvail: 22 },
          artifact: { rowsKept: 3, rowsAvail: 12 },
        },
        temporalSpreadDays: { kept: 88, available: 128 },
      },
      {
        fixtureId: "fx-003",
        droppedExpectations: ["exp-003-b"],
        outboundTokens: 3100,
        typeCoverage: {
          transcript: { rowsKept: 11, rowsAvail: 35 },
          email: { rowsKept: 12, rowsAvail: 40 },
          observation: { rowsKept: 9, rowsAvail: 30 },
          artifact: { rowsKept: 4, rowsAvail: 14 },
        },
        temporalSpreadDays: { kept: 102, available: 151 },
      },
    ],
  },
];

const CURATION_DECLARED_FRONTIER = [
  { configId: "cfg-baseline" },
  { configId: "cfg-dedup" },
] as const;

/** Per-case deterministic pass gate: gold-fact survival >= 0.8. */
const CURATION_PASS_FLOOR = 0.8;

function buildCurationRun(): IngestEvalRunInput {
  const results: IngestEvalRunInput["results"][number][] = [];
  const perConfigSurvival = new Map<string, number[]>();
  const perConfigTokens = new Map<string, number[]>();
  let passed = 0;
  let total = 0;

  for (const cfg of CURATION_CONFIGS) {
    for (const fspec of cfg.fixtures) {
      const fx = fixtureById(fspec.fixtureId);
      const droppedSet = new Set(fspec.droppedExpectations);
      const perExpectation = fx.expectations.map((e) => ({
        expectationId: e.id,
        survived: !droppedSet.has(e.id),
        contentRetained: !droppedSet.has(e.id),
        availablePreCuration: true,
      }));
      const available = perExpectation.length;
      const survived = perExpectation.filter((p) => p.survived).length;
      const rate = round(survived / available, 4);
      const pass = rate >= CURATION_PASS_FLOOR;
      if (pass) passed += 1;
      total += 1;

      const sList = perConfigSurvival.get(cfg.configId) ?? [];
      sList.push(rate);
      perConfigSurvival.set(cfg.configId, sList);
      const tList = perConfigTokens.get(cfg.configId) ?? [];
      tList.push(fspec.outboundTokens);
      perConfigTokens.set(cfg.configId, tList);

      // FLAT detail (no `metrics` nesting): curationFrontier and
      // CurationFactsDetail read survival/outboundTokens/typeCoverage at the
      // top level; curationConfigTable's `d.metrics ?? d` fallback also reads
      // this shape (survival.rate via its d.survival fallback).
      const detail: Record<string, unknown> = {
        kind: "curation-facts",
        configId: cfg.configId,
        knobs: { ...cfg.knobs },
        survival: { rate, survived, available, perExpectation },
        outboundTokens: fspec.outboundTokens,
        typeCoverage: fspec.typeCoverage,
        compressionPct: cfg.compressionPct,
        dealCoverage: { ...cfg.dealCoverage },
        nearDupRate: cfg.nearDupRate,
        deadRowRate: cfg.deadRowRate,
        temporalAlignment: cfg.temporalAlignment,
        temporalSpreadDays: { ...fspec.temporalSpreadDays }, // record — table reads .kept
      };

      results.push({
        caseId: `${cfg.configId}#${fspec.fixtureId}`,
        pass,
        scores: [{ name: "curation-facts", value: rate, passed: pass, detail }],
      });
    }
  }

  // Best config by mean survival (ties broken by fewer tokens).
  let bestId = "";
  let bestSurvival = -1;
  let bestTokens = Number.POSITIVE_INFINITY;
  for (const cfg of CURATION_CONFIGS) {
    const s = mean(perConfigSurvival.get(cfg.configId) ?? []);
    const t = mean(perConfigTokens.get(cfg.configId) ?? []);
    if (s > bestSurvival || (s === bestSurvival && t < bestTokens)) {
      bestId = cfg.configId;
      bestSurvival = s;
      bestTokens = t;
    }
  }
  const bestCfg = CURATION_CONFIGS.find((c) => c.configId === bestId);

  const scoreboardMd = [
    "| config | survival | tokens |",
    "| --- | --- | --- |",
    ...CURATION_CONFIGS.map((cfg) => {
      const s = mean(perConfigSurvival.get(cfg.configId) ?? []);
      const t = mean(perConfigTokens.get(cfg.configId) ?? []);
      return `| ${cfg.configId} | ${round(s, 3)} | ${Math.round(t)} |`;
    }),
  ].join("\n");

  return {
    run: {
      id: CURATION_RUN_ID,
      setId: BUNDLE_SET_ID,
      targetId: "curation-sweep",
      gitSha: "c3d4e5f6a7b8",
      tsStart: "2026-07-17T14:05:00.000Z",
      tsEnd: "2026-07-17T14:09:44.000Z",
      status: "ok",
      meta: {
        family: "curation",
        benchmark: "sdc-bench",
        gitBranch: "bench/curation-sweep",
        summary: {
          detPassRate: round(passed / total, 4),
          survivalBest: round(bestSurvival, 4),
          tokensAtBest: Math.round(bestTokens),
          compressionPct: bestCfg?.compressionPct ?? 0,
          paretoCount: CURATION_DECLARED_FRONTIER.length,
          configCount: CURATION_CONFIGS.length,
        },
        curation: {
          sourceSetId: BUNDLE_SET_ID,
          // Declared front deliberately EXCLUDES cfg-aggressive (which client
          // recompute would keep) — exercises declared-wins-else-compute.
          frontier: [...CURATION_DECLARED_FRONTIER],
          scoreboardMd,
        },
      },
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Seed the two family sets and the three family runs into `store`.
 *
 * DETERMINISTIC + IDEMPOTENT: all ids/timestamps/metrics are fixed literals
 * (2026-07 vintage); re-running goes through `upsertEvalSet` / `upsertEvalCase`
 * ON CONFLICT and `ingestEvalRun`'s transactional full replacement, so a
 * second call leaves the store byte-identical (no duplicated rows).
 */
export function seedEvalFamilies(store: EvalStore): SeedSummary {
  // Answer bank — meta passed on EVERY upsert (ON CONFLICT rewrites meta_json;
  // omitting it would NULL the family identity).
  store.upsertEvalSet({
    id: BANK_SET_ID,
    name: "Answer bank — render-bench v3",
    description: "Frozen deal states + golden responses for the answer renderer.",
    createdTs: new Date("2026-07-10T08:00:00.000Z"),
    meta: { family: "answer-bank" },
  });
  for (const c of BANK_CASES) {
    store.upsertEvalCase(BANK_SET_ID, {
      caseId: c.fid,
      input: c.state,
      expected: c.golden,
      tags: ["seed", "render-bench"],
    });
  }

  // Question bundle.
  store.upsertEvalSet({
    id: BUNDLE_SET_ID,
    name: "Question bundle — sdc-bench v2 (cache)",
    description: "Cached benchmark fixtures with gold expectations for SDC + curation.",
    createdTs: new Date("2026-07-10T09:00:00.000Z"),
    meta: {
      family: "question-bundle",
      source: "cache",
      benchmark: "sdc-bench",
      version: "v2",
      dataset: "beanmaxx",
      createdAt: "2026-07-10T09:00:00.000Z",
      families: ["sdc", "curation"],
    },
  });
  for (const fx of BUNDLE_FIXTURES) {
    store.upsertEvalCase(BUNDLE_SET_ID, {
      caseId: fx.fixtureId,
      input: { question: fx.question, scope: fx.scope, as_of: fx.asOf },
      expected: {
        ground_truth: {
          expectations: fx.expectations,
          golden_response: fx.goldenResponse,
        },
      },
      tags: ["seed", "sdc-bench"],
    });
  }

  const rendererRun = buildRendererRun();
  const sdcRun = buildSdcRun();
  const curationRun = buildCurationRun();
  store.ingestEvalRun(rendererRun);
  store.ingestEvalRun(sdcRun);
  store.ingestEvalRun(curationRun);

  return {
    sets: [
      { id: BANK_SET_ID, family: "answer-bank", cases: BANK_CASES.length },
      { id: BUNDLE_SET_ID, family: "question-bundle", cases: BUNDLE_FIXTURES.length },
    ],
    runs: [
      { id: RENDERER_RUN_ID, family: "renderer", results: rendererRun.results.length },
      { id: SDC_RUN_ID, family: "sdc", results: sdcRun.results.length },
      { id: CURATION_RUN_ID, family: "curation", results: curationRun.results.length },
    ],
  };
}
