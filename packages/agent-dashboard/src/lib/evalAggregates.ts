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

/**
 * Curation frontier with the viewer's "declared-wins-else-compute" rule: when
 * the source bench emitted a canonical frontier (`meta.curation.frontier`, a
 * list of `{configId}` on the front), it is authoritative for the on-front
 * flag; otherwise dominance is recomputed (`curationFrontier`). Points are still
 * derived from per-case `curation-facts` details either way.
 */
export function curationFrontierDeclared(
  results: readonly JoinedEvalResultRow[],
  declaredFront?: readonly { configId?: unknown }[] | null,
): FrontierPoint[] {
  const computed = curationFrontier(results);
  if (!Array.isArray(declaredFront) || declaredFront.length === 0) return computed;
  const onFront = new Set(
    declaredFront.map((d) => (typeof d?.configId === "string" ? d.configId : "")).filter(Boolean),
  );
  return computed
    .map((p) => ({ ...p, onFrontier: onFront.has(p.configId) }))
    .sort((a, b) => b.survival - a.survival || a.tokens - b.tokens);
}

// ---- p50 -------------------------------------------------------------------

/** Median of the finite numbers in `values`; `null` when none. */
export function p50(values: readonly (number | null | undefined)[]): number | null {
  const xs = values
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? ((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2 : (xs[mid] ?? null);
}

function mean(values: readonly (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function rate(hits: number, total: number): number | null {
  return total > 0 ? hits / total : null;
}

// ---- Renderer variant scoreboard -------------------------------------------

export interface RendererVariant {
  variantKey: string;
  variant: {
    shape?: string;
    verbosity?: string;
    tone?: string;
    citationMode?: string;
    model?: string;
  };
  n: number;
  detPassRate: number | null;
  flagsRate: number | null;
  retriesRate: number | null;
  coverageHonestRate: number | null;
  lenRatioP50: number | null;
  judgeReadability: number | null;
  judgeFaithful: number | null;
  judgeToneDiff: number | null;
  latencyMsP50: number | null;
  costUsdMean: number | null;
  /** e.g. "inventedIds:2 coverageHonesty:1" — gates tripped across the variant's renders. */
  gateFailures: string;
}

interface VAcc {
  variant: RendererVariant["variant"];
  n: number;
  detPass: number;
  flags: number;
  retries: number;
  covHonest: number;
  covKnown: number;
  lenRatios: (number | null)[];
  read: (number | null)[];
  faith: (number | null)[];
  toneDiff: (number | null)[];
  latency: (number | null)[];
  cost: (number | null)[];
  gates: Record<string, number>;
}

const GATE_KEYS = [
  "inventedIds",
  "droppedIds",
  "inventedDates",
  "inventedMoney",
  "coverageHonesty",
  "tableIntegrity",
] as const;

/**
 * Groups a renderer run's `render-grade` cases by `variantKey` into the viewer's
 * variant scoreboard. Grade pass = `report.pass`; a gate counts as failed when
 * its `pass === false` OR (coverageHonesty) `status === 'dishonest'` — the same
 * rule the viewer's per-variant aggregation uses.
 */
export function rendererVariantScoreboard(
  results: readonly JoinedEvalResultRow[],
): RendererVariant[] {
  const by = new Map<string, VAcc>();

  for (const r of results) {
    const score = scoreWithKind(r.scores, "render-grade");
    if (!score || !isRecord(score.detail)) continue;
    const d = score.detail;
    const key = typeof d.variantKey === "string" ? d.variantKey : null;
    if (key === null) continue;
    const report = isRecord(d.report) ? d.report : {};
    const judge = isRecord(d.judge) ? d.judge : {};
    const cost = isRecord(d.cost) ? d.cost : {};
    const variant = isRecord(d.variant) ? d.variant : {};

    const acc = by.get(key) ?? {
      variant: {
        shape: typeof variant.shape === "string" ? variant.shape : undefined,
        verbosity: typeof variant.verbosity === "string" ? variant.verbosity : undefined,
        tone: typeof variant.tone === "string" ? variant.tone : undefined,
        citationMode: typeof variant.citationMode === "string" ? variant.citationMode : undefined,
        model: typeof variant.model === "string" ? variant.model : undefined,
      },
      n: 0,
      detPass: 0,
      flags: 0,
      retries: 0,
      covHonest: 0,
      covKnown: 0,
      lenRatios: [],
      read: [],
      faith: [],
      toneDiff: [],
      latency: [],
      cost: [],
      gates: {},
    };

    acc.n += 1;
    if (report.pass === true) acc.detPass += 1;
    if (
      d.fidelityFailure === true ||
      d.status === "presentation_fallback" ||
      d.status === "crashed"
    )
      acc.flags += 1;
    if (d.retriedForLength === true) acc.retries += 1;

    const cov = isRecord(report.coverageHonesty) ? report.coverageHonesty : null;
    if (cov && cov.status !== "not_declared") {
      acc.covKnown += 1;
      if (cov.pass === true) acc.covHonest += 1;
    }

    const rl = isRecord(report.relativeLength) ? report.relativeLength : null;
    acc.lenRatios.push(rl ? num(rl.ratio) : null);
    acc.read.push(num(judge.readability));
    acc.faith.push(num(judge.faithful_emphasis));
    acc.toneDiff.push(num(judge.tone_differentiation));
    acc.latency.push(num(d.latencyMs));
    acc.cost.push(isRecord(cost) ? num(cost.estimatedUsd) : null);

    for (const g of GATE_KEYS) {
      const gate = isRecord(report[g]) ? report[g] : null;
      const failed = gate ? gate.pass === false || gate.status === "dishonest" : false;
      if (failed) acc.gates[g] = (acc.gates[g] ?? 0) + 1;
    }

    by.set(key, acc);
  }

  return [...by.entries()]
    .map(([variantKey, a]) => ({
      variantKey,
      variant: a.variant,
      n: a.n,
      detPassRate: rate(a.detPass, a.n),
      flagsRate: rate(a.flags, a.n),
      retriesRate: rate(a.retries, a.n),
      coverageHonestRate: rate(a.covHonest, a.covKnown),
      lenRatioP50: p50(a.lenRatios),
      judgeReadability: mean(a.read),
      judgeFaithful: mean(a.faith),
      judgeToneDiff: mean(a.toneDiff),
      latencyMsP50: p50(a.latency),
      costUsdMean: mean(a.cost),
      gateFailures: GATE_KEYS.filter((g) => a.gates[g])
        .map((g) => `${g}:${a.gates[g]}`)
        .join(" "),
    }))
    .sort((x, y) => x.variantKey.localeCompare(y.variantKey));
}

// ---- SDC axis means (run-level score map fallback) -------------------------

/**
 * Mean of each `score-map` axis across a run's cases — the client-computed
 * fallback for the run-level SDC score map when `meta.sdc.scores` is absent.
 */
export function sdcAxisMeans(results: readonly JoinedEvalResultRow[]): Record<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const r of results) {
    const score = scoreWithKind(r.scores, "score-map");
    if (!score || !isRecord(score.detail)) continue;
    const axes = score.detail.scores ?? score.detail.axes;
    if (!isRecord(axes)) continue;
    for (const [k, v] of Object.entries(axes)) {
      const n = num(v);
      if (n === null) continue;
      const acc = sums.get(k) ?? { sum: 0, n: 0 };
      acc.sum += n;
      acc.n += 1;
      sums.set(k, acc);
    }
  }
  const out: Record<string, number> = {};
  for (const [k, { sum, n }] of sums) out[k] = sum / n;
  return out;
}

// ---- Curation config table -------------------------------------------------

export interface CurationConfigRow {
  configId: string;
  knobs: Record<string, unknown>;
  n: number;
  survival: number | null;
  outboundTokens: number | null;
  compressionPct: number | null;
  dealMinShare: number | null;
  zeroRowDeals: number | null;
  nearDupRate: number | null;
  deadRowRate: number | null;
  temporalSpreadDays: number | null;
}

/**
 * Per-config aggregate table for a curation run — one row per `configId`,
 * averaging the `curation-facts` `metrics` across the config's fixtures. Sorted
 * survival↓, then outbound-tokens↑ (the viewer's frontier ordering).
 */
export function curationConfigTable(results: readonly JoinedEvalResultRow[]): CurationConfigRow[] {
  const by = new Map<
    string,
    { knobs: Record<string, unknown>; n: number; cols: Record<string, (number | null)[]> }
  >();

  const push = (acc: { cols: Record<string, (number | null)[]> }, k: string, v: number | null) => {
    const col = acc.cols[k] ?? [];
    col.push(v);
    acc.cols[k] = col;
  };

  for (const r of results) {
    const score = scoreWithKind(r.scores, "curation-facts");
    if (!score || !isRecord(score.detail)) continue;
    const d = score.detail;
    const configId = typeof d.configId === "string" ? d.configId : null;
    if (configId === null) continue;
    const m = isRecord(d.metrics) ? d.metrics : d; // tolerate flat or nested
    const survival = isRecord(m.goldFactSurvival)
      ? num(m.goldFactSurvival.rate)
      : num(d.survival && isRecord(d.survival) ? d.survival.rate : null);
    const dealCov = isRecord(m.dealCoverage) ? m.dealCoverage : {};
    const temporal = isRecord(m.temporalSpreadDays) ? m.temporalSpreadDays : {};

    const acc = by.get(configId) ?? { knobs: isRecord(d.knobs) ? d.knobs : {}, n: 0, cols: {} };
    acc.n += 1;
    push(acc, "survival", survival);
    push(acc, "outboundTokens", num(m.outboundTokens));
    push(acc, "compressionPct", num(m.compressionPct));
    push(acc, "dealMinShare", num(dealCov.minShare));
    push(acc, "zeroRowDeals", num(dealCov.zeroRowDeals));
    push(acc, "nearDupRate", num(m.nearDupRate));
    push(acc, "deadRowRate", num(m.deadRowRate));
    push(acc, "temporalSpreadDays", num(temporal.kept));
    by.set(configId, acc);
  }

  return [...by.entries()]
    .map(([configId, a]) => ({
      configId,
      knobs: a.knobs,
      n: a.n,
      survival: mean(a.cols.survival ?? []),
      outboundTokens: mean(a.cols.outboundTokens ?? []),
      compressionPct: mean(a.cols.compressionPct ?? []),
      dealMinShare: mean(a.cols.dealMinShare ?? []),
      zeroRowDeals: mean(a.cols.zeroRowDeals ?? []),
      nearDupRate: mean(a.cols.nearDupRate ?? []),
      deadRowRate: mean(a.cols.deadRowRate ?? []),
      temporalSpreadDays: mean(a.cols.temporalSpreadDays ?? []),
    }))
    .sort(
      (x, y) =>
        (y.survival ?? -1) - (x.survival ?? -1) ||
        (x.outboundTokens ?? Number.POSITIVE_INFINITY) -
          (y.outboundTokens ?? Number.POSITIVE_INFINITY),
    );
}
