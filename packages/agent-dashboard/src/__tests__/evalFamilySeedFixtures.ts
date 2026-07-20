/**
 * Seed-lifted fixture literals for the slice-9 fixture-explorer tests —
 * payloads copied from `packages/agent-cli/src/eval-seed/seed-eval-families.ts`
 * (the consumer-verified shapes: same ids, same field names). Not a test file;
 * imported by the sets/case page suites + `evalFixtureExplorers.test.tsx`.
 */

import type { EvalCaseRow, EvalSetSummary } from "../api/types";

export const BANK_SET_ID = "bank:render-bench@v3";
export const BUNDLE_SET_ID = "bundle:cache:sdc-bench@v2";

/** `fid-001` deal state (verbatim from the seed). */
export const FID_001_STATE = [
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
].join("\n");

/** `fid-001` golden response (verbatim from the seed). */
export const FID_001_GOLDEN = [
  "Northwind accepted a 3-year renewal at $118k/yr with a 6% uplift cap on the June 12",
  "pricing call [evidence-1][evidence-2]. Two legal items remain open (liability cap,",
  "data-residency addendum) [evidence-3]; the incumbent's 22% retention discount is the",
  "main competitive risk [evidence-4], but budget is approved through FY27 [evidence-5].",
].join("\n");

/** `fid-002` deal state (verbatim from the seed). */
export const FID_002_STATE = [
  "## Deal state — Acme Corp expansion (opp-1873)",
  "",
  "Stage: Proposal · Owner: Jordan Blake · Close date: 2026-09-02.",
  "Economic buyer is CFO Elena Marsh [evidence-1]; she asked for a 3-year TCO model on",
  "2026-06-25 [evidence-2]. The security questionnaire (247 items) is 60% complete and",
  "gated on the SOC 2 Type II bridge letter [evidence-3].",
  "",
  "Procurement flagged that the MSA must move to Acme paper [evidence-4]. Next step:",
  "TCO review with Elena on 2026-07-22 [evidence-5].",
].join("\n");

/** `fid-002` golden response (verbatim from the seed). */
export const FID_002_GOLDEN = [
  "The economic buyer is CFO Elena Marsh [evidence-1]. Signature is blocked on the TCO",
  "model she requested [evidence-2], the SOC 2 bridge letter gating the security",
  "questionnaire [evidence-3], and procurement's requirement to move to Acme paper",
  "[evidence-4]. The TCO review is set for 2026-07-22 [evidence-5].",
].join("\n");

export const BANK_CASES: EvalCaseRow[] = [
  {
    setId: BANK_SET_ID,
    caseId: "fid-001",
    input: FID_001_STATE,
    expected: FID_001_GOLDEN,
    tags: ["seed", "render-bench"],
    split: null,
  },
  {
    setId: BANK_SET_ID,
    caseId: "fid-002",
    input: FID_002_STATE,
    expected: FID_002_GOLDEN,
    tags: ["seed", "render-bench"],
    split: null,
  },
];

export const BANK_SET_SUMMARY: EvalSetSummary = {
  id: BANK_SET_ID,
  name: "Answer bank — render-bench v3",
  description: "Frozen deal states + golden responses for the answer renderer.",
  createdTs: "2026-07-10T08:00:00.000Z",
  caseCount: BANK_CASES.length,
  splitCounts: { "": BANK_CASES.length },
  meta: { family: "answer-bank" },
};

/** `fx-001` expectations (verbatim from the seed; 3 required of 5). */
export const FX_001_EXPECTATIONS = [
  {
    id: "exp-001-a",
    kind: "deterministic",
    required: true,
    weight: 3,
    text: "States the $118k/yr renewal price",
    source: "Pricing call 2026-06-12",
  },
  {
    id: "exp-001-b",
    kind: "deterministic",
    required: true,
    weight: 2,
    text: "States the 3-year term with 6% uplift cap",
    source: "Pricing call 2026-06-12",
  },
  {
    id: "exp-001-c",
    kind: "deterministic",
    required: true,
    weight: 2,
    text: "Names the two open legal items",
    source: "Legal redlines 2026-06-19",
  },
  {
    id: "exp-001-d",
    kind: "judge",
    required: false,
    weight: 1,
    text: "Flags the incumbent's 22% retention discount as a risk",
    source: "Competitive note 2026-06-16",
  },
  {
    id: "exp-001-e",
    kind: "judge",
    required: false,
    weight: 1,
    text: "Notes budget approved through FY27",
    source: "Champion sync 2026-06-24",
  },
] as const;

/** `fx-003` expectations (verbatim from the seed; 3 required of 4). */
export const FX_003_EXPECTATIONS = [
  {
    id: "exp-003-a",
    kind: "deterministic",
    required: true,
    weight: 3,
    text: "Reports Umbrella HIPAA review passed",
    source: "HIPAA review 2026-06-20",
  },
  {
    id: "exp-003-b",
    kind: "deterministic",
    required: true,
    weight: 2,
    text: "Reports Acme questionnaire at 60% gated on SOC 2 letter",
    source: "Security thread 2026-06-30",
  },
  {
    id: "exp-003-c",
    kind: "judge",
    required: true,
    weight: 2,
    text: "Characterizes pen-test findings as remediated/accepted",
    source: "Pen-test report 2026-07-03",
  },
  {
    id: "exp-003-d",
    kind: "judge",
    required: false,
    weight: 1,
    text: "Notes the BAA redlines with counsel",
    source: "Legal update 2026-07-05",
  },
] as const;

export const FX_001_QUESTION =
  "What pricing did Northwind commit to on the renewal, and what is still open?";
export const FX_003_QUESTION = "Summarize security-review status across the open enterprise deals.";

export const FX_001_GOLDEN_RESPONSE =
  "Northwind committed to $118k/yr on a 3-year term with a 6% uplift cap; liability-cap " +
  "language and the data-residency addendum remain open in legal.";
export const FX_003_GOLDEN_RESPONSE =
  "Umbrella passed HIPAA review and accepted the pen-test remediation plan; Acme's " +
  "questionnaire is 60% done pending the SOC 2 bridge letter; BAA redlines are with counsel.";

/** Splits deviate from the (untagged) seed so the split filter has facets. */
export const BUNDLE_CASES: EvalCaseRow[] = [
  {
    setId: BUNDLE_SET_ID,
    caseId: "fx-001",
    input: { question: FX_001_QUESTION, scope: "deal:opp-2214", as_of: "2026-07-10" },
    expected: {
      ground_truth: {
        expectations: FX_001_EXPECTATIONS,
        golden_response: FX_001_GOLDEN_RESPONSE,
      },
    },
    tags: ["seed", "sdc-bench"],
    split: "train",
  },
  {
    setId: BUNDLE_SET_ID,
    caseId: "fx-003",
    input: { question: FX_003_QUESTION, scope: "portfolio:enterprise", as_of: "2026-07-10" },
    expected: {
      ground_truth: {
        expectations: FX_003_EXPECTATIONS,
        golden_response: FX_003_GOLDEN_RESPONSE,
      },
    },
    tags: ["seed", "sdc-bench"],
    split: "test",
  },
];

export const BUNDLE_SET_META = {
  family: "question-bundle",
  source: "cache",
  benchmark: "sdc-bench",
  version: "v2",
  dataset: "beanmaxx",
  createdAt: "2026-07-10T09:00:00.000Z",
  families: ["sdc", "curation"],
} as const;

export const BUNDLE_SET_SUMMARY: EvalSetSummary = {
  id: BUNDLE_SET_ID,
  name: "Question bundle — sdc-bench v2 (cache)",
  description: "Cached benchmark fixtures with gold expectations for SDC + curation.",
  createdTs: "2026-07-10T09:00:00.000Z",
  caseCount: BUNDLE_CASES.length,
  splitCounts: { train: 1, test: 1 },
  meta: { ...BUNDLE_SET_META, families: [...BUNDLE_SET_META.families] },
};
