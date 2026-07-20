/**
 * Slice-9 fixture explorers — component suite for the bank/bundle family
 * views + ExpectationCards over seed-lifted payloads
 * (`evalFamilySeedFixtures.ts`). Set views navigate on row click, so they
 * render inside a `MemoryRouter` with a location probe route.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalRunRow } from "../api/types";
import { BankCaseView } from "../pages/eval/families/bank/BankCaseView";
import { BankSetView, bankStatsOf } from "../pages/eval/families/bank/BankSetView";
import { BundleCaseView } from "../pages/eval/families/bundle/BundleCaseView";
import { BundleSetView } from "../pages/eval/families/bundle/BundleSetView";
import {
  ExpectationCards,
  parseExpectations,
} from "../pages/eval/families/bundle/ExpectationCards";
import { readSetMeta } from "../pages/eval/families/types";
import {
  BANK_CASES,
  BANK_SET_ID,
  BANK_SET_SUMMARY,
  BUNDLE_CASES,
  BUNDLE_SET_ID,
  BUNDLE_SET_SUMMARY,
} from "./evalFamilySeedFixtures";

const runs: EvalRunRow[] = [
  {
    id: "seed-renderer-01",
    tsStart: "2026-07-15T10:00:00.000Z",
    tsEnd: "2026-07-15T10:12:30.000Z",
    setId: BANK_SET_ID,
    targetId: "answer-renderer",
    variant: null,
    split: null,
    model: null,
    gitSha: "a1b2c3d4e5f6",
    status: "ok",
  },
];

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderWithRouter(ui: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <Routes>
        <Route path="/start" element={ui} />
        <Route path="/eval/sets/:id/cases/:caseId" element={<LocationDisplay />} />
        <Route path="/eval/runs/:id" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>,
  );
}

function bankMeta() {
  const meta = readSetMeta(BANK_SET_SUMMARY);
  if (!meta) throw new Error("bank meta should parse");
  return meta;
}

function bundleMeta() {
  const meta = readSetMeta(BUNDLE_SET_SUMMARY);
  if (!meta) throw new Error("bundle meta should parse");
  return meta;
}

describe("bankStatsOf", () => {
  it("derives words/refs/chars/provenance/regime from the state markdown", () => {
    const first = BANK_CASES[0];
    if (!first) throw new Error("fixture missing");
    const stats = bankStatsOf(first);
    expect(stats.fid).toBe("fid-001");
    expect(stats.title).toBe("Northwind Traders renewal");
    expect(stats.refs).toBe(5);
    expect(stats.provenance).toBe("opp-2214");
    expect(stats.regime).toBe("grounded");
    expect(stats.words).toBeGreaterThan(50);
    expect(stats.chars).toBe(String(first.input).length);
  });

  it("tolerates a non-string input (all zeros, unreferenced)", () => {
    const stats = bankStatsOf({
      setId: "s",
      caseId: "c",
      input: { not: "markdown" },
      expected: null,
      tags: null,
      split: null,
    });
    expect(stats.words).toBe(0);
    expect(stats.refs).toBe(0);
    expect(stats.regime).toBe("unreferenced");
    expect(stats.provenance).toBeNull();
  });
});

describe("BankSetView", () => {
  afterEach(cleanup);

  it("renders the computed fixture table (fid, regime, refs, provenance)", () => {
    renderWithRouter(
      <BankSetView set={BANK_SET_SUMMARY} cases={BANK_CASES} runs={runs} meta={bankMeta()} />,
    );
    expect(screen.getByText("answer-bank")).toBeTruthy();
    expect(screen.getByText("fid-001")).toBeTruthy();
    expect(screen.getByText("Northwind Traders renewal")).toBeTruthy();
    expect(screen.getByText("opp-2214")).toBeTruthy();
    expect(screen.getByText("opp-1873")).toBeTruthy();
    expect(screen.getAllByText("grounded").length).toBe(2);
    // runs-against-set section survives the family replacement
    expect(screen.getByText("answer-renderer")).toBeTruthy();
  });

  it("row click navigates with BOTH ids encoded", async () => {
    renderWithRouter(
      <BankSetView set={BANK_SET_SUMMARY} cases={BANK_CASES} runs={[]} meta={bankMeta()} />,
    );
    fireEvent.click(screen.getByText("fid-001"));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        `/eval/sets/${encodeURIComponent(BANK_SET_ID)}/cases/fid-001`,
      );
    });
  });
});

describe("BankCaseView", () => {
  afterEach(cleanup);

  it("renders stat tiles, both markdown panes, and used-ref chips", () => {
    const first = BANK_CASES[0];
    if (!first) throw new Error("fixture missing");
    renderWithRouter(<BankCaseView caseRow={first} history={[]} meta={bankMeta()} />);
    expect(screen.getByText("Evidence refs")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("Deal state")).toBeTruthy();
    expect(screen.getByText("Golden response")).toBeTruthy();
    // golden markdown rendered (a fragment unique to the golden)
    expect(screen.getByText(/22% retention discount/)).toBeTruthy();
    // used-ref chips from the golden — all five evidence ids
    expect(screen.getByText("Used evidence")).toBeTruthy();
    for (const n of [1, 2, 3, 4, 5]) {
      expect(screen.getByText(`evidence-${n}`)).toBeTruthy();
    }
  });
});

describe("BundleSetView", () => {
  afterEach(cleanup);

  it("renders bundle identity chips + the fixture table with gold counts", () => {
    renderWithRouter(
      <BundleSetView set={BUNDLE_SET_SUMMARY} cases={BUNDLE_CASES} runs={[]} meta={bundleMeta()} />,
    );
    expect(screen.getByText("question-bundle")).toBeTruthy();
    expect(screen.getByText("cache")).toBeTruthy();
    expect(screen.getByText("sdc-bench@v2")).toBeTruthy();
    expect(screen.getByText("beanmaxx")).toBeTruthy();
    expect(screen.getByText("sdc")).toBeTruthy();
    expect(screen.getByText("curation")).toBeTruthy();
    // fixtures with per-fixture gold-expectation counts (required/total)
    expect(screen.getByText("fx-001")).toBeTruthy();
    expect(screen.getByText("3 req / 5")).toBeTruthy();
    expect(screen.getByText("3 req / 4")).toBeTruthy();
    expect(screen.getByText("deal:opp-2214")).toBeTruthy();
  });

  it("filters by request family (scope prefix) and by split", () => {
    renderWithRouter(
      <BundleSetView set={BUNDLE_SET_SUMMARY} cases={BUNDLE_CASES} runs={[]} meta={bundleMeta()} />,
    );
    // request-family facet: portfolio hides the deal-scoped fixture
    fireEvent.click(screen.getByRole("button", { name: "portfolio" }));
    expect(screen.queryByText("fx-001")).toBeNull();
    expect(screen.getByText("fx-003")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "portfolio" })); // toggle off
    // split facet: train keeps only fx-001
    fireEvent.click(screen.getByRole("button", { name: "train" }));
    expect(screen.getByText("fx-001")).toBeTruthy();
    expect(screen.queryByText("fx-003")).toBeNull();
  });

  it("row click navigates with BOTH ids encoded", async () => {
    renderWithRouter(
      <BundleSetView set={BUNDLE_SET_SUMMARY} cases={BUNDLE_CASES} runs={[]} meta={bundleMeta()} />,
    );
    fireEvent.click(screen.getByText("fx-001"));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        `/eval/sets/${encodeURIComponent(BUNDLE_SET_ID)}/cases/fx-001`,
      );
    });
  });
});

describe("BundleCaseView + ExpectationCards", () => {
  afterEach(cleanup);

  it("renders the question card, scope key-values incl. as_of, cards, and golden", () => {
    const first = BUNDLE_CASES[0];
    if (!first) throw new Error("fixture missing");
    renderWithRouter(<BundleCaseView caseRow={first} history={[]} meta={bundleMeta()} />);
    expect(
      screen.getByText(
        "What pricing did Northwind commit to on the renewal, and what is still open?",
      ),
    ).toBeTruthy();
    expect(screen.getByText("scope · deal:opp-2214")).toBeTruthy();
    expect(screen.getByText("as_of · 2026-07-10")).toBeTruthy();
    // expectation cards: required/optional chips, det-vs-judge pills, weight,
    // resolved source labels
    expect(screen.getByText("3 required · 5 total")).toBeTruthy();
    expect(screen.getAllByText("required").length).toBe(3);
    expect(screen.getAllByText("optional").length).toBe(2);
    expect(screen.getAllByText("deterministic").length).toBe(3);
    expect(screen.getAllByText("judge").length).toBe(2);
    expect(screen.getByText("weight 3")).toBeTruthy();
    expect(screen.getAllByText("Pricing call 2026-06-12").length).toBe(2);
    // golden response markdown
    expect(screen.getByText(/liability-cap/)).toBeTruthy();
  });

  it("empty/malformed expected → muted note, never fake cards", () => {
    expect(parseExpectations(null)).toEqual([]);
    expect(parseExpectations({ ground_truth: { expectations: [{ noId: true }, 42] } })).toEqual([]);
    render(<ExpectationCards expectations={[]} />);
    expect(screen.getByText("No gold expectations recorded on this fixture.")).toBeTruthy();
  });
});
