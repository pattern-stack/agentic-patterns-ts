/**
 * Run-level aggregate math: two-lens rollup and the curation Pareto frontier,
 * computed from per-case results. Pure functions — no DOM.
 */

import { describe, expect, it } from "vitest";
import type { JoinedEvalResultRow } from "../api/types";
import { curationFrontier, twoLensRollup } from "../lib/evalAggregates";

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

describe("twoLensRollup", () => {
  it("computes gated pass rate and judge mean independently", () => {
    const results = [
      row({ pass: true, scores: [{ name: "judge", value: 0.8 }] }),
      row({ pass: false, scores: [{ name: "judge", value: 0.6 }] }),
      row({ pass: null, scores: [{ name: "judge", value: 1.0 }] }), // ungated but judged
    ];
    const r = twoLensRollup(results);
    expect(r.gated).toBe(2);
    expect(r.detPassRate).toBeCloseTo(0.5);
    expect(r.judged).toBe(3);
    expect(r.judgeMean).toBeCloseTo(0.8);
  });

  it("falls back to judge:* axis mean when no headline judge score", () => {
    const results = [
      row({
        pass: true,
        scores: [
          { name: "judge:accuracy", value: 0.4 },
          { name: "judge:grounding", value: 0.6 },
        ],
      }),
    ];
    const r = twoLensRollup(results);
    expect(r.judgeMean).toBeCloseTo(0.5);
  });

  it("returns null lenses when nothing is gated or judged", () => {
    const r = twoLensRollup([row({ pass: null, scores: [{ name: "exact", value: 1 }] })]);
    expect(r.detPassRate).toBeNull();
    expect(r.judgeMean).toBeNull();
  });
});

describe("curationFrontier", () => {
  const mk = (configId: string, fixtureId: string, rate: number, tokens: number) =>
    row({
      caseId: `${configId}:${fixtureId}`,
      scores: [
        {
          name: "curation",
          value: rate,
          detail: { kind: "curation-facts", configId, outboundTokens: tokens, survival: { rate } },
        },
      ],
    });

  it("groups by config, averages, and marks the Pareto front", () => {
    const results = [
      mk("A", "f1", 0.9, 1000), // high survival, high tokens
      mk("A", "f2", 0.9, 1000),
      mk("B", "f1", 0.9, 500), // same survival, fewer tokens → dominates A
      mk("C", "f1", 0.6, 2000), // dominated by both
    ];
    const front = curationFrontier(results);
    const get = (id: string) => {
      const p = front.find((x) => x.configId === id);
      if (!p) throw new Error(`no config ${id}`);
      return p;
    };
    expect(get("A").survival).toBeCloseTo(0.9);
    expect(get("A").tokens).toBeCloseTo(1000);
    expect(get("A").n).toBe(2);
    expect(get("B").onFrontier).toBe(true);
    expect(get("A").onFrontier).toBe(false); // B dominates (same survival, fewer tokens)
    expect(get("C").onFrontier).toBe(false);
    // sorted survival desc then tokens asc → B before A (tie on survival, fewer tokens)
    expect(front[0]?.configId).toBe("B");
  });

  it("returns [] when the run has no curation cases", () => {
    expect(curationFrontier([row({ scores: [{ name: "exact", value: 1 }] })])).toEqual([]);
  });

  it("skips cases missing configId, tokens, or survival", () => {
    const results = [
      row({ scores: [{ name: "c", value: 1, detail: { kind: "curation-facts", configId: "A" } }] }),
    ];
    expect(curationFrontier(results)).toEqual([]);
  });
});
