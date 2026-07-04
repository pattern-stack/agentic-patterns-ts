/**
 * EvalRunsPage — render suite, stubbed fetch (the `DashboardPage.test.tsx`
 * idiom: `vi.stubGlobal("fetch")`). Wrapped in `MemoryRouter` since the page
 * navigates on row click.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalRunRow } from "../api/types";
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

function renderPage() {
  return render(
    <MemoryRouter>
      <EvalRunsPage />
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mkFetchResponse(200, { runs })),
    );

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

  it("503 -> the unconfigured card, not the empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mkFetchResponse(503, { error: "persistence not configured" })),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Eval persistence is not configured")).toBeTruthy();
    });
    expect(screen.queryByText("No eval runs yet")).toBeNull();
  });

  it("zero runs -> the 'No eval runs yet' card with the ap eval hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mkFetchResponse(200, { runs: [] })),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("No eval runs yet")).toBeTruthy();
    });
    expect(screen.getByText("ap eval")).toBeTruthy();
  });

  it("selecting a variant filter narrows rows; unmatched filters show the no-match message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mkFetchResponse(200, { runs })),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeTruthy();
    });

    const variantSelect = screen.getByLabelText("Variant") as HTMLSelectElement;
    fireEvent.change(variantSelect, { target: { value: "candidate" } });

    expect(screen.queryByText("run-aaaa")).toBeNull();
    expect(screen.getByText("run-bbbb")).toBeTruthy();
    expect(screen.getByText("Clear filters")).toBeTruthy();

    // "candidate" (run-bbbbbbbb) is split "train" — narrowing to split "dev"
    // on top of the variant filter intersects to zero matches.
    const splitSelect = screen.getByLabelText("Split") as HTMLSelectElement;
    fireEvent.change(splitSelect, { target: { value: "dev" } });

    await waitFor(() => {
      expect(screen.getByText("No runs match the current filters.")).toBeTruthy();
    });
  });
});
