/**
 * The constellation model — pure mappers that turn an agent's composition into a
 * React-Flow node/edge graph, and fold a run's trace cursor into a per-frame
 * node-state snapshot (the SSE/replay node pulses). Ported from swe-brain's
 * Agent Plane; the graph builder lives in composition.ts (domain-specific), this
 * file owns the geometry + the per-frame fold.
 *
 * `computeFrame(steps, cursor, graph)` is the heart of the live overlay: given
 * the ordered `TraceStep[]` and a cursor, it returns which node is active, every
 * node's run-state, the just-in-time tool reveal, the active/complete edges, and
 * the HUD readout. Replay and a live SSE stream both feed it the same steps —
 * only the cursor differs.
 */
import { type Edge, type Node, Position } from '@xyflow/react';
import type { BlastRadius, CapabilityMeta, CapabilityRecord, TraceStep } from './types';

export type ConstNodeKind = 'agent' | 'capability' | 'tool' | 'subagent';
export type RunState = 'pending' | 'running' | 'complete' | 'error' | 'skipped';
export type ToolReveal = 'hidden' | 'emerging' | 'shown' | 'settled' | 'gated';
export type EdgeKind = 'tether' | 'tool' | 'handoff';

/** Disc diameters per node kind (small circular nodes). */
export const DISC: Record<ConstNodeKind, number> = {
  agent: 76,
  capability: 44, // a subordinate grouping tier — clearly smaller than the agent
  tool: 46,
  subagent: 54,
};

export interface ConstNodeData {
  kind: ConstNodeKind;
  label: string;
  sub?: string;
  blast?: BlastRadius;
  capabilityName?: string;
  toolName?: string;
  /** for a tool node: the chain agent that owns it (its label + node id). */
  agentLabel?: string;
  agentId?: string;
  gated?: boolean;
  // per-frame overlay (set by the surface each render):
  state?: RunState;
  reveal?: ToolReveal;
  active?: boolean;
  /** first line of a tool's result, shown only while the tool node is active */
  resultChip?: string;
  [key: string]: unknown;
}

export interface ConstEdgeData {
  kind: EdgeKind;
  active?: boolean;
  complete?: boolean;
  emerging?: boolean;
  [key: string]: unknown;
}

export type ConstNode = Node<ConstNodeData>;
export type ConstEdge = Edge<ConstEdgeData>;

export interface Constellation {
  nodes: ConstNode[];
  edges: ConstEdge[];
}

const AGENT_ID = 'agent';
const capId = (name: string) => `cap:${name}`;
const toolId = (capName: string, toolName: string) => `tool:${capName}:${toolName}`;
const edgeId = (source: string, target: string) => `e:${source}->${target}`;

/* ── layout geometry (flow coords; fitView reframes) ─────────────────────── */
const COL_AGENT = 0;
const COL_CAP = 280;
const COL_TOOL = 540;
const CAP_GAP = 150;
const TOOL_GAP = 74;

/** Position a node by its disc CENTER (React Flow positions by top-left). */
function at(kind: ConstNodeKind, cx: number, cy: number): { x: number; y: number } {
  return { x: cx - DISC[kind] / 2, y: cy - DISC[kind] / 2 };
}

/**
 * Build a single-agent constellation (agent → capabilities → tools). `caps` is
 * the agent's resolved capabilities (blast + title); `records` the live registry
 * (real tool names). Used directly for ARM A; composition.ts composes it for the
 * multi-agent arms.
 */
export function buildConstellation(
  agentName: string,
  caps: CapabilityMeta[],
  records: CapabilityRecord[],
): Constellation {
  const nodes: ConstNode[] = [];
  const edges: ConstEdge[] = [];

  const toolsFor = (capName: string, overlay: CapabilityMeta): string[] => {
    const record = records.find((r) => r.name === capName);
    return record?.tools.length ? record.tools.map((t) => t.name) : overlay.tools;
  };

  const capCount = caps.length;
  const capTop = -((capCount - 1) * CAP_GAP) / 2;

  nodes.push({
    id: AGENT_ID,
    type: 'agent',
    position: at('agent', COL_AGENT, 0),
    data: { kind: 'agent', label: agentName, sub: 'agent' },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  });

  caps.forEach((cap, ci) => {
    const capY = capTop + ci * CAP_GAP;
    const tools = toolsFor(cap.name, cap);
    nodes.push({
      id: capId(cap.name),
      type: 'capability',
      position: at('capability', COL_CAP, capY),
      data: {
        kind: 'capability',
        label: cap.title,
        sub: `${tools.length} tool${tools.length === 1 ? '' : 's'}`,
        blast: cap.blastRadius,
        capabilityName: cap.name,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });
    edges.push({
      id: edgeId(AGENT_ID, capId(cap.name)),
      source: AGENT_ID,
      target: capId(cap.name),
      type: 'constellation',
      data: { kind: 'tether' },
    });

    const toolTop = capY - ((tools.length - 1) * TOOL_GAP) / 2;
    tools.forEach((tool, ti) => {
      const tid = toolId(cap.name, tool);
      nodes.push({
        id: tid,
        type: 'tool',
        position: at('tool', COL_TOOL, toolTop + ti * TOOL_GAP),
        data: {
          kind: 'tool',
          label: tool,
          blast: cap.blastRadius,
          capabilityName: cap.name,
          toolName: tool,
          gated: cap.blastRadius === 'external',
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      });
      edges.push({
        id: edgeId(capId(cap.name), tid),
        source: capId(cap.name),
        target: tid,
        type: 'constellation',
        data: { kind: 'tool' },
      });
    });
  });

  return { nodes, edges };
}

/* ── per-frame fold ──────────────────────────────────────────────────────── */

export interface Frame {
  nodeStates: Record<string, RunState>;
  reveals: Record<string, ToolReveal>;
  activeNodeId: string | null;
  activeEdgeIds: Set<string>;
  completeEdgeIds: Set<string>;
  emergingEdgeIds: Set<string>;
  resultChips: Record<string, string>;
  hud: {
    phase: string;
    iter: number;
    maxIter: number;
    elapsedMs: number;
    tokensIn: number;
    tokensOut: number;
    running: boolean;
    done: boolean;
  };
}

function firstLine(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return (s.split('\n')[0] ?? '').slice(0, 48);
}

const edgeKey = (s: string, t: string) => `e:${s}->${t}`;

/**
 * Fold steps[0..cursor] into a frame. `cursor` is the index of the *current*
 * step (-1 = before the run starts / idle). The model is an execution CHAIN:
 * each agent/sub-agent node lights by the trace's per-step `agent` tag, and each
 * tool node (owned by one agent) reveals just-in-time when THAT agent invokes it
 * — so tools pop above their agent and light only while actually running.
 */
export function computeFrame(steps: TraceStep[], cursor: number, graph: Constellation): Frame {
  const nodeStates: Record<string, RunState> = {};
  const reveals: Record<string, ToolReveal> = {};
  const resultChips: Record<string, string> = {};
  const activeEdgeIds = new Set<string>();
  const completeEdgeIds = new Set<string>();
  const emergingEdgeIds = new Set<string>();

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    nodeStates[n.id] = 'pending';
    if (n.data.kind === 'tool') reveals[n.id] = n.data.gated ? 'gated' : 'hidden';
  }

  const lastIdx = steps.length - 1;
  const clamped = Math.min(cursor, lastIdx);
  const activeStep = clamped >= 0 ? steps[clamped] : null;
  const done = activeStep?.kind === 'finish';
  const seen = clamped >= 0 ? steps.slice(0, clamped + 1) : [];
  const activeAgent = activeStep?.agent;
  const agentNodes = graph.nodes.filter((n) => n.data.kind === 'agent' || n.data.kind === 'subagent');

  // ── tools: per (owning agent, tool name) just-in-time reveal + state ──
  for (const n of graph.nodes) {
    if (n.data.kind !== 'tool' || n.data.gated) continue;
    const agL = n.data.agentLabel;
    const tool = n.data.toolName;
    const capName = n.data.capabilityName;
    // owner match (ADR 0005): the chain projection keys a tool on its owning
    // agent (`agentLabel`); the composition projection has no `agentLabel`, so it
    // keys on the capability instead. Same fold, both projections.
    const owns = (s: TraceStep): boolean =>
      agL != null ? s.agent === agL : s.capability == null || s.capability === capName;
    // edges into this tool: chain = agent→tool spoke; composition = capability→tool.
    const spokeIds = n.data.agentId
      ? [edgeKey(n.data.agentId, n.id)]
      : capName
        ? [edgeKey(capId(capName), n.id)]
        : [];

    const calls: number[] = [];
    const results: number[] = [];
    steps.forEach((s, i) => {
      if (s.tool === tool && owns(s)) {
        if (s.kind === 'tool_call') calls.push(i);
        else if (s.kind === 'tool_result') results.push(i);
      }
    });
    if (calls.length === 0) continue;
    const firstCall = calls[0] as number;
    let modelIdx = -1;
    for (let i = firstCall - 1; i >= 0; i--) {
      const si = steps[i];
      if (si && si.kind === 'model' && owns(si)) {
        modelIdx = i;
        break;
      }
    }
    const decideIdx = modelIdx === -1 ? firstCall : modelIdx;
    const here = clamped >= 0 ? steps[clamped] : undefined;
    const onThisTool =
      here != null && here.tool === tool && owns(here) && (here.kind === 'tool_call' || here.kind === 'tool_result');
    const lastResultSeen = Math.max(-1, ...results.filter((i) => i <= clamped));

    let reveal: ToolReveal = 'hidden';
    if (clamped < 0 || clamped < decideIdx) reveal = 'hidden';
    else if (clamped < firstCall) reveal = 'emerging';
    else if (onThisTool) reveal = 'shown';
    else reveal = 'settled';
    reveals[n.id] = reveal;

    const lastResultErrored = lastResultSeen >= 0 && steps[lastResultSeen]?.status === 'error';
    nodeStates[n.id] =
      reveal === 'shown' ? 'running' : reveal === 'settled' ? (lastResultErrored ? 'error' : 'complete') : 'pending';

    if (onThisTool && here?.kind === 'tool_result') {
      // prefer the short note ("4 rows") over the raw JSON so the chip stays tiny.
      resultChips[n.id] = (here?.note ?? '') || firstLine(here?.output);
    }

    // light the edge(s) into this tool (agent→tool for chain, capability→tool for composition)
    for (const spoke of spokeIds) {
      if (reveal === 'shown') activeEdgeIds.add(spoke);
      else if (reveal === 'settled') completeEdgeIds.add(spoke);
      else if (reveal === 'emerging') emergingEdgeIds.add(spoke);
    }
  }

  // ── capability nodes: roll up state from THEIR OWN tools (by edge, so it works
  //    whether capability nodes are global (composition) or per-agent (chain)),
  //    and light the tether(s) into them. No-op when there are no capability
  //    nodes (a fully-collapsed chain graph). ──
  for (const n of graph.nodes) {
    if (n.data.kind !== 'capability') continue;
    const toolStates = graph.edges
      .filter((e) => e.source === n.id && e.data?.kind === 'tool')
      .map((e) => byId.get(e.target))
      .filter((t): t is ConstNode => !!t && !t.data.gated)
      .map((t) => nodeStates[t.id]);
    nodeStates[n.id] = toolStates.includes('running')
      ? 'running'
      : toolStates.includes('error')
        ? 'error'
        : toolStates.length > 0 && toolStates.every((s) => s === 'complete')
          ? 'complete'
          : toolStates.some((s) => s === 'complete')
            ? 'running'
            : 'pending';
    const st = nodeStates[n.id];
    for (const e of graph.edges) {
      if (e.target !== n.id || e.data?.kind !== 'tether') continue;
      if (st === 'running') activeEdgeIds.add(e.id);
      else if (st === 'complete') completeEdgeIds.add(e.id);
    }
  }

  // ── agents / sub-agents: light by the active step's `agent` tag ──
  for (const n of agentNodes) {
    const label = n.data.label;
    const total = steps.filter((s) => s.agent === label).length;
    if (total === 0) {
      nodeStates[n.id] = 'pending';
      continue;
    }
    const seenMine = seen.filter((s) => s.agent === label);
    const erroredMine = seenMine.some((s) => s.status === 'error');
    if (done) {
      nodeStates[n.id] = seenMine.length ? (erroredMine ? 'error' : 'complete') : 'pending';
    } else {
      nodeStates[n.id] =
        activeAgent === label
          ? erroredMine
            ? 'error'
            : 'running'
          : seenMine.length === 0
            ? 'pending'
            : seenMine.length >= total
              ? erroredMine
                ? 'error'
                : 'complete'
              : 'running';
    }
  }

  // ── handoff edges: light into the active / completed downstream agent ──
  for (const e of graph.edges) {
    if (e.data?.kind !== 'handoff') continue;
    const st = nodeStates[e.target] ?? 'pending';
    if (st === 'running') activeEdgeIds.add(e.id);
    else if (st === 'complete' || st === 'error') completeEdgeIds.add(e.id);
  }

  // ── which node carries the active pulse ──
  let activeNodeId: string | null = null;
  if (activeStep) {
    if ((activeStep.kind === 'tool_call' || activeStep.kind === 'tool_result') && activeStep.tool) {
      const tn = graph.nodes.find(
        (n) =>
          n.data.kind === 'tool' &&
          n.data.toolName === activeStep.tool &&
          (n.data.agentLabel != null
            ? n.data.agentLabel === activeStep.agent
            : activeStep.capability == null || n.data.capabilityName === activeStep.capability),
      );
      activeNodeId = tn?.id ?? agentNodes.find((n) => n.data.label === activeStep.agent)?.id ?? null;
    } else {
      activeNodeId = agentNodes.find((n) => n.data.label === activeStep.agent)?.id ?? agentNodes[0]?.id ?? null;
    }
  }

  // ── HUD readout ──
  const elapsedMs = seen.reduce((sum, s) => sum + (s.ms || 0), 0);
  const lastModel = [...seen].reverse().find((s) => s.kind === 'model');
  const tokensIn = lastModel?.ctxTokens ?? 0;
  const tokensOut = seen
    .filter((s) => s.kind === 'model')
    .reduce((sum, s) => sum + (s.outTokens ?? 0), 0);
  const iters = seen.reduce((m, s) => Math.max(m, s.iter), 0);
  const maxIter = steps.reduce((m, s) => Math.max(m, s.iter), 0);
  const toolCalls = seen.filter((s) => s.kind === 'tool_call').length;
  const phase =
    clamped < 0
      ? 'Idle — press Play'
      : done
        ? `Complete · ${maxIter} iter${maxIter === 1 ? '' : 's'} · ${toolCalls} tool${toolCalls === 1 ? '' : 's'}`
        : (activeStep?.label ?? activeStep?.kind ?? '');

  return {
    nodeStates,
    reveals,
    activeNodeId,
    activeEdgeIds,
    completeEdgeIds,
    emergingEdgeIds,
    resultChips,
    hud: {
      phase,
      iter: iters,
      maxIter,
      elapsedMs,
      tokensIn,
      tokensOut,
      running: !done && clamped >= 0,
      done,
    },
  };
}
