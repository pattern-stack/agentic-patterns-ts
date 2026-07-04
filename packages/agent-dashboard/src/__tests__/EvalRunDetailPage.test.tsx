/**
 * EvalRunDetailPage — render + expand + trace suite, stubbed fetch. Stubs
 * `/eval/runs/:id`, then `/eval/sets/:id/cases`, then `/admin/events/recent`
 * by inspecting the requested URL (the sequential-dependent-fetch precedent
 * from `ConversationDetailPage`, plus the lazy trace click).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalRunDetailResponse } from "../api/types";
import { EvalRunDetailPage } from "../pages/eval/EvalRunDetailPage";

const detailResponse: EvalRunDetailResponse = {
  run: {
    id: "run-1",
    tsStart: "2026-07-01T10:00:00Z",
    tsEnd: "2026-07-01T10:05:00Z",
    setId: "bank",
    targetId: "dealbrain/curator",
    variant: "baseline",
    split: "dev",
    model: "sonnet",
    gitSha: "abcdef1234567",
    status: "ok",
  },
  results: [
    {
      evalRunId: "run-1",
      caseId: "case-pass",
      runId: "r1",
      scores: [{ name: "exact-match", value: 1, passed: true }],
      pass: true,
      traceId: "run-1:case-pass",
      runStatus: "ok",
      finalAnswer: '"4"',
      inputTokens: 10,
      outputTokens: 5,
      finishReason: "stop",
      elapsedMs: 120,
      runError: null,
    },
    {
      evalRunId: "run-1",
      caseId: "case-fail",
      runId: "r2",
      scores: [{ name: "exact-match", value: 0, passed: false }],
      pass: false,
      traceId: "run-1:case-fail",
      runStatus: "ok",
      finalAnswer: '"41"',
      inputTokens: 12,
      outputTokens: 6,
      finishReason: "stop",
      elapsedMs: 130,
      runError: null,
    },
    {
      evalRunId: "run-1",
      caseId: "case-ungated",
      runId: "r3",
      scores: null,
      pass: null,
      traceId: null,
      runStatus: "ok",
      finalAnswer: '"7"',
      inputTokens: 8,
      outputTokens: 4,
      finishReason: "stop",
      elapsedMs: 90,
      runError: null,
    },
    {
      evalRunId: "run-1",
      caseId: "case-missing",
      runId: "r4",
      scores: [{ name: "exact-match", value: 0, passed: false }],
      pass: false,
      traceId: null,
      runStatus: "ok",
      finalAnswer: '"x"',
      inputTokens: 5,
      outputTokens: 3,
      finishReason: "stop",
      elapsedMs: 50,
      runError: null,
    },
    {
      evalRunId: "run-1",
      caseId: "case-error",
      runId: "r5",
      scores: null,
      pass: null,
      traceId: "run-1:case-error",
      runStatus: "error",
      finalAnswer: null,
      inputTokens: null,
      outputTokens: null,
      finishReason: null,
      elapsedMs: null,
      runError: "boom: model call failed",
    },
  ],
  summary: {
    cases: 5,
    passed: 1,
    failed: 2,
    ungated: 2,
    errored: 1,
    passRate: 1 / 3,
    inputTokens: 35,
    outputTokens: 18,
  },
};

// case-missing is deliberately absent from the bank.
const casesResponse = {
  setId: "bank",
  cases: [
    { setId: "bank", caseId: "case-pass", input: "2+2?", expected: "4", tags: null, split: "dev" },
    { setId: "bank", caseId: "case-fail", input: "6*7?", expected: "42", tags: null, split: "dev" },
    {
      setId: "bank",
      caseId: "case-ungated",
      input: "3+4?",
      expected: "7",
      tags: null,
      split: "dev",
    },
    {
      setId: "bank",
      caseId: "case-error",
      input: "boom?",
      expected: "n/a",
      tags: null,
      split: "dev",
    },
  ],
};

const eventsResponse = {
  events: [
    {
      id: 3,
      type: "agent.tool.end",
      timestamp: "2026-07-01T10:00:03Z",
      data: { x: 3 },
      traceId: "run-1:case-pass",
    },
    {
      id: 2,
      type: "agent.tool.start",
      timestamp: "2026-07-01T10:00:02Z",
      data: { x: 2 },
      traceId: "run-1:case-pass",
    },
    {
      id: 1,
      type: "agent.llm.start",
      timestamp: "2026-07-01T10:00:01Z",
      data: { x: 1 },
      traceId: "some-other-trace",
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
      if (url.includes("/eval/sets/bank/cases")) {
        return mkFetchResponse(200, casesResponse);
      }
      if (url.includes("/eval/runs/run-1")) {
        return mkFetchResponse(200, detailResponse);
      }
      if (url.includes("/admin/events/recent")) {
        return mkFetchResponse(200, eventsResponse);
      }
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/eval/runs/run-1"]}>
      <Routes>
        <Route path="/eval/runs/:id" element={<EvalRunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EvalRunDetailPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders summary pills and tri-state badges for pass/fail/ungated rows", async () => {
    stubFetch();
    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-pass")).toBeTruthy();
    });

    // Summary pills.
    expect(container.textContent).toContain("Cases");
    expect(container.textContent).toContain("Passed");
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("Ungated");
    expect(container.textContent).toContain("33%"); // passRate 1/3 rounded

    // Tri-state badges — one of each is present among the case rows.
    expect(screen.getAllByText("pass").length).toBeGreaterThan(0);
    expect(screen.getAllByText("fail").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ungated").length).toBeGreaterThan(0);
  });

  it("expanding a failing row shows Expected/Actual side-by-side; the errored case shows runError", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-fail")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("case-fail"));

    await waitFor(() => {
      expect(screen.getByText("Expected")).toBeTruthy();
    });
    // Expected = bank's "42"; Actual = safeParseAnswer('"41"') = "41" — both pretty-printed.
    expect(screen.getByText('"42"')).toBeTruthy();
    expect(screen.getByText('"41"')).toBeTruthy();

    // Collapse case-fail, expand the errored case.
    fireEvent.click(screen.getByText("case-fail"));
    fireEvent.click(screen.getByText("case-error"));

    await waitFor(() => {
      expect(screen.getByText("boom: model call failed")).toBeTruthy();
    });
    // The error panel replaces Actual — no pretty-printed finalAnswer (it's null anyway).
    expect(screen.queryByText("no scores recorded")).toBeTruthy();
  });

  it("a case absent from the bank shows the 'not in bank' fallback", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-missing")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("case-missing"));

    await waitFor(() => {
      expect(screen.getByText("expected unavailable — case not in bank")).toBeTruthy();
    });
  });

  it("Load trace fetches /admin/events/recent and renders only the case's traceId; empty match shows the purged message", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("case-pass")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("case-pass"));
    await waitFor(() => {
      expect(screen.getByText("run-1:case-pass")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Load trace"));

    await waitFor(() => {
      expect(screen.getByText("tool.end")).toBeTruthy();
    });
    // Only the two rows stamped with this case's traceId render — the
    // "some-other-trace" row (llm.start) is filtered out.
    expect(screen.getByText("tool.start")).toBeTruthy();
    expect(screen.queryByText("llm.start")).toBeNull();

    // Collapse and expand the errored case — its traceId has no matching
    // events in the seeded window, so it renders the purged-log message.
    fireEvent.click(screen.getByText("case-pass"));
    fireEvent.click(screen.getByText("case-error"));
    await waitFor(() => {
      expect(screen.getByText("run-1:case-error")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Load trace"));

    await waitFor(() => {
      expect(
        screen.getByText("No trace events found — the event log may have been purged."),
      ).toBeTruthy();
    });
  });
});
