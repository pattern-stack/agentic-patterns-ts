/**
 * Run-level eval aggregates, computed client-side from the per-case results the
 * run-detail endpoint already returns (`JoinedEvalResultRow[]`). No store/route
 * change — the cross-case views (two-lens rollup, curation Pareto frontier) are
 * pure functions of `scores[].detail`.
 */

import type { EvalScoreLike, JoinedEvalResultRow } from "../api/types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** First score whose detail carries the given `kind`. */
function scoreWithKind(scores: EvalScoreLike[] | null, kind: string): EvalScoreLike | null {
  if (!scores) return null;
  for (const s of scores) {
    if (isRecord(s.detail) && s.detail.kind === kind) return s;
  }
  return null;
}

// ---- Two-lens rollup -------------------------------------------------------

export interface TwoLensRollup {
  /** Cases with a gated (non-null) pass verdict. */
  gated: number;
  /** Deterministic lens: gated pass rate (0..1), or null when nothing is gated. */
  detPassRate: number | null;
  /** Judge lens: mean of the `judge` score's value (0..1), or null when absent. */
  judgeMean: number | null;
  /** Cases contributing a judge value. */
  judged: number;
}

/**
 * The product-thesis rollup: deterministic pass rate vs judge-content mean, the
 * two lenses side by side. Judge value is read from a score named `judge` (the
 * built-in judge scorer's headline), falling back to any `judge:*` axis mean.
 */
export function twoLensRollup(results: readonly JoinedEvalResultRow[]): TwoLensRollup {
  let gated = 0;
  let passed = 0;
  let judged = 0;
  let judgeSum = 0;

  for (const r of results) {
    if (r.pass !== null) {
      gated += 1;
      if (r.pass) passed += 1;
    }
    const jv = judgeValue(r.scores);
    if (jv !== null) {
      judged += 1;
      judgeSum += jv;
    }
  }

  return {
    gated,
    detPassRate: gated > 0 ? passed / gated : null,
    judgeMean: judged > 0 ? judgeSum / judged : null,
    judged,
  };
}

/** A case's judge value: the `judge` score, else the mean of `judge:*` axes. */
function judgeValue(scores: EvalScoreLike[] | null): number | null {
  if (!scores) return null;
  const headline = scores.find((s) => s.name === "judge");
  if (headline) return num(headline.value);
  const axes = scores.filter((s) => s.name.startsWith("judge:")).map((s) => num(s.value));
  const present = axes.filter((v): v is number => v !== null);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) / present.length : null;
}

// ---- Curation Pareto frontier ----------------------------------------------

export interface FrontierPoint {
  configId: string;
  /** Mean gold-fact survival across the config's fixtures (0..1). */
  survival: number;
  /** Mean outbound tokens across the config's fixtures. */
  tokens: number;
  /** Fixtures contributing to this config's means. */
  n: number;
  /** On the Pareto front (not dominated on survival↑ / tokens↓). */
  onFrontier: boolean;
}

interface Accum {
  survivalSum: number;
  tokenSum: number;
  n: number;
}

/**
 * The curation sweep's frontier: group the run's curation cases by `configId`,
 * average survival and outbound tokens per config, and mark the Pareto front
 * (a config is dominated when another has survival ≥ and tokens ≤, strictly
 * better on at least one). Reads `curation-facts` detail carrying `configId`,
 * `outboundTokens`, and `survival.rate`. Returns `[]` when the run has no such
 * cases (the panel then hides). Sorted survival↓, then tokens↑.
 */
export function curationFrontier(results: readonly JoinedEvalResultRow[]): FrontierPoint[] {
  const byConfig = new Map<string, Accum>();

  for (const r of results) {
    const score = scoreWithKind(r.scores, "curation-facts");
    if (!score || !isRecord(score.detail)) continue;
    const d = score.detail;
    const configId = typeof d.configId === "string" ? d.configId : null;
    const tokens = num(d.outboundTokens);
    const survival = isRecord(d.survival) ? num(d.survival.rate) : null;
    if (configId === null || tokens === null || survival === null) continue;

    const acc = byConfig.get(configId) ?? { survivalSum: 0, tokenSum: 0, n: 0 };
    acc.survivalSum += survival;
    acc.tokenSum += tokens;
    acc.n += 1;
    byConfig.set(configId, acc);
  }

  const points: Omit<FrontierPoint, "onFrontier">[] = [...byConfig.entries()].map(
    ([configId, a]) => ({
      configId,
      survival: a.survivalSum / a.n,
      tokens: a.tokenSum / a.n,
      n: a.n,
    }),
  );

  const withFront: FrontierPoint[] = points.map((p) => ({
    ...p,
    onFrontier: !points.some(
      (q) =>
        q !== p &&
        q.survival >= p.survival &&
        q.tokens <= p.tokens &&
        (q.survival > p.survival || q.tokens < p.tokens),
    ),
  }));

  return withFront.sort((a, b) => b.survival - a.survival || a.tokens - b.tokens);
}
