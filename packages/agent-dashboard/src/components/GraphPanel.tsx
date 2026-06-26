/**
 * GraphPanel — the constellation surface (the swe-brain Agent Plane, ported).
 * Mode-agnostic per ADR 0005: takes a `GraphSource` (chain = execution view,
 * composition = capability view), builds the shared `Constellation`, and — for
 * the chain projection — folds the event stream into TraceStep[] and overlays
 * the run as node pulses via useRunReplay. Drives REPLAY (persisted, scrubber),
 * LIVE (events streaming in), and the static composition view (no steps).
 */
import { useEffect, useMemo, useState } from 'react';
import { ConstellationGraph } from '../constellation/ConstellationGraph';
import { RunBarHud } from '../constellation/RunBarHud';
import { type GraphSource, buildGraph, buildToolIndex } from '../graph/composition';
import type { ConstNode } from '../graph/constellation-model';
import { eventsToSteps } from '../graph/trace-from-events';
import { useRunReplay } from '../graph/use-run-replay';
import { T } from '../ui/tokens';
import { Badge, Button } from '../ui/atoms';

const TOOL_INDEX = buildToolIndex();
const NO_STEPS: never[] = [];

export function GraphPanel({
  source,
  runKey,
  live = false,
  terminal = true,
  minZoom,
  fitPadding,
}: {
  source: GraphSource;
  runKey: string;
  live?: boolean;
  terminal?: boolean;
  /** Forwarded to the canvas — a narrow embed passes a smaller minZoom so a full
   *  chain fits instead of overflowing. Omit for the default eval-view framing. */
  minZoom?: number;
  fitPadding?: number;
}) {
  // chain-projection inputs (only present in chain mode); used for memo keys.
  const eventCount = source.mode === 'chain' ? source.events.length : 0;
  const graph = useMemo(
    () => buildGraph(source),
    // Keyed on (runKey, mode, eventCount): a growing live stream (eventCount)
    // reveals nodes. arm/toolDefs are NOT keys — that's correct ONLY because both
    // are stable per runKey (arm derives from run.mode; toolDefs are fixed for the
    // run / empty for the live session). A new run → new runKey → rebuild.
    // biome-ignore lint/correctness/useExhaustiveDependencies: source is rebuilt each render; key on its stable signature.
    [runKey, source.mode, eventCount],
  );
  const steps = useMemo(
    () => (source.mode === 'chain' ? eventsToSteps(source.events, TOOL_INDEX, { terminal }) : NO_STEPS),
    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on event count + terminal intentionally.
    [source.mode, eventCount, terminal],
  );
  const replay = useRunReplay(steps, graph, runKey);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // live: advance the cursor to the freshest step as events stream in.
  // biome-ignore lint: keyed on step count intentionally.
  useEffect(() => {
    if (live && steps.length > 0) replay.seek(steps.length - 1);
  }, [live, steps.length, replay.seek]);

  const selectedNode = selectedNodeId ? graph.nodes.find((n) => n.id === selectedNodeId) ?? null : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 420 }}>
      <div style={{ flex: 1, position: 'relative', minHeight: 320, border: '1px solid var(--line)', borderRadius: T.radius.lg, overflow: 'hidden', background: 'var(--background)' }}>
        <RunBarHud hud={replay.frame.hud} />
        <ConstellationGraph
          graph={graph}
          frame={replay.frame}
          selectedNodeId={selectedNodeId}
          onNodeClick={(id) => setSelectedNodeId((cur) => (cur === id ? null : id))}
          minZoom={minZoom}
          fitPadding={fitPadding}
        />
        {selectedNode && (
          <NodeInspector node={selectedNode} onClose={() => setSelectedNodeId(null)} />
        )}
      </div>
      {!live && <Scrubber replay={replay} count={steps.length} />}
    </div>
  );
}

function Scrubber({ replay, count }: { replay: ReturnType<typeof useRunReplay>; count: number }) {
  if (count === 0) return <div style={{ marginTop: 8, fontSize: T.fz.tiny, color: 'var(--mute)' }}>no trace steps to scrub</div>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
      <Button variant="default" onClick={replay.playing ? replay.pause : replay.play}>
        {replay.playing ? '⏸ Pause' : '▶ Play'}
      </Button>
      <Button variant="ghost" onClick={replay.reset}>
        ↺ Reset
      </Button>
      <input
        type="range"
        min={-1}
        max={count - 1}
        value={replay.cursor}
        onChange={(e) => replay.seek(Number(e.target.value))}
        style={{ flex: 1, accentColor: 'var(--accent)' }}
      />
      <span style={{ fontFamily: T.font.mono, fontSize: T.fz.micro, color: 'var(--ink-2)', minWidth: 72, textAlign: 'right' }}>
        {replay.cursor < 0 ? 'idle' : `${replay.cursor + 1} / ${count}`}
      </span>
    </div>
  );
}

function NodeInspector({ node, onClose }: { node: ConstNode; onClose: () => void }) {
  const d = node.data;
  return (
    <div
      style={{
        position: 'absolute',
        top: 'var(--space-3)',
        right: 'var(--space-3)',
        width: 240,
        background: 'var(--paper)',
        border: '1px solid var(--line)',
        borderRadius: T.radius.lg,
        boxShadow: T.shadow.s2,
        padding: '12px 14px',
        zIndex: 5,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Badge tone="accent">{d.kind}</Badge>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--mute)', cursor: 'pointer', fontSize: 16 }}>
          ×
        </button>
      </div>
      <div style={{ fontWeight: 700, fontSize: T.fz.lg, marginBottom: 4, fontFamily: d.kind === 'tool' ? T.font.mono : T.font.sans }}>{d.label}</div>
      {d.agentLabel && <div style={{ fontSize: T.fz.small, color: 'var(--mute)' }}>tool of · {d.agentLabel}</div>}
      {d.capabilityName && <div style={{ fontSize: T.fz.small, color: 'var(--mute)' }}>capability · {d.capabilityName}</div>}
      {d.blast && <div style={{ fontSize: T.fz.small, color: 'var(--mute)' }}>blast · {d.blast}</div>}
      {d.sub && <div style={{ fontSize: T.fz.small, color: 'var(--mute)' }}>{d.sub}</div>}
      {d.resultChip && <div style={{ marginTop: 8, fontFamily: T.font.mono, fontSize: T.fz.micro, color: 'var(--ink-2)' }}>{d.resultChip}</div>}
    </div>
  );
}
