/**
 * Family compare deltas (slice 10) — pure-logic suite over seed-shaped
 * `render-grade` / `score-map` details. B − A everywhere; a variant/fixture
 * present in only one run keeps the other side null and every delta null.
 */

import { describe, expect, it } from "vitest";
import type { JoinedEvalResultRow } from "../api/types";
import { rendererCompare, sdcCompare } from "../lib/evalFamilyCompare";

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

/** Seed-shaped `render-grade` result (composite `${fid}#${variantKey}` caseId). */
function renderRow(opts: {
  fid: string;
  variantKey: string;
  pass?: boolean;
  readability?: number | null;
  ratio?: number;
  usd?: number;
}): JoinedEvalResultRow {
  const { fid, variantKey, pass = true, readability = 4.0, ratio = 1.0, usd = 0.004 } = opts;
  return row({
    caseId: `${fid}#${variantKey}`,
    pass,
    scores: [
      {
        name: "render-grade",
        value: pass ? 1 : 0,
        passed: pass,
        detail: {
          kind: "render-grade",
          fid,
          variantKey,
          variant: { shape: "prose", verbosity: "brief" },
          status: "ok",
          report: {
            pass,
            relativeLength: { ratio, stateWords: 100, renderedWords: Math.round(100 * ratio) },
          },
          judge:
            readability === null
              ? null
              : { readability, faithful_emphasis: 4.0, tone_differentiation: 3.5 },
          cost: { inputTokens: 900, outputTokens: 260, estimatedUsd: usd },
          latencyMs: 1800,
        },
      },
    ],
  });
}

/** Seed-shaped `score-map` result (simple fixture caseId). */
function sdcRow(opts: {
  caseId: string;
  hybrid?: number;
  correctness?: number;
  retrieval?: number;
  topLevelHybridOnly?: boolean;
}): JoinedEvalResultRow {
  const { caseId, hybrid = 0.8, correctness = 0.9, retrieval = 0.7, topLevelHybridOnly } = opts;
  const axes: Record<string, number> = {
    answer_correctness: correctness,
    evidence_seen_recall: retrieval,
    citation_claim_support: 0.75,
    ...(topLevelHybridOnly ? {} : { hybrid }),
  };
  return row({
    caseId,
    scores: [
      {
        name: "score-map",
        value: hybrid,
        detail: {
          kind: "score-map",
          ...(topLevelHybridOnly ? { hybrid } : {}),
          scores: axes,
          axes,
        },
      },
    ],
  });
}

describe("rendererCompare", () => {
  it("joins scoreboards by variantKey and computes B − A deltas", () => {
    const a = [
      renderRow({
        fid: "fid-001",
        variantKey: "prose#brief",
        pass: true,
        readability: 4.0,
        ratio: 1.0,
        usd: 0.004,
      }),
      renderRow({
        fid: "fid-002",
        variantKey: "prose#brief",
        pass: false,
        readability: 4.2,
        ratio: 1.2,
        usd: 0.006,
      }),
    ];
    const b = [
      renderRow({
        fid: "fid-001",
        variantKey: "prose#brief",
        pass: true,
        readability: 4.4,
        ratio: 1.3,
        usd: 0.002,
      }),
      renderRow({
        fid: "fid-002",
        variantKey: "prose#brief",
        pass: true,
        readability: 4.6,
        ratio: 1.5,
        usd: 0.002,
      }),
    ];
    const rows = rendererCompare(a, b);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    if (!r) throw new Error("missing row");
    expect(r.variantKey).toBe("prose#brief");
    expect(r.a?.n).toBe(2);
    expect(r.b?.n).toBe(2);
    expect(r.detPass.a).toBeCloseTo(0.5);
    expect(r.detPass.b).toBeCloseTo(1.0);
    expect(r.detPass.delta).toBeCloseTo(0.5);
    expect(r.readability.delta).toBeCloseTo(4.5 - 4.1);
    expect(r.lenRatio.a).toBeCloseTo(1.1); // p50 of the seed's relativeLength.ratio
    expect(r.lenRatio.delta).toBeCloseTo(0.3);
    expect(r.usdPerRender.delta).toBeCloseTo(-0.003);
  });

  it("a variant present in only one run keeps the other side and deltas null", () => {
    const a = [renderRow({ fid: "fid-001", variantKey: "table#brief" })];
    const b = [renderRow({ fid: "fid-001", variantKey: "prose#full" })];
    const rows = rendererCompare(a, b);
    expect(rows.map((r) => r.variantKey)).toEqual(["prose#full", "table#brief"]); // sorted union
    const tableRow = rows.find((r) => r.variantKey === "table#brief");
    expect(tableRow?.b).toBeNull();
    expect(tableRow?.detPass.a).toBeCloseTo(1.0);
    expect(tableRow?.detPass.b).toBeNull();
    expect(tableRow?.detPass.delta).toBeNull();
    expect(tableRow?.usdPerRender.delta).toBeNull();
    const proseRow = rows.find((r) => r.variantKey === "prose#full");
    expect(proseRow?.a).toBeNull();
    expect(proseRow?.detPass.delta).toBeNull();
  });

  it("a null metric on either side yields a null delta without dropping the row", () => {
    const a = [renderRow({ fid: "fid-003", variantKey: "prose#brief", readability: null })];
    const b = [renderRow({ fid: "fid-003", variantKey: "prose#brief", readability: 4.5 })];
    const r = rendererCompare(a, b)[0];
    expect(r?.readability.a).toBeNull();
    expect(r?.readability.delta).toBeNull();
    expect(r?.detPass.delta).toBeCloseTo(0); // both sides still compared
  });

  it("returns [] for empty results and ignores non-renderer rows", () => {
    expect(rendererCompare([], [])).toEqual([]);
    const generic = [row({ scores: [{ name: "exact-match", value: 1 }] })];
    expect(rendererCompare(generic, generic)).toEqual([]);
  });
});

describe("sdcCompare", () => {
  it("matches fixtures by caseId and computes B − A axis deltas", () => {
    const a = [sdcRow({ caseId: "fx-001", hybrid: 0.8, correctness: 0.9, retrieval: 0.7 })];
    const b = [sdcRow({ caseId: "fx-001", hybrid: 0.9, correctness: 0.85, retrieval: 0.8 })];
    const rows = sdcCompare(a, b);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    if (!r) throw new Error("missing row");
    expect(r.caseId).toBe("fx-001");
    expect(r.hybrid.delta).toBeCloseTo(0.1);
    expect(r.correctness.delta).toBeCloseTo(-0.05);
    expect(r.retrieval.delta).toBeCloseTo(0.1);
  });

  it("reads the top-level hybrid when the axes record lacks one", () => {
    const a = [sdcRow({ caseId: "fx-001", hybrid: 0.6, topLevelHybridOnly: true })];
    const b = [sdcRow({ caseId: "fx-001", hybrid: 0.75, topLevelHybridOnly: true })];
    const r = sdcCompare(a, b)[0];
    expect(r?.hybrid.a).toBeCloseTo(0.6);
    expect(r?.hybrid.delta).toBeCloseTo(0.15);
  });

  it("a fixture present in only one run keeps the other side and deltas null", () => {
    const a = [sdcRow({ caseId: "fx-001" }), sdcRow({ caseId: "fx-002" })];
    const b = [sdcRow({ caseId: "fx-002" }), sdcRow({ caseId: "fx-003" })];
    const rows = sdcCompare(a, b);
    expect(rows.map((r) => r.caseId)).toEqual(["fx-001", "fx-002", "fx-003"]); // sorted union
    const only = rows.find((r) => r.caseId === "fx-001");
    expect(only?.b).toBeNull();
    expect(only?.hybrid.a).toBeCloseTo(0.8);
    expect(only?.hybrid.delta).toBeNull();
    const bOnly = rows.find((r) => r.caseId === "fx-003");
    expect(bOnly?.a).toBeNull();
    expect(bOnly?.retrieval.delta).toBeNull();
  });

  it("returns [] for empty results and skips cases with no score-map on either side", () => {
    expect(sdcCompare([], [])).toEqual([]);
    const noMap = [row({ caseId: "fx-009", scores: [{ name: "exact-match", value: 1 }] })];
    expect(sdcCompare(noMap, noMap)).toEqual([]);
  });
});
