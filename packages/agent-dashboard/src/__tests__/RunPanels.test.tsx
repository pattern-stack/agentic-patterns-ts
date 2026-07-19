/**
 * RunPanels — the two-lens rollup and curation-frontier cards self-hide when
 * their data is absent, and render when present.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { JoinedEvalResultRow } from "../api/types";
import { RunPanels } from "../pages/eval/panels/RunPanels";

afterEach(cleanup);

function row(partial: Partial<JoinedEvalResultRow>): JoinedEvalResultRow {
  return {
    evalRunId: "r",
    caseId: "c",
    runId: null,
    scores: null,
    pass: null,
    traceId: null,
    runStatus: "ok",
    finalAnswer: null,
    inputTokens: null,
    outputTokens: null,
    finishReason: null,
    elapsedMs: null,
    runError: null,
    ...partial,
  };
}

describe("RunPanels", () => {
  it("renders nothing when there is no lens or frontier data", () => {
    const { container } = render(
      <RunPanels results={[row({ scores: [{ name: "x", value: 1 }] })]} />,
    );
    expect(container.textContent).toBe("");
  });

  it("shows the two-lens rollup when cases are gated", () => {
    render(<RunPanels results={[row({ pass: true }), row({ pass: false })]} />);
    expect(screen.getByText("Two lenses")).toBeTruthy();
    expect(screen.getByText("Deterministic")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
  });

  it("shows the curation frontier when curation cases are present", () => {
    const mk = (configId: string, rate: number, tokens: number) =>
      row({
        caseId: configId,
        scores: [
          {
            name: "curation",
            value: rate,
            detail: {
              kind: "curation-facts",
              configId,
              outboundTokens: tokens,
              survival: { rate },
            },
          },
        ],
      });
    render(<RunPanels results={[mk("A", 0.9, 500), mk("B", 0.6, 1500)]} />);
    // the scatter (unique img role) proves the frontier panel rendered
    expect(screen.getByRole("img", { name: /Curation frontier/ })).toBeTruthy();
    // heading carries the on-front count — match the distinctive "1/2" fraction
    expect(screen.getByText(/·\s*1\/2\s*on/)).toBeTruthy();
  });
});
