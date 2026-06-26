/**
 * Execution-chain layout: agents in a left→right row (the hand-off sequence).
 * Around each agent, a balanced fan centred on 12 o'clock (1→[12], 2→[11,1],
 * widening only as needed). Two cases:
 *  - collapsed (single-capability agent): its tools orbit the agent directly.
 *  - grouped (≥2 capabilities, or the tunable forces the tier): the agent's
 *    capabilities orbit it on a tight radius, and each capability's tools orbit
 *    THAT capability (nested orbit).
 * Hierarchy is read from edges (tether = agent→capability, tool = parent→tool),
 * so this stays correct whichever shape the builder emitted. Positions are by
 * disc CENTRE; React Flow positions by top-left, so we offset by half the disc.
 */
import { type ConstNode, type Constellation, DISC } from './constellation-model';

const AGENT_GAP = 280; // horizontal pitch between chained agents
const UP = -Math.PI / 2; // 12 o'clock (screen y grows downward)
const DESIRED_ARC = (60 * Math.PI) / 180; // the 11–1 o'clock spread
const MIN_SPACING = (42 * Math.PI) / 180; // adjacent items never closer than this
const ARC_MAX = (300 * Math.PI) / 180;
const TOOL_GAP = 48; // agent→tool spoke gap (collapsed)
// agent→capability gap: pushed out far enough that a capability's label (drawn
// below its disc) clears the agent disc/label beneath it, and the two capability
// labels separate. Caps are small discs (grouping tier) on a longer spoke.
const CAP_GAP = 66;
const CAP_TOOL_GAP = 20; // capability→tool gap (tools hug their toolbox)

/** index of an `ag:N` node, for ordering the chain. */
const agIndex = (id: string): number => {
  const m = id.match(/^ag:(\d+)$/);
  return m ? Number(m[1]) : 0;
};

export function layoutChain(graph: Constellation): Constellation {
  const center = new Map<string, { x: number; y: number }>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const childrenOf = (id: string, kind: 'tool' | 'tether'): string[] =>
    graph.edges.filter((e) => e.source === id && e.data?.kind === kind).map((e) => e.target);

  /** Fan `ids` symmetrically around (cx,cy), centred on 12 o'clock, at `radius`. */
  const fan = (cx: number, cy: number, ids: string[], radius: number) => {
    const n = ids.length;
    const arc = n <= 1 ? 0 : Math.min(ARC_MAX, Math.max(DESIRED_ARC, MIN_SPACING * (n - 1)));
    ids.forEach((id, i) => {
      const angle = n <= 1 ? UP : UP + (i / (n - 1) - 0.5) * arc;
      center.set(id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    });
  };

  // agents along the row, in chain order
  const agents = graph.nodes
    .filter((n) => n.data.kind === 'agent' || n.data.kind === 'subagent')
    .sort((a, b) => agIndex(a.id) - agIndex(b.id));
  agents.forEach((a, i) => center.set(a.id, { x: i * AGENT_GAP, y: 0 }));

  for (const a of agents) {
    const c = center.get(a.id);
    if (!c) continue;
    const capIds = childrenOf(a.id, 'tether').filter((id) => byId.get(id)?.data.kind === 'capability');
    if (capIds.length > 0) {
      // grouped: capabilities orbit the agent, then each capability's tools orbit it.
      fan(c.x, c.y, capIds, DISC[a.data.kind] / 2 + DISC.capability / 2 + CAP_GAP);
      for (const capId of capIds) {
        const cc = center.get(capId);
        if (!cc) continue;
        fan(cc.x, cc.y, childrenOf(capId, 'tool'), DISC.capability / 2 + DISC.tool / 2 + CAP_TOOL_GAP);
      }
    } else {
      // collapsed: tools orbit the agent directly.
      fan(c.x, c.y, childrenOf(a.id, 'tool'), DISC[a.data.kind] / 2 + DISC.tool / 2 + TOOL_GAP);
    }
  }

  const nodes: ConstNode[] = graph.nodes.map((n) => {
    const c = center.get(n.id) ?? { x: 0, y: 0 };
    const d = DISC[n.data.kind];
    return { ...n, position: { x: c.x - d / 2, y: c.y - d / 2 } };
  });
  return { nodes, edges: graph.edges };
}
