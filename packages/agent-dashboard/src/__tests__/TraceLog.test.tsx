/**
 * TraceLog — pins the EXACT rendering math ported from swe-brain's
 * `AgentDevSurface.tsx` (port-map §5.2): the cumulative-offset fold during
 * render (`let acc = 0; const at = acc; acc += step.ms;` -> `+{(at/1000).
 * toFixed(2)}s`) and the per-kind message templates.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TraceLog } from "../components/organisms/TraceLog";
import type { TraceStep } from "../graph/types";

afterEach(cleanup);

const steps: TraceStep[] = [
  { seq: 1, iter: 0, kind: "context", label: "Compile request context", ms: 0 },
  {
    seq: 2,
    iter: 1,
    kind: "model",
    label: "Model call · iteration 1",
    ms: 500,
    ctxTokens: 1200,
    outTokens: 40,
    emits: ["search"],
  },
  { seq: 3, iter: 1, kind: "tool_call", tool: "search", ms: 250, args: { q: "hi" } },
  {
    seq: 4,
    iter: 1,
    kind: "tool_result",
    tool: "search",
    ms: 120,
    status: "ok",
    note: "2 rows",
  },
  { seq: 5, iter: 2, kind: "finish", label: "finishReason: stop", ms: 0, status: "ok" },
];

describe("TraceLog — cumulative offset fold", () => {
  it("accumulates ms across steps in order: 0, 0, 0.50, 0.75, 0.87", () => {
    render(<TraceLog steps={steps} />);
    // at = the running total BEFORE this step's own ms is added.
    expect(screen.getByTestId("log-offset-1").textContent).toBe("+0.00s");
    expect(screen.getByTestId("log-offset-2").textContent).toBe("+0.00s");
    expect(screen.getByTestId("log-offset-3").textContent).toBe("+0.50s"); // 0 + 500ms
    expect(screen.getByTestId("log-offset-4").textContent).toBe("+0.75s"); // 500 + 250ms
    expect(screen.getByTestId("log-offset-5").textContent).toBe("+0.87s"); // 750 + 120ms
  });

  it("renders the per-kind message templates", () => {
    render(<TraceLog steps={steps} />);
    expect(screen.getByTestId("log-row-3").textContent).toContain('call search {"q":"hi"}');
    expect(screen.getByTestId("log-row-4").textContent).toContain("returned 2 rows · ok");
    expect(screen.getByTestId("log-row-2").textContent).toContain(
      "Model call · iteration 1 · 1,200 ctx → 40 out · emits search",
    );
  });

  it("renders an honest empty state for zero steps", () => {
    render(<TraceLog steps={[]} />);
    expect(screen.getByText("No steps in this run.")).toBeTruthy();
  });
});
