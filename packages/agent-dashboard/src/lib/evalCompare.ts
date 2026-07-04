/**
 * A/B compare — pure client-side alignment + summary over two eval runs'
 * `GET /eval/runs/:id` payloads (#138, E5b).
 *
 * No fetch, no React. Mirrors `EvalStore.compareEvalRuns` semantics exactly
 * (`eval-store.ts:460-506`) — sorted union of case ids, one-sided rows keep
 * the other side `null`, and the six-bucket summary counts identically,
 * including the subtlety that a pair where both sides are present but
 * neither carries a `pass`/`fail` verdict (ungated) increments **no**
 * bucket. `evalCompare.test.ts` proves parity with those semantics directly.
 *
 * Deliberately richer than the store's `EvalComparisonRow`: each side here
 * keeps the *full* `JoinedEvalResultRow` (finalAnswer, traceId, runStatus,
 * tokens, elapsedMs) rather than just `{ pass, scores }` — the compare page
 * needs all of it for the expanded actual-vs-actual + trace drill-down (spec
 * finding 3).
 */

import type { JoinedEvalResultRow, SplitAggregate } from "../api/types";

export type DeltaKind =
  | "regression"
  | "improvement"
  | "same-pass"
  | "same-fail"
  | "ungated"
  | "a-only"
  | "b-only";

export interface ComparisonCaseRow {
  caseId: string;
  a: JoinedEvalResultRow | null; // null = not run in A
  b: JoinedEvalResultRow | null; // null = not run in B
  delta: DeltaKind;
}

/** Bucket-for-bucket = `EvalComparison["summary"]` (`eval-store.ts:158-165`). */
export interface ComparisonSummary {
  bothPassed: number;
  bothFailed: number;
  onlyAPassed: number; // regressions when A = older/baseline
  onlyBPassed: number; // improvements when A = older/baseline
  aOnly: number; // not-run coverage, never a failure
  bOnly: number;
}

/**
 * Per-case delta classification. A case present in only one run is a
 * coverage fact ("a-only"/"b-only"), never a regression/improvement. A case
 * present in both but where neither side carries a gated pass/fail verdict
 * is "ungated" — same treatment as the store's "increments no bucket" rule.
 */
export function classifyDelta(
  a: JoinedEvalResultRow | null,
  b: JoinedEvalResultRow | null,
): DeltaKind {
  if (a && !b) return "a-only";
  if (b && !a) return "b-only";
  if (!a || !b) return "a-only"; // unreachable given alignResults' union construction

  if (a.pass === true && b.pass === true) return "same-pass";
  if (a.pass === false && b.pass === false) return "same-fail";
  if (a.pass === true && b.pass === false) return "regression";
  if (a.pass === false && b.pass === true) return "improvement";
  return "ungated";
}

/** Sorted union of case ids across both runs' results. */
export function alignResults(
  a: readonly JoinedEvalResultRow[],
  b: readonly JoinedEvalResultRow[],
): ComparisonCaseRow[] {
  const aMap = new Map(a.map((r) => [r.caseId, r]));
  const bMap = new Map(b.map((r) => [r.caseId, r]));
  const caseIds = Array.from(new Set([...aMap.keys(), ...bMap.keys()])).sort();

  return caseIds.map((caseId) => {
    const ar = aMap.get(caseId) ?? null;
    const br = bMap.get(caseId) ?? null;
    return { caseId, a: ar, b: br, delta: classifyDelta(ar, br) };
  });
}

/** Bucket counts over aligned rows — parity vectors verified against the store. */
export function summarizeComparison(rows: readonly ComparisonCaseRow[]): ComparisonSummary {
  let bothPassed = 0;
  let bothFailed = 0;
  let onlyAPassed = 0;
  let onlyBPassed = 0;
  let aOnly = 0;
  let bOnly = 0;

  for (const row of rows) {
    switch (row.delta) {
      case "a-only":
        aOnly++;
        break;
      case "b-only":
        bOnly++;
        break;
      case "same-pass":
        bothPassed++;
        break;
      case "same-fail":
        bothFailed++;
        break;
      case "regression":
        onlyAPassed++;
        break;
      case "improvement":
        onlyBPassed++;
        break;
      case "ungated":
        break; // increments no bucket — the store's own rule
    }
  }

  return { bothPassed, bothFailed, onlyAPassed, onlyBPassed, aOnly, bOnly };
}

/**
 * The overfit gap: `train` pass-rate minus `test` pass-rate, in percentage
 * points. `null` unless both buckets exist with a non-null `passRate` — no
 * guess when either side is unscored, which is the point (§7).
 */
export function overfitGap(
  aggregates: readonly SplitAggregate[],
): { train: number; test: number; gapPts: number } | null {
  const train = aggregates.find((a) => a.split === "train");
  const test = aggregates.find((a) => a.split === "test");
  if (!train || !test || train.passRate === null || test.passRate === null) {
    return null;
  }
  return {
    train: train.passRate,
    test: test.passRate,
    gapPts: (train.passRate - test.passRate) * 100,
  };
}
