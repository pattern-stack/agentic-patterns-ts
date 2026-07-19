/**
 * Run-level eval panels — cross-case views computed client-side from the run's
 * per-case results. Additive above the per-case table; each panel self-hides
 * when its data isn't present, so a plain run shows only the two-lens rollup.
 *
 * - Two-lens rollup: deterministic pass rate vs judge-content mean (the
 *   pipeline-pass ≠ content-quality thesis, legible at a glance).
 * - Curation frontier: survival-vs-tokens Pareto scatter over the run's
 *   curation configs (only when curation cases are present).
 */

import type { JoinedEvalResultRow } from "../../../api/types";
import { Card } from "../../../components/atoms/Card";
import { curationFrontier, twoLensRollup } from "../../../lib/evalAggregates";
import { FrontierScatter } from "./FrontierScatter";

const headingStyle = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  color: "var(--fg-subtle)",
  marginBottom: 10,
};

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function Lens({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--fg-subtle)" }}>{sub}</div>
    </div>
  );
}

export function RunPanels({ results }: { results: readonly JoinedEvalResultRow[] }) {
  const lens = twoLensRollup(results);
  const frontier = curationFrontier(results);

  // The two-lens card only earns its space once at least one lens has data.
  const showLens = lens.detPassRate !== null || lens.judgeMean !== null;
  if (!showLens && frontier.length === 0) return null;

  return (
    <>
      {showLens && (
        <Card>
          <div style={headingStyle}>Two lenses</div>
          <div style={{ display: "flex", gap: 40, flexWrap: "wrap", alignItems: "flex-start" }}>
            <Lens
              label="Deterministic"
              value={pct(lens.detPassRate)}
              sub={`${lens.gated} gated case${lens.gated === 1 ? "" : "s"}`}
            />
            <Lens
              label="Judge"
              value={pct(lens.judgeMean)}
              sub={
                lens.judged > 0
                  ? `${lens.judged} judged case${lens.judged === 1 ? "" : "s"}`
                  : "no judge scores"
              }
            />
          </div>
        </Card>
      )}

      {frontier.length > 0 && (
        <Card>
          <div style={headingStyle}>
            Curation frontier · {frontier.filter((p) => p.onFrontier).length}/{frontier.length} on
            front
          </div>
          <FrontierScatter points={frontier} />
        </Card>
      )}
    </>
  );
}
