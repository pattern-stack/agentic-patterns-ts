/**
 * ScoreMapView — the grouped-meter core of the score-map visualization,
 * extracted from `ScoreMapDetail` so the SAME grouping + meter layout renders
 * at both grains: per-case (`ScoreMapDetail`, `detail.axes`) and per-run
 * (`SdcRunDetail`, declared `meta.sdc.scores` or the client-mean fallback).
 *
 * Pure presentational: takes an axis→value record (values untyped, guarded by
 * `numOrNull`), buckets known axes into readable groups, and drops unknowns
 * into an "Other axes" catch-all so new metrics render for free. Returns
 * `null` when the record yields no groups (empty map).
 */

import { MeterBar, numOrNull, rendererHeadingStyle } from "./shared";

// Bucketing mirrors the Dealbrain viewer's SCORE_GROUPS (viewer app.js).
const SCORE_GROUPS: { title: string; match: string[] }[] = [
  {
    title: "Headline",
    match: [
      "hybrid",
      "score",
      "answer_correctness",
      "answer_fact_coverage",
      "golden_answer_alignment_llm",
      "judge_reference",
    ],
  },
  {
    title: "Retrieval & coverage",
    match: [
      "retrieval",
      "coverage_retrieval",
      "evidence_seen_recall",
      "expected_seen_recall",
      "expected_deal_coverage",
      "per_deal_support_coverage",
      "source_grounding",
      "source_usefulness",
      "fact_evidence_seen",
      "citation_source_recall",
    ],
  },
  {
    title: "Citations",
    match: [
      "citation_support",
      "citation_claim_support",
      "citation_integrity",
      "citation_selection_hygiene",
      "required_citation_recall",
      "response_citation_density",
    ],
  },
  {
    title: "Response quality",
    match: [
      "response_quality",
      "response_completeness",
      "response_structure",
      "response_actionability",
      "response_specificity",
      "response_concision",
      "answer_quality_binary",
    ],
  },
  {
    title: "Hygiene & contract",
    match: [
      "format_contract",
      "structured_exact",
      "tool_strategy",
      "tool_contract",
      "deal_state_routing",
      "deal_contamination_hygiene",
      "missing_context_hygiene",
      "response_refusal_hygiene",
      "instruction_leakage_cleanliness",
      "forbidden_claim_avoidance",
      "payload_budget_hygiene",
      "fallback_final_gate",
      "criteria_evidence",
      "binary_expectations",
      "answer_grounding_binary",
      "cost_latency",
      "judge_criteria",
    ],
  },
];

const rowStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(0,1fr) 42px",
  gap: "2px 8px",
  alignItems: "center",
};
const nameStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-muted)",
  overflow: "hidden" as const,
  textOverflow: "ellipsis" as const,
  whiteSpace: "nowrap" as const,
};
const valStyle = { fontFamily: "var(--font-mono)", fontSize: 11, textAlign: "right" as const };

function groupAxes(axes: Record<string, unknown>): { title: string; keys: string[] }[] {
  const used = new Set<string>();
  const groups: { title: string; keys: string[] }[] = [];
  for (const g of SCORE_GROUPS) {
    const keys = g.match.filter((k) => k in axes);
    for (const k of keys) used.add(k);
    if (keys.length) groups.push({ title: g.title, keys });
  }
  const leftovers = Object.keys(axes).filter((k) => !used.has(k));
  if (leftovers.length) groups.push({ title: "Other axes", keys: leftovers });
  return groups;
}

export interface ScoreMapViewProps {
  /** Axis→value record (values guarded — non-numbers render as "—"). */
  axes: Record<string, unknown>;
}

export function ScoreMapView({ axes }: ScoreMapViewProps) {
  const groups = groupAxes(axes);
  if (groups.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 2 }}>
      {groups.map((g) => (
        <div key={g.title} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={rendererHeadingStyle}>{g.title}</div>
          {g.keys.map((k) => {
            const v = numOrNull(axes[k]);
            return (
              <div key={k} style={rowStyle}>
                <span style={nameStyle} title={k}>
                  {k}
                </span>
                <span style={valStyle}>{v === null ? "—" : v.toFixed(2)}</span>
                <div style={{ gridColumn: "1 / 3" }}>
                  <MeterBar value={v} />
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
