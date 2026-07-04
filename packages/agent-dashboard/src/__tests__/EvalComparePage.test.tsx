/**
 * EvalComparePage — render suite, stubbed fetch (the `EvalRunDetailPage.test.tsx`
 * URL-branching idiom: `/eval/runs/:aId`, `/eval/runs/:bId`, then
 * `/eval/sets/:id/cases`, then `/admin/events/recent` for the lazy trace).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalRunDetailResponse, EvalRunRow, JoinedEvalResultRow } from "../api/types";
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
    mkResult("case-improve", { evalRunId: "run-a", pass: false, finalAnswer: '"wrong"' }),
    mkResult("case-aonly", { evalRunId: "run-a", pass: true, finalAnswer: '"9"' }),
    mkResult("case-error", { evalRunId: "run-a", pass: true, finalAnswer: '"4"' }),
  ],
  summary: {
    cases: 5,
    passed: 4,
    failed: 1,
    ungated: 0,
    errored: 0,
    passRate: 0.8,
    inputTokens: 50,
    outputTokens: 25,
  },
};

const detailB: EvalRunDetailResponse = {
  run: runB,
  results: [
    mkResult("case-both-pass", { evalRunId: "run-b", pass: true, finalAnswer: '"4"' }),
    mkResult("case-regress", { evalRunId: "run-b", pass: false, finalAnswer: '"5"' }),
    mkResult("case-improve", { evalRunId: "run-b", pass: true, finalAnswer: '"7"' }),
    mkResult("case-error", {
      evalRunId: "run-b",
      pass: null,
      runStatus: "error",
      finalAnswer: null,
      scores: null,
      runError: "boom: model call failed",
      traceId: "run-b:case-error",
    }),
    // case-bonly is present only in B.
    mkResult("case-bonly", { evalRunId: "run-b", pass: true, finalAnswer: '"11"' }),
  ],
  summary: {
    cases: 4,
    passed: 2,
    failed: 1,
    ungated: 1,
    errored: 1,
    passRate: 2 / 3,
    inputTokens: 40,
    outputTokens: 20,
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

interface StubOptions {
  aId?: string;
  bId?: string;
  aStatus?: number;
  bStatus?: number;
  aBody?: unknown;
  bBody?: unknown;
}

function stubFetch(opts: StubOptions = {}) {
  const {
    aId = "run-a",
    bId = "run-b",
    aStatus = 200,
    bStatus = 200,
    aBody = detailA,
    bBody = detailB,
  } = opts;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/eval/runs/${aId}`)) {
        return mkFetchResponse(aStatus, aBody);
      }
      if (url.includes(`/eval/runs/${bId}`)) {
        return mkFetchResponse(bStatus, bBody);
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

function renderPage(aId = "run-a", bId = "run-b") {
  return render(
    <MemoryRouter initialEntries={[`/eval/compare/${aId}/${bId}`]}>
      <Routes>
        <Route path="/eval/compare/:aId/:bId" element={<EvalComparePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EvalComparePage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders provenance cards, six summary tiles, and the aligned per-case table", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("A · baseline")).toBeTruthy();
    });
    expect(screen.getByText("B · candidate")).toBeTruthy();
    expect(screen.getByText("variant · baseline")).toBeTruthy();
    expect(screen.getByText("variant · candidate")).toBeTruthy();

    // Six summary tiles.
    expect(screen.getByText("Both passed")).toBeTruthy();
    expect(screen.getByText("Both failed")).toBeTruthy();
    expect(screen.getByText("Regressions")).toBeTruthy();
    expect(screen.getByText("Improvements")).toBeTruthy();
    expect(screen.getByText("Only in A")).toBeTruthy();
    expect(screen.getByText("Only in B")).toBeTruthy();

    // Aligned rows — sorted union of case ids across both runs.
    expect(screen.getByText("case-both-pass")).toBeTruthy();
    expect(screen.getByText("case-regress")).toBeTruthy();
    expect(screen.getByText("case-improve")).toBeTruthy();
    expect(screen.getByText("case-aonly")).toBeTruthy();
    expect(screen.getByText("case-bonly")).toBeTruthy();
    expect(screen.getByText("case-error")).toBeTruthy();
  });

  it("a one-sided case shows the muted 'not run' badge, not an error", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-aonly")).toBeTruthy();
    });

    const row = screen.getByText("case-aonly").closest("tr");
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("not run");
  });

  it("expanding the errored case shows the red error treatment for that side only", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-error")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("case-error"));

    await waitFor(() => {
      expect(screen.getByText("boom: model call failed")).toBeTruthy();
    });
    // A's side (not errored) still shows its pretty-printed actual answer.
    expect(screen.getByText('"4"')).toBeTruthy();
  });

  it("expanding a row shows A/B actual answers side by side", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-regress")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("case-regress"));

    await waitFor(() => {
      expect(screen.getByText("A · Actual")).toBeTruthy();
    });
    expect(screen.getByText("B · Actual")).toBeTruthy();
    expect(screen.getByText('"4"')).toBeTruthy();
    expect(screen.getByText('"5"')).toBeTruthy();
  });

  it("expanding a one-sided row shows 'not run in this eval run' for the absent side", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-aonly")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("case-aonly"));

    await waitFor(() => {
      expect(screen.getAllByText("not run in this eval run").length).toBeGreaterThan(0);
    });
  });

  it("different setIds -> the non-blocking warning banner", async () => {
    const bOtherSet: EvalRunDetailResponse = {
      ...detailB,
      run: { ...runB, setId: "other-bank" },
    };
    stubFetch({ bBody: bOtherSet });
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText("Runs are from different sets — case alignment may be sparse."),
      ).toBeTruthy();
    });
  });

  it("either detail 404s -> the not-found card, naming the missing id", async () => {
    stubFetch({ bStatus: 404, bBody: { error: 'eval run "run-b" not found' } });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Eval run not found")).toBeTruthy();
    });
    expect(screen.getByText(/"run-b"/)).toBeTruthy();
  });

  it("either detail 503s -> the unconfigured card", async () => {
    stubFetch({ aStatus: 503, aBody: { error: "persistence not configured" } });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Eval persistence is not configured")).toBeTruthy();
    });
  });
});
