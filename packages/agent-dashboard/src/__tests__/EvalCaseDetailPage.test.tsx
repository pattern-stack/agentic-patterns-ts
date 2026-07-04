/**
 * EvalCaseDetailPage — render suite over a URL-aware stubbed `fetch`. One GET
 * (`/eval/sets/:id/cases/:caseId`) returns the case + history; the page
 * renders the case body and a history table whose rows expand + link to runs.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalCaseDetailResponse } from "../api/types";
import { EvalCaseDetailPage } from "../pages/eval/EvalCaseDetailPage";

const detail: EvalCaseDetailResponse = {
  case: {
    setId: "bank",
    caseId: "case-01",
    input: "2+2?",
    expected: "4",
    tags: ["smoke"],
    split: "test",
  },
  history: [
    {
      evalRunId: "run-newest0",
      tsStart: "2026-07-02T10:00:00Z",
      targetId: "dealbrain/curator",
      variant: "candidate",
      split: "test",
      model: "opus",
      runStatus: "ok",
      pass: true,
      scores: [{ name: "exact", value: 1, passed: true }],
      finalAnswer: '"4"',
      inputTokens: 12,
      outputTokens: 3,
      elapsedMs: 700,
    },
    {
      evalRunId: "run-oldest0",
      tsStart: "2026-07-01T10:00:00Z",
      targetId: "dealbrain/curator",
      variant: "baseline",
      split: "test",
      model: "sonnet",
      runStatus: "ok",
      pass: false,
      scores: [{ name: "exact", value: 0, passed: false }],
      finalAnswer: '"3"',
      inputTokens: 10,
      outputTokens: 2,
      elapsedMs: 500,
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

function stubFetch(opts: { body?: EvalCaseDetailResponse; status?: number } = {}) {
  const { body = detail, status = 200 } = opts;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cases/")) return mkFetchResponse(status, body);
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPage(path = "/eval/sets/bank/cases/case-01") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/eval/sets/:id/cases/:caseId" element={<EvalCaseDetailPage />} />
        <Route path="/eval/runs/:id" element={<LocationDisplay />} />
        <Route path="/eval/sets/:id" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EvalCaseDetailPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the case, held-out marker, tags, and the cross-run history newest-first", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => screen.getByText("case-01"));
    expect(screen.getByText("held-out")).toBeTruthy();
    expect(screen.getByText("smoke")).toBeTruthy();

    const table = screen.getByRole("table");
    const rows = within(table);
    // newest-first: candidate (pass) above baseline (fail)
    expect(rows.getByText("candidate")).toBeTruthy();
    expect(rows.getByText("baseline")).toBeTruthy();
    expect(rows.getByText("pass")).toBeTruthy();
    expect(rows.getByText("fail")).toBeTruthy();
  });

  it("navigates to the full run from an expanded history row", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => screen.getByText("candidate"));
    fireEvent.click(screen.getByText("candidate")); // expand the newest row
    const link = await screen.findByText("View full run →");
    fireEvent.click(link);
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/eval/runs/run-newest0");
    });
  });

  it("shows the empty-history card when the case was never run", async () => {
    stubFetch({ body: { case: detail.case, history: [] } });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("This case has not been evaluated in any run yet.")).toBeTruthy();
    });
  });

  it("404 -> the not-found card", async () => {
    stubFetch({ status: 404 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Eval case not found")).toBeTruthy();
    });
  });

  it("503 -> the unconfigured card", async () => {
    stubFetch({ status: 503 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Eval persistence is not configured")).toBeTruthy();
    });
  });
});
