/**
 * composition.ts — build the constellation as an EXECUTION CHAIN for a run.
 *
 * The graph is the sequence of agents the run actually ran (ARM A: one analyst;
 * ARM B: gather → curate → answer; ARM C: coordinator → gather → curate →
 * answer), chained left→right by hand-off edges. Each agent OWNS the tools it
 * invoked, which sit above it and reveal/​light just-in-time as that agent calls
 * them (driven by computeFrame's per-(agent,tool) reveal). The agent chain +
 * per-agent tools come from the event stream; with no events yet we fall back to
 * a skeleton from the arm + the captured tool surface.
 *
 * Browser-bundled — no server imports.
 */
import { MarkerType } from "@xyflow/react";
import {
  type ConstEdge,
  type ConstNode,
  type Constellation,
  buildConstellation,
} from "./constellation-model";
import { layoutChain } from "./layout";
import type { ToolIndex } from "./trace-from-events";
import type { BlastRadius, CapabilityMeta } from "./types";

export type Arm = "single" | "pipeline" | "coordinator";

/* ── static inventory (verbatim toolbox keys, blueprint-verified) ─────────── */
const QUERY_SURFACE_TOOLS = ["describe", "list_types", "search", "fetch", "inspect", "curate"];
const DEAL_SCOPE_TOOLS = [
  "find_deal",
  "top_deals",
  "list_deals",
  "find_account",
  "list_deal_fields",
];
const COORDINATION_TOOLS = [...DEAL_SCOPE_TOOLS, "answer_over_deals"];

const TOOL_CAPABILITY: Record<string, string> = {
  describe: "query-surface",
  list_types: "query-surface",
  search: "query-surface",
  fetch: "query-surface",
  inspect: "query-surface",
  curate: "query-surface",
  find_deal: "deal-scope",
  top_deals: "deal-scope",
  list_deals: "deal-scope",
  find_account: "deal-scope",
  list_deal_fields: "deal-scope",
  answer_over_deals: "coordination",
  ask_deal_book: "retrieval-ask",
};

/** Per-tool blast override — empty today (every retrieval tool is a read). */
const TOOL_BLAST: Partial<Record<string, BlastRadius>> = {};

export function blastOf(toolName: string): BlastRadius {
  return TOOL_BLAST[toolName] ?? "read";
}
export function capabilityOf(toolName: string): string {
  return TOOL_CAPABILITY[toolName] ?? "other";
}

/** tool → {capability, blast} for the trace fold. Built from the static inventory. */
export function buildToolIndex(): ToolIndex {
  const idx: ToolIndex = new Map();
  for (const name of Object.keys(TOOL_CAPABILITY)) {
    idx.set(name, { capabilityName: capabilityOf(name), blast: blastOf(name) });
  }
  return idx;
}

/* ── structural row shapes (match the /api JSON; no server import) ────────── */
export interface ToolDefLike {
  name: string;
  description?: string | null;
}
export interface EventLite {
  type: string;
  seq?: number;
  payload_json?: string;
  [k: string]: unknown;
}

/* ── chain derivation ─────────────────────────────────────────────────────── */

export interface ChainAgent {
  id: string;
  label: string;
  kind: "agent" | "subagent";
  /** tool names this agent actually invoked (or its skeleton surface, idle). */
  tools: string[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const safeParse = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const payloadOf = (e: EventLite): Record<string, unknown> =>
  e.payload_json ? safeParse(e.payload_json) : (e as Record<string, unknown>);
const toolNameOf = (e: EventLite, p: Record<string, unknown>): string | undefined =>
  str(e.tool_name as unknown) ?? str(p.toolName) ?? str(p.tool_name);
// FOLD FIX 2(a): strip the `agent.`/`pattern.` prefix so we match the framework's
// BARE event names (`message.start`, `tool.start`) as well as the cockpit's
// `agent.`-prefixed ones.
const bareType = (t: string): string => t.replace(/^(agent|pattern)\./, "");
// FOLD FIX 2(a): the framework streams `message.start {agent_name}` (snake_case);
// persisted cockpit rows carry `agentName`. Accept both.
const agentNameOf = (p: Record<string, unknown>): string | undefined =>
  str(p.agentName) ?? str(p.agent_name);

const ag = (i: number, label: string, kind: "agent" | "subagent", tools: string[]): ChainAgent => ({
  id: `ag:${i}`,
  label,
  kind,
  tools,
});

/** Idle skeleton when no events have streamed yet. */
function skeleton(arm: Arm, toolDefs: ToolDefLike[]): ChainAgent[] {
  const td = toolDefs.map((t) => t.name);
  if (arm === "pipeline")
    return [
      ag(0, "gather", "agent", QUERY_SURFACE_TOOLS),
      ag(1, "curate", "subagent", QUERY_SURFACE_TOOLS),
      ag(2, "answer", "subagent", []),
    ];
  if (arm === "coordinator")
    return [
      ag(0, "coordinator", "agent", td.length ? td : COORDINATION_TOOLS),
      ag(1, "gather", "subagent", QUERY_SURFACE_TOOLS),
      ag(2, "curate", "subagent", QUERY_SURFACE_TOOLS),
      ag(3, "answer", "subagent", []),
    ];
  return [ag(0, "retrieval-analyst", "agent", td.length ? td : QUERY_SURFACE_TOOLS)];
}

/** Recover the ordered agent chain + each agent's invoked tools from the events. */
export function deriveChain(arm: Arm, toolDefs: ToolDefLike[], events: EventLite[]): ChainAgent[] {
  if (events.length) {
    const order: string[] = [];
    const tools = new Map<string, string[]>();
    let cur: string | undefined;
    for (const e of events) {
      const t = bareType(String(e.type));
      const p = payloadOf(e);
      if (t === "message.start") {
        const name = agentNameOf(p);
        if (name) {
          cur = name;
          if (!tools.has(name)) {
            order.push(name);
            tools.set(name, []);
          }
        }
      } else if (t === "tool.start") {
        const tn = toolNameOf(e, p);
        if (cur && tn) {
          const arr = tools.get(cur) ?? [];
          if (!tools.has(cur)) {
            order.push(cur);
            tools.set(cur, arr);
          }
          if (!arr.includes(tn)) arr.push(tn);
        }
      }
    }
    if (order.length)
      return order.map((name, i) =>
        ag(i, name, i === 0 ? "agent" : "subagent", tools.get(name) ?? []),
      );
  }
  return skeleton(arm, toolDefs);
}

/* ── node / edge factories ────────────────────────────────────────────────── */
function mkNode(
  id: string,
  kind: ConstNode["data"]["kind"],
  data: Record<string, unknown>,
): ConstNode {
  return {
    id,
    type: kind,
    position: { x: 0, y: 0 },
    data: { kind, ...data } as ConstNode["data"],
    sourcePosition: "right" as never,
    targetPosition: "left" as never,
  };
}
function mkEdge(source: string, target: string, kind: "tool" | "handoff" | "tether"): ConstEdge {
  return {
    id: `e:${source}->${target}`,
    source,
    target,
    type: "constellation",
    data: { kind },
    ...(kind === "handoff" ? { markerEnd: { type: MarkerType.ArrowClosed } } : {}),
  };
}

const CAP_TITLE: Record<string, string> = {
  "query-surface": "Query Surface",
  "deal-scope": "Deal Scope",
  coordination: "Coordination",
  "retrieval-ask": "Retrieval Ask",
  other: "Other",
};
const capTitle = (name: string): string =>
  CAP_TITLE[name] ??
  name
    .split(/[-_]/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");

/** Group an agent's tools by their owning capability, preserving first-seen order. */
function groupByCapability(tools: string[]): { name: string; tools: string[] }[] {
  const order: string[] = [];
  const byCap = new Map<string, string[]>();
  for (const t of tools) {
    const cap = capabilityOf(t);
    if (!byCap.has(cap)) {
      order.push(cap);
      byCap.set(cap, []);
    }
    byCap.get(cap)!.push(t);
  }
  return order.map((name) => ({ name, tools: byCap.get(name)! }));
}

/** Default: collapse the capability tier when an agent uses only ONE capability
 *  (the tier adds nothing there). Tunable per ADR 0005 — flip to always show it.
 *  Threaded from the GraphSource so a UI toggle can drive it later. */
export const DEFAULT_COLLAPSE_SINGLE_CAPABILITY = true;

/** Build the execution-chain constellation for a run. With multiple capabilities
 *  on an agent (or `collapseSingleCapability=false`), tools nest under capability
 *  nodes; with one capability and collapse on, tools attach straight to the agent. */
export function buildRunConstellation(
  arm: Arm,
  toolDefs: ToolDefLike[],
  events: EventLite[],
  opts: { collapseSingleCapability?: boolean } = {},
): Constellation {
  const collapse = opts.collapseSingleCapability ?? DEFAULT_COLLAPSE_SINGLE_CAPABILITY;
  const chain = deriveChain(arm, toolDefs, events);
  const nodes: ConstNode[] = [];
  const edges: ConstEdge[] = [];

  const mkTool = (agent: ChainAgent, cap: string, tool: string, parent: string) => {
    const tid = `tool:${agent.id}:${tool}`;
    nodes.push(
      mkNode(tid, "tool", {
        label: tool,
        toolName: tool,
        agentLabel: agent.label, // tools always carry their agent → fold matches unambiguously
        agentId: agent.id,
        capabilityName: cap,
        blast: blastOf(tool),
        gated: false,
      }),
    );
    edges.push(mkEdge(parent, tid, "tool"));
  };

  chain.forEach((agent, i) => {
    nodes.push(
      mkNode(agent.id, agent.kind, {
        label: agent.label,
        sub: agent.kind === "agent" ? "agent" : "phase",
      }),
    );
    if (i > 0) {
      const prev = chain[i - 1];
      if (prev) edges.push(mkEdge(prev.id, agent.id, "handoff"));
    }

    const caps = groupByCapability(agent.tools);
    const showTier = caps.length > 1 || !collapse;
    if (!showTier) {
      // collapsed: tools hang straight off the agent (the common single-toolbox case)
      for (const cap of caps) for (const tool of cap.tools) mkTool(agent, cap.name, tool, agent.id);
    } else {
      // grouped: agent → capability → tools (capability tier earns its place)
      for (const cap of caps) {
        const cid = `cap:${agent.id}:${cap.name}`;
        nodes.push(
          mkNode(cid, "capability", {
            label: capTitle(cap.name),
            capabilityName: cap.name,
            agentId: agent.id,
            sub: `${cap.tools.length} tool${cap.tools.length === 1 ? "" : "s"}`,
            blast: cap.tools.reduce<BlastRadius>(
              (acc, t) => (blastOf(t) === "external" ? "external" : acc),
              "read",
            ),
          }),
        );
        edges.push(mkEdge(agent.id, cid, "tether"));
        for (const tool of cap.tools) mkTool(agent, cap.name, tool, cid);
      }
    }
  });
  return layoutChain({ nodes, edges });
}

/** Map a persisted run `mode` (sandbox/sequential/coordinator) to an Arm. */
export function armFromMode(mode: string | undefined | null): Arm {
  if (mode === "sequential") return "pipeline";
  if (mode === "coordinator") return "coordinator";
  return "single";
}

/* ── the two projections (ADR 0005) ──────────────────────────────────────────
 * One graph IR (`Constellation`), two builders behind one seam. `chain` = the
 * execution view ("what happened/will happen") built from a run's events;
 * `composition` = the capability view ("what CAN happen") built from an agent's
 * static surface. Both return the identical Constellation the renderer + the
 * computeFrame overlay consume — the difference is construction + layout only. */
export type GraphSource =
  | {
      mode: "chain";
      arm: Arm;
      toolDefs: ToolDefLike[];
      events: EventLite[];
      /** show the capability tier even for single-capability agents (default: collapse). */
      collapseSingleCapability?: boolean;
    }
  | { mode: "composition"; agentName: string; capabilities: CapabilityMeta[] };

/** Build a constellation for either projection. The graph host is mode-agnostic. */
export function buildGraph(source: GraphSource): Constellation {
  if (source.mode === "composition") {
    // capability tiers (agent → capability → tools); buildConstellation lays itself out.
    return buildConstellation(source.agentName, source.capabilities, []);
  }
  return buildRunConstellation(source.arm, source.toolDefs, source.events, {
    collapseSingleCapability: source.collapseSingleCapability,
  });
}
