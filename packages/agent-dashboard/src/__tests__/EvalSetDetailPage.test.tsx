/**
 * EvalSetDetailPage — render suite over a URL-aware stubbed `fetch`. The page
 * issues four independent GETs (`/eval/sets` for the summary, its
 * `/eval/sets/:id/cases`, `/eval/runs` client-filtered to the set, and the
 * `SplitAggregatesPanel`'s `/eval/aggregates/splits`), so the stub is
 * URL-aware — the `/cases` check precedes the `/eval/sets` check since the
 * former is a superstring.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalCaseRow, EvalRunRow, EvalSetSummary, SplitAggregate } from "../api/types";
import { EvalSetDetailPage } from "../pages/eval/EvalSetDetailPage";

const setSummary: EvalSetSummary = {
  id: "bank",
  name: "Bank One",
  description: "smoke bank",
  createdTs: "2026-07-01T10:00:00Z",
  caseCount: 3,
  splitCounts: { train: 1, test: 1, "": 1 },
};

const cases: EvalCaseRow[] = [
  {
    setId: "bank",
    caseId: "case-train",
    input: "2+2?",
    expected: "4",
    tags: ["smoke"],
    split: "train",
  },
  { setId: "bank", caseId: "case-test", input: "3+3?", expected: "6", tags: null, split: "test" },
  {
    setId: "bank",
    caseId: "case-untagged",
    input: "5+5?",
    expected: "10",
    tags: null,
    split: null,
  },
];

const runs: EvalRunRow[] = [
  {
    id: "run-aaaaaaaa",
    tsStart: "2026-07-01T10:00:00Z",
    tsEnd: "2026-07-01T10:05:00Z",
    setId: "bank",
    targetId: "dealbrain/curator",
    variant: "baseline",
    split: "train",
    model: "sonnet",
    gitSha: "abc1234",
    status: "ok",
  },
  {
    id: "run-other",
    tsStart: "2026-07-02T10:00:00Z",
    tsEnd: null,
    setId: "other-bank",
    targetId: "x",
    variant: null,
    split: null,
    model: null,
    gitSha: null,
    status: "ok",
  },
];

const aggregates: SplitAggregate[] = [
  { split: "train", results: 1, passed: 1, failed: 0, passRate: 1 },
];

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

interface StubOptions {
  sets?: EvalSetSummary[];
  setsStatus?: number;
  cases?: EvalCaseRow[];
  runs?: EvalRunRow[];
}

function stubFetch(opts: StubOptions = {}) {
  const {
    sets = [setSummary],
    setsStatus = 200,
    cases: casesBody = cases,
    runs: runsBody = runs,
  } = opts;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/eval/aggregates/splits")) return mkFetchResponse(200, { aggregates });
      if (url.includes("/cases")) return mkFetchResponse(200, { setId: "bank", cases: casesBody });
      if (url.includes("/eval/runs")) return mkFetchResponse(200, { runs: runsBody });
      if (url.includes("/eval/sets")) return mkFetchResponse(setsStatus, { sets });
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPage(id = "bank") {
  return render(
    <MemoryRouter initialEntries={[`/eval/sets/${id}`]}>
      <Routes>
        <Route path="/eval/sets/:id" element={<EvalSetDetailPage />} />
        <Route path="/eval/sets/:id/cases/:caseId" element={<LocationDisplay />} />
        <Route path="/eval/runs/:id" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EvalSetDetailPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the set header, split-grouped cases, and only the runs for this set", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => screen.getByText("Bank One"));

    // Split-group section headers (case counts per split)
    expect(screen.getByText("train (1)")).toBeTruthy();
    expect(screen.getByText("test (1)")).toBeTruthy();
    expect(screen.getByText("untagged (1)")).toBeTruthy();
    // held-out marker on the test group
    expect(screen.getByText("held-out")).toBeTruthy();

    // Cases present
    expect(screen.getByText("case-train")).toBeTruthy();
    expect(screen.getByText("case-test")).toBeTruthy();

    // Runs panel: this set's run is shown, the other-bank run is filtered out
    expect(screen.getByText("run-aaaa")).toBeTruthy();
    expect(screen.queryByText("run-othe")).toBeNull();
  });

  it("navigates into a case on row click", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => screen.getByText("case-train"));
    fireEvent.click(screen.getByText("case-train"));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/eval/sets/bank/cases/case-train");
    });
  });

  it("navigates into a run on row click", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => screen.getByText("run-aaaa"));
    fireEvent.click(screen.getByText("run-aaaa"));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/eval/runs/run-aaaaaaaa");
    });
  });

  it("404s the page when the set id is not in the list", async () => {
    stubFetch();
    renderPage("nope");
    await waitFor(() => {
      expect(screen.getByText("Eval set not found")).toBeTruthy();
    });
  });

  it("503 -> the unconfigured card", async () => {
    stubFetch({ setsStatus: 503 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Eval persistence is not configured")).toBeTruthy();
    });
  });

  it("shows the empty-cases card when the set has no cases", async () => {
    stubFetch({ cases: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("This set has no cases yet.")).toBeTruthy();
    });
  });
});
