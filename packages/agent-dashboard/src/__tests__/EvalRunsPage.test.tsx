/**
 * EvalRunsPage — render suite, stubbed fetch (the `DashboardPage.test.tsx`
 * idiom: `vi.stubGlobal("fetch")`). Wrapped in `MemoryRouter` since the page
 * navigates on row click.
 *
 * Fetch stubbing is URL-aware (the `EvalRunDetailPage.test.tsx` idiom) —
 * the page now issues two independent GETs per load (`/eval/runs` and
 * `/eval/aggregates/splits`, #138's `SplitAggregatesPanel`), so a single
 * URL-blind mock would feed the aggregates fetch the runs body and crash.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalRunRow, SplitAggregate } from "../api/types";
import { EvalRunsPage } from "../pages/eval/EvalRunsPage";

const runs: EvalRunRow[] = [
  {
    id: "run-aaaaaaaa",
    tsStart: "2026-07-01T10:00:00Z",
    tsEnd: "2026-07-01T10:05:00Z",
    setId: "bank",
    targetId: "dealbrain/curator",
    variant: "baseline",
    split: "dev",
    model: "sonnet",
    gitSha: "abc1234",
    status: "ok",
    // 3 of 4 gated cases passed -> "3/4" + "75%".
    summary: { cases: 4, passed: 3, failed: 1, ungated: 0, passRate: 0.75 },
  },
  {
    id: "run-bbbbbbbb",
    tsStart: "2026-07-02T10:00:00Z",
    tsEnd: null,
    setId: "bank",
    targetId: "dealbrain/curator",
    variant: "candidate",
    split: "train",
    model: "opus",
    gitSha: "def5678",
    status: "running",
    // No summary (still running) -> the pass cell shows "—".
  },
];

// Adds a third run for the "selection capped at 2" test.
const threeRuns: EvalRunRow[] = [
  ...runs,
  {
    id: "run-cccccccc",
    tsStart: "2026-07-03T10:00:00Z",
    tsEnd: "2026-07-03T10:05:00Z",
    setId: "bank",
    targetId: "dealbrain/curator",
    variant: "third",
    split: "test",
    model: "sonnet",
    gitSha: "ghi9012",
    status: "ok",
  },
];

const defaultAggregates: SplitAggregate[] = [
  { split: "train", results: 4, passed: 3, failed: 1, passRate: 0.75 },
  { split: "test", results: 2, passed: 1, failed: 1, passRate: 0.5 },
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
  runs?: EvalRunRow[];
  runsStatus?: number;
  aggregates?: SplitAggregate[];
  aggregatesStatus?: number;
}

function stubFetch(opts: StubOptions = {}) {
  const {
    runs: runsBody = runs,
    runsStatus = 200,
    aggregates = defaultAggregates,
    aggregatesStatus = 200,
  } = opts;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/eval/aggregates/splits")) {
        return mkFetchResponse(aggregatesStatus, { aggregates });
      }
      if (url.includes("/eval/runs")) {
        return mkFetchResponse(runsStatus, { runs: runsBody });
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
        <Route path="/eval/compare/:aId/:bId" element={<LocationDisplay />} />
        <Route path="/eval/runs/:id" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("EvalRunsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders seeded runs — target/variant/status visible", async () => {
    stubFetch();

    renderPage();

    let table: HTMLElement;
    await waitFor(() => {
      table = screen.getByRole("table");
    });
    const rows = within(table!);

    expect(rows.getByText("baseline")).toBeTruthy();
    expect(rows.getAllByText("dealbrain/curator").length).toBeGreaterThan(0);
    expect(rows.getByText("candidate")).toBeTruthy();
    expect(rows.getByText("ok")).toBeTruthy();
    expect(rows.getByText("running")).toBeTruthy();
  });

  it("renders the pass column — passed/cases + rate badge; a summary-less run shows —", async () => {
    stubFetch();

    renderPage();

    let table: HTMLElement;
    await waitFor(() => {
      table = screen.getByRole("table");
    });

    // Column header + the seeded run's fraction and rate badge (scoped to the
    // runs table — the split-aggregates panel above it also renders a "75%").
    expect(within(table!).getByText("Passed")).toBeTruthy();
    expect(within(table!).getByText("3/4")).toBeTruthy();
    expect(within(table!).getByText("75%")).toBeTruthy();

    // The running (summary-less) run's pass cell is the only "—" in its row.
    const checkbox = screen.getByLabelText("select run run-bbbbbbbb for compare");
    const row = checkbox.closest("tr");
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByText("—")).toBeTruthy();
  });

  it("503 -> the unconfigured card, not the empty state", async () => {
    stubFetch({ runsStatus: 503, aggregatesStatus: 503 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Eval persistence is not configured")).toBeTruthy();
    });
    expect(screen.queryByText("No eval runs yet")).toBeNull();
  });

  it("zero runs -> the 'No eval runs yet' card with the ap eval hint", async () => {
    stubFetch({ runs: [] });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("No eval runs yet")).toBeTruthy();
    });
    expect(screen.getByText("ap eval")).toBeTruthy();
  });

  it("selecting a variant filter narrows rows; unmatched filters show the no-match message", async () => {
    stubFetch();

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeTruthy();
    });

    const variantSelect = screen.getByLabelText("Variant") as HTMLSelectElement;
    fireEvent.change(variantSelect, { target: { value: "candidate" } });

    expect(screen.queryByText("run-aaaa…")).toBeNull();
    expect(screen.getByText("run-bbbb…")).toBeTruthy();
    expect(screen.getByText("Clear filters")).toBeTruthy();

    // "candidate" (run-bbbbbbbb) is split "train" — narrowing to split "dev"
    // on top of the variant filter intersects to zero matches.
    const splitSelect = screen.getByLabelText("Split") as HTMLSelectElement;
    fireEvent.change(splitSelect, { target: { value: "dev" } });

    await waitFor(() => {
      expect(screen.getByText("No runs match the current filters.")).toBeTruthy();
    });
  });

  describe("compare selection (#138)", () => {
    it("selecting two rows enables Compare and navigates to /eval/compare/<olderId>/<newerId>", async () => {
      stubFetch();
      renderPage();

      await waitFor(() => {
        expect(screen.getByRole("table")).toBeTruthy();
      });

      fireEvent.click(screen.getByLabelText("select run run-bbbbbbbb for compare"));
      fireEvent.click(screen.getByLabelText("select run run-aaaaaaaa for compare"));

      await waitFor(() => {
        expect(screen.getByText("2 of 2 selected")).toBeTruthy();
      });

      const compareButton = screen.getByRole("button", { name: "Compare" }) as HTMLButtonElement;
      expect(compareButton.disabled).toBe(false);
      fireEvent.click(compareButton);

      await waitFor(() => {
        // run-aaaaaaaa (2026-07-01) is older than run-bbbbbbbb (2026-07-02) —
        // A = baseline (older) comes first regardless of selection order.
        expect(screen.getByTestId("location").textContent).toBe(
          "/eval/compare/run-aaaaaaaa/run-bbbbbbbb",
        );
      });
    });

    it("checkbox click does not trigger row navigation", async () => {
      stubFetch();
      renderPage();

      await waitFor(() => {
        expect(screen.getByRole("table")).toBeTruthy();
      });

      fireEvent.click(screen.getByLabelText("select run run-aaaaaaaa for compare"));

      await waitFor(() => {
        expect(screen.getByText("1 of 2 selected")).toBeTruthy();
      });
      // Still on the runs page — no navigation to the run detail route.
      expect(screen.queryByTestId("location")).toBeNull();
      expect(screen.getByRole("table")).toBeTruthy();
    });

    it("a third checkbox is disabled once two rows are selected", async () => {
      stubFetch({ runs: threeRuns });
      renderPage();

      await waitFor(() => {
        expect(screen.getByRole("table")).toBeTruthy();
      });

      fireEvent.click(screen.getByLabelText("select run run-aaaaaaaa for compare"));
      fireEvent.click(screen.getByLabelText("select run run-bbbbbbbb for compare"));

      await waitFor(() => {
        expect(screen.getByText("2 of 2 selected")).toBeTruthy();
      });

      const thirdCheckbox = screen.getByLabelText(
        "select run run-cccccccc for compare",
      ) as HTMLInputElement;
      expect(thirdCheckbox.disabled).toBe(true);
    });
  });

  describe("split aggregates panel (#138)", () => {
    it("renders per-split buckets and the overfit gap tile from stubbed fetch", async () => {
      stubFetch();
      renderPage();

      await waitFor(() => {
        expect(screen.getByText("Split aggregates")).toBeTruthy();
      });

      await waitFor(() => {
        expect(screen.getByText("3/4 passed · 1 failed")).toBeTruthy();
      });
      expect(screen.getByText("1/2 passed · 1 failed")).toBeTruthy();
      // gap = (0.75 - 0.5) * 100 = 25.0 pts, positive -> red-tinted "+" prefix.
      expect(screen.getByText("+25.0 pts")).toBeTruthy();
    });

    it("aggregates fetch failure leaves the runs table intact", async () => {
      stubFetch({ aggregatesStatus: 500 });
      renderPage();

      let table: HTMLElement;
      await waitFor(() => {
        table = screen.getByRole("table");
      });
      await waitFor(() => {
        expect(screen.getByText(/Failed to load split aggregates/)).toBeTruthy();
      });
      // The runs table rendered fine despite the aggregates fetch failing.
      expect(within(table!).getByText("baseline")).toBeTruthy();
    });
  });
});
