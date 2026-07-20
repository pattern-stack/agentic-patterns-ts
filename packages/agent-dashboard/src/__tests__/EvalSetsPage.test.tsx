/**
 * EvalSetsPage — render suite over a URL-aware stubbed `fetch` (the
 * `EvalRunsPage.test.tsx` idiom). Wrapped in `MemoryRouter` since the page
 * navigates into set detail on row click.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalSetSummary } from "../api/types";
import { EvalSetsPage } from "../pages/eval/EvalSetsPage";
import { BANK_SET_SUMMARY, BUNDLE_SET_SUMMARY } from "./evalFamilySeedFixtures";

const sets: EvalSetSummary[] = [
  {
    id: "bank",
    name: "Bank One",
    description: "smoke bank",
    createdTs: "2026-07-01T10:00:00Z",
    caseCount: 4,
    splitCounts: { train: 2, dev: 1, "": 1 },
  },
  {
    id: "curator",
    name: null,
    description: null,
    createdTs: "2026-07-02T10:00:00Z",
    caseCount: 3,
    splitCounts: { test: 3 },
  },
];

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

function stubFetch(opts: { sets?: EvalSetSummary[]; status?: number } = {}) {
  const { sets: setsBody = sets, status = 200 } = opts;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/eval/sets")) return mkFetchResponse(status, { sets: setsBody });
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
    <MemoryRouter initialEntries={["/eval/sets"]}>
      <Routes>
        <Route path="/eval/sets" element={<EvalSetsPage />} />
        <Route path="/eval/sets/:id" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EvalSetsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders seeded sets with names, case counts, and per-split badges", async () => {
    stubFetch();
    renderPage();

    let table: HTMLElement;
    await waitFor(() => {
      table = screen.getByRole("table");
    });
    const rows = within(table!);
    expect(rows.getByText("bank")).toBeTruthy();
    expect(rows.getByText("Bank One")).toBeTruthy();
    expect(rows.getByText("curator")).toBeTruthy();
    // per-split badges — train/dev/untagged for bank, test for curator
    expect(rows.getByText("train 2")).toBeTruthy();
    expect(rows.getByText("untagged 1")).toBeTruthy();
    expect(rows.getByText("test 3")).toBeTruthy();
  });

  it("navigates to the set detail on row click", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => screen.getByText("bank"));
    fireEvent.click(screen.getByText("bank"));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/eval/sets/bank");
    });
  });

  it("family chip column: bank shows state count, bundle shows meta chips, generic untouched", async () => {
    stubFetch({ sets: [...sets, BANK_SET_SUMMARY, BUNDLE_SET_SUMMARY] });
    renderPage();

    await waitFor(() => screen.getByText("answer-bank"));
    // answer-bank rows carry the frozen state count
    expect(screen.getByText("2 states")).toBeTruthy();
    // bundle columns from set.meta: source, benchmark@version, dataset, families[]
    expect(screen.getByText("question-bundle")).toBeTruthy();
    expect(screen.getByText("cache")).toBeTruthy();
    expect(screen.getByText("sdc-bench@v2")).toBeTruthy();
    expect(screen.getByText("beanmaxx")).toBeTruthy();
    expect(screen.getByText("sdc")).toBeTruthy();
    expect(screen.getByText("curation")).toBeTruthy();
    // generic rows render exactly as before, alongside the family rows
    expect(screen.getByText("Bank One")).toBeTruthy();
    expect(screen.getByText("train 2")).toBeTruthy();
  });

  it("503 -> the unconfigured card, not the empty state", async () => {
    stubFetch({ status: 503 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Eval persistence is not configured")).toBeTruthy();
    });
  });

  it("empty -> the no-sets card", async () => {
    stubFetch({ sets: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("No eval sets yet")).toBeTruthy();
    });
  });
});
