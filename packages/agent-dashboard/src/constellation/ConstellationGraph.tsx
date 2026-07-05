/**
 * The React-Flow constellation canvas. Takes the static graph
 * (`buildConstellation`/`composition.ts`) + the current `Frame` (per-step
 * node/edge overlay) and renders custom circular nodes + animated edges. Node
 * click opens the inspector. React Flow's stock chrome is suppressed and the
 * canvas is transparent so the themed surface shows through.
 */
import { Background, BackgroundVariant, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./constellation.css";
import { useMemo } from "react";
import type { Constellation, Frame } from "../graph/constellation-model";
import { ConstellationEdge } from "./ConstellationEdge";
import { ConstellationNode } from "./ConstellationNode";

const nodeTypes = {
  agent: ConstellationNode,
  capability: ConstellationNode,
  tool: ConstellationNode,
  subagent: ConstellationNode,
};
const edgeTypes = { constellation: ConstellationEdge };

export function ConstellationGraph({
  graph,
  frame,
  selectedNodeId,
  onNodeClick,
  minZoom = 0.4,
  fitPadding = 0.28,
}: {
  graph: Constellation;
  frame: Frame;
  selectedNodeId: string | null;
  onNodeClick: (nodeId: string) => void;
  /** Lower bound on fitView zoom. The default suits the wide eval views; a
   *  narrow embed (e.g. the workspace right rail) passes a smaller value so a
   *  full L→R chain can shrink to fit instead of overflowing the box. */
  minZoom?: number;
  fitPadding?: number;
}) {
  const nodes = useMemo(
    () =>
      graph.nodes.map((n) => ({
        ...n,
        selected: n.id === selectedNodeId,
        data: {
          ...n.data,
          state: frame.nodeStates[n.id] ?? "pending",
          reveal: frame.reveals[n.id],
          active: frame.activeNodeId === n.id,
          resultChip: frame.resultChips[n.id],
        },
      })),
    [graph, frame, selectedNodeId],
  );

  const edges = useMemo(
    () =>
      graph.edges.map((e) => ({
        ...e,
        data: {
          ...e.data,
          active: frame.activeEdgeIds.has(e.id),
          complete: frame.completeEdgeIds.has(e.id),
          emerging: frame.emergingEdgeIds.has(e.id),
          resting: frame.restingEdgeIds.has(e.id),
        },
      })),
    [graph, frame],
  );

  // remount (→ re-run fitView) only when the graph STRUCTURE changes — e.g. the
  // capabilities resolve and the tool set grows. Per-frame overlay changes keep
  // the same node ids, so replay never remounts.
  const graphKey = useMemo(() => graph.nodes.map((n) => n.id).join("|"), [graph]);

  return (
    <div className="const-flow" style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        key={graphKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: fitPadding }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        zoomOnScroll={false}
        panOnScroll={false}
        panOnDrag
        minZoom={minZoom}
        maxZoom={1.6}
        onNodeClick={(_, node) => onNodeClick(node.id)}
        style={{ background: "transparent" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="var(--line-2)" />
      </ReactFlow>
    </div>
  );
}
