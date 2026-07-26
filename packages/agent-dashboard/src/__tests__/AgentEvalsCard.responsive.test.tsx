/**
 * AgentEvalsCard overflow fixes (W2-AgentLens, spec
 * `.claude/specs/2026-07-26-responsive-agent-lens.md` §3d): two UNCONDITIONAL
 * style additions — no `useBreakpoint()` dependency, both inert on desktop —
 * so a long eval-set id elides instead of pushing the Run button off a narrow
 * card, and the latest-run summary line wraps instead of overflowing it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalRunRow } from "../api/types";
import { fetchEvalRuns } from "../lib/evalApi";
import { AgentEvalsCard } from "../pages/build/AgentEvalsCard";

vi.mock("../lib/evalApi", () => ({
  fetchEvalRuns: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LONG_SET_ID = "a-very-long-eval-set-identifier-that-would-overflow-a-narrow-card";

function renderCard(evals: { setId: string }[]) {
  return render(
    <MemoryRouter>
      <AgentEvalsCard agentId="a1" agentName="Agent One" evals={evals} />
    </MemoryRouter>,
  );
}

describe("AgentEvalsCard — per-eval-ref Link elides instead of overflowing", () => {
  it("the setId Link has minWidth:0 + ellipsis styling", async () => {
    vi.mocked(fetchEvalRuns).mockResolvedValue({ kind: "ok", data: [] });
    renderCard([{ setId: LONG_SET_ID }]);

    const link = await screen.findByRole("link", { name: LONG_SET_ID });
    // React's inline-style writer doesn't append "px" to a literal 0, and
    // jsdom expands the `flex` shorthand's getter to its longhand triple.
    expect(link.style.minWidth).toBe("0");
    expect(link.style.overflow).toBe("hidden");
    expect(link.style.textOverflow).toBe("ellipsis");
    expect(link.style.whiteSpace).toBe("nowrap");
    // flex:1 (unchanged) still lets it grow to fill the row.
    expect(link.style.flex).toBe("1 1 0%");
  });
});

describe("AgentEvalsCard — latest-run line wraps instead of overflowing", () => {
  const run: EvalRunRow = {
    id: "run-1",
    tsStart: "2026-01-01T00:00:00.000Z",
    tsEnd: "2026-01-01T00:00:05.000Z",
    setId: "bank",
    targetId: "a1",
    variant: null,
    split: null,
    model: "claude-sonnet",
    gitSha: null,
    scorer: "exact-match",
    status: "ok",
    summary: { passed: 8, cases: 10, failed: 2, ungated: 0, passRate: 0.8 },
  };

  it("the row has flexWrap: wrap", async () => {
    vi.mocked(fetchEvalRuns).mockResolvedValue({ kind: "ok", data: [run] });
    renderCard([{ setId: "bank" }]);

    const line = await screen.findByTestId("eval-latest-run-line");
    expect(line.style.flexWrap).toBe("wrap");
    // sanity: this is the same line rendering the run's status/model.
    expect(screen.getByText("ok")).toBeTruthy();
    expect(screen.getByText("claude-sonnet")).toBeTruthy();
  });
});
