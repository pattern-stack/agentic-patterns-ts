/**
 * Curation Pareto-frontier scatter — survival (y, quarter-floored data min..1)
 * vs outbound tokens (x), "upper-left wins". On-frontier configs are filled dots joined by a
 * dashed step-line; dominated configs are hollow. Inline SVG (no chart dep),
 * theme-aware via CSS vars.
 *
 * Slice-8 extensions (additive — existing consumers pass `points` only and
 * render identically): frontier step-line + a hover tooltip (a rendered
 * in-SVG readout; the native `<title>` tooltips remain as fallback).
 * Declared-wins frontier flagging is NOT this chart's job — flags arrive on
 * `points`, pre-computed by `curationFrontierDeclared` (lib/evalAggregates),
 * the one home of that rule.
 */

import { useState } from "react";
import type { FrontierPoint } from "../../../lib/evalAggregates";

const W = 460;
const H = 240;
// top inset clears the y-axis caption, which draws ABOVE the plot (at y=12)
// so it can never collide with the topmost tick label.
const PAD = { top: 28, right: 16, bottom: 34, left: 44 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

const TIP_W = 190;
const TIP_H = 32;

interface Scale {
  x: (v: number) => number;
  y: (v: number) => number;
  minTok: number;
  maxTok: number;
  // Lowest survival shown — floored to a quarter boundary below the data's
  // minimum so tight high-survival clusters aren't crammed into a top sliver.
  yLo: number;
  yTicks: number[];
}

function makeScale(points: readonly FrontierPoint[]): Scale {
  const tokens = points.map((p) => p.tokens);
  const maxTok = Math.max(1, ...tokens);
  const minTok = Math.min(...tokens, 0);
  const span = maxTok - minTok || 1;
  const minSurvival = Math.min(...points.map((p) => Math.max(0, Math.min(1, p.survival))));
  const yLo = Math.min(0.75, Math.floor(minSurvival / 0.25) * 0.25);
  const ySpan = 1 - yLo;
  const step = ySpan <= 0.25 ? 0.05 : ySpan <= 0.5 ? 0.1 : 0.25;
  const yTicks: number[] = [];
  for (let t = yLo; t < 1 - 1e-9; t += step) yTicks.push(Number(t.toFixed(2)));
  yTicks.push(1);
  return {
    x: (v) => PAD.left + ((v - minTok) / span) * plotW,
    // survival is a rate; y inverts (1 at top), spanning [yLo, 1].
    y: (v) => PAD.top + ((1 - Math.max(yLo, Math.min(1, v))) / ySpan) * plotH,
    minTok,
    maxTok,
    yLo,
    yTicks,
  };
}

export interface FrontierScatterProps {
  points: FrontierPoint[];
}

export function FrontierScatter({ points }: FrontierScatterProps) {
  const [hover, setHover] = useState<FrontierPoint | null>(null);
  if (points.length === 0) return null;

  const pts = points;
  const scale = makeScale(pts);

  // The frontier polyline: on-frontier points, left→right by tokens, drawn as a
  // step (horizontal then vertical) to read as a dominance boundary.
  const front = pts.filter((p) => p.onFrontier).sort((a, b) => a.tokens - b.tokens);
  const stepPath = front.reduce((acc, p, i) => {
    const x = scale.x(p.tokens);
    const y = scale.y(p.survival);
    const prev = front[i - 1];
    if (i === 0 || !prev) return `M ${x} ${y}`;
    const py = scale.y(prev.survival);
    return `${acc} L ${x} ${py} L ${x} ${y}`;
  }, "");

  // Hover tooltip placement: beside the point, clamped into the plot; flips
  // below when there is no room above.
  const tip = hover
    ? (() => {
        const px = scale.x(hover.tokens);
        const py = scale.y(hover.survival);
        const tx = Math.min(Math.max(px + 8, PAD.left), W - PAD.right - TIP_W);
        const ty = py - TIP_H - 8 >= 2 ? py - TIP_H - 8 : py + 10;
        return { tx, ty };
      })()
    : null;

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
      {scale.yTicks.map((t) => (
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
      <text x={4} y={12} fontSize={9} fill="var(--fg-muted)">
        survival ↑
      </text>

      {/* x domain labels */}
      <text x={PAD.left} y={H - 20} fontSize={9} fill="var(--fg-muted)">
        {Math.round(scale.minTok)}
      </text>
      <text x={W - PAD.right} y={H - 20} textAnchor="end" fontSize={9} fill="var(--fg-muted)">
        {Math.round(scale.maxTok)}
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
      {pts.map((p) => {
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
            onMouseEnter={() => setHover(p)}
            onMouseLeave={() => setHover(null)}
          >
            <title>
              {p.configId} · survival {(p.survival * 100).toFixed(0)}% · {Math.round(p.tokens)} tok
              · {p.onFrontier ? "on frontier" : "dominated"} · n={p.n}
            </title>
          </circle>
        );
      })}

      {/* hover tooltip (rendered last so it paints above the points) */}
      {hover && tip && (
        <g data-testid="frontier-tooltip" pointerEvents="none">
          <rect
            x={tip.tx}
            y={tip.ty}
            width={TIP_W}
            height={TIP_H}
            rx={4}
            fill="var(--bg-surface)"
            stroke="var(--border)"
            strokeWidth={1}
          />
          <text x={tip.tx + 8} y={tip.ty + 13} fontSize={9} fill="var(--fg-default)">
            {/* ellipsize: SVG text does not clip to the rect; the native
                <title> on the point still carries the full id. */}
            {hover.configId.length > 22 ? `${hover.configId.slice(0, 21)}…` : hover.configId} ·{" "}
            {hover.onFrontier ? "on frontier" : "dominated"}
          </text>
          <text x={tip.tx + 8} y={tip.ty + 25} fontSize={9} fill="var(--fg-muted)">
            survival {(hover.survival * 100).toFixed(0)}% · {Math.round(hover.tokens)} tok · n=
            {hover.n}
          </text>
        </g>
      )}
    </svg>
  );
}
