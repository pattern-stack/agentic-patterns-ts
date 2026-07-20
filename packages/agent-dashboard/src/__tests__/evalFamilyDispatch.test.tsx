/**
 * Family dispatch (slices 5-9 seam) — proves the ONE UI LAW at both dispatch
 * sites: a family run REPLACES the generic body with the registry component,
 * while generic and unknown-family runs render the pre-family UI unchanged.
 * Asserts against the real family components (section headers, root testids);
 * per-family content depth is covered by each family's own test file.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalRunRow, EvalRunSummary, JoinedEvalResultRow, SplitAggregate } from "../api/types";
import { EvalRunDetailPage } from "../pages/eval/EvalRunDetailPage";
import { EvalRunsPage } from "../pages/eval/EvalRunsPage";

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

function mkRun(id: string, meta?: Record<string, unknown> | null): EvalRunRow {
  return {
    id,
    tsStart: "2026-07-01T10:00:00Z",
    tsEnd: "2026-07-01T10:05:00Z",
    setId: null,
    targetId: "dealbrain/curator",
    variant: "baseline",
    split: null,
    model: "sonnet",
    gitSha: null,
    status: "ok",
    summary: { cases: 1, passed: 1, failed: 0, ungated: 0, passRate: 1 },
    meta,
  };
}

const detailResults: JoinedEvalResultRow[] = [
  {
    evalRunId: "run-detail-1",
    caseId: "fx-001",
    runId: null,
    scores: [{ name: "judge", value: 0.8 }],
    pass: true,
    traceId: null,
    runStatus: "ok",
    finalAnswer: null,
    inputTokens: null,
    outputTokens: null,
    finishReason: null,
    elapsedMs: null,
    runError: null,
  },
];

const detailSummary: EvalRunSummary = {
  cases: 1,
  passed: 1,
  failed: 0,
  ungated: 0,
  errored: 0,
  passRate: 1,
  inputTokens: 0,
  outputTokens: 0,
};

const emptyAggregates: SplitAggregate[] = [];

/** URL-aware stub: aggregates checked BEFORE the runs superstring. */
function stubListFetch(runs: EvalRunRow[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/eval/aggregates/splits")) {
        return mkFetchResponse(200, { aggregates: emptyAggregates });
      }
      if (url.includes("/eval/runs")) {
        return mkFetchResponse(200, { runs });
      }
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

function stubDetailFetch(run: EvalRunRow) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/eval/runs/${run.id}`)) {
        return mkFetchResponse(200, { run, results: detailResults, summary: detailSummary });
      }
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

function renderDetailPage(runId: string) {
  return render(
    <MemoryRouter initialEntries={[`/eval/runs/${runId}`]}>
      <Routes>
        <Route path="/eval/runs/:id" element={<EvalRunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderListPage() {
  return render(
    <MemoryRouter initialEntries={["/eval"]}>
      <Routes>
        <Route path="/eval" element={<EvalRunsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("eval family dispatch (scaffold)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("EvalRunDetailPage", () => {
    it("family run replaces the generic body with the registry RunDetail", async () => {
      const run = mkRun("run-detail-1", { family: "sdc" });
      stubDetailFetch(run);

      renderDetailPage(run.id);

      await waitFor(() => {
        expect(screen.getByTestId("sdc-run-detail")).toBeTruthy();
      });
      // Generic body is REPLACED, not decorated: no generic stat row. (The
      // family body may render its own tables, so no bare "no table" check.)
      expect(screen.queryByText("Pass Rate")).toBeNull();
      // The shell survives the dispatch (status badge from the header).
      expect(screen.getByText("ok")).toBeTruthy();
    });

    it("generic run keeps the generic body (stat row + results table)", async () => {
      const run = mkRun("run-detail-1");
      stubDetailFetch(run);

      renderDetailPage(run.id);

      await waitFor(() => {
        expect(screen.getByText("Pass Rate")).toBeTruthy();
      });
      expect(screen.getByRole("table")).toBeTruthy();
      expect(screen.queryByTestId("sdc-run-detail")).toBeNull();
      expect(screen.queryByTestId("curation-run-detail")).toBeNull();
    });

    it("unknown family degrades to the generic body", async () => {
      const run = mkRun("run-detail-1", { family: "mystery-benchmark" });
      stubDetailFetch(run);

      renderDetailPage(run.id);

      await waitFor(() => {
        expect(screen.getByText("Pass Rate")).toBeTruthy();
      });
      expect(screen.getByRole("table")).toBeTruthy();
      expect(screen.queryByTestId("sdc-run-detail")).toBeNull();
    });
  });

  describe("EvalRunsPage", () => {
    it("family runs render stacked sections; generic runs keep the full body under Other runs", async () => {
      stubListFetch([
        mkRun("run-renderer-1", { family: "renderer" }),
        mkRun("run-sdc-1", { family: "sdc" }),
        mkRun("run-generic-1"),
      ]);

      renderListPage();

      await waitFor(() => {
        expect(screen.getByText("Renderer runs")).toBeTruthy();
      });
      expect(screen.getByText("SDC runs")).toBeTruthy();
      // Empty family sections hide entirely.
      expect(screen.queryByText("Curation runs")).toBeNull();
      // The generic section keeps the entire pre-family body, labeled.
      expect(screen.getByText("Other runs")).toBeTruthy();
      // Family tables render alongside the generic one now — scope by content:
      // the generic table carries the generic run and none of the family runs.
      const tables = screen.getAllByRole("table");
      const generic = tables.find((t) => t.textContent?.includes("run-gene"));
      expect(generic).toBeTruthy();
      expect(generic?.textContent).not.toContain("run-rend");
    });

    it("all-generic renders exactly as today (no sections, no placeholders)", async () => {
      stubListFetch([mkRun("run-generic-1"), mkRun("run-generic-2")]);

      renderListPage();

      await waitFor(() => {
        expect(screen.getByRole("table")).toBeTruthy();
      });
      expect(screen.queryByText("Other runs")).toBeNull();
      expect(screen.queryByText("Renderer runs")).toBeNull();
      expect(screen.queryByText("SDC runs")).toBeNull();
      expect(screen.queryByText("Curation runs")).toBeNull();
    });
  });
});
