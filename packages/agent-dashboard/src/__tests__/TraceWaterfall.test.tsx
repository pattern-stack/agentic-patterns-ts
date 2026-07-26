/**
 * TraceWaterfall — pins the EXACT rendering math ported from swe-brain's
 * `AgentDevSurface.tsx` (port-map §5.1): the render-time `lastIter` grouping
 * fold (an iteration header only when `step.iter` changes), the bar-width
 * formula `Math.max(3, (ms/maxMs)*100)%` (including the `||1` maxMs guard
 * when every step is 0ms), and the seq-keyed expand/collapse toggle whose
 * body prefers `args` over `output` ("args wins").
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TraceWaterfall } from "../components/organisms/TraceWaterfall";
import type { TraceStep } from "../graph/types";

afterEach(cleanup);

function mkStep(
  overrides: Partial<TraceStep> & Pick<TraceStep, "seq" | "iter" | "kind" | "ms">,
): TraceStep {
  return { ...overrides };
}

describe("TraceWaterfall — iteration grouping", () => {
  const steps: TraceStep[] = [
    mkStep({ seq: 1, iter: 0, kind: "context", label: "Compile request context", ms: 0 }),
    mkStep({
      seq: 2,
      iter: 1,
      kind: "model",
      label: "Model call · iteration 1",
      ms: 500,
      ctxTokens: 100,
      outTokens: 20,
    }),
    mkStep({ seq: 3, iter: 1, kind: "tool_call", tool: "search", ms: 250, args: { q: "hi" } }),
    mkStep({
      seq: 4,
      iter: 1,
      kind: "tool_result",
      tool: "search",
      ms: 100,
      status: "ok",
      output: [1, 2],
      note: "2 rows",
    }),
    mkStep({ seq: 5, iter: 2, kind: "finish", label: "finishReason: stop", ms: 0, status: "ok" }),
  ];

  it("shows an iteration header only when `iter` changes across consecutive steps", () => {
    render(<TraceWaterfall steps={steps} />);
    // seq 1 (iter 0 -> "setup") and seq 2 (iter 0 -> 1) each start a new
    // group; seq 3 and seq 4 stay in iteration 1 (no header); seq 5 starts
    // iteration 2.
    expect(screen.getByTestId("waterfall-iter-header-1").textContent).toBe("setup");
    expect(screen.getByTestId("waterfall-iter-header-2").textContent).toBe("iteration 1");
    expect(screen.queryByTestId("waterfall-iter-header-3")).toBeNull();
    expect(screen.queryByTestId("waterfall-iter-header-4")).toBeNull();
    expect(screen.getByTestId("waterfall-iter-header-5").textContent).toBe("iteration 2");
  });

  it("bar widths follow max(3, ms/maxMs*100)% off the run's own maxMs", () => {
    render(<TraceWaterfall steps={steps} />);
    // maxMs = max(0, 500, 250, 100, 0) = 500.
    expect(screen.getByTestId("waterfall-bar-1").style.width).toBe("3%"); // 0ms floors to 3%
    expect(screen.getByTestId("waterfall-bar-2").style.width).toBe("100%"); // 500/500
    expect(screen.getByTestId("waterfall-bar-3").style.width).toBe("50%"); // 250/500
    expect(screen.getByTestId("waterfall-bar-4").style.width).toBe("20%"); // 100/500
    expect(screen.getByTestId("waterfall-bar-5").style.width).toBe("3%"); // 0ms floors to 3%
  });

  it("the `|| 1` maxMs guard prevents a divide-by-zero when every step is 0ms", () => {
    const zeroSteps: TraceStep[] = [
      mkStep({ seq: 1, iter: 0, kind: "context", ms: 0 }),
      mkStep({ seq: 2, iter: 1, kind: "finish", ms: 0 }),
    ];
    render(<TraceWaterfall steps={zeroSteps} />);
    expect(screen.getByTestId("waterfall-bar-1").style.width).toBe("3%");
    expect(screen.getByTestId("waterfall-bar-2").style.width).toBe("3%");
  });

  it("renders an honest empty state for zero steps instead of an empty div", () => {
    render(<TraceWaterfall steps={[]} />);
    expect(screen.getByText("No steps in this run.")).toBeTruthy();
  });
});

describe("TraceWaterfall — expand/collapse (seq-keyed, args wins)", () => {
  const step: TraceStep = mkStep({
    seq: 7,
    iter: 1,
    kind: "tool_call",
    tool: "search",
    ms: 42,
    args: { q: "hi" },
    output: { should: "never show — args wins" },
  });

  it("a row with args/output is clickable and starts collapsed", () => {
    render(<TraceWaterfall steps={[step]} />);
    expect(screen.queryByText(/"q": "hi"/)).toBeNull();
  });

  it("toggling via the inline button expands the JSON body, preferring `args` over `output`", () => {
    render(<TraceWaterfall steps={[step]} />);
    fireEvent.click(screen.getByText(/▸ args/));
    expect(screen.getByText(/"q": "hi"/)).toBeTruthy();
    expect(screen.queryByText(/never show/)).toBeNull();

    // toggling again collapses it back.
    fireEvent.click(screen.getByText(/▾ args/));
    expect(screen.queryByText(/"q": "hi"/)).toBeNull();
  });

  it("a row with neither args nor output is not clickable and has no expand affordance", () => {
    const plain = mkStep({ seq: 9, iter: 1, kind: "model", label: "Model call", ms: 10 });
    render(<TraceWaterfall steps={[plain]} />);
    expect(screen.queryByText(/▸/)).toBeNull();
  });
});

describe("TraceWaterfall — token chip breakdown (#388)", () => {
  it("shows the cache/reasoning breakdown parentheticals when tokenDetails is present", () => {
    const step = mkStep({
      seq: 1,
      iter: 1,
      kind: "model",
      label: "Model call · iteration 1",
      ms: 100,
      ctxTokens: 12400,
      outTokens: 320,
      tokenDetails: { cacheRead: 11900, reasoning: 140 },
    });
    render(<TraceWaterfall steps={[step]} />);
    expect(screen.getByText("12,400 (11,900 cached) ctx · 320 (140 rsn) out")).toBeTruthy();
  });

  it("renders the byte-identical string (no parentheticals) when tokenDetails is absent", () => {
    const step = mkStep({
      seq: 1,
      iter: 1,
      kind: "model",
      label: "Model call · iteration 1",
      ms: 100,
      ctxTokens: 100,
      outTokens: 20,
    });
    render(<TraceWaterfall steps={[step]} />);
    expect(screen.getByText("100 ctx · 20 out")).toBeTruthy();
  });
});
