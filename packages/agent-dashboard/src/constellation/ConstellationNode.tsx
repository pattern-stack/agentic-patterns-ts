/**
 * The four constellation node kinds, rendered as one component and registered
 * for every React-Flow node type. Small circular discs, per-step lighting
 * (active = accent + pulse ring), just-in-time tool reveal
 * (hidden→emerging→shown→settled), blast-radius corner dots, the consent veil on
 * gated tools, and the result chip that springs in while a tool runs. Every
 * colour is a `var(--*)` / `T` reference, so the graph re-tones across themes.
 */
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Bot, Check, Hammer, Lock, Sparkles, Toolbox, X } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { BLAST_COLOR } from '../graph/catalog';
import {
  type ConstNodeData,
  type ConstNodeKind,
  DISC,
  type RunState,
  type ToolReveal,
} from '../graph/constellation-model';
import { T } from '../ui/tokens';

const GLYPH: Record<ConstNodeKind, typeof Bot> = {
  agent: Bot,
  capability: Toolbox,
  tool: Hammer,
  subagent: Sparkles,
};

const BLAST_DOT = 8;
const MEDALLION = 15;
const LABEL_GAP = 6;

interface Tone {
  border: string;
  bg: string;
  ring: string;
  ink: string;
}

function stateTone(state: RunState, active: boolean): Tone {
  if (state === 'error')
    return {
      border: T.tone.err.color,
      bg: T.tone.err.soft,
      ring: 'transparent',
      ink: T.tone.err.ink,
    };
  if (active || state === 'running')
    return {
      border: 'hsl(var(--accent))',
      bg: 'var(--accent-soft)',
      ring: 'color-mix(in oklch, hsl(var(--accent)) 42%, transparent)',
      ink: 'var(--accent-ink)',
    };
  if (state === 'complete')
    return {
      border: T.tone.ok.color,
      bg: 'var(--paper)',
      ring: 'transparent',
      ink: 'var(--ink-2)',
    };
  return { border: 'var(--line)', bg: 'var(--fill)', ring: 'transparent', ink: 'var(--ink-2)' };
}

function nodeOpacity(kind: ConstNodeKind, state: RunState, reveal: ToolReveal | undefined): number {
  if (kind === 'tool') {
    return { hidden: 0, emerging: 0.6, shown: 1, settled: 0.82, gated: 0.4 }[reveal ?? 'hidden'];
  }
  if (kind === 'agent') return 1; // the anchor is always fully present
  return state === 'pending' ? 0.72 : 1;
}

function nodeScale(kind: ConstNodeKind, reveal: ToolReveal | undefined): number {
  if (kind !== 'tool') return 1;
  return { hidden: 0.3, emerging: 0.85, shown: 1, settled: 0.8, gated: 0.82 }[reveal ?? 'hidden'];
}

function Medallion({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: MEDALLION,
        height: MEDALLION,
        borderRadius: '999px',
        background: 'var(--paper)',
        border: `1.5px solid ${color}`,
        color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </span>
  );
}

export function ConstellationNode(props: NodeProps) {
  const d = props.data as ConstNodeData;
  const size = DISC[d.kind];
  const state: RunState = d.state ?? 'pending';
  const reveal: ToolReveal | undefined =
    d.kind === 'tool' ? (d.reveal ?? (d.gated ? 'gated' : 'hidden')) : undefined;
  const active = !!d.active;
  const tone = stateTone(state, active);
  const Icon = GLYPH[d.kind];
  const dashed = d.kind === 'subagent';
  const hidden = d.kind === 'tool' && reveal === 'hidden';

  return (
    <div
      className="const-tool-wrap"
      style={{
        position: 'relative',
        width: size,
        height: size,
        opacity: nodeOpacity(d.kind, state, reveal),
        transform: `scale(${nodeScale(d.kind, reveal)})`,
        pointerEvents: hidden ? 'none' : 'auto',
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />

      <div
        className={active ? 'const-disc const-disc--active' : 'const-disc'}
        style={
          {
            width: size,
            height: size,
            borderRadius: '999px',
            border: `${d.kind === 'agent' ? 2 : 1.5}px ${dashed ? 'dashed' : 'solid'} ${tone.border}`,
            background: tone.bg,
            color: tone.ink,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: active ? T.shadow.s2 : state === 'complete' ? T.shadow.s1 : 'none',
            // consumed by the constPulseRing keyframe (constellation.css)
            '--const-ring': tone.ring,
          } as CSSProperties
        }
      >
        <Icon size={Math.round(size * 0.36)} strokeWidth={1.75} aria-hidden />
      </div>

      {/* blast-radius corner dot (capability + tool) */}
      {d.blast && (d.kind === 'capability' || d.kind === 'tool') && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 1,
            right: 1,
            width: BLAST_DOT,
            height: BLAST_DOT,
            borderRadius: '999px',
            background: BLAST_COLOR[d.blast],
            border: '1.5px solid var(--paper)',
          }}
        />
      )}

      {state === 'complete' && (
        <Medallion color={T.tone.ok.color}>
          <Check size={9} strokeWidth={3} aria-hidden />
        </Medallion>
      )}
      {state === 'error' && (
        <Medallion color={T.tone.err.color}>
          <X size={9} strokeWidth={3} aria-hidden />
        </Medallion>
      )}

      {/* consent veil — gated tools wear the lock and never fire */}
      {d.gated && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '999px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'color-mix(in oklch, var(--paper) 55%, transparent)',
            color: 'var(--mute)',
          }}
        >
          <Lock size={14} aria-hidden />
        </span>
      )}

      {/* label below the disc (out of flow so it doesn't shift edge anchors) */}
      <div
        style={{
          position: 'absolute',
          top: `calc(100% + ${LABEL_GAP}px)`,
          left: '50%',
          transform: 'translateX(-50%)',
          textAlign: 'center',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        <div
          title={d.label}
          style={{
            fontSize: T.fz.tiny,
            fontWeight: 600,
            color: 'var(--ink)',
            fontFamily: d.kind === 'tool' ? T.font.mono : T.font.sans,
            maxWidth: d.kind === 'tool' ? 92 : 120,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {d.label}
        </div>
        {d.sub && (
          <div style={{ fontSize: T.fz.micro, color: 'var(--mute)', marginTop: 1 }}>{d.sub}</div>
        )}
      </div>

      {/* result chip — the first line of a tool's output, only while it runs */}
      {d.kind === 'tool' && active && d.resultChip && (
        <span
          className="const-chip"
          style={{
            position: 'absolute',
            left: `calc(100% + ${LABEL_GAP}px)`,
            top: '50%',
            transform: 'translateY(-50%)',
            whiteSpace: 'nowrap',
            fontFamily: T.font.mono,
            fontSize: T.fz.micro,
            color: 'var(--ink-2)',
            background: 'var(--paper)',
            border: '1px solid var(--line)',
            borderRadius: T.radius.sm,
            padding: '2px 7px',
            boxShadow: T.shadow.s1,
            maxWidth: 120,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {d.resultChip}
        </span>
      )}
    </div>
  );
}
