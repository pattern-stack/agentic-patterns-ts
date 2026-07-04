/**
 * `lib/evalCompare.ts` — pure-logic suite, incl. parity vectors mirroring
 * `EvalStore.compareEvalRuns`'s bucket rules (`eval-store.ts:488-497`).
 */

import { describe, expect, it } from "vitest";
import type { JoinedEvalResultRow, SplitAggregate } from "../api/types";
import { alignResults, classifyDelta, overfitGap, summarizeComparison } from "../lib/evalCompare";

function row(caseId: string, pass: boolean | null, overrides: Partial<JoinedEvalResultRow> = {}) {
  const r: JoinedEvalResultRow = {
    evalRunId: "run-x",
    caseId,
    runId: `r-${caseId}`,
    scores: pass === null ? [] : [{ name: "exact-match", value: pass ? 1 : 0, passed: pass }],
    pass,
    traceId: `run-x:${caseId}`,
    runStatus: "ok",
    finalAnswer: '"answer"',
    inputTokens: 10,
    outputTokens: 5,
    finishReason: "stop",
    elapsedMs: 100,
    runError: null,
    ...overrides,
  };
  return r;
}

describe("alignResults", () => {
  it("returns the sorted union of case ids", () => {
    const a = [row("case-b", true), row("case-a", false)];
    const b = [row("case-a", true), row("case-c", true)];
    const aligned = alignResults(a, b);
    expect(aligned.map((r) => r.caseId)).toEqual(["case-a", "case-b", "case-c"]);
  });

  it("a case only in A -> b: null", () => {
    const aligned = alignResults([row("case-1", true)], []);
    expect(aligned).toEqual([
      {
        caseId: "case-1",
        a: expect.objectContaining({ caseId: "case-1" }),
        b: null,
        delta: "a-only",
      },
    ]);
  });

  it("a case only in B -> a: null", () => {
    const aligned = alignResults([], [row("case-1", true)]);
    expect(aligned).toEqual([
      {
        caseId: "case-1",
        a: null,
        b: expect.objectContaining({ caseId: "case-1" }),
        delta: "b-only",
      },
    ]);
  });

  it("a case in both keeps both full rows (richer than the store's { pass, scores })", () => {
    const aRow = row("case-1", true, { finalAnswer: '"4"' });
    const bRow = row("case-1", false, { finalAnswer: '"5"' });
    const aligned = alignResults([aRow], [bRow]);
    expect(aligned[0]?.a).toEqual(aRow);
    expect(aligned[0]?.b).toEqual(bRow);
    expect(aligned[0]?.a?.finalAnswer).toBe('"4"');
    expect(aligned[0]?.b?.finalAnswer).toBe('"5"');
  });
});

describe("classifyDelta — full matrix", () => {
  it("a-only / b-only", () => {
    expect(classifyDelta(row("c", true), null)).toBe("a-only");
    expect(classifyDelta(null, row("c", true))).toBe("b-only");
  });

  it("both passed -> same-pass; both failed -> same-fail", () => {
    expect(classifyDelta(row("c", true), row("c", true))).toBe("same-pass");
    expect(classifyDelta(row("c", false), row("c", false))).toBe("same-fail");
  });

  it("A pass, B fail -> regression; A fail, B pass -> improvement", () => {
    expect(classifyDelta(row("c", true), row("c", false))).toBe("regression");
    expect(classifyDelta(row("c", false), row("c", true))).toBe("improvement");
  });

  it("either side ungated (pass: null) -> ungated, never regression/improvement", () => {
    expect(classifyDelta(row("c", null), row("c", null))).toBe("ungated");
    expect(classifyDelta(row("c", null), row("c", true))).toBe("ungated");
    expect(classifyDelta(row("c", null), row("c", false))).toBe("ungated");
    expect(classifyDelta(row("c", true), row("c", null))).toBe("ungated");
    expect(classifyDelta(row("c", false), row("c", null))).toBe("ungated");
  });
});

describe("summarizeComparison — parity vectors mirroring eval-store.ts:488-497", () => {
  it("(pass,pass) -> bothPassed", () => {
    const rows = alignResults([row("c1", true)], [row("c1", true)]);
    expect(summarizeComparison(rows)).toEqual({
      bothPassed: 1,
      bothFailed: 0,
      onlyAPassed: 0,
      onlyBPassed: 0,
      aOnly: 0,
      bOnly: 0,
    });
  });

  it("(fail,fail) -> bothFailed", () => {
    const rows = alignResults([row("c1", false)], [row("c1", false)]);
    expect(summarizeComparison(rows)).toEqual({
      bothPassed: 0,
      bothFailed: 1,
      onlyAPassed: 0,
      onlyBPassed: 0,
      aOnly: 0,
      bOnly: 0,
    });
  });

  it("(pass,fail) -> onlyAPassed (a regression when A = baseline)", () => {
    const rows = alignResults([row("c1", true)], [row("c1", false)]);
    expect(summarizeComparison(rows)).toEqual({
      bothPassed: 0,
      bothFailed: 0,
      onlyAPassed: 1,
      onlyBPassed: 0,
      aOnly: 0,
      bOnly: 0,
    });
  });

  it("(fail,pass) -> onlyBPassed (an improvement when A = baseline)", () => {
    const rows = alignResults([row("c1", false)], [row("c1", true)]);
    expect(summarizeComparison(rows)).toEqual({
      bothPassed: 0,
      bothFailed: 0,
      onlyAPassed: 0,
      onlyBPassed: 1,
      aOnly: 0,
      bOnly: 0,
    });
  });

  it("one-sided rows -> aOnly / bOnly, never a pass/fail bucket", () => {
    const rows = alignResults(
      [row("c1", true), row("c2", false)],
      [row("c2", false), row("c3", true)],
    );
    // c1: A only -> aOnly; c2: both fail -> bothFailed; c3: B only -> bOnly
    expect(summarizeComparison(rows)).toEqual({
      bothPassed: 0,
      bothFailed: 1,
      onlyAPassed: 0,
      onlyBPassed: 0,
      aOnly: 1,
      bOnly: 1,
    });
  });

  it("(null,null) and (null,pass/fail) pairs increment no bucket (the ungated subtlety)", () => {
    const rows = alignResults(
      [row("c1", null), row("c2", null), row("c3", true), row("c4", false)],
      [row("c1", null), row("c2", true), row("c3", null), row("c4", null)],
    );
    // None of c1-c4 land in bothPassed/bothFailed/onlyAPassed/onlyBPassed —
    // every pair has at least one null side. Only the a-only/b-only buckets
    // would move, and there are none here (all four case ids present on
    // both sides).
    expect(summarizeComparison(rows)).toEqual({
      bothPassed: 0,
      bothFailed: 0,
      onlyAPassed: 0,
      onlyBPassed: 0,
      aOnly: 0,
      bOnly: 0,
    });
  });
});

describe("overfitGap", () => {
  const agg = (split: SplitAggregate["split"], passRate: number | null): SplitAggregate => ({
    split,
    results: 10,
    passed: passRate === null ? 0 : Math.round(passRate * 10),
    failed: passRate === null ? 0 : 10 - Math.round(passRate * 10),
    passRate,
  });

  it("both buckets present with non-null rates -> signed percentage points", () => {
    const result = overfitGap([agg("train", 0.9), agg("test", 0.6), agg("dev", 0.8)]);
    expect(result?.train).toBe(0.9);
    expect(result?.test).toBe(0.6);
    expect(result?.gapPts).toBeCloseTo(30);
  });

  it("missing the test bucket -> null", () => {
    expect(overfitGap([agg("train", 0.9), agg("dev", 0.8)])).toBeNull();
  });

  it("missing the train bucket -> null", () => {
    expect(overfitGap([agg("test", 0.6), agg("dev", 0.8)])).toBeNull();
  });

  it("passRate: null on either bucket -> null", () => {
    expect(overfitGap([agg("train", null), agg("test", 0.6)])).toBeNull();
    expect(overfitGap([agg("train", 0.9), agg("test", null)])).toBeNull();
  });

  it("untagged/dev buckets are ignored", () => {
    const result = overfitGap([agg("train", 0.9), agg("test", 0.6), agg(null, 0.5)]);
    expect(result?.train).toBe(0.9);
    expect(result?.test).toBe(0.6);
    expect(result?.gapPts).toBeCloseTo(30);
  });

  it("a negative gap (test outperforms train) is still returned, unsigned by the caller's tint choice", () => {
    const result = overfitGap([agg("train", 0.5), agg("test", 0.8)]);
    expect(result?.train).toBe(0.5);
    expect(result?.test).toBe(0.8);
    expect(result?.gapPts).toBeCloseTo(-30);
  });
});
