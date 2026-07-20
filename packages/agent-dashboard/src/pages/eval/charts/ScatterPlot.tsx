/**
 * ScatterPlot atom — the FrontierScatter idiom generalized to arbitrary x/y
 * points. Same conventions: fixed viewBox + PAD insets, width="100%" with a
 * maxWidth cap, role="img" + aria-label + <title>, gridlines on
 * var(--border-muted), 9px var(--fg-muted) labels, per-mark <title> tooltips,
 * colors via CSS vars only.
 *
 * Emphasis is double-encoded for CVD safety (shape AND color): emphasized
 * points are filled ● in var(--accent); when any point is emphasized, the
 * rest render as ✕ crosses in var(--fg-muted). With no emphasis anywhere,
 * all points are plain filled dots.
 *
 * Self-hides (returns null) when no finite points exist.
 */

// top inset clears the y-axis caption, which draws ABOVE the plot (at y=12)
// so it can never collide with the topmost tick label.
const PAD = { top: 28, right: 16, bottom: 34, left: 44 };

export interface ScatterPoint {
  x: number;
  y: number;
  label?: string;
  emphasis?: boolean;
}

export interface ScatterPlotProps {
  points: readonly ScatterPoint[];
  xLabel: string;
  yLabel: string;
  width?: number;
  height?: number;
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
}

const defaultFormat = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

const Y_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

export function ScatterPlot({
  points,
  xLabel,
  yLabel,
  width = 460,
  height = 240,
  formatX = defaultFormat,
  formatY = defaultFormat,
}: ScatterPlotProps) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length === 0) return null;

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // Scale spans are forced to 1 on degenerate (all-equal) domains so marks
  // still plot — but LABELS always show real data values (never minX + 1).
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const sx = (v: number) => PAD.left + ((v - minX) / spanX) * plotW;
  const sy = (v: number) => PAD.top + (1 - (v - minY) / spanY) * plotH;

  const someEmphasis = pts.some((p) => p.emphasis === true);

  // Stable unique keys without leaning on the array index.
  const seen = new Map<string, number>();
  const keyFor = (p: ScatterPoint): string => {
    const base = p.label ?? `${p.x},${p.y}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  };

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${yLabel} versus ${xLabel} scatter`}
      style={{ maxWidth: width, fontFamily: "var(--font-mono)" }}
    >
      <title>
        {yLabel} vs {xLabel}
      </title>

      {/* y grid + labels */}
      {Y_TICK_FRACTIONS.map((f) => {
        // Position by fraction (stable even on degenerate domains); label with
        // the REAL data value at that fraction — never minY + f * forcedSpan.
        const yPos = PAD.top + (1 - f) * plotH;
        const v = minY + f * (maxY - minY);
        // Degenerate all-equal-y domain: keep the gridlines, label only f=0
        // (every tick would repeat the same value).
        const labelled = maxY !== minY || f === 0;
        return (
          <g key={f}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={yPos}
              y2={yPos}
              stroke="var(--border-muted)"
              strokeWidth={1}
            />
            {labelled ? (
              <text
                x={PAD.left - 6}
                y={yPos + 3}
                textAnchor="end"
                fontSize={9}
                fill="var(--fg-muted)"
              >
                {formatY(v)}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* axis captions */}
      <text x={PAD.left} y={height - 8} fontSize={9} fill="var(--fg-muted)">
        {xLabel} →
      </text>
      <text x={4} y={12} fontSize={9} fill="var(--fg-muted)">
        {yLabel} ↑
      </text>

      {/* x domain labels */}
      <text x={PAD.left} y={height - 20} fontSize={9} fill="var(--fg-muted)">
        {formatX(minX)}
      </text>
      <text
        x={width - PAD.right}
        y={height - 20}
        textAnchor="end"
        fontSize={9}
        fill="var(--fg-muted)"
      >
        {formatX(maxX)}
      </text>

      {/* marks: ● filled accent when emphasized, ✕ muted cross otherwise */}
      {pts.map((p) => {
        const cx = sx(p.x);
        const cy = sy(p.y);
        const key = keyFor(p);
        const tip = `${p.label ? `${p.label} · ` : ""}${xLabel} ${formatX(p.x)} · ${yLabel} ${formatY(p.y)}`;
        if (someEmphasis && p.emphasis !== true) {
          return (
            <g key={key} stroke="var(--fg-muted)" strokeWidth={1.5}>
              <title>{tip}</title>
              <line x1={cx - 4} y1={cy - 4} x2={cx + 4} y2={cy + 4} />
              <line x1={cx - 4} y1={cy + 4} x2={cx + 4} y2={cy - 4} />
            </g>
          );
        }
        return (
          <circle
            key={key}
            cx={cx}
            cy={cy}
            r={p.emphasis ? 5 : 4}
            fill="var(--accent)"
            stroke="var(--accent)"
            strokeWidth={p.emphasis ? 2 : 1}
          >
            <title>{tip}</title>
          </circle>
        );
      })}
    </svg>
  );
}
