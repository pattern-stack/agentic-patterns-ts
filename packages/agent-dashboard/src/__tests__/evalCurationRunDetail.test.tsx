/**
 * Slice 8 — CurationRunDetail (curation-family run body) + the FrontierScatter
 * extensions. Fixtures are seed-shaped (lifted from
 * `agent-cli/src/eval-seed/seed-eval-families.ts`: FLAT curation-facts details,
 * composite `<configId>#<fixtureId>` case ids, `meta.curation` blob) with a
 * declared frontier that deliberately differs from the client recompute so
 * declared-wins is observable.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalRunRow, EvalRunSummary, JoinedEvalResultRow } from "../api/types";
import type { FrontierPoint } from "../lib/evalAggregates";
import { FrontierScatter } from "../pages/eval/charts/FrontierScatter";
import { CurationRunDetail } from "../pages/eval/families/curation/CurationRunDetail";
import { type RunMeta, readRunMeta } from "../pages/eval/families/types";

afterEach(cleanup);

// ---- seed-shaped fixture ---------------------------------------------------

const SOURCE_SET_ID = "bundle:cache:sdc-bench@v2";
const ENCODED_SET = encodeURIComponent(SOURCE_SET_ID); // bundle%3Acache%3Asdc-bench%40v2

interface CfgSpec {
  configId: string;
  knobs: Record<string, unknown>;
  compressionPct: number;
  nearDupRate: number;
  deadRowRate: number;
  dealCoverage: { minShare: number; zeroRowDeals: number };
  temporalAlignment: number;
}

const CFG: Record<string, CfgSpec> = {
  baseline: {
    configId: "cfg-baseline",
    knobs: { maxRows: 400, dedup: false, temporalWindow: "all", minRelevance: 0 },
    compressionPct: 18,
    nearDupRate: 0.21,
    deadRowRate: 0.09,
    dealCoverage: { minShare: 0.18, zeroRowDeals: 0 },
    temporalAlignment: 0.94,
  },
  dedup: {
    configId: "cfg-dedup",
    knobs: { maxRows: 250, dedup: true, temporalWindow: "all", minRelevance: 0.2 },
    compressionPct: 46,
    nearDupRate: 0.03,
    deadRowRate: 0.05,
    dealCoverage: { minShare: 0.14, zeroRowDeals: 0 },
    temporalAlignment: 0.91,
  },
  lopsided: {
    configId: "cfg-lopsided",
    knobs: { maxRows: 200, dedup: false, temporalWindow: "90d", minRelevance: 0.35 },
    compressionPct: 42,
    nearDupRate: 0.19,
    deadRowRate: 0.11,
    dealCoverage: { minShare: 0.07, zeroRowDeals: 0 },
    temporalAlignment: 0.78,
  },
  aggressive: {
    configId: "cfg-aggressive",
    knobs: { maxRows: 120, dedup: true, temporalWindow: "180d", minRelevance: 0.5 },
    compressionPct: 74,
    nearDupRate: 0.02,
    deadRowRate: 0.02,
    dealCoverage: { minShare: 0.05, zeroRowDeals: 1 },
    temporalAlignment: 0.83,
  },
};

/** One curation case: FLAT curation-facts detail, `${configId}#${fixtureId}` id. */
function curationResult(
  cfg: CfgSpec,
  fixtureId: string,
  dropped: readonly string[],
  outboundTokens: number,
  spread: { kept: number; available: number },
): JoinedEvalResultRow {
  const expIds = ["a", "b", "c", "d", "e"].map((s) => `exp-${fixtureId}-${s}`);
  const droppedSet = new Set(dropped);
  const perExpectation = expIds.map((id) => ({
    expectationId: id,
    survived: !droppedSet.has(id),
    contentRetained: !droppedSet.has(id),
    availablePreCuration: true,
  }));
  const available = perExpectation.length;
  const survived = perExpectation.filter((p) => p.survived).length;
  const rate = survived / available;
  const pass = rate >= 0.8;
  return {
    evalRunId: "seed-curation-01",
    caseId: `${cfg.configId}#${fixtureId}`,
    runId: null,
    scores: [
      {
        name: "curation-facts",
        value: rate,
        passed: pass,
        detail: {
          kind: "curation-facts",
          configId: cfg.configId,
          knobs: { ...cfg.knobs },
          survival: { rate, survived, available, perExpectation },
          outboundTokens,
          typeCoverage: {
            transcript: { rowsKept: 42, rowsAvail: 42 },
            email: { rowsKept: 31, rowsAvail: 31 },
          },
          compressionPct: cfg.compressionPct,
          dealCoverage: { ...cfg.dealCoverage },
          nearDupRate: cfg.nearDupRate,
          deadRowRate: cfg.deadRowRate,
          temporalAlignment: cfg.temporalAlignment,
          temporalSpreadDays: { ...spread },
        },
      },
    ],
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

// Pareto layout (mean survival / mean tokens):
//   cfg-baseline    1.0 / 9800   — computed front (max survival)
//   cfg-dedup       0.9 / 6400   — computed front
//   cfg-aggressive  0.7 / 3100   — computed front (min tokens)
//   cfg-lopsided    0.7 / 6900   — dominated (dedup: ≥ survival, ≤ tokens)
// Declared frontier lists only baseline + dedup ⇒ cfg-aggressive flips off.
const RESULTS: JoinedEvalResultRow[] = [
  curationResult(CFG.baseline as CfgSpec, "fx-001", [], 9600, { kept: 142, available: 142 }),
  curationResult(CFG.baseline as CfgSpec, "fx-002", [], 10000, { kept: 128, available: 128 }),
  curationResult(CFG.dedup as CfgSpec, "fx-001", [], 6200, { kept: 137, available: 142 }),
  curationResult(CFG.dedup as CfgSpec, "fx-002", ["exp-fx-002-d"], 6600, {
    kept: 121,
    available: 128,
  }),
  curationResult(CFG.lopsided as CfgSpec, "fx-001", ["exp-fx-001-e"], 6800, {
    kept: 84,
    available: 142,
  }),
  curationResult(CFG.lopsided as CfgSpec, "fx-002", ["exp-fx-002-b", "exp-fx-002-e"], 7000, {
    kept: 79,
    available: 128,
  }),
  curationResult(CFG.aggressive as CfgSpec, "fx-001", ["exp-fx-001-d"], 3000, {
    kept: 96,
    available: 142,
  }),
  curationResult(CFG.aggressive as CfgSpec, "fx-002", ["exp-fx-002-c", "exp-fx-002-e"], 3200, {
    kept: 88,
    available: 128,
  }),
];

const RAW_META = {
  family: "curation",
  benchmark: "sdc-bench",
  gitBranch: "bench/curation-sweep",
  summary: {
    detPassRate: 0.75,
    survivalBest: 1,
    tokensAtBest: 9800,
    compressionPct: 18,
    paretoCount: 2,
    configCount: 4,
  },
  curation: {
    sourceSetId: SOURCE_SET_ID,
    // Declared front deliberately EXCLUDES cfg-aggressive (which recompute keeps).
    frontier: [{ configId: "cfg-baseline" }, { configId: "cfg-dedup" }],
    scoreboardMd: [
      "| config | survival | tokens |",
      "| --- | --- | --- |",
      "| cfg-baseline | 1 | 9800 |",
      "| cfg-dedup | 0.9 | 6400 |",
    ].join("\n"),
  },
};

function metaOf(raw: Record<string, unknown>): RunMeta {
  const m = readRunMeta({ meta: raw });
  if (!m) throw new Error("fixture meta must parse as a curation RunMeta");
  return m;
}

const DECLARED_META = metaOf(RAW_META);
// No declared frontier + no scoreboard ⇒ computed path, scoreboard hidden.
const COMPUTED_META = metaOf({ ...RAW_META, curation: { sourceSetId: SOURCE_SET_ID } });

const RUN: EvalRunRow = {
  id: "seed-curation-01",
  tsStart: "2026-07-17T14:05:00.000Z",
  tsEnd: "2026-07-17T14:09:44.000Z",
  setId: SOURCE_SET_ID,
  targetId: "curation-sweep",
  variant: null,
  split: null,
  model: null,
  gitSha: "c3d4e5f6a7b8",
  status: "ok",
  meta: RAW_META,
};

const SUMMARY: EvalRunSummary = {
  cases: 8,
  passed: 6,
  failed: 2,
  ungated: 0,
  errored: 0,
  passRate: 0.75,
  inputTokens: 0,
  outputTokens: 0,
};

function renderDetail(meta: RunMeta, results: JoinedEvalResultRow[] = RESULTS) {
  return render(
    <MemoryRouter>
      <CurationRunDetail
        run={RUN}
        results={results}
        summary={SUMMARY}
        casesById={new Map()}
        meta={meta}
      />
    </MemoryRouter>,
  );
}

/** The table row (`<tr>`) that carries the given config id. */
function rowOf(configId: string): HTMLElement {
  const cell = screen.getAllByTestId("config-id").find((e) => e.textContent === configId);
  if (!cell) throw new Error(`no config row for ${configId}`);
  const tr = cell.closest("tr");
  if (!tr) throw new Error(`config cell for ${configId} is not in a row`);
  return tr;
}

// ---- CurationRunDetail -----------------------------------------------------

describe("CurationRunDetail", () => {
  it("renders header tiles from meta.summary", () => {
    renderDetail(DECLARED_META);
    const tiles = screen.getByTestId("curation-summary-tiles");
    expect(within(tiles).getByText("Best survival")).toBeTruthy();
    expect(within(tiles).getByText("100%")).toBeTruthy();
    expect(within(tiles).getByText(/@ 9.800 tok/)).toBeTruthy(); // locale-tolerant separator
    expect(within(tiles).getByText("18%")).toBeTruthy();
    expect(within(tiles).getByText("2/4")).toBeTruthy(); // declared pareto k / configs n
    expect(within(tiles).getByText("Fixtures").parentElement?.textContent).toContain("2");
  });

  it("declared frontier wins over the recompute, and the chip says declared", () => {
    renderDetail(DECLARED_META);
    expect(screen.getByText("frontier · declared")).toBeTruthy();
    // Recompute would put cfg-aggressive on the front too; declared excludes it.
    expect(screen.getAllByText("pareto").length).toBe(2);
    expect(within(rowOf("cfg-baseline")).getByText("pareto")).toBeTruthy();
    expect(within(rowOf("cfg-dedup")).getByText("pareto")).toBeTruthy();
    expect(within(rowOf("cfg-aggressive")).queryByText("pareto")).toBeNull();
    expect(within(rowOf("cfg-lopsided")).queryByText("pareto")).toBeNull();
  });

  it("falls back to the computed frontier when meta declares none", () => {
    renderDetail(COMPUTED_META);
    expect(screen.getByText("frontier · computed")).toBeTruthy();
    expect(screen.getAllByText("pareto").length).toBe(3);
    expect(within(rowOf("cfg-aggressive")).getByText("pareto")).toBeTruthy();
    expect(within(rowOf("cfg-lopsided")).queryByText("pareto")).toBeNull();
    // No scoreboardMd on this meta ⇒ the card hides.
    expect(screen.queryByTestId("curation-scoreboard")).toBeNull();
  });

  it("sorts the config table by survival desc, then tokens asc", () => {
    renderDetail(DECLARED_META);
    const order = screen.getAllByTestId("config-id").map((e) => e.textContent);
    // cfg-aggressive (0.7 / 3100 tok) ties cfg-lopsided (0.7 / 6900 tok) on
    // survival — tokens break the tie.
    expect(order).toEqual(["cfg-baseline", "cfg-dedup", "cfg-aggressive", "cfg-lopsided"]);
  });

  it("expands a config into per-fixture cards with wrapper-level encoded links", () => {
    const { container } = renderDetail(DECLARED_META);
    fireEvent.click(rowOf("cfg-baseline"));
    // One card per fixture, each linking to the bundle case via
    // meta.curation.sourceSetId — encoded at the wrapper level.
    const fx1 = container.querySelectorAll(`a[href="/eval/sets/${ENCODED_SET}/cases/fx-001"]`);
    const fx2 = container.querySelectorAll(`a[href="/eval/sets/${ENCODED_SET}/cases/fx-002"]`);
    expect(fx1.length).toBe(1);
    expect(fx2.length).toBe(1);
    // The embedded CurationFactsDetail renders the expectation chips.
    expect(screen.getAllByText(/exp-fx-001-a/).length).toBeGreaterThan(0);
  });

  it("renders meta.curation.scoreboardMd through the Markdown atom", () => {
    const { container } = renderDetail(DECLARED_META);
    const board = screen.getByTestId("curation-scoreboard");
    expect(
      container.querySelector('[data-testid="curation-scoreboard"] table.md-table'),
    ).toBeTruthy();
    expect(board.textContent).toContain("cfg-baseline");
  });
});

// ---- FrontierScatter slice-8 extensions ------------------------------------

const POINTS: FrontierPoint[] = [
  { configId: "cfg-baseline", survival: 1, tokens: 9800, n: 2, onFrontier: true },
  { configId: "cfg-dedup", survival: 0.9, tokens: 6400, n: 2, onFrontier: true },
  { configId: "cfg-aggressive", survival: 0.7, tokens: 3100, n: 2, onFrontier: true },
];

describe("FrontierScatter (slice-8 extensions)", () => {
  it("draws a dashed step-line through the frontier points", () => {
    const { container } = render(<FrontierScatter points={POINTS} />);
    const step = container.querySelector('path[stroke-dasharray="4 3"]');
    expect(step).toBeTruthy();
    expect(container.querySelectorAll('circle[fill="var(--accent)"]').length).toBe(3);
  });

  it("renders pre-flagged frontier points as given — flagging lives in curationFrontierDeclared", () => {
    // Declared-wins is the aggregate's job, not the chart's: a single
    // pre-flagged point renders filled with no step-line.
    const single = POINTS.map((p) => ({ ...p, onFrontier: p.configId === "cfg-baseline" }));
    const { container } = render(<FrontierScatter points={single} />);
    expect(container.querySelectorAll('circle[fill="var(--accent)"]').length).toBe(1);
    expect(container.querySelector('path[stroke-dasharray="4 3"]')).toBeNull();
  });

  it("shows a hover tooltip on point enter and hides it on leave", () => {
    const { container } = render(<FrontierScatter points={POINTS} />);
    const circle = container.querySelector("circle");
    if (!circle) throw new Error("expected at least one point");
    fireEvent.mouseOver(circle); // React derives onMouseEnter from mouseover
    const tip = screen.getByTestId("frontier-tooltip");
    expect(tip.textContent).toContain("cfg-baseline");
    expect(tip.textContent).toContain("on frontier");
    fireEvent.mouseOut(circle);
    expect(screen.queryByTestId("frontier-tooltip")).toBeNull();
  });
});
