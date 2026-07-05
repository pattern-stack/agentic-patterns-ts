/**
 * GraphPanel — the constellation surface (the swe-brain Agent Plane, ported).
 * Mode-agnostic per ADR 0005: takes a `GraphSource` (chain = execution view,
 * composition = capability view), builds the shared `Constellation`, and — for
 * the chain projection — folds the event stream into TraceStep[] and overlays
 * the run as node pulses via useRunReplay. Drives REPLAY (persisted, scrubber),
 * LIVE (events streaming in), and the static composition view (no steps).
 */
import { useMemo, useState } from "react";
import { ConstellationGraph } from "../constellation/ConstellationGraph";
import { NodeInspector, type ProvenanceMap, type RunMeta } from "../constellation/NodeInspector";
import { RunBarHud } from "../constellation/RunBarHud";
import { type GraphSource, buildGraph, buildToolIndex } from "../graph/composition";
import { eventsToSteps } from "../graph/trace-from-events";
import { useRunReplay } from "../graph/use-run-replay";
import { Button } from "../ui/atoms";
import { T } from "../ui/tokens";

const TOOL_INDEX = buildToolIndex();
const NO_STEPS: never[] = [];

export function GraphPanel({
  source,
  runKey,
  live = false,
  terminal = true,
  minZoom,
  fitPadding,
  runMeta,
  provenance,
}: {
  source: GraphSource;
  runKey: string;
  live?: boolean;
  terminal?: boolean;
  /** Forwarded to the canvas — a narrow embed passes a smaller minZoom so a full
   *  chain fits instead of overflowing. Omit for the default eval-view framing. */
  minZoom?: number;
  fitPadding?: number;
  /** run framing (request / answer / system prompt) for the inspector's agent I/O tab. */
  runMeta?: RunMeta;
  /** real per-node provenance chips (from /composition); inspector derives when absent. */
  provenance?: ProvenanceMap;
}) {
  // chain-projection inputs (only present in chain mode); used for memo keys.
  const eventCount = source.mode === "chain" ? source.events.length : 0;
  // Keyed on (runKey, mode, eventCount): a growing live stream (eventCount)
  // reveals nodes. arm/toolDefs are NOT keys — that's correct ONLY because both
  // are stable per runKey (arm derives from run.mode; toolDefs are fixed for the
  // run / empty for the live session). A new run → new runKey → rebuild.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` is rebuilt (new ref) every render — depending on it would rebuild the graph on every render; the intended rebuild triggers are runKey, source.mode, and the live eventCount, which form source's stable signature.
  const graph = useMemo(() => buildGraph(source), [runKey, source.mode, eventCount]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: source.events array identity churns each render — eventCount (its length) is the intended growth signal, so keying on the count (not the array) rebuilds steps only as the stream grows, not on every render.
  const steps = useMemo(
    () =>
      source.mode === "chain" ? eventsToSteps(source.events, TOOL_INDEX, { terminal }) : NO_STEPS,
    [source.mode, eventCount, terminal],
  );
  // live mode: the engine drains the cursor toward the growing SSE frontier at a
  // flowing cadence (paced just-in-time reveal). Replay mode: manual play/seek.
  const replay = useRunReplay(steps, graph, runKey, { live });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectedNode = selectedNodeId
    ? (graph.nodes.find((n) => n.id === selectedNodeId) ?? null)
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 420 }}>
      <div
        style={{
          flex: 1,
          position: "relative",
          minHeight: 320,
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
          minZoom={minZoom}
          fitPadding={fitPadding}
        />
        {selectedNode && (
          <NodeInspector
            node={selectedNode}
            steps={steps}
            runMeta={runMeta}
            provenance={provenance}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
      {!live && <Scrubber replay={replay} count={steps.length} />}
    </div>
  );
}

function Scrubber({ replay, count }: { replay: ReturnType<typeof useRunReplay>; count: number }) {
  if (count === 0)
    return (
      <div style={{ marginTop: 8, fontSize: T.fz.tiny, color: "var(--mute)" }}>
        no trace steps to scrub
      </div>
    );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
      <Button variant="default" onClick={replay.playing ? replay.pause : replay.play}>
        {replay.playing ? "⏸ Pause" : "▶ Play"}
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
        style={{ flex: 1, accentColor: "var(--accent)" }}
      />
      <span
        style={{
          fontFamily: T.font.mono,
          fontSize: T.fz.micro,
          color: "var(--ink-2)",
          minWidth: 72,
          textAlign: "right",
        }}
      >
        {replay.cursor < 0 ? "idle" : `${replay.cursor + 1} / ${count}`}
      </span>
    </div>
  );
}
