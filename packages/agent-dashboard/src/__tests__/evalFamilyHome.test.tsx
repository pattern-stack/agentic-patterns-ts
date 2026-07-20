/**
 * Family home sections on `/eval` (slice 5) — the three family tables
 * (Renderer / SDC / Curation) rendered as stacked sections above the generic
 * "Other runs" block. Fetch stubbing follows the `EvalRunsPage.test.tsx`
 * URL-aware idiom; family run fixtures lift their `meta` payloads from the
 * committed seed (`agent-cli/src/eval-seed/seed-eval-families.ts`) — same ids
 * and field names.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalRunRow, SplitAggregate } from "../api/types";
import { EvalRunsPage } from "../pages/eval/EvalRunsPage";

// ---- Fixtures (seed-shaped: ids + meta field names from seed-eval-families) --

const BANK_SET_ID = "bank:render-bench@v3";
const BUNDLE_SET_ID = "bundle:cache:sdc-bench@v2";

const rendererRun: EvalRunRow = {
  id: "seed-renderer-01",
  tsStart: "2026-07-15T10:00:00.000Z",
  tsEnd: "2026-07-15T10:12:30.000Z",
  setId: BANK_SET_ID,
  targetId: "answer-renderer",
  variant: null,
  split: null,
  model: null,
  gitSha: "a1b2c3d4e5f6",
  status: "ok",
  summary: { cases: 24, passed: 20, failed: 4, ungated: 0, passRate: 0.8333 },
  meta: {
    family: "renderer",
    benchmark: "render-bench",
    judgeModel: "claude-sonnet-4-5",
    gitBranch: "bench/render-grid",
    summary: {
      detPassRate: 0.8333,
      judgeLens: { kind: "mean", value: 0.8642 },
      costUsd: 0.0421,
      judgeCostUsd: 0.0112,
      latencyP50: 1240,
      flagsRate: 0.125,
      fallbackRate: 0.0417,
      retriesRate: 0.0833,
    },
    renderer: {
      bankSetId: BANK_SET_ID,
      orderingChecks: ["stage-before-risks", "citations-follow-claims"],
      gridArgs: { states: 4, judgeMode: "full", models: ["gpt-4o-mini", "gpt-4o"] },
    },
  },
};

const sdcRun: EvalRunRow = {
  id: "seed-sdc-01",
  tsStart: "2026-07-16T09:30:00.000Z",
  tsEnd: "2026-07-16T09:41:12.000Z",
  setId: BUNDLE_SET_ID,
  targetId: "sdc-pipeline",
  variant: null,
  split: null,
  model: "claude-sonnet-4-5",
  gitSha: "b2c3d4e5f6a7",
  status: "ok",
  summary: { cases: 5, passed: 4, failed: 1, ungated: 0, passRate: 0.8 },
  meta: {
    family: "sdc",
    benchmark: "sdc-bench",
    judgeModel: "claude-sonnet-4-5",
    gitBranch: "bench/sdc-nightly",
    summary: {
      detPassRate: 0.8,
      judgeLens: { kind: "ratio", value: 0.8636, num: 19, den: 22 },
      costUsd: 0.1982,
      judgeCostUsd: 0.0287,
      latencyP50: 8400,
      crashedCount: 1,
    },
    sdc: {
      scores: { answer_correctness: 0.92, citation_accuracy: 0.85, hybrid: 0.83 },
      failures: [{ fixtureId: "fx-006", error: "fixture crashed before grading" }],
    },
  },
};

const curationRun: EvalRunRow = {
  id: "seed-curation-01",
  tsStart: "2026-07-17T14:05:00.000Z",
  tsEnd: "2026-07-17T14:09:44.000Z",
  setId: BUNDLE_SET_ID,
  targetId: "curation-sweep",
  variant: null,
  split: null,
  model: null,
  gitSha: "c3d4e5f6a7b8",
  status: "ok",
  summary: { cases: 12, passed: 9, failed: 3, ungated: 0, passRate: 0.75 },
  meta: {
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
      sourceSetId: BUNDLE_SET_ID,
      frontier: [{ configId: "cfg-baseline" }, { configId: "cfg-dedup" }],
      scoreboardMd: "| config | survival |\n|---|---|\n| cfg-baseline | 1.000 |",
    },
  },
};

const genericRun: EvalRunRow = {
  id: "run-generic-1",
  tsStart: "2026-07-01T10:00:00Z",
  tsEnd: "2026-07-01T10:05:00Z",
  setId: "bank",
  targetId: "dealbrain/curator",
  variant: "baseline",
  split: "dev",
  model: "sonnet",
  gitSha: "abc1234",
  status: "ok",
  summary: { cases: 4, passed: 3, failed: 1, ungated: 0, passRate: 0.75 },
};

const allRuns = [rendererRun, sdcRun, curationRun, genericRun];

const defaultAggregates: SplitAggregate[] = [
  { split: "train", results: 4, passed: 3, failed: 1, passRate: 0.75 },
];

// ---- Harness (the EvalRunsPage.test.tsx URL-aware stub idiom) ---------------

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

function stubFetch(runsBody: EvalRunRow[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/eval/aggregates/splits")) {
        return mkFetchResponse(200, { aggregates: defaultAggregates });
      }
      if (url.includes("/eval/runs")) {
        return mkFetchResponse(200, { runs: runsBody });
      }
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/eval"]}>
      <Routes>
        <Route path="/eval" element={<EvalRunsPage />} />
        <Route path="/eval/runs/:id" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The `<section>` wrapping a family heading — scopes value assertions. */
function familySection(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  const section = heading.closest("section");
  if (!section) throw new Error(`no <section> around heading "${name}"`);
  return section;
}

describe("EvalRunsPage — family home sections (slice 5)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stacks the three family sections in RUN_FAMILY_ORDER, then Other runs", async () => {
    stubFetch(allRuns);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Renderer runs" })).toBeTruthy();
    });

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Renderer runs", "SDC runs", "Curation runs", "Other runs"]);

    // The generic table still renders the generic run below the sections
    // ("baseline" also appears as a Variant filter option — assert the cell).
    const tables = screen.getAllByRole("table");
    const genericTable = tables[tables.length - 1] as HTMLElement;
    expect(within(genericTable).getByText("baseline")).toBeTruthy();
    // Compare checkboxes exist ONLY for generic rows (family delta is slice 10).
    expect(screen.getByLabelText("select run run-generic-1 for compare")).toBeTruthy();
    expect(screen.queryByLabelText("select run seed-renderer-01 for compare")).toBeNull();
  });

  it("renderer section: two-lens pills, rates, and per-render/run cost off meta.summary", async () => {
    stubFetch(allRuns);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Renderer runs" })).toBeTruthy();
    });
    const section = within(familySection("Renderer runs"));

    expect(section.getByText("det 83%")).toBeTruthy(); // detPassRate 0.8333
    expect(section.getByText("judge 0.86")).toBeTruthy(); // mean lens, toFixed(2)
    expect(section.getByText("24")).toBeTruthy(); // graded renders
    expect(section.getByText("13%")).toBeTruthy(); // flagsRate 0.125
    expect(section.getByText("4%")).toBeTruthy(); // fallbackRate 0.0417
    expect(section.getByText("8%")).toBeTruthy(); // retriesRate 0.0833
    expect(section.getByText("$0.0018")).toBeTruthy(); // 0.0421 / 24 renders
    expect(section.getByText("$0.0533")).toBeTruthy(); // costUsd + judgeCostUsd
  });

  it("sdc section: ratio judge lens, model, declared hybrid, cost, p50 latency", async () => {
    stubFetch(allRuns);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "SDC runs" })).toBeTruthy();
    });
    const section = within(familySection("SDC runs"));

    expect(section.getByText("det 80%")).toBeTruthy();
    expect(section.getByText("judge 19/22")).toBeTruthy(); // ratio lens = k/n
    expect(section.getByText("claude-sonnet-4-5")).toBeTruthy();
    expect(section.getByText("5")).toBeTruthy(); // graded fixtures
    expect(section.getByText("0.83")).toBeTruthy(); // meta.sdc.scores.hybrid
    expect(section.getByText("$0.20")).toBeTruthy(); // costUsd 0.1982
    expect(section.getByText("8.4s")).toBeTruthy(); // latencyP50 8400
  });

  it("curation section: configs/fixtures, survival@tokens, pareto and the declared chip", async () => {
    stubFetch(allRuns);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Curation runs" })).toBeTruthy();
    });
    const section = within(familySection("Curation runs"));

    expect(section.getByText("4")).toBeTruthy(); // configCount
    expect(section.getByText("3")).toBeTruthy(); // fixtures = 12 cases / 4 configs
    expect(section.getByText("100% @ 9.8k tok")).toBeTruthy(); // survivalBest @ tokensAtBest
    expect(section.getByText("18%")).toBeTruthy(); // compressionPct (already percent units)
    expect(section.getByText("2/4")).toBeTruthy(); // paretoCount / configCount
    expect(section.getByText("declared")).toBeTruthy(); // meta.curation.frontier present
  });

  it("frontier chip falls back to 'computed' when meta.curation.frontier is absent", async () => {
    const noFrontier: EvalRunRow = {
      ...curationRun,
      meta: {
        family: "curation",
        summary: (curationRun.meta as Record<string, unknown>).summary,
        curation: { sourceSetId: BUNDLE_SET_ID },
      },
    };
    stubFetch([noFrontier]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Curation runs" })).toBeTruthy();
    });
    const section = within(familySection("Curation runs"));
    expect(section.getByText("computed")).toBeTruthy();
    expect(section.queryByText("declared")).toBeNull();
  });

  it("empty families hide — a renderer-only load renders just its section + Other runs", async () => {
    stubFetch([rendererRun, genericRun]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Renderer runs" })).toBeTruthy();
    });
    expect(screen.queryByRole("heading", { name: "SDC runs" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Curation runs" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Other runs" })).toBeTruthy();
  });

  it("an all-generic load renders NO family sections and NO 'Other runs' heading", async () => {
    stubFetch([genericRun]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeTruthy();
    });
    expect(screen.queryByRole("heading", { name: "Renderer runs" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "SDC runs" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Curation runs" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Other runs" })).toBeNull();
    // The generic body renders exactly as before (filters + table —
    // "baseline" also appears as a Variant filter option, assert the cell).
    expect(screen.getByLabelText("Variant")).toBeTruthy();
    expect(within(screen.getByRole("table")).getByText("baseline")).toBeTruthy();
  });

  it("missing summary fields render em-dashes, never 0 or NaN", async () => {
    const bare: EvalRunRow = {
      id: "seed-renderer-bare",
      tsStart: "2026-07-15T10:00:00.000Z",
      tsEnd: null,
      setId: BANK_SET_ID,
      targetId: "answer-renderer",
      variant: null,
      split: null,
      model: null,
      gitSha: null,
      status: "ok",
      // No list summary and meta.summary absent — every metric cell dashes.
      meta: { family: "renderer" },
    };
    stubFetch([bare]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Renderer runs" })).toBeTruthy();
    });
    const section = within(familySection("Renderer runs"));

    expect(section.getByText("det —")).toBeTruthy();
    // Renders / Flags / Fallback / Retries / $ per render / Run $ all dash.
    expect(section.getAllByText("—").length).toBe(6);
    expect(section.queryByText(/NaN/)).toBeNull();
    expect(section.queryByText("0%")).toBeNull();
  });

  it("run-id links are URL-encoded hrefs to the run detail", async () => {
    const oddId: EvalRunRow = {
      ...rendererRun,
      id: "seed renderer/01",
      summary: rendererRun.summary,
    };
    stubFetch([oddId, sdcRun, curationRun]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Renderer runs" })).toBeTruthy();
    });

    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain("/eval/runs/seed%20renderer%2F01");
    expect(links).toContain("/eval/runs/seed-sdc-01");
    expect(links).toContain("/eval/runs/seed-curation-01");
  });

  it("clicking a family row navigates to the run detail", async () => {
    stubFetch(allRuns);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "SDC runs" })).toBeTruthy();
    });

    const modelCell = within(familySection("SDC runs")).getByText("claude-sonnet-4-5");
    const row = modelCell.closest("tr");
    expect(row).toBeTruthy();
    fireEvent.click(row as HTMLElement);

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/eval/runs/seed-sdc-01");
    });
  });
});
