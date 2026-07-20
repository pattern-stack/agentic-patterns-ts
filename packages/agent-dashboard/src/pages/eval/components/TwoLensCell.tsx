/**
 * TwoLensCell — the det/judge two-pill cell for list-grain family tables.
 *
 * Contract (docs/eval-family-contract.md): the deterministic pill ALWAYS
 * renders (pass-rate %, "—" when unknown); the judge pill renders only when a
 * `judgeLens` exists — `kind:"mean"` shows the value, `kind:"ratio"` shows
 * num/den — and is OMITTED (not zeroed) otherwise. Dashboard-native runs have
 * no `meta.summary` at list grain, so det-only is a real, expected state;
 * gate on field presence, never on summary truthiness (parseSummary yields an
 * all-undefined object for `{}`).
 *
 * Both pills are threshold-colored (≥0.8 green / ≥0.5 yellow / else red) so
 * det-vs-judge disagreement is legible at a glance; the glyph prefix keeps the
 * lenses distinguishable without color.
 */

import { Badge, type BadgeTone } from "../../../components/atoms/Badge";
import type { JudgeLens, RunSummary } from "../families/types";

export interface TwoLensCellProps {
  /** The run's parsed `meta.summary` (readRunMeta(run)?.summary). */
  summary?: RunSummary | null;
  /** Fallback det pass-rate (0..1) for runs without a family summary. */
  detPassRate?: number | null;
}

function toneFor(v: number | null): BadgeTone {
  if (v === null) return "neutral";
  if (v >= 0.8) return "green";
  if (v >= 0.5) return "yellow";
  return "red";
}

function judgeText(lens: JudgeLens): string {
  if (lens.kind === "ratio") {
    return lens.num !== undefined && lens.den !== undefined
      ? `${lens.num}/${lens.den}`
      : `${Math.round(lens.value * 100)}%`;
  }
  return lens.value.toFixed(2);
}

export function TwoLensCell({ summary, detPassRate }: TwoLensCellProps) {
  const det = summary?.detPassRate ?? detPassRate ?? null;
  const judge = summary?.judgeLens;
  const detText = det === null ? "—" : `${Math.round(det * 100)}%`;

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <Badge tone={toneFor(det)} title="Deterministic pass rate">
        {`det ${detText}`}
      </Badge>
      {judge && (
        <Badge
          tone={toneFor(judge.value)}
          title={
            judge.kind === "ratio" ? "Judge lens — verdicts passed" : "Judge lens — mean score"
          }
        >
          {`judge ${judgeText(judge)}`}
        </Badge>
      )}
    </span>
  );
}
