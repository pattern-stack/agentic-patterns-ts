/**
 * Curation Pareto-frontier scatter — survival (y, 0..1) vs outbound tokens
 * (x), "upper-left wins". On-frontier configs are filled dots joined by a
 * dashed step-line; dominated configs are hollow. Inline SVG (no chart dep),
 * theme-aware via CSS vars.
 */

import type { FrontierPoint } from "../../../lib/evalAggregates";

const W = 460;
const H = 240;
const PAD = { top: 16, right: 16, bottom: 34, left: 44 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

interface Scale {
  x: (v: number) => number;
  y: (v: number) => number;
}

function makeScale(points: FrontierPoint[]): Scale {
  const tokens = points.map((p) => p.tokens);
  const maxTok = Math.max(1, ...tokens);
  const minTok = Math.min(...tokens, 0);
  const span = maxTok - minTok || 1;
  return {
    x: (v) => PAD.left + ((v - minTok) / span) * plotW,
    // survival is a rate 0..1; y inverts (1 at top).
    y: (v) => PAD.top + (1 - Math.max(0, Math.min(1, v))) * plotH,
  };
}

export function FrontierScatter({ points }: { points: FrontierPoint[] }) {
  if (points.length === 0) return null;
  const scale = makeScale(points);

  // The frontier polyline: on-frontier points, left→right by tokens, drawn as a
  // step (horizontal then vertical) to read as a dominance boundary.
  const front = points.filter((p) => p.onFrontier).sort((a, b) => a.tokens - b.tokens);
  const stepPath = front.reduce((acc, p, i) => {
    const x = scale.x(p.tokens);
    const y = scale.y(p.survival);
    const prev = front[i - 1];
    if (i === 0 || !prev) return `M ${x} ${y}`;
    const py = scale.y(prev.survival);
    return `${acc} L ${x} ${py} L ${x} ${y}`;
  }, "");

  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Curation frontier: gold-fact survival versus outbound tokens"
      style={{ maxWidth: W, fontFamily: "var(--font-mono)" }}
    >
      <title>Curation frontier — survival vs outbound tokens (upper-left wins)</title>

      {/* y grid + labels */}
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={scale.y(t)}
            y2={scale.y(t)}
            stroke="var(--border-muted)"
            strokeWidth={1}
          />
          <text
            x={PAD.left - 6}
            y={scale.y(t) + 3}
            textAnchor="end"
            fontSize={9}
            fill="var(--fg-muted)"
          >
            {t.toFixed(2)}
          </text>
        </g>
      ))}

      {/* axis captions */}
      <text x={PAD.left} y={H - 8} fontSize={9} fill="var(--fg-muted)">
        outbound tokens →
      </text>
      <text x={4} y={PAD.top + 4} fontSize={9} fill="var(--fg-muted)">
        survival ↑
      </text>

      {/* frontier step-line */}
      {front.length > 1 && (
        <path
          d={stepPath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      )}

      {/* points: filled ring on frontier, hollow when dominated */}
      {points.map((p) => {
        const cx = scale.x(p.tokens);
        const cy = scale.y(p.survival);
        return (
          <circle
            key={p.configId}
            cx={cx}
            cy={cy}
            r={p.onFrontier ? 5 : 4}
            fill={p.onFrontier ? "var(--accent)" : "transparent"}
            stroke={p.onFrontier ? "var(--accent)" : "var(--fg-muted)"}
            strokeWidth={p.onFrontier ? 2 : 1.5}
          >
            <title>
              {p.configId} · survival {(p.survival * 100).toFixed(0)}% · {Math.round(p.tokens)} tok
              · {p.onFrontier ? "on frontier" : "dominated"} · n={p.n}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}
