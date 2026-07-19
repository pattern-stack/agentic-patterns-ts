/**
 * Slice 1 foundation: family identity (familyOf/setFamilyOf/readRunMeta/
 * readSetMeta) and the new run-level aggregates. Pure functions, no DOM.
 */

import { describe, expect, it } from "vitest";
import type { JoinedEvalResultRow } from "../api/types";
import {
  curationConfigTable,
  curationFrontierDeclared,
  p50,
  rendererVariantScoreboard,
  sdcAxisMeans,
} from "../lib/evalAggregates";
import { familyOf, readRunMeta, readSetMeta, setFamilyOf } from "../pages/eval/families/types";

function row(scores: JoinedEvalResultRow["scores"], caseId = "c"): JoinedEvalResultRow {
  return {
    evalRunId: "r",
    caseId,
    runId: null,
    scores,
    pass: null,
    traceId: null,
    runStatus: "ok",
    finalAnswer: null,
    inputTokens: null,
    outputTokens: null,
    finishReason: null,
    elapsedMs: null,
    runError: null,
  };
}

describe("family identity", () => {
  it("classifies runs by meta.family and degrades to null", () => {
    expect(familyOf({ meta: { family: "renderer" } })).toBe("renderer");
    expect(familyOf({ meta: { family: "sdc" } })).toBe("sdc");
    expect(familyOf({ meta: { family: "curation" } })).toBe("curation");
    expect(familyOf({ meta: { family: "bogus" } })).toBeNull();
    expect(familyOf({ meta: {} })).toBeNull();
    expect(familyOf({})).toBeNull();
    expect(familyOf(null)).toBeNull();
  });

  it("classifies sets and parses bundle meta defensively", () => {
    expect(setFamilyOf({ meta: { family: "answer-bank" } })).toBe("answer-bank");
    const m = readSetMeta({
      meta: {
        family: "question-bundle",
        source: "cache",
        benchmark: "rb",
        version: "v3",
        dataset: "d",
        families: ["sdc"],
        junk: 1,
      },
    });
    expect(m).toEqual({
      family: "question-bundle",
      source: "cache",
      benchmark: "rb",
      version: "v3",
      dataset: "d",
      createdAt: undefined,
      families: ["sdc"],
    });
    expect(setFamilyOf({ meta: { family: "renderer" } })).toBeNull(); // run family, not a set family
  });

  it("readRunMeta parses summary + judgeLens and drops malformed pieces", () => {
    const m = readRunMeta({
      meta: {
        family: "sdc",
        benchmark: "search-deal-context",
        summary: {
          detPassRate: 0.5,
          judgeLens: { kind: "ratio", value: 0.6, num: 3, den: 5 },
          costUsd: 1.2,
          junk: "x",
        },
        sdc: { scores: { hybrid: 0.7 } },
      },
    });
    expect(m?.family).toBe("sdc");
    expect(m?.summary?.detPassRate).toBe(0.5);
    expect(m?.summary?.judgeLens).toEqual({ kind: "ratio", value: 0.6, num: 3, den: 5 });
    expect(m?.sdc).toEqual({ scores: { hybrid: 0.7 } });
    // malformed judgeLens → undefined, not throw
    expect(
      readRunMeta({ meta: { family: "sdc", summary: { judgeLens: { kind: "nope", value: 1 } } } })
        ?.summary?.judgeLens,
    ).toBeUndefined();
  });
});

describe("p50", () => {
  it("medians finite values, ignoring null/undefined", () => {
    expect(p50([1, 2, 3])).toBe(2);
    expect(p50([1, 2, 3, 4])).toBe(2.5);
    expect(p50([null, 5, undefined])).toBe(5);
    expect(p50([])).toBeNull();
  });
});

describe("rendererVariantScoreboard", () => {
  const mk = (variantKey: string, pass: boolean, ratio: number, readability: number) =>
    row([
      {
        name: "render-grade",
        value: pass ? 1 : 0,
        detail: {
          kind: "render-grade",
          variantKey,
          variant: { shape: "email", model: "flash" },
          fidelityFailure: !pass,
          retriedForLength: false,
          latencyMs: 800,
          cost: { estimatedUsd: 0.01 },
          judge: { readability, faithful_emphasis: 0.9, tone_differentiation: 0.5 },
          report: {
            pass,
            relativeLength: { ratio },
            coverageHonesty: { status: pass ? "honest" : "dishonest", pass },
            inventedIds: { pass, inventedIds: pass ? [] : ["x"] },
          },
        },
      },
    ]);

  it("groups by variantKey and computes rates + gate-failure strings", () => {
    const board = rendererVariantScoreboard([
      mk("A", true, 0.9, 0.8),
      mk("A", false, 1.1, 0.6),
      mk("B", true, 1.0, 0.95),
    ]);
    const a = board.find((v) => v.variantKey === "A");
    expect(a?.n).toBe(2);
    expect(a?.detPassRate).toBeCloseTo(0.5);
    expect(a?.flagsRate).toBeCloseTo(0.5);
    expect(a?.lenRatioP50).toBeCloseTo(1.0);
    expect(a?.judgeReadability).toBeCloseTo(0.7);
    // one failing render trips inventedIds + coverageHonesty(dishonest)
    expect(a?.gateFailures).toContain("inventedIds:1");
    expect(a?.gateFailures).toContain("coverageHonesty:1");
    expect(a?.variant.shape).toBe("email");
  });
});

describe("sdcAxisMeans", () => {
  it("averages each axis across cases (accepts scores or axes key)", () => {
    const means = sdcAxisMeans([
      row([
        {
          name: "score-map",
          value: 0.7,
          detail: { kind: "score-map", scores: { hybrid: 0.8, retrieval: 1.0 } },
        },
      ]),
      row([
        { name: "score-map", value: 0.6, detail: { kind: "score-map", axes: { hybrid: 0.6 } } },
      ]),
    ]);
    expect(means.hybrid).toBeCloseTo(0.7);
    expect(means.retrieval).toBeCloseTo(1.0);
  });
});

describe("curationConfigTable + declared frontier", () => {
  const mk = (configId: string, rate: number, tokens: number) =>
    row(
      [
        {
          name: "curation",
          value: rate,
          detail: {
            kind: "curation-facts",
            configId,
            knobs: { ledger: 300 },
            outboundTokens: tokens,
            survival: { rate },
            metrics: {
              outboundTokens: tokens,
              compressionPct: 40,
              goldFactSurvival: { rate },
              dealCoverage: { minShare: 0.2, zeroRowDeals: 1 },
              nearDupRate: 0.1,
              deadRowRate: 0.05,
              temporalSpreadDays: { kept: 30 },
            },
          },
        },
      ],
      `${configId}#f1`,
    );

  it("builds one row per config sorted survival desc", () => {
    const rows = curationConfigTable([mk("A", 0.9, 1000), mk("B", 0.6, 500)]);
    expect(rows.map((r) => r.configId)).toEqual(["A", "B"]);
    expect(rows[0]?.survival).toBeCloseTo(0.9);
    expect(rows[0]?.compressionPct).toBeCloseTo(40);
    expect(rows[0]?.dealMinShare).toBeCloseTo(0.2);
    expect(rows[0]?.knobs).toEqual({ ledger: 300 });
  });

  it("declared frontier overrides computed dominance", () => {
    const results = [mk("A", 0.9, 1000), mk("B", 0.9, 500)];
    // computed: B dominates A. Declared says A is on-front.
    const front = curationFrontierDeclared(results, [{ configId: "A" }]);
    expect(front.find((p) => p.configId === "A")?.onFrontier).toBe(true);
    expect(front.find((p) => p.configId === "B")?.onFrontier).toBe(false);
  });
});
