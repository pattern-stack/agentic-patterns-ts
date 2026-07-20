/**
 * EvalCaseDetailPage — render suite over a URL-aware stubbed `fetch`. One GET
 * (`/eval/sets/:id/cases/:caseId`) returns the case + history; the page
 * renders the case body and a history table whose rows expand + link to runs.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalCaseDetailResponse, EvalSetSummary } from "../api/types";
import { EvalCaseDetailPage } from "../pages/eval/EvalCaseDetailPage";
import {
  BANK_CASES,
  BANK_SET_ID,
  BANK_SET_SUMMARY,
  BUNDLE_CASES,
  BUNDLE_SET_ID,
  BUNDLE_SET_SUMMARY,
} from "./evalFamilySeedFixtures";

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

function stubFetch(
  opts: { body?: EvalCaseDetailResponse; status?: number; sets?: EvalSetSummary[] } = {},
) {
  const { body = detail, status = 200, sets } = opts;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cases/")) return mkFetchResponse(status, body);
      // The family lookup's set-list GET — 404 when the test declares no sets
      // (the page tolerates the failure and stays generic).
      if (url.includes("/eval/sets") && sets) return mkFetchResponse(200, { sets });
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

  it("generic case keeps the Edit affordance", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => screen.getByText("case-01"));
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("answer-bank case: family view + empty-history explanatory note, Edit hidden", async () => {
    const caseRow = BANK_CASES[0];
    if (!caseRow) throw new Error("fixture missing");
    stubFetch({ body: { case: caseRow, history: [] }, sets: [BANK_SET_SUMMARY] });
    renderPage(`/eval/sets/${encodeURIComponent(BANK_SET_ID)}/cases/fid-001`);

    await waitFor(() => screen.getByText("Golden response"));
    // stat tiles + used-ref chips from the golden
    expect(screen.getByText("Evidence refs")).toBeTruthy();
    expect(screen.getByText("Used evidence")).toBeTruthy();
    expect(screen.getByText("evidence-5")).toBeTruthy();
    // frozen import — no Edit
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    // history stays below, empty with the composite-id note (never fake rows)
    expect(screen.getByText(/composite case ids/)).toBeTruthy();
    expect(screen.queryByText("This case has not been evaluated in any run yet.")).toBeNull();
  });

  it("question-bundle case: expectation cards render and the history table stays", async () => {
    const caseRow = BUNDLE_CASES[0];
    if (!caseRow) throw new Error("fixture missing");
    stubFetch({ body: { case: caseRow, history: detail.history }, sets: [BUNDLE_SET_SUMMARY] });
    renderPage(`/eval/sets/${encodeURIComponent(BUNDLE_SET_ID)}/cases/fx-001`);

    await waitFor(() => screen.getByText("Gold expectations"));
    expect(screen.getByText("3 required · 5 total")).toBeTruthy();
    expect(screen.getAllByText("required").length).toBe(3);
    expect(screen.getAllByText("judge").length).toBe(2);
    expect(screen.getAllByText("Pricing call 2026-06-12").length).toBe(2);
    expect(screen.getByText("scope · deal:opp-2214")).toBeTruthy();
    expect(screen.getByText("as_of · 2026-07-10")).toBeTruthy();
    // cross-run history table still renders below the family body
    expect(screen.getByText("candidate")).toBeTruthy();
    expect(screen.getByText("baseline")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
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
