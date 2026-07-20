/**
 * Histogram atom — dependency-free inline SVG, generalized from the
 * FrontierScatter idiom: fixed viewBox + PAD insets, width="100%" with a
 * maxWidth cap, role="img" + aria-label + <title>, gridlines on
 * var(--border-muted), 9px var(--fg-muted) labels, every color a CSS var so
 * theming just works. Single-series magnitude → one hue (var(--accent)).
 *
 * Self-hides (returns null) when no finite values exist, so an empty
 * distribution never renders NaN axes.
 */

const PAD = { top: 12, right: 16, bottom: 24, left: 40 };

export interface HistogramProps {
  values: readonly number[];
  /** Bin count (default 10). */
  bins?: number;
  width?: number;
  height?: number;
  /** Accessible name + tooltip caption (default "Histogram"). */
  label?: string;
  /** Formats bin-edge values (x-axis + per-bar tooltips). */
  formatValue?: (v: number) => string;
}

const defaultFormat = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

export function Histogram({
  values,
  bins = 10,
  width = 460,
  height = 160,
  label = "Histogram",
  formatValue = defaultFormat,
}: HistogramProps) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;

  const binCount = Math.max(1, Math.floor(bins));
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;

  const counts = new Array<number>(binCount).fill(0);
  for (const v of finite) {
    const idx = Math.min(binCount - 1, Math.floor(((v - min) / span) * binCount));
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const maxCount = Math.max(...counts);

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const barW = plotW / binCount;
  const yFor = (count: number) => PAD.top + (1 - count / maxCount) * plotH;

  // Integer count ticks: baseline, midpoint, max (deduped for tiny maxima).
  const yTicks = [...new Set([0, Math.round(maxCount / 2), maxCount])];

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      style={{ maxWidth: width, fontFamily: "var(--font-mono)" }}
    >
      <title>
        {label} — distribution of {finite.length} values
      </title>

      {/* count gridlines + labels */}
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={yFor(t)}
            y2={yFor(t)}
            stroke="var(--border-muted)"
            strokeWidth={1}
          />
          <text
            x={PAD.left - 6}
            y={yFor(t) + 3}
            textAnchor="end"
            fontSize={9}
            fill="var(--fg-muted)"
          >
            {t}
          </text>
        </g>
      ))}

      {/* bars — 2px surface gap between neighbors, per-bar tooltip */}
      {counts.map((count, i) => {
        if (count === 0) return null;
        const lo = min + (span * i) / binCount;
        const hi = min + (span * (i + 1)) / binCount;
        const y = yFor(count);
        return (
          <rect
            key={lo}
            x={PAD.left + i * barW + 1}
            y={y}
            width={Math.max(1, barW - 2)}
            height={PAD.top + plotH - y}
            fill="var(--accent)"
          >
            <title>
              {formatValue(lo)}–{formatValue(hi)} · n={count}
            </title>
          </rect>
        );
      })}

      {/* x-axis domain labels */}
      <text x={PAD.left} y={height - 6} fontSize={9} fill="var(--fg-muted)">
        {formatValue(min)}
      </text>
      <text
        x={width - PAD.right}
        y={height - 6}
        textAnchor="end"
        fontSize={9}
        fill="var(--fg-muted)"
      >
        {formatValue(max)}
      </text>
    </svg>
  );
}
