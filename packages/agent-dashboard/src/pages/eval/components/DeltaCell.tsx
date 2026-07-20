/**
 * DeltaCell — a signed delta for table cells, generalizing the
 * EvalComparePage deltaBadge color semantics to numeric deltas: improvement
 * green, regression red, ~0 and unknown muted. Direction is double-encoded
 * (▲/▼ glyph + color) so it stays legible without color. `higherIsBetter`
 * (default true) flips which direction counts as an improvement.
 */

export interface DeltaCellProps {
  value: number | null;
  /** Formats the signed value (default `+x.xx` / `-x.xx`). */
  formatValue?: (v: number) => string;
  /** Whether a positive delta is an improvement (default true). */
  higherIsBetter?: boolean;
  /** |value| at or below this renders as neutral "no change" (default 1e-9). */
  epsilon?: number;
}

const baseStyle = { fontFamily: "var(--font-mono)", fontSize: 11 };
const defaultFormat = (v: number): string => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;

export function DeltaCell({
  value,
  formatValue = defaultFormat,
  higherIsBetter = true,
  epsilon = 1e-9,
}: DeltaCellProps) {
  if (value === null || !Number.isFinite(value)) {
    return <span style={{ ...baseStyle, color: "var(--fg-muted)" }}>—</span>;
  }
  if (Math.abs(value) <= epsilon) {
    return (
      <span style={{ ...baseStyle, color: "var(--fg-muted)" }} title="no change">
        {formatValue(0)}
      </span>
    );
  }
  const up = value > 0;
  const improvement = up === higherIsBetter;
  return (
    <span
      style={{ ...baseStyle, color: improvement ? "var(--green)" : "var(--red)" }}
      title={improvement ? "improvement" : "regression"}
    >
      {`${up ? "▲" : "▼"} ${formatValue(value)}`}
    </span>
  );
}
