/**
 * Slice 6 — RendererRunDetail (the renderer-family run-detail body).
 *
 * Fixtures mirror the committed seed (`agent-cli/src/eval-seed/
 * seed-eval-families.ts`): `render-grade` detail field names, composite
 * `${fid}#${variantKey}` case ids, the seed's report shape (`buildReport`),
 * and the seed's run meta blob (parsed through the REAL `readRunMeta`, so the
 * fixture also proves the meta contract round-trips).
 *
 * The component renders directly inside a `MemoryRouter` (it uses
 * `useSearchParams` + `Link`); the page-level dispatch seam is covered by
 * `evalFamilyDispatch.test.tsx`.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EvalCaseRow,
  EvalRunRow,
  EvalRunSummary,
  EvalScoreLike,
  JoinedEvalResultRow,
} from "../api/types";
import { RendererRunDetail } from "../pages/eval/families/renderer/RendererRunDetail";
import type { RunMeta } from "../pages/eval/families/types";
import { readRunMeta } from "../pages/eval/families/types";

const BANK_SET_ID = "bank:render-bench@v3";
const RUN_ID = "seed-renderer-01";

// Two seed variants — enough for grouping + the variant filter.
const VARIANTS = [
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
    key: "table-dense-inline",
    variant: {
      shape: "table",
      verbosity: "dense",
      tone: "plain",
      citationMode: "inline",
      model: "gpt-4o",
    },
  },
] as const;

interface CaseOpts {
  fid: string;
  variantIdx?: 0 | 1;
  latencyMs?: number;
  estimatedUsd?: number;
  ratio?: number;
  judge?: {
    readability: number;
    faithful_emphasis: number;
    tone_differentiation: number;
  } | null;
  status?: "ok" | "presentation_fallback" | "crashed";
  inventedIds?: string[];
  coverage?: { status: "honest" | "dishonest" | "not_declared"; carried: number; total: number };
  retriedForLength?: boolean;
}

/** Seed-shaped `render-grade` result row (field names lifted from `buildRendererRun`). */
function mkRenderResult(opts: CaseOpts): JoinedEvalResultRow {
  const v = VARIANTS[opts.variantIdx ?? 0];
  const coverage = opts.coverage ?? { status: "honest", carried: 5, total: 5 };
  const inventedFail = opts.inventedIds !== undefined;
  const dishonest = coverage.status === "dishonest";
  const pass = !inventedFail && !dishonest;
  const report = {
    pass,
    inventedIds: inventedFail
      ? { pass: false, inventedIds: opts.inventedIds }
      : { pass: true, inventedIds: [] },
    droppedIds: { pass: true, droppedIds: [], dropRatio: 0 },
    inventedDates: { pass: true, invented: [] },
    inventedMoney: { pass: true, invented: [] },
    coverageHonesty: {
      status: coverage.status,
      pass: !dishonest,
      actualCarried: coverage.carried,
      actualTotal: coverage.total,
    },
    tableIntegrity: { pass: true, strayPipeLines: [], unbalancedRowLines: [] },
    relativeLength: { ratio: opts.ratio ?? 0.4, stateWords: 120, renderedWords: 48 },
  };
  const judge =
    opts.judge === undefined
      ? { readability: 0.85, faithful_emphasis: 0.8, tone_differentiation: 0.6 }
      : opts.judge;
  const detail: Record<string, unknown> = {
    kind: "render-grade",
    fid: opts.fid,
    variant: { ...v.variant },
    effective: {
      verbosity: v.variant.verbosity,
      tone: v.variant.tone,
      citationMode: v.variant.citationMode,
    },
    variantKey: v.key,
    regime: "grounded",
    status: opts.status ?? "ok",
    fidelityFailure: inventedFail,
    retriedForLength: opts.retriedForLength ?? false,
    report,
    judge,
    cost: { inputTokens: 940, outputTokens: 210, estimatedUsd: opts.estimatedUsd ?? 0.0028 },
    latencyMs: opts.latencyMs ?? 1450,
    renderedText: `### ${opts.fid} rendered output\n\nBody with [evidence-1].`,
    carriedIds: ["evidence-1"],
    coverage: { carried: coverage.carried, total: coverage.total },
  };
  const scores: EvalScoreLike[] = [
    { name: "render-grade", value: pass ? 1 : 0, passed: pass, detail },
    { name: "judge", value: judge ? judge.readability : null },
  ];
  return {
    evalRunId: RUN_ID,
    caseId: `${opts.fid}#${v.key}`,
    runId: null,
    scores,
    pass,
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

/** The seed's renderer run meta blob, verbatim shape. */
function mkRun(): EvalRunRow {
  return {
    id: RUN_ID,
    tsStart: "2026-07-15T10:00:00.000Z",
    tsEnd: "2026-07-15T10:12:30.000Z",
    setId: BANK_SET_ID,
    targetId: "answer-renderer",
    variant: null,
    split: null,
    model: null,
    gitSha: "a1b2c3d4e5f6",
    status: "ok",
    meta: {
      family: "renderer",
      benchmark: "render-bench",
      judgeModel: "claude-sonnet-4-5",
      gitBranch: "bench/render-grid",
      summary: {
        detPassRate: 0.75,
        judgeLens: { kind: "mean", value: 0.83 },
        costUsd: 0.0725,
        judgeCostUsd: 0.0112,
        latencyP50: 2100,
        flagsRate: 0.16,
        fallbackRate: 0.08,
        retriesRate: 0.08,
      },
      renderer: {
        bankSetId: BANK_SET_ID,
        orderingChecks: ["stage-before-risks", "citations-follow-claims"],
        gridArgs: { states: 4, judgeMode: "full", models: ["gpt-4o-mini", "gpt-4o"] },
      },
    },
  };
}

function metaOf(run: EvalRunRow): RunMeta {
  const meta = readRunMeta(run);
  if (meta === null) throw new Error("fixture run must parse as a renderer family run");
  return meta;
}

const SUMMARY: EvalRunSummary = {
  cases: 4,
  passed: 2,
  failed: 2,
  ungated: 0,
  errored: 0,
  passRate: 0.5,
  inputTokens: 0,
  outputTokens: 0,
};

const BANK_CASE: EvalCaseRow = {
  setId: BANK_SET_ID,
  caseId: "fid-001",
  input:
    "## Deal state — Northwind Traders renewal (opp-2214)\n\n" +
    "On the pricing call [evidence-1] Dana Fuentes accepted the 3-year term [evidence-2].",
  expected: "Northwind accepted a 3-year renewal [evidence-1][evidence-2].",
  tags: ["seed", "render-bench"],
  split: null,
};

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderBody(
  results: JoinedEvalResultRow[],
  opts: { url?: string; cases?: Map<string, EvalCaseRow> } = {},
) {
  const run = mkRun();
  return render(
    <MemoryRouter initialEntries={[opts.url ?? `/eval/runs/${RUN_ID}`]}>
      <RendererRunDetail
        run={run}
        results={results}
        summary={SUMMARY}
        casesById={opts.cases ?? new Map()}
        meta={metaOf(run)}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** 2 passing prose renders + an invented-ids fail + a dishonest-coverage fail (both table). */
function mixedResults(): JoinedEvalResultRow[] {
  return [
    mkRenderResult({ fid: "fid-001", variantIdx: 0 }),
    mkRenderResult({ fid: "fid-002", variantIdx: 0, status: "presentation_fallback" }),
    mkRenderResult({
      fid: "fid-001",
      variantIdx: 1,
      inventedIds: ["evidence-9", "evidence-12"],
      judge: { readability: 0.65, faithful_emphasis: 0.4, tone_differentiation: 0.7 },
    }),
    mkRenderResult({
      fid: "fid-003",
      variantIdx: 1,
      coverage: { status: "dishonest", carried: 3, total: 8 },
    }),
  ];
}

describe("RendererRunDetail (slice 6)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders stat tiles from meta.summary and the grid-args provenance line", () => {
    renderBody(mixedResults());

    expect(screen.getByText("Renders")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy(); // detPassRate 0.75
    expect(screen.getByText("$0.0725")).toBeTruthy(); // render $
    expect(screen.getByText("$0.0112")).toBeTruthy(); // judge $
    expect(screen.getByText(/states 4/)).toBeTruthy();
    expect(screen.getByText(/judge full/)).toBeTruthy();
    expect(screen.getByText(/models gpt-4o-mini, gpt-4o/)).toBeTruthy();
    expect(screen.getByText(/stage-before-risks/)).toBeTruthy();
    expect(screen.getByText(/citations-follow-claims/)).toBeTruthy();
  });

  it("groups the scoreboard by variantKey with gate-failure strings", () => {
    renderBody(mixedResults());

    // One scoreboard row per variant (the FIRST table; variant keys also
    // appear as filter <option>s, so scope the queries).
    const scoreboardTable = screen.getAllByRole("table")[0];
    expect(scoreboardTable).toBeTruthy();
    const sb = within(scoreboardTable as HTMLElement);
    expect(sb.getByText("prose-brief-inline")).toBeTruthy();
    expect(sb.getByText("table-dense-inline")).toBeTruthy();
    // The table variant tripped inventedIds once AND coverageHonesty once —
    // the aggregate's "<gate>:<count>" string rendered faithfully.
    expect(sb.getByText(/inventedIds:1/)).toBeTruthy();
    expect(sb.getByText(/coverageHonesty:1/)).toBeTruthy();
  });

  it("caps the render list at 25 rows and pages with Show more", () => {
    const results = Array.from({ length: 30 }, (_, i) =>
      mkRenderResult({ fid: `fid-${String(i).padStart(3, "0")}`, variantIdx: 0 }),
    );
    renderBody(results);

    expect(screen.getAllByText(/^fid-\d+#prose-brief-inline$/)).toHaveLength(25);
    expect(screen.getByText("25 of 30 shown")).toBeTruthy();

    fireEvent.click(screen.getByText("Show 5 more"));

    expect(screen.getAllByText(/^fid-\d+#prose-brief-inline$/)).toHaveLength(30);
    expect(screen.queryByText(/Show \d+ more/)).toBeNull();
  });

  it("variant / status / failing-only / fid filters narrow the list", () => {
    renderBody(mixedResults());

    // Variant filter.
    fireEvent.change(screen.getByLabelText("Variant"), {
      target: { value: "prose-brief-inline" },
    });
    expect(screen.getByText("fid-001#prose-brief-inline")).toBeTruthy();
    expect(screen.queryByText("fid-001#table-dense-inline")).toBeNull();
    fireEvent.change(screen.getByLabelText("Variant"), { target: { value: "" } });

    // Status filter.
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "presentation_fallback" },
    });
    expect(screen.getByText("fid-002#prose-brief-inline")).toBeTruthy();
    expect(screen.queryByText("fid-001#prose-brief-inline")).toBeNull();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "" } });

    // Failing only — the invented-ids and dishonest-coverage rows.
    fireEvent.click(screen.getByLabelText("Failing only"));
    expect(screen.getByText("fid-001#table-dense-inline")).toBeTruthy();
    expect(screen.getByText("fid-003#table-dense-inline")).toBeTruthy();
    expect(screen.queryByText("fid-001#prose-brief-inline")).toBeNull();
    fireEvent.click(screen.getByLabelText("Failing only"));

    // Fid text filter.
    fireEvent.change(screen.getByLabelText("Case filter"), { target: { value: "fid-002" } });
    expect(screen.getByText("fid-002#prose-brief-inline")).toBeTruthy();
    expect(screen.queryByText("fid-001#prose-brief-inline")).toBeNull();
  });

  it("expanding a row shows gates, both EvidenceText panes, and the encoded bank link", () => {
    renderBody(mixedResults(), { cases: new Map([["fid-001", BANK_CASE]]) });

    fireEvent.click(screen.getByText("fid-001#prose-brief-inline"));

    // Gate chips via the embedded RenderGradeDetail.
    expect(screen.getByText(/invented ids ✓/)).toBeTruthy();
    // LEFT pane: the bank case input, joined via detail.fid.
    expect(document.body.textContent).toContain("Northwind Traders renewal");
    // RIGHT pane: detail.renderedText.
    expect(document.body.textContent).toContain("fid-001 rendered output");
    // Bank cross-link, both segments encoded.
    const link = screen.getByTitle("View this bank case");
    expect(link.getAttribute("href")).toBe("/eval/sets/bank%3Arender-bench%40v3/cases/fid-001");
    // Expanding synced ?render= into the URL (replace-style).
    expect(screen.getByTestId("loc").textContent).toContain("render=fid-001%23prose-brief-inline");
  });

  it("tolerates a missing bank case (degraded fetch) in the expanded row", () => {
    renderBody(mixedResults()); // empty casesById

    fireEvent.click(screen.getByText("fid-001#prose-brief-inline"));

    expect(screen.getByText(/bank case not available/)).toBeTruthy();
    expect(document.body.textContent).toContain("fid-001 rendered output");
  });

  it("?render=<caseId> deep-links an auto-expanded row", () => {
    renderBody(mixedResults(), {
      url: `/eval/runs/${RUN_ID}?render=fid-003%23table-dense-inline`,
      cases: new Map([["fid-001", BANK_CASE]]),
    });

    // The dishonest-coverage row is expanded without a click.
    expect(document.body.textContent).toContain("fid-003 rendered output");
    expect(screen.getByText(/coverage ✕/)).toBeTruthy();
  });

  it("empty results render a sane empty state (no scoreboard, no table)", () => {
    renderBody([]);

    expect(screen.getByText("No render-grade results")).toBeTruthy();
    expect(screen.queryByText("Variant scoreboard")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    // Provenance still shows — the run identity survives an empty result set.
    expect(screen.getByText(/states 4/)).toBeTruthy();
  });
});
