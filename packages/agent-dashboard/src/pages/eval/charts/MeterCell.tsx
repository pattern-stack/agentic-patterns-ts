/**
 * MeterCell — a compact meter for table cells, composing the ONE shipped
 * meter core (`MeterBar` + its threshold colors in renderers/shared). No
 * second meter implementation exists — this is a layout wrapper over the
 * shared core, in two shapes:
 *
 * - WITH a label (score maps, judge panels): the ScoreMapDetail grouped-row
 *   layout — mono 11px ellipsized label, right-aligned value, full-width bar
 *   underneath.
 * - WITHOUT a label (plain table cells): a single line — fixed-width bar +
 *   value beside it, matching BarCell's rhythm so mixed columns align.
 *
 * `value` is 0..1 by default; pass `max` for other bounded scales (the bar is
 * normalized, the text shows the raw value).
 */

import { MeterBar } from "../renderers/shared";

export interface MeterCellProps {
  value: number | null;
  /** Upper bound for the bar's normalization (default 1). */
  max?: number;
  label?: string;
  /** Formats the raw (un-normalized) value (default `.toFixed(2)`). */
  format?: (v: number) => string;
}

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

export function MeterCell({
  value,
  max = 1,
  label,
  format = (v: number) => v.toFixed(2),
}: MeterCellProps) {
  const bounded =
    value === null || !Number.isFinite(value) || max <= 0
      ? null
      : Math.max(0, Math.min(1, value / max));

  // Missing value ⇒ the house muted dash alone — no empty meter track (matches
  // the Gates/Coverage empty states; an empty bar reads as a zero score).
  if (bounded === null) {
    if (label === undefined) {
      return <span style={{ ...valStyle, color: "var(--fg-subtle)" }}>—</span>;
    }
    return (
      <div style={rowStyle}>
        <span style={nameStyle} title={label}>
          {label}
        </span>
        <span style={{ ...valStyle, color: "var(--fg-subtle)" }}>—</span>
      </div>
    );
  }

  // Label-less table cell ⇒ one line, BarCell rhythm (bar left, value right).
  if (label === undefined) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 72, flex: "none" }}>
          <MeterBar value={bounded} />
        </span>
        <span style={valStyle}>{value === null ? "—" : format(value)}</span>
      </span>
    );
  }

  return (
    <div style={rowStyle}>
      <span style={nameStyle} title={label}>
        {label}
      </span>
      <span style={valStyle}>{value === null ? "—" : format(value)}</span>
      <div style={{ gridColumn: "1 / 3" }}>
        <MeterBar value={bounded} />
      </div>
    </div>
  );
}
