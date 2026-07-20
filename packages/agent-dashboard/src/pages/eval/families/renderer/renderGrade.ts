/**
 * Render-grade row parsing for the renderer family screens (slice 6).
 *
 * A renderer run's results carry one `kind: "render-grade"` score per render
 * (see `eval-family-contract.md` + the seed fixture's `buildReport`). This
 * module flattens that untyped detail blob into the typed row the run-detail
 * table, filters, and charts consume — defensively (every field tolerates a
 * miss), matching the gate-failure rule `lib/evalAggregates.ts` uses for the
 * variant scoreboard: a gate counts as failed when `pass === false` OR
 * (coverageHonesty) `status === "dishonest"`.
 */

import type { EvalScoreLike, JoinedEvalResultRow } from "../../../../api/types";
import { isRecord, numOrNull } from "../../renderers/shared";

/** The six deterministic fidelity gates, in report order. */
export const RENDER_GATE_KEYS = [
  "inventedIds",
  "droppedIds",
  "inventedDates",
  "inventedMoney",
  "coverageHonesty",
  "tableIntegrity",
] as const;

export interface RenderGradeRow {
  /** Composite `${fid}#${variantKey}` case id (never a bank case id). */
  caseId: string;
  result: JoinedEvalResultRow;
  /** The owning `render-grade` score (for embedding `RenderGradeDetail`). */
  score: EvalScoreLike;
  /** The full detail blob, verbatim. */
  detail: Record<string, unknown>;
  /** Bank-case join key (`detail.fid`) — the LEFT pane + the ↗ bank link. */
  fid: string | null;
  variantKey: string | null;
  status: string | null;
  /** `report.pass` — the deterministic grade lens. */
  detPass: boolean | null;
  /** Gate keys that tripped (pass===false || status==="dishonest"). */
  failedGates: string[];
  judgeReadability: number | null;
  judgeFaithful: number | null;
  judgeToneDiff: number | null;
  /** `report.relativeLength.ratio`. */
  lenRatio: number | null;
  latencyMs: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  renderedText: string | null;
  fidelityFailure: boolean;
  retriedForLength: boolean;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Parse one result's `render-grade` score into a row, or `null` when absent/malformed. */
export function readRenderGradeRow(result: JoinedEvalResultRow): RenderGradeRow | null {
  const score = result.scores?.find((s) => isRecord(s.detail) && s.detail.kind === "render-grade");
  if (!score || !isRecord(score.detail)) return null;
  const d = score.detail;
  const report = isRecord(d.report) ? d.report : {};
  const judge = isRecord(d.judge) ? d.judge : {};
  const cost = isRecord(d.cost) ? d.cost : {};
  const rl = isRecord(report.relativeLength) ? report.relativeLength : {};

  const failedGates = RENDER_GATE_KEYS.filter((g) => {
    const gate = isRecord(report[g]) ? report[g] : null;
    return gate !== null && (gate.pass === false || gate.status === "dishonest");
  });

  return {
    caseId: result.caseId,
    result,
    score,
    detail: d,
    fid: strOrNull(d.fid),
    variantKey: strOrNull(d.variantKey),
    status: strOrNull(d.status),
    detPass: typeof report.pass === "boolean" ? report.pass : null,
    failedGates,
    judgeReadability: numOrNull(judge.readability),
    judgeFaithful: numOrNull(judge.faithful_emphasis),
    judgeToneDiff: numOrNull(judge.tone_differentiation),
    lenRatio: numOrNull(rl.ratio),
    latencyMs: numOrNull(d.latencyMs),
    costUsd: numOrNull(cost.estimatedUsd),
    inputTokens: numOrNull(cost.inputTokens),
    outputTokens: numOrNull(cost.outputTokens),
    renderedText: strOrNull(d.renderedText),
    fidelityFailure: d.fidelityFailure === true,
    retriedForLength: d.retriedForLength === true,
  };
}

/** All render-grade rows in a run's results, fetch order preserved. */
export function readRenderGradeRows(results: readonly JoinedEvalResultRow[]): RenderGradeRow[] {
  const out: RenderGradeRow[] = [];
  for (const r of results) {
    const row = readRenderGradeRow(r);
    if (row) out.push(row);
  }
  return out;
}
