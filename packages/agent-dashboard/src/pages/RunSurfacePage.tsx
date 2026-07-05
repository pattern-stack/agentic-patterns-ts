/**
 * RunSurfacePage — the integrated Live Run surface.
 *
 * Owns the replay engine and composes the pieces around it: the constellation
 * canvas (with the HUD overlay + the node inspector) on the left, the
 * LiveTracePanel scrubber on the right, and a Play/Reset transport up top. The
 * trace panel and the graph share ONE `useRunReplay` cursor — clicking a trace
 * row seeks the constellation, and Play walks both in lockstep.
 *
 * Phase 1 (this slice + the mode toggle): driven by the deterministic
 * `SAMPLE_EVENTS` so the whole surface is browser-verifiable without a live
 * model. The Chain ⇄ Composition toggle swaps the GRAPH (executed chain vs. the
 * full declared surface) while the SAME trace overlays both. Slice 6 adds the
 * live path: an agent picker + SSE streaming into the same replay.
 */
import { useMemo, useState } from "react";
import { ConstellationGraph } from "../constellation/ConstellationGraph";
import { LiveTracePanel } from "../constellation/LiveTracePanel";
import { NodeInspector, type RunMeta } from "../constellation/NodeInspector";
import { RunBarHud } from "../constellation/RunBarHud";
import { type GraphSource, buildGraph, buildToolIndex } from "../graph/composition";
import {
  SAMPLE_ANSWER,
  SAMPLE_CAPABILITIES,
  SAMPLE_EVENTS,
  SAMPLE_REQUEST,
  SAMPLE_SYSTEM_PROMPT,
} from "../graph/sample-run-trace";
import { eventsToSteps } from "../graph/trace-from-events";
import { useRunReplay } from "../graph/use-run-replay";
import { Button } from "../ui/atoms";
import { T } from "../ui/tokens";

const TOOL_INDEX = buildToolIndex();
const RUN_META: RunMeta = {
  request: SAMPLE_REQUEST,
  answer: SAMPLE_ANSWER,
  systemPrompt: SAMPLE_SYSTEM_PROMPT,
};

type GraphMode = "chain" | "composition";
const MODES: { value: GraphMode; label: string }[] = [
  { value: "chain", label: "Chain" },
  { value: "composition", label: "Composition" },
];

function ModeToggle({ mode, onChange }: { mode: GraphMode; onChange: (m: GraphMode) => void }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 3,
        background: "var(--fill)",
        padding: 3,
        borderRadius: T.radius.md,
      }}
    >
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          onClick={() => onChange(m.value)}
          title={
            m.value === "chain"
              ? "Execution chain — the agents/tools that actually ran"
              : "Declared composition — the agent's full capabilities, lit as used"
          }
          style={{
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: T.fz.micro,
            padding: "5px 12px",
            borderRadius: T.radius.sm,
            background: mode === m.value ? "var(--paper)" : "transparent",
            color: mode === m.value ? "var(--ink)" : "var(--mute)",
            fontWeight: mode === m.value ? 600 : 500,
            boxShadow: mode === m.value ? T.shadow.s1 : "none",
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function RunSurfacePage() {
  const [mode, setMode] = useState<GraphMode>("chain");
  const source = useMemo<GraphSource>(
    () =>
      mode === "composition"
        ? { mode: "composition", agentName: "retrieval-analyst", capabilities: SAMPLE_CAPABILITIES }
        : { mode: "chain", arm: "single", toolDefs: [], events: SAMPLE_EVENTS },
    [mode],
  );
  const graph = useMemo(() => buildGraph(source), [source]);
  const steps = useMemo(() => eventsToSteps(SAMPLE_EVENTS, TOOL_INDEX, { terminal: true }), []);
  // one cursor across both projections; composition mode rests the full toolbox ring.
  const replay = useRunReplay(steps, graph, "demo", { restBase: mode === "composition" });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNode = selectedNodeId
    ? (graph.nodes.find((n) => n.id === selectedNodeId) ?? null)
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Live Run</h1>
        <span
          style={{
            fontSize: T.fz.micro,
            fontFamily: T.font.mono,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--mute)",
            border: "1px solid var(--line)",
            borderRadius: T.radius.sm,
            padding: "2px 7px",
          }}
        >
          demo · sample trace
        </span>
        <div style={{ flex: 1 }} />
        <ModeToggle mode={mode} onChange={setMode} />
        <Button variant="default" onClick={replay.playing ? replay.pause : replay.play}>
          {replay.playing ? "⏸ Pause" : "▶ Play"}
        </Button>
        <Button variant="ghost" onClick={replay.reset}>
          ↺ Reset
        </Button>
      </div>

      <div style={{ display: "flex", gap: 16, minHeight: 560 }}>
        <div
          style={{
            flex: 1,
            position: "relative",
            minWidth: 0,
            border: "1px solid var(--line)",
            borderRadius: T.radius.lg,
            overflow: "hidden",
            background: "var(--background)",
          }}
        >
          <RunBarHud hud={replay.frame.hud} />
          <ConstellationGraph
            graph={graph}
            frame={replay.frame}
            selectedNodeId={selectedNodeId}
            onNodeClick={(id) => setSelectedNodeId((cur) => (cur === id ? null : id))}
          />
          {selectedNode && (
            <NodeInspector
              node={selectedNode}
              steps={steps}
              runMeta={RUN_META}
              onClose={() => setSelectedNodeId(null)}
            />
          )}
        </div>
        <LiveTracePanel
          steps={steps}
          cursor={replay.cursor}
          onSeek={replay.seek}
          request={SAMPLE_REQUEST}
          answer={SAMPLE_ANSWER}
        />
      </div>
    </div>
  );
}
