/**
 * Family-aware A/B compare deltas (slice 10) — pure functions over the two
 * `GET /eval/runs/:id` payloads the compare page already holds. Consumed by
 * `EvalComparePage`'s family branch when both runs share a family.
 *
 * `lib/evalCompare.ts` (the store-parity generic alignment/summary) stays
 * UNTOUCHED — this module is the separate family layer on top:
 * - renderer: per-`variantKey` deltas over `rendererVariantScoreboard` rows
 *   (renderer caseIds are composite `${fid}#${variantKey}`, so alignment joins
 *   on variantKey, not caseId). len-ratio is the scoreboard's `lenRatioP50`,
 *   i.e. `report.relativeLength.ratio` verbatim — the renderer screens' one
 *   len-ratio definition.
 * - sdc: per-fixture (caseId) axis deltas off the `score-map` detail, matching
 *   `SdcRunDetail`'s projection: hybrid = `detail.hybrid ?? axes.hybrid`,
 *   correctness = `axes.answer_correctness`, retrieval =
 *   `axes.evidence_seen_recall` (axes = `detail.scores ?? detail.axes`).
 *
 * One-sided rule everywhere: a variant/fixture present in only one run keeps
 * the other side `null` and every delta `null`. Deltas are B − A (A = baseline).
 * Nothing here throws on malformed detail blobs.
 */

import type { JoinedEvalResultRow } from "../api/types";
import {
  type RendererVariant,
  rendererVariantScoreboard,
  scoreMapCoreAxes,
} from "./evalAggregates";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** One metric's A/B values plus the B − A delta (null unless both present). */
export interface MetricDelta {
  a: number | null;
  b: number | null;
  delta: number | null;
}

function metricDelta(a: number | null | undefined, b: number | null | undefined): MetricDelta {
  const av = a ?? null;
  const bv = b ?? null;
  return { a: av, b: bv, delta: av !== null && bv !== null ? bv - av : null };
}

// ---- Renderer: per-variantKey deltas ---------------------------------------

export interface RendererCompareRow {
  variantKey: string;
  /** Scoreboard row per side — null when the variant ran in only one run. */
  a: RendererVariant | null;
  b: RendererVariant | null;
  detPass: MetricDelta;
  readability: MetricDelta;
  lenRatio: MetricDelta;
  usdPerRender: MetricDelta;
}

/**
 * Join both runs' variant scoreboards on `variantKey` (sorted union) and take
 * the four headline deltas: det-pass rate, judge readability mean, len-ratio
 * p50, and mean $/render.
 */
export function rendererCompare(
  aResults: readonly JoinedEvalResultRow[],
  bResults: readonly JoinedEvalResultRow[],
): RendererCompareRow[] {
  const aByKey = new Map(rendererVariantScoreboard(aResults).map((v) => [v.variantKey, v]));
  const bByKey = new Map(rendererVariantScoreboard(bResults).map((v) => [v.variantKey, v]));
  const keys = Array.from(new Set([...aByKey.keys(), ...bByKey.keys()])).sort((x, y) =>
    x.localeCompare(y),
  );

  return keys.map((variantKey) => {
    const a = aByKey.get(variantKey) ?? null;
    const b = bByKey.get(variantKey) ?? null;
    return {
      variantKey,
      a,
      b,
      detPass: metricDelta(a?.detPassRate, b?.detPassRate),
      readability: metricDelta(a?.judgeReadability, b?.judgeReadability),
      lenRatio: metricDelta(a?.lenRatioP50, b?.lenRatioP50),
      usdPerRender: metricDelta(a?.costUsdMean, b?.costUsdMean),
    };
  });
}

// ---- SDC: per-fixture axis deltas ------------------------------------------

/** One side's score-map axes for a fixture. */
export interface SdcCaseAxes {
  hybrid: number | null;
  correctness: number | null;
  retrieval: number | null;
}

export interface SdcCompareRow {
  caseId: string;
  /** Axes per side — null when the fixture has no score-map in that run. */
  a: SdcCaseAxes | null;
  b: SdcCaseAxes | null;
  hybrid: MetricDelta;
  correctness: MetricDelta;
  retrieval: MetricDelta;
}

/** A result's score-map axes, or null when it carries no score-map detail. */
function readSdcAxes(result: JoinedEvalResultRow | undefined): SdcCaseAxes | null {
  if (!result?.scores) return null;
  const score = result.scores.find((s) => isRecord(s.detail) && s.detail.kind === "score-map");
  if (!score || !isRecord(score.detail)) return null;
  // The shared projection (evalAggregates.scoreMapCoreAxes) — the same read
  // SdcRunDetail and sdcAxisMeans use, so the pages cannot silently diverge.
  const core = scoreMapCoreAxes(score.detail);
  return { hybrid: core.hybrid, correctness: core.correctness, retrieval: core.retrieval };
}

/**
 * Per-fixture deltas over the sorted union of caseIds that carry a `score-map`
 * detail in at least one run: hybrid, answer-correctness, and retrieval
 * (evidence-seen recall).
 */
export function sdcCompare(
  aResults: readonly JoinedEvalResultRow[],
  bResults: readonly JoinedEvalResultRow[],
): SdcCompareRow[] {
  const aByCase = new Map(aResults.map((r) => [r.caseId, r]));
  const bByCase = new Map(bResults.map((r) => [r.caseId, r]));
  const rows: SdcCompareRow[] = [];

  const caseIds = Array.from(new Set([...aByCase.keys(), ...bByCase.keys()])).sort();
  for (const caseId of caseIds) {
    const a = readSdcAxes(aByCase.get(caseId));
    const b = readSdcAxes(bByCase.get(caseId));
    if (a === null && b === null) continue;
    rows.push({
      caseId,
      a,
      b,
      hybrid: metricDelta(a?.hybrid, b?.hybrid),
      correctness: metricDelta(a?.correctness, b?.correctness),
      retrieval: metricDelta(a?.retrieval, b?.retrieval),
    });
  }

  return rows;
}
