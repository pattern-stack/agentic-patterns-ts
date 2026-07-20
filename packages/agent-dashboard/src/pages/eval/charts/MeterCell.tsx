/**
 * MeterCell — a compact labeled meter for table cells, composing the ONE
 * shipped meter core (`MeterBar` + its threshold colors in renderers/shared)
 * with the ScoreMapDetail grouped-row layout: mono 11px ellipsized label,
 * right-aligned value, full-width bar underneath. No second meter
 * implementation exists — this is a layout wrapper over the shared core.
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
  return (
    <div style={rowStyle}>
      <span style={nameStyle} title={label}>
        {label ?? ""}
      </span>
      <span style={valStyle}>
        {value === null || !Number.isFinite(value) ? "—" : format(value)}
      </span>
      <div style={{ gridColumn: "1 / 3" }}>
        <MeterBar value={bounded} />
      </div>
    </div>
  );
}
