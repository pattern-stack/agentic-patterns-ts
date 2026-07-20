/**
 * SDC run-detail body (slice 7) — seed-shaped fixtures (seed-eval-families.ts).
 * Proves: declared-vs-computed score-map sourcing (meta.sdc.scores wins, client
 * means are fallback), the crashed-fixtures strip renders meta.sdc.failures
 * without polluting the fixture table, row expand reuses the registry path
 * (CaseDetail) under the ↗ bundle banner, ?fixture= deep-link auto-expands,
 * and the table filters (failing-only / text) narrow rows. Plus the extracted
 * ScoreMapView rendering at run grain.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalCaseRow, EvalRunRow, EvalRunSummary, JoinedEvalResultRow } from "../api/types";
import { SdcRunDetail } from "../pages/eval/families/sdc/SdcRunDetail";
import { type RunMeta, readRunMeta } from "../pages/eval/families/types";
import { ScoreMapView } from "../pages/eval/renderers/ScoreMapView";

afterEach(cleanup);

// ---- seed-shaped fixtures (ids + field names from seed-eval-families.ts) ----

const BUNDLE_SET_ID = "bundle:cache:sdc-bench@v2";
const SDC_RUN_ID = "seed-sdc-01";

interface SdcSpec {
  fixtureId: string;
  axes: Record<string, number>;
  hybrid: number;
  dealIds: string[];
  missingContext: boolean;
  citationCount: number;
  retrievedSourceCount: number;
  costUsd: number;
  latencyMs: number;
  pass: boolean;
  verdicts: { expectationId: string; passed: boolean; reason: string; evidence?: string }[];
}

const SPECS: SdcSpec[] = [
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
    pass: true,
    verdicts: [
      { expectationId: "exp-001-a", passed: true, reason: "Covered", evidence: "[evidence-1]" },
      { expectationId: "exp-001-b", passed: true, reason: "Covered", evidence: "[evidence-2]" },
    ],
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
    pass: true,
    verdicts: [
      { expectationId: "exp-003-a", passed: true, reason: "Covered", evidence: "[evidence-1]" },
      { expectationId: "exp-003-d", passed: false, reason: "Answer does not establish it" },
    ],
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
    pass: false,
    verdicts: [
      { expectationId: "exp-004-a", passed: false, reason: "Answer does not establish it" },
      { expectationId: "exp-004-c", passed: false, reason: "Answer does not establish it" },
    ],
  },
];

function mkResult(spec: SdcSpec): JoinedEvalResultRow {
  const axes = { ...spec.axes, hybrid: spec.hybrid };
  return {
    evalRunId: SDC_RUN_ID,
    caseId: spec.fixtureId,
    runId: null,
    scores: [
      {
        name: "score-map",
        value: spec.hybrid,
        passed: spec.pass,
        detail: {
          kind: "score-map",
          scores: axes,
          axes,
          hybrid: spec.hybrid,
          answerMd: "**Q:** seed question\n\nseed answer [evidence-1]",
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
        value: spec.verdicts.filter((v) => v.passed).length / spec.verdicts.length,
        passed: spec.pass,
        detail: { kind: "judge-verdicts", verdicts: spec.verdicts },
      },
      { name: "judge", value: spec.verdicts.filter((v) => v.passed).length / spec.verdicts.length },
    ],
    pass: spec.pass,
    traceId: null,
    runStatus: "ok",
    finalAnswer: null,
    inputTokens: null,
    outputTokens: null,
    finishReason: null,
    elapsedMs: null,
    runError: null,
  };
}

const results = SPECS.map(mkResult);

// Declared axis map: the seed's canonical scores.json rides meta.sdc.scores,
// deliberately offset (+0.02) from the client means so sourcing is visible.
// Client mean of answer_correctness here = (0.92+0.76+0.58)/3 = 0.75.
const declaredScores = {
  answer_correctness: 0.77,
  evidence_seen_recall: 0.76,
  citation_claim_support: 0.74,
  response_completeness: 0.71,
  missing_context_hygiene: 0.85,
  facet_decomposition_depth: 0.69,
};

const crashedFixture = {
  fixtureId: "fx-006",
  error: "resolver timeout after 90s (portfolio-scope deal-universe fanout)",
};

function mkMetaBlob(overrides?: { sdc?: Record<string, unknown> | undefined }) {
  return {
    family: "sdc",
    benchmark: "sdc-bench",
    judgeModel: "claude-sonnet-4-5",
    gitBranch: "bench/sdc-nightly",
    summary: {
      detPassRate: 0.6667,
      judgeLens: { kind: "ratio", value: 0.6667, num: 4, den: 6 },
      costUsd: 0.131,
      judgeCostUsd: 0.0287,
      latencyP50: 9200,
      crashedCount: 1,
    },
    sdc:
      overrides && "sdc" in overrides
        ? overrides.sdc
        : { scores: declaredScores, failures: [crashedFixture] },
  };
}

function mkRun(metaBlob: Record<string, unknown>): EvalRunRow {
  return {
    id: SDC_RUN_ID,
    tsStart: "2026-07-16T09:30:00.000Z",
    tsEnd: "2026-07-16T09:41:12.000Z",
    setId: BUNDLE_SET_ID,
    targetId: "sdc-pipeline",
    variant: null,
    split: null,
    model: "claude-sonnet-4-5",
    gitSha: "b2c3d4e5f6a7",
    status: "ok",
    meta: metaBlob,
  };
}

const summary: EvalRunSummary = {
  cases: 3,
  passed: 2,
  failed: 1,
  ungated: 0,
  errored: 0,
  passRate: 2 / 3,
  inputTokens: 0,
  outputTokens: 0,
};

const bundleCase: EvalCaseRow = {
  setId: BUNDLE_SET_ID,
  caseId: "fx-001",
  input: {
    question: "What pricing did Northwind commit to on the renewal, and what is still open?",
    scope: "deal:opp-2214",
    asOf: "2026-07-10",
  },
  expected: { expectations: [{ id: "exp-001-a", required: true }] },
  tags: null,
  split: null,
};

const casesById = new Map<string, EvalCaseRow>([["fx-001", bundleCase]]);

function parseMeta(run: EvalRunRow): RunMeta {
  const meta = readRunMeta(run);
  if (!meta) throw new Error("test blob failed to parse as a family run meta");
  return meta;
}

function renderDetail(metaBlob: Record<string, unknown>, initialEntry = "/eval/runs/seed-sdc-01") {
  const run = mkRun(metaBlob);
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SdcRunDetail
        run={run}
        results={results}
        summary={summary}
        casesById={casesById}
        meta={parseMeta(run)}
      />
    </MemoryRouter>,
  );
}

// ---- tests ------------------------------------------------------------------

describe("SdcRunDetail", () => {
  it("renders the declared score map (meta.sdc.scores) with a 'declared' chip", () => {
    renderDetail(mkMetaBlob());

    const card = within(screen.getByTestId("sdc-score-map"));
    expect(card.getByText("declared")).toBeTruthy();
    // Declared value (0.77), NOT the client mean (0.75).
    expect(card.getByText("0.77")).toBeTruthy();
    expect(card.queryByText("0.75")).toBeNull();
    // Grouped-meter layout via ScoreMapView.
    expect(card.getByText("Headline")).toBeTruthy();
    expect(card.getByText("Other axes")).toBeTruthy();

    // Header badges + tiles off meta / summary.
    expect(screen.getByText(/benchmark · sdc-bench/)).toBeTruthy();
    expect(screen.getByText(/branch · bench\/sdc-nightly/)).toBeTruthy();
    expect(screen.getByText(/judge · claude-sonnet-4-5/)).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy(); // det k/n
    expect(screen.getByText("4/6")).toBeTruthy(); // judge verdict k/n (judgeLens ratio)
  });

  it("falls back to client-computed axis means with a 'computed' chip when meta.sdc.scores is absent", () => {
    renderDetail(mkMetaBlob({ sdc: { failures: [crashedFixture] } }));

    const card = within(screen.getByTestId("sdc-score-map"));
    expect(card.getByText("computed")).toBeTruthy();
    expect(card.queryByText("declared")).toBeNull();
    // Client mean of answer_correctness = 0.75; declared 0.77 must NOT appear.
    expect(card.getByText("0.75")).toBeTruthy();
    expect(card.queryByText("0.77")).toBeNull();
  });

  it("renders crashed fixtures as a strip without polluting the fixture table", () => {
    renderDetail(mkMetaBlob());

    const strip = within(screen.getByTestId("sdc-crashed-strip"));
    expect(strip.getByText("fx-006")).toBeTruthy();
    expect(strip.getByText(/resolver timeout after 90s/)).toBeTruthy();

    const table = screen.getByRole("table");
    expect(table.textContent).toContain("fx-001");
    expect(table.textContent).not.toContain("fx-006");
  });

  it("expanding a fixture row shows the bundle banner link and the registry-rendered case detail", () => {
    renderDetail(mkMetaBlob());

    expect(screen.queryByTestId("sdc-bundle-banner")).toBeNull();
    fireEvent.click(screen.getByText("fx-001"));

    const banner = screen.getByTestId("sdc-bundle-banner");
    const link = within(banner).getByTitle("View this fixture's bundle case");
    expect(link.getAttribute("href")).toBe(
      "/eval/sets/bundle%3Acache%3Asdc-bench%40v2/cases/fx-001",
    );
    // CaseDetail body: score list with the registry judge-verdicts renderer.
    expect(screen.getByText("Scores")).toBeTruthy();
    expect(screen.getByText(/2\/2 met/)).toBeTruthy();
    expect(screen.getByText("exp-001-a")).toBeTruthy();
  });

  it("?fixture=<caseId> deep-link auto-expands that row (incl. the missing-context panel)", () => {
    renderDetail(mkMetaBlob(), "/eval/runs/seed-sdc-01?fixture=fx-003");

    const banner = screen.getByTestId("sdc-bundle-banner");
    const link = within(banner).getByTitle("View this fixture's bundle case");
    expect(link.getAttribute("href")).toBe(
      "/eval/sets/bundle%3Acache%3Asdc-bench%40v2/cases/fx-003",
    );
    // fx-003 flagged missingContext: CaseDetail's case-level notice renders.
    expect(screen.getByText("missing context")).toBeTruthy();
  });

  it("failing-only and text filters narrow the fixture table", () => {
    renderDetail(mkMetaBlob());

    expect(screen.getByText("3/3 fixtures")).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/failing only/));
    expect(screen.getByText("1/3 fixtures")).toBeTruthy();
    const table = screen.getByRole("table");
    expect(table.textContent).toContain("fx-004");
    expect(table.textContent).not.toContain("fx-001");

    fireEvent.click(screen.getByLabelText(/failing only/));
    fireEvent.change(screen.getByPlaceholderText(/Filter fixtures/), {
      target: { value: "opp-1873" },
    });
    expect(screen.getByText("1/3 fixtures")).toBeTruthy();
    expect(screen.getByRole("table").textContent).toContain("fx-003");
  });
});

describe("ScoreMapView (run grain)", () => {
  it("groups axes into buckets with an Other-axes catch-all and returns null on an empty map", () => {
    render(<ScoreMapView axes={{ hybrid: 0.82, citation_claim_support: 0.4, brand_new: 0.5 }} />);
    expect(screen.getByText("Headline")).toBeTruthy();
    expect(screen.getByText("Citations")).toBeTruthy();
    expect(screen.getByText("Other axes")).toBeTruthy();
    expect(screen.getByText("brand_new")).toBeTruthy();
    expect(screen.getByText("0.82")).toBeTruthy();
    expect(ScoreMapView({ axes: {} })).toBeNull();
  });
});
