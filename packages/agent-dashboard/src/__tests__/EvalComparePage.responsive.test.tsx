/**
 * EvalComparePage responsive — summary grid stacking, column pruning, and
 * expanded-row grid stacking on phone (W1-EvalCompare). Reuses the
 * fetch-stub idiom from `EvalComparePage.test.tsx`. Desktop (explicit
 * matchMedia stub returning false, and the jsdom fallback via the legacy
 * suite) must render unchanged.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalRunDetailResponse, EvalRunRow, JoinedEvalResultRow } from "../api/types";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { EvalComparePage } from "../pages/eval/EvalComparePage";

function mkRun(overrides: Partial<EvalRunRow>): EvalRunRow {
  return {
    id: "run-x",
    tsStart: "2026-07-01T10:00:00Z",
    tsEnd: "2026-07-01T10:05:00Z",
    setId: "bank",
    targetId: "dealbrain/curator",
    variant: "x",
    split: "dev",
    model: "sonnet",
    gitSha: "abc1234567",
    status: "ok",
    ...overrides,
  };
}

function mkResult(
  caseId: string,
  overrides: Partial<JoinedEvalResultRow> = {},
): JoinedEvalResultRow {
  return {
    evalRunId: "run-x",
    caseId,
    runId: `r-${caseId}`,
    scores: [{ name: "exact-match", value: 1, passed: true }],
    pass: true,
    traceId: `run-x:${caseId}`,
    runStatus: "ok",
    finalAnswer: '"4"',
    inputTokens: 10,
    outputTokens: 5,
    finishReason: "stop",
    elapsedMs: 100,
    runError: null,
    ...overrides,
  };
}

const runA = mkRun({ id: "run-a", variant: "baseline", split: "dev", gitSha: "aaa1111111" });
const runB = mkRun({
  id: "run-b",
  variant: "candidate",
  split: "train",
  gitSha: "bbb2222222",
  status: "ok",
});

const detailA: EvalRunDetailResponse = {
  run: runA,
  results: [
    mkResult("case-both-pass", { evalRunId: "run-a", pass: true, finalAnswer: '"4"' }),
    mkResult("case-regress", { evalRunId: "run-a", pass: true, finalAnswer: '"4"' }),
  ],
  summary: {
    cases: 2,
    passed: 2,
    failed: 0,
    ungated: 0,
    errored: 0,
    passRate: 1,
    inputTokens: 20,
    outputTokens: 10,
  },
};

const detailB: EvalRunDetailResponse = {
  run: runB,
  results: [
    mkResult("case-both-pass", { evalRunId: "run-b", pass: true, finalAnswer: '"4"' }),
    mkResult("case-regress", { evalRunId: "run-b", pass: false, finalAnswer: '"5"' }),
  ],
  summary: {
    cases: 2,
    passed: 1,
    failed: 1,
    ungated: 0,
    errored: 0,
    passRate: 0.5,
    inputTokens: 20,
    outputTokens: 10,
  },
};

const casesResponse = {
  setId: "bank",
  cases: [
    {
      setId: "bank",
      caseId: "case-both-pass",
      input: "2+2?",
      expected: "4",
      tags: null,
      split: "dev",
    },
  ],
};

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/eval/runs/run-a")) {
        return mkFetchResponse(200, detailA);
      }
      if (url.includes("/eval/runs/run-b")) {
        return mkFetchResponse(200, detailB);
      }
      if (url.includes("/eval/sets/bank/cases")) {
        return mkFetchResponse(200, casesResponse);
      }
      if (url.includes("/admin/events/recent")) {
        return mkFetchResponse(200, { events: [] });
      }
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

/** Stubs `window.matchMedia` so `useBreakpoint` reports phone or desktop. */
function stubMatchMedia(phone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: phone && (query === "(max-width: 639px)" || query === "(max-width: 899px)"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/eval/compare/run-a/run-b"]}>
      <Routes>
        <Route path="/eval/compare/:aId/:bId" element={<EvalComparePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetMediaQueryCacheForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetMediaQueryCacheForTests();
});

describe("EvalComparePage — responsive", () => {
  it("stacks the summary grid to one column on phone", async () => {
    stubMatchMedia(true);
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("A · baseline")).toBeTruthy();
    });
    expect(screen.getByText("B · candidate")).toBeTruthy();

    const grid = screen.getByTestId("compare-summary-grid");
    expect(grid.style.gridTemplateColumns).toBe("1fr");

    const aLabel = screen.getByText("A · baseline");
    const bLabel = screen.getByText("B · candidate");
    const aFollowedByB = Boolean(
      aLabel.compareDocumentPosition(bLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(aFollowedByB).toBe(true);
  });

  it("prunes A/B and score columns on phone, keeping Case and Δ", async () => {
    stubMatchMedia(true);
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-regress")).toBeTruthy();
    });

    expect(screen.getByRole("columnheader", { name: "Case" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Δ" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "A" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "B" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Scores A" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Scores B" })).toBeNull();
  });

  it("stacks the expanded A/B grids on phone with legible labels", async () => {
    stubMatchMedia(true);
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-regress")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("case-regress"));

    await waitFor(() => {
      expect(screen.getByText("A · Actual")).toBeTruthy();
    });

    for (const testId of ["expanded-actual-grid", "expanded-scores-grid", "expanded-trace-grid"]) {
      const grid = screen.getByTestId(testId);
      expect(grid.style.gridTemplateColumns).toBe("1fr");
    }

    expect(screen.getByText("A · Actual")).toBeTruthy();
    expect(screen.getByText("B · Actual")).toBeTruthy();
    expect(screen.getByText("A · Scores")).toBeTruthy();
    expect(screen.getByText("B · Scores")).toBeTruthy();
    expect(screen.getByText("A · Trace")).toBeTruthy();
    expect(screen.getByText("B · Trace")).toBeTruthy();
  });

  it("stacks the expanded Input/Expected grid on phone", async () => {
    stubMatchMedia(true);
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-both-pass")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("case-both-pass"));

    await waitFor(() => {
      expect(screen.getByText("Input / Expected")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Input / Expected"));

    const grid = screen.getByTestId("expanded-input-grid");
    expect(grid.style.gridTemplateColumns).toBe("1fr");
  });

  it("desktop stays two columns and shows all six column headers (explicit stub)", async () => {
    stubMatchMedia(false);
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("A · baseline")).toBeTruthy();
    });

    const grid = screen.getByTestId("compare-summary-grid");
    expect(grid.style.gridTemplateColumns).toBe("1fr 1fr");

    for (const name of ["Case", "A", "B", "Δ", "Scores A", "Scores B"]) {
      expect(screen.getByRole("columnheader", { name })).toBeTruthy();
    }
  });
});
