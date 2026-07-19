/**
 * The per-case detail renderers beyond render-grade: score-map (grouped axes),
 * judge-verdicts (met/unmet cards), curation-facts (retained/cut chips). Each
 * proves registry resolution + a happy render + graceful null on a bad payload.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDetailRenderer } from "../pages/eval/renderers";
import { CurationFactsDetail } from "../pages/eval/renderers/CurationFactsDetail";
import { JudgeVerdictsDetail } from "../pages/eval/renderers/JudgeVerdictsDetail";
import { ScoreMapDetail } from "../pages/eval/renderers/ScoreMapDetail";

afterEach(cleanup);

const score = { name: "x", value: null };

describe("registry wiring", () => {
  it("resolves all registered kinds", () => {
    for (const kind of ["render-grade", "score-map", "judge-verdicts", "curation-facts"]) {
      expect(resolveDetailRenderer({ kind })).toBeTypeOf("function");
    }
  });
});

describe("ScoreMapDetail", () => {
  it("groups known axes and buckets unknowns into Other axes", () => {
    const detail = {
      kind: "score-map",
      axes: { hybrid: 0.82, citation_support: 0.4, some_new_axis: 0.5 },
    };
    render(<ScoreMapDetail detail={detail} score={score} />);
    expect(screen.getByText("Headline")).toBeTruthy();
    expect(screen.getByText("Citations")).toBeTruthy();
    expect(screen.getByText("Other axes")).toBeTruthy();
    expect(screen.getByText("some_new_axis")).toBeTruthy();
    expect(screen.getByText("0.82")).toBeTruthy();
  });
  it("returns null when axes is missing", () => {
    expect(ScoreMapDetail({ detail: { kind: "score-map" }, score })).toBeNull();
  });
});

describe("JudgeVerdictsDetail", () => {
  it("renders met/unmet cards with reason and evidence", () => {
    const detail = {
      kind: "judge-verdicts",
      verdicts: [
        { expectation_id: "exp-1", passed: true, reason: "named all deals" },
        {
          expectation_id: "exp-2",
          passed: false,
          reason: "missed Fireflies",
          evidence: "no mention",
        },
      ],
    };
    render(<JudgeVerdictsDetail detail={detail} score={score} />);
    expect(screen.getByText(/1\/2 met/)).toBeTruthy();
    expect(screen.getByText("exp-1")).toBeTruthy();
    expect(screen.getByText("missed Fireflies")).toBeTruthy();
    expect(screen.getByText(/no mention/)).toBeTruthy();
  });
  it("returns null when there are no valid verdicts", () => {
    expect(
      JudgeVerdictsDetail({ detail: { kind: "judge-verdicts", verdicts: [] }, score }),
    ).toBeNull();
    expect(JudgeVerdictsDetail({ detail: { kind: "judge-verdicts" }, score })).toBeNull();
  });
});

describe("CurationFactsDetail", () => {
  it("renders survival headline, retained/cut chips, and type bars", () => {
    const detail = {
      kind: "curation-facts",
      survival: {
        rate: 0.75,
        survived: 3,
        available: 4,
        perExpectation: [
          { expectationId: "f-1", survived: true },
          { expectationId: "f-2", survived: false },
          { expectationId: "f-3", contentRetained: true, availablePreCuration: false },
        ],
      },
      typeCoverage: { summary: { rowsKept: 2, rowsAvail: 5 } },
    };
    render(<CurationFactsDetail detail={detail} score={score} />);
    expect(screen.getByText(/75% survived · 3\/4 facts/)).toBeTruthy();
    expect(screen.getByText(/f-1 ✓/)).toBeTruthy();
    expect(screen.getByText(/f-2 ✕/)).toBeTruthy();
    expect(screen.getByText("summary")).toBeTruthy();
    expect(screen.getByText("2/5")).toBeTruthy();
  });
  it("returns null when survival is missing", () => {
    expect(CurationFactsDetail({ detail: { kind: "curation-facts" }, score })).toBeNull();
  });
});
