/**
 * RunSurfacePage — the integrated Live Run surface.
 *
 * Owns the replay engine and composes the pieces around it: the constellation
 * canvas (with the HUD overlay + the node inspector) on the left, the
 * LiveTracePanel scrubber on the right, and a Play/Reset transport up top. The
 * trace panel and the graph share ONE `useRunReplay` cursor — clicking a trace
 * row seeks the constellation, and Play walks both in lockstep.
 *
 * Phase 1 (this slice): driven by the deterministic `SAMPLE_EVENTS` so the whole
 * surface is browser-verifiable without a live model. Slice 6 adds the live path:
 * an agent picker + SSE streaming into the same replay, and the declared/chain
 * mode toggle.
 */
import { useMemo, useState } from "react";
import { ConstellationGraph } from "../constellation/ConstellationGraph";
import { LiveTracePanel } from "../constellation/LiveTracePanel";
import { NodeInspector, type RunMeta } from "../constellation/NodeInspector";
import { RunBarHud } from "../constellation/RunBarHud";
import { type GraphSource, buildGraph, buildToolIndex } from "../graph/composition";
import {
  SAMPLE_ANSWER,
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

export function RunSurfacePage() {
  const source = useMemo<GraphSource>(
    () => ({ mode: "chain", arm: "single", toolDefs: [], events: SAMPLE_EVENTS }),
    [],
  );
  const graph = useMemo(() => buildGraph(source), [source]);
  const steps = useMemo(() => eventsToSteps(SAMPLE_EVENTS, TOOL_INDEX, { terminal: true }), []);
  const replay = useRunReplay(steps, graph, "demo");
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
