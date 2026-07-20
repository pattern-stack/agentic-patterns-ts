/**
 * Answer-bank case view — stat tiles (from `bankStatsOf`, the same client-side
 * derivation the set table uses), the deal state + golden rendered as markdown
 * with `[evidence-N]` highlighting (`EvidenceText`), and the golden's used
 * evidence-ref chips. Replaces the generic pretty-JSON input/expected panes;
 * the page keeps the cross-run history section below (composite
 * `fid#variantKey` results match by prefix and carry a "Recorded as" label).
 */

import { Card } from "../../../../components/atoms/Card";
import { Chip } from "../../../../components/atoms/Chip";
import { EvidenceText } from "../../components/EvidenceText";
import type { FamilyCaseViewProps } from "../index";
import { bankStatsOf } from "./BankSetView";

const sectionHeadingStyle = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  color: "var(--fg-subtle)",
  marginBottom: 8,
};

const panelStyle = {
  padding: "2px 12px",
  background: "var(--bg-inset)",
  borderRadius: 6,
  fontSize: 13,
  overflowX: "auto" as const,
  wordBreak: "break-word" as const,
};

// Standalone stat tile — bordered like the root dashboard's stat cards. (Run
// details use borderless label/value tiles instead because theirs sit inside
// an already-bordered summary Card; value size 20 is shared across both.)
function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "10px 14px",
        minWidth: 90,
        background: "var(--bg-surface)",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--fg-subtle)", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

/** Distinct `[evidence-N]` ids in `text`, in first-seen order. */
function usedRefIds(text: string): string[] {
  const re = /\[evidence-(\d+)\]/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const id = `evidence-${m[1] ?? ""}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function BankCaseView({ caseRow }: FamilyCaseViewProps) {
  const stats = bankStatsOf(caseRow);
  const state = typeof caseRow.input === "string" ? caseRow.input : null;
  const golden = typeof caseRow.expected === "string" ? caseRow.expected : null;
  const refs = golden ? usedRefIds(golden) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <StatTile label="Words" value={stats.words} />
        <StatTile label="Evidence refs" value={stats.refs} />
        <StatTile label="Chars" value={stats.chars} />
        <StatTile label="Regime" value={stats.regime} />
        {stats.provenance && <StatTile label="Provenance" value={stats.provenance} />}
      </div>

      <Card>
        <div style={sectionHeadingStyle}>Deal state</div>
        {state ? (
          <div style={panelStyle}>
            <EvidenceText content={state} />
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
            This case's input is not a markdown deal state.
          </div>
        )}
      </Card>

      <Card>
        <div style={sectionHeadingStyle}>Golden response</div>
        {golden ? (
          <div style={panelStyle}>
            <EvidenceText content={golden} />
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>No golden response recorded.</div>
        )}
        {refs.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              alignItems: "center",
              marginTop: 10,
            }}
          >
            <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>Used evidence</span>
            {refs.map((id) => (
              <Chip key={id} tone="mono">
                {id}
              </Chip>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
