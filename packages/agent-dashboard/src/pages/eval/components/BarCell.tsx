/**
 * BarCell — a bounded-magnitude bar + text for table cells. Unlike MeterCell
 * (score semantics, threshold green/yellow/red), BarCell is a plain magnitude
 * readout in a single hue (var(--accent) by default) — use it for tokens,
 * counts, costs. Null/non-finite values render an empty track + "—".
 */

export interface BarCellProps {
  value: number | null;
  /** Upper bound the bar is normalized against (default 1). */
  max?: number;
  /** Track width in px (default 72 — sized for table cells). */
  width?: number;
  /** Bar fill (default var(--accent)). */
  color?: string;
  /** Formats the raw value text. */
  format?: (v: number) => string;
}

const defaultFormat = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

export function BarCell({
  value,
  max = 1,
  width = 72,
  color = "var(--accent)",
  format = defaultFormat,
}: BarCellProps) {
  const bounded =
    value === null || !Number.isFinite(value) || max <= 0
      ? null
      : Math.max(0, Math.min(1, value / max));
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          position: "relative",
          width,
          height: 6,
          borderRadius: 3,
          background: "var(--bg-surface-hover)",
          overflow: "hidden",
          flex: "none",
        }}
      >
        {bounded !== null && (
          <span
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${bounded * 100}%`,
              background: color,
            }}
          />
        )}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
        {value === null || !Number.isFinite(value) ? "—" : format(value)}
      </span>
    </span>
  );
}
