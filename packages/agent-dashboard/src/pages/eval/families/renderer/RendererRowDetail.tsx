/**
 * Expanded-row drill-in for one render (`RendererRunDetail`'s
 * `DataTable.renderExpanded`). Top to bottom: the six gate chips (REUSING the
 * registered `RenderGradeDetail` renderer as a plain embedded component),
 * judge meters + cost/latency readout, then side-by-side `EvidenceText`
 * panes — LEFT the bank case input (joined via `detail.fid`, tolerating a
 * miss: composite run ids never match bank ids and the bank fetch can
 * degrade), RIGHT the rendered markdown — with an "↗ bank" cross-link to
 * `/eval/sets/:setId/cases/:fid` (both segments encoded).
 */

import { Link } from "react-router-dom";
import type { EvalCaseRow } from "../../../../api/types";
import { Badge } from "../../../../components/atoms/Badge";
import { MeterCell } from "../../charts/MeterCell";
import { EvidenceText } from "../../components/EvidenceText";
import { RenderGradeDetail } from "../../renderers/RenderGradeDetail";
import type { RenderGradeRow } from "./renderGrade";

const headingStyle = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  color: "var(--fg-subtle)",
  marginBottom: 6,
};

const mutedStyle = { color: "var(--fg-muted)", fontSize: 13 };

// Panes sit on the expanded row's --bg-inset, so they use the surface tone.
const panelStyle = {
  margin: 0,
  padding: "2px 12px",
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: 13,
  overflowX: "auto" as const,
  wordBreak: "break-word" as const,
};

const prePanelStyle = {
  ...panelStyle,
  padding: 10,
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  whiteSpace: "pre-wrap" as const,
};

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "—";
  } catch {
    return String(value);
  }
}

export interface RendererRowDetailProps {
  row: RenderGradeRow;
  /** The bank case joined by `row.fid` — undefined on a degraded/missing bank. */
  bankCase: EvalCaseRow | undefined;
  /** The run's set id — the bank link target; null hides the link. */
  setId: string | null;
}

export function RendererRowDetail({ row, bankCase, setId }: RendererRowDetailProps) {
  const bankHref =
    setId !== null && row.fid !== null
      ? `/eval/sets/${encodeURIComponent(setId)}/cases/${encodeURIComponent(row.fid)}`
      : null;
  const judged =
    row.judgeReadability !== null || row.judgeFaithful !== null || row.judgeToneDiff !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={headingStyle}>Gates</div>
        <RenderGradeDetail detail={row.detail} score={row.score} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        <div style={{ minWidth: 240, flex: "0 1 320px" }}>
          <div style={headingStyle}>Judge</div>
          {judged ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <MeterCell label="readability" value={row.judgeReadability} />
              <MeterCell label="faithful_emphasis" value={row.judgeFaithful} />
              <MeterCell label="tone_differentiation" value={row.judgeToneDiff} />
            </div>
          ) : (
            <div style={mutedStyle}>judge skipped for this render</div>
          )}
        </div>

        <div>
          <div style={headingStyle}>Cost · Latency</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
            {row.costUsd !== null ? `$${row.costUsd.toFixed(4)}` : "$ —"}
            {" · "}
            {row.inputTokens ?? "—"} in / {row.outputTokens ?? "—"} out
            {" · "}
            {row.latencyMs !== null ? `${row.latencyMs}ms` : "—"}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {row.status !== null && row.status !== "ok" && (
              <Badge tone={row.status === "crashed" ? "red" : "yellow"}>{row.status}</Badge>
            )}
            {row.retriedForLength && <Badge tone="yellow">retried for length</Badge>}
            {row.fidelityFailure && <Badge tone="red">fidelity failure</Badge>}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <div style={{ ...headingStyle, display: "flex", gap: 10, alignItems: "baseline" }}>
            <span>Bank input{row.fid !== null ? ` · ${row.fid}` : ""}</span>
            {bankHref !== null && (
              <Link
                to={bankHref}
                title="View this bank case"
                style={{
                  color: "var(--accent)",
                  fontSize: 12,
                  fontWeight: 500,
                  textDecoration: "none",
                  textTransform: "none",
                  letterSpacing: "normal",
                }}
              >
                ↗ bank
              </Link>
            )}
          </div>
          {bankCase === undefined ? (
            <div style={mutedStyle}>
              bank case not available{row.fid !== null ? ` (fid ${row.fid})` : ""}
            </div>
          ) : typeof bankCase.input === "string" ? (
            <div style={panelStyle}>
              <EvidenceText content={bankCase.input} />
            </div>
          ) : (
            <pre style={prePanelStyle}>{pretty(bankCase.input)}</pre>
          )}
        </div>

        <div>
          <div style={headingStyle}>Rendered output</div>
          {row.renderedText !== null ? (
            <div style={panelStyle}>
              <EvidenceText content={row.renderedText} />
            </div>
          ) : (
            <div style={mutedStyle}>no rendered text recorded</div>
          )}
        </div>
      </div>
    </div>
  );
}
