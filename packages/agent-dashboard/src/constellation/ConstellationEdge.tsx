/**
 * The constellation edge. EVERY edge is a short STRAIGHT line drawn border-to-
 * border between the two disc centres (a "floating" edge via useInternalNode) —
 * so connectors read as sitting ON the radius between nodes, no weird looping,
 * whether it's a radial spoke (agent→capability tether, capability/agent→tool)
 * or the horizontal hand-off chain (agent→agent). Per-kind differences are
 * styling only: tethers rest faint, tool spokes hide until revealed, hand-offs
 * carry an arrow + an energy particle. Active edges wear marching ants; complete
 * ones settle to the ok tone. All colours are tokens (re-tone per theme).
 */
import { BaseEdge, type EdgeProps, getStraightPath, useInternalNode } from '@xyflow/react';
import type { ConstEdgeData } from '../graph/constellation-model';
import { T } from '../ui/tokens';

function nodeCentre(n: ReturnType<typeof useInternalNode>): { x: number; y: number; r: number } | null {
  if (!n) return null;
  const p = n.internals.positionAbsolute;
  const w = n.measured?.width ?? 46;
  const h = n.measured?.height ?? 46;
  return { x: p.x + w / 2, y: p.y + h / 2, r: Math.min(w, h) / 2 };
}

export function ConstellationEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, markerEnd } = props;
  const data = (props.data ?? {}) as ConstEdgeData;
  const kind = data.kind ?? 'tether';
  const active = !!data.active;
  const complete = !!data.complete;
  const emerging = !!data.emerging;

  // hooks must run unconditionally
  const sourceNode = useInternalNode(props.source);
  const targetNode = useInternalNode(props.target);

  // ── the universal straight path: border-to-border between the disc centres.
  // Falls back to the handle coords for the first frame before nodes measure. ──
  let sx = sourceX;
  let sy = sourceY;
  let tx = targetX;
  let ty = targetY;
  const s = nodeCentre(sourceNode);
  const t = nodeCentre(targetNode);
  if (s && t) {
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    sx = s.x + ux * s.r;
    sy = s.y + uy * s.r;
    tx = t.x - ux * t.r;
    ty = t.y - uy * t.r;
  }
  const [path] = getStraightPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty });

  const stroke = active
    ? 'var(--accent)'
    : complete
      ? T.tone.ok.color
      : emerging
        ? 'color-mix(in oklch, var(--accent) 50%, var(--line))'
        : 'var(--line)';
  const strokeWidth = active ? 2 : 1.25;
  const resting = !active && !complete && !emerging;
  // dashes: active = marching ants; tool spokes + emerging wires are dotted; the
  // hand-off chain + resting tethers are solid.
  const strokeDasharray = active ? '4 4' : kind === 'tool' || emerging ? '2 5' : undefined;
  // opacity: tool spokes stay hidden until their tool reveals; tethers rest faint;
  // hand-offs are always present.
  const opacity = kind === 'tool' && resting ? 0 : emerging ? 0.5 : kind === 'tether' && resting ? 0.7 : 1;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={kind === 'handoff' ? markerEnd : undefined}
        className={active ? 'const-edge--active' : undefined}
        style={{
          stroke,
          strokeWidth,
          strokeDasharray,
          opacity,
          transition: 'stroke var(--motion-mid) var(--ease-out), opacity var(--motion-mid) var(--ease-out)',
        }}
      />
      {/* the "data flows" particle — only on an active hand-off (the chain step) */}
      {active && kind === 'handoff' && (
        <circle r={3} fill="var(--accent)">
          <animateMotion dur="1s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  );
}
