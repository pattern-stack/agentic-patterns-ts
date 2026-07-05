/**
 * Contract tests for the constellation graph engine (ported from the cockpit
 * model/ into src/graph/). These are pure, transport-agnostic folds — the audit
 * found them shipped with ZERO tests. We pin the three highest-value functions:
 *
 *   - eventsToSteps  (trace-from-events.ts) — folds an ordered event stream into
 *     TraceStep[]. Exercised in BOTH wire shapes the fold must tolerate:
 *       (a) LIVE  — the framework's post-adapter named-SSE frames, snake_case
 *                   payload (`agent_name`/`tool_name`/`duration_ms`/`input_tokens`
 *                   /`output_tokens`/`finish_reason`), BARE event names.
 *       (b) PERSISTED — cockpit rows: promoted snake_case columns + an
 *                   `agent.`-prefixed `type` + a camelCase `payload_json` blob.
 *     Both shapes MUST fold to the identical TraceStep[] — that guards FOLD FIX
 *     2(a)/2(b) (prefix-strip + snake/camel tolerance).
 *
 *   - deriveChain    (composition.ts) — recovers the agent->agent handoff chain
 *     + per-agent tool ownership from framework-shaped events.
 *
 *   - computeFrame   (constellation-model.ts) — folds steps[0..cursor] into the
 *     per-frame node run-states, just-in-time tool reveals, and active/complete
 *     edges, for a single-agent chain and a two-agent pipeline.
 *
 * The wire shapes mirror packages/agent-runtime/src/transport/sse-formatter.ts
 * (the named-SSE adapter) and agent-runner.ts (the emitter). In particular the
 * framework's `agent.llm.end` carries `finish_reason: "tool_calls"` — see the
 * `planned()` FINDING block at the bottom.
 */

import { describe, expect, it } from "vitest";
import {
  type Arm,
  type ChainAgent,
  type EventLite,
  buildRunConstellation,
  buildToolIndex,
  deriveChain,
} from "../graph/composition";
import { buildConstellation, computeFrame } from "../graph/constellation-model";
import type { EventLike } from "../graph/trace-from-events";
import { eventsToSteps } from "../graph/trace-from-events";
import type { CapabilityMeta, TraceStep } from "../graph/types";

const tools = buildToolIndex();

/* ── logical event model → the two wire shapes ──────────────────────────────
 * Define a run ONCE as logical events, then render each to a LIVE frame and a
 * PERSISTED row. This guarantees the two fixtures describe the same run, so an
 * equality assertion over their folds is a genuine snake/camel + prefix guard. */
interface Logical {
  type: string; // bare name, e.g. "message.start"
  seq: number;
  agent?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  reason?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  iteration?: number;
}

/** LIVE: framework post-adapter SSE frame — bare type, flat snake_case payload. */
function toLive(l: Logical): EventLike {
  const e: EventLike = { type: l.type, seq: l.seq };
  if (l.agent) e.agent_name = l.agent;
  if (l.tool) e.tool_name = l.tool;
  if (l.args !== undefined) e.arguments = l.args;
  if (l.result !== undefined) e.result = l.result;
  if (l.error !== undefined) e.error = l.error;
  if (l.reason !== undefined) e.reason = l.reason;
  if (l.durationMs !== undefined) e.duration_ms = l.durationMs;
  if (l.inputTokens !== undefined) e.input_tokens = l.inputTokens;
  if (l.outputTokens !== undefined) e.output_tokens = l.outputTokens;
  if (l.finishReason !== undefined) e.finish_reason = l.finishReason;
  if (l.iteration !== undefined) e.iteration = l.iteration;
  return e;
}

/** PERSISTED: cockpit row — `agent.`-prefixed type, promoted snake columns,
 *  plus the untouched camelCase event body in `payload_json`. */
function toPersisted(l: Logical): EventLike {
  const e: EventLike = { type: `agent.${l.type}`, seq: l.seq };
  if (l.tool) e.tool_name = l.tool;
  if (l.args !== undefined) e.args_json = JSON.stringify(l.args);
  if (l.result !== undefined) e.result_json = JSON.stringify(l.result);
  if (l.error !== undefined) e.error = l.error;
  if (l.durationMs !== undefined) e.duration_ms = l.durationMs;
  const p: Record<string, unknown> = {};
  if (l.agent) p.agentName = l.agent;
  if (l.tool) p.toolName = l.tool;
  if (l.args !== undefined) p.arguments = l.args;
  if (l.result !== undefined) p.result = l.result;
  if (l.error !== undefined) p.error = l.error;
  if (l.reason !== undefined) p.reason = l.reason;
  if (l.durationMs !== undefined) p.durationMs = l.durationMs;
  if (l.inputTokens !== undefined) p.inputTokens = l.inputTokens;
  if (l.outputTokens !== undefined) p.outputTokens = l.outputTokens;
  if (l.finishReason !== undefined) p.finishReason = l.finishReason;
  if (l.iteration !== undefined) p.iteration = l.iteration;
  e.payload_json = JSON.stringify(p);
  return e;
}

/** A single-agent (ARM A) run: 2 iterations, one tool call (`search`). */
const SINGLE_RUN: Logical[] = [
  { type: "message.start", seq: 0, agent: "retrieval-analyst" },
  { type: "iteration.start", seq: 1, iteration: 0 },
  {
    type: "llm.end",
    seq: 2,
    durationMs: 1200,
    inputTokens: 500,
    outputTokens: 40,
    finishReason: "tool_calls",
  },
  { type: "tool.start", seq: 3, tool: "search", args: { q: "beans" } },
  { type: "tool.end", seq: 4, tool: "search", result: [{ id: "a" }, { id: "b" }], durationMs: 300 },
  { type: "iteration.start", seq: 5, iteration: 1 },
  {
    type: "llm.end",
    seq: 6,
    durationMs: 800,
    inputTokens: 600,
    outputTokens: 120,
    finishReason: "stop",
  },
  { type: "message.complete", seq: 7 },
];

const liveSingle = SINGLE_RUN.map(toLive);
const persistedSingle = SINGLE_RUN.map(toPersisted);

/** Project a TraceStep to the load-bearing fields (drops cosmetic `detail`). */
const pick = (s: TraceStep) => ({
  seq: s.seq,
  iter: s.iter,
  kind: s.kind,
  label: s.label,
  ms: s.ms,
  ctxTokens: s.ctxTokens,
  outTokens: s.outTokens,
  tool: s.tool,
  capability: s.capability,
  blast: s.blast,
  status: s.status,
  note: s.note,
  agent: s.agent,
  emits: s.emits,
});

describe("eventsToSteps — fold to TraceStep[]", () => {
  it("folds a live (camelCase-bare snake) single-agent stream to the expected steps", () => {
    const steps = eventsToSteps(liveSingle, tools);
    expect(steps.map(pick)).toEqual([
      {
        seq: 1,
        iter: 0,
        kind: "context",
        label: "Compile request context",
        ms: 0,
        agent: "retrieval-analyst",
      },
      {
        seq: 2,
        iter: 1,
        kind: "model",
        label: "Model call · iteration 1",
        ms: 1200,
        ctxTokens: 500,
        outTokens: 40,
        agent: "retrieval-analyst",
        emits: ["search"],
      },
      {
        seq: 3,
        iter: 1,
        kind: "tool_call",
        tool: "search",
        capability: "query-surface",
        blast: "read",
        ms: 0,
        agent: "retrieval-analyst",
      },
      {
        seq: 4,
        iter: 1,
        kind: "tool_result",
        tool: "search",
        capability: "query-surface",
        blast: "read",
        ms: 300,
        status: "ok",
        note: "2 rows",
        agent: "retrieval-analyst",
      },
      {
        seq: 5,
        iter: 2,
        kind: "model",
        label: "Model call · iteration 2",
        ms: 800,
        ctxTokens: 600,
        outTokens: 120,
        agent: "retrieval-analyst",
        emits: [],
      },
      {
        seq: 6,
        iter: 2,
        kind: "finish",
        label: "finishReason: stop",
        ms: 0,
        status: "ok",
        agent: "retrieval-analyst",
      },
    ]);
  });

  it("carries the raw args / output through onto the tool steps", () => {
    const steps = eventsToSteps(liveSingle, tools);
    const call = steps.find((s) => s.kind === "tool_call");
    const result = steps.find((s) => s.kind === "tool_result");
    expect(call?.args).toEqual({ q: "beans" });
    expect(result?.output).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("folds the PERSISTED (prefixed + camelCase payload) shape identically to LIVE", () => {
    // The guard for FOLD FIX 2(a)/2(b): same run, two wire shapes, one fold.
    expect(eventsToSteps(persistedSingle, tools)).toEqual(eventsToSteps(liveSingle, tools));
  });

  it("treats only the LAST message.complete as the finish step", () => {
    // A pipeline emits message.complete per sub-agent; only the last closes the run.
    const events = PIPELINE_RUN.map(toLive);
    const steps = eventsToSteps(events, tools);
    expect(steps.filter((s) => s.kind === "finish")).toHaveLength(1);
    expect(steps.at(-1)?.kind).toBe("finish");
  });

  it("folds llm.start into a provisional 'thinking' model step, finalized in place by llm.end", () => {
    // A live stream that carries llm.start BEFORE llm.end must yield exactly ONE
    // model step per turn (the provisional step finalized in place), not two.
    const run: Logical[] = [
      { type: "message.start", seq: 0, agent: "retrieval-analyst" },
      { type: "iteration.start", seq: 1, iteration: 0 },
      { type: "llm.start", seq: 2 },
      {
        type: "llm.end",
        seq: 3,
        durationMs: 900,
        inputTokens: 500,
        outputTokens: 40,
        finishReason: "stop",
      },
      { type: "message.complete", seq: 4 },
    ];
    const steps = eventsToSteps(run.map(toLive), tools);
    const models = steps.filter((s) => s.kind === "model");
    expect(models).toHaveLength(1);
    // finalized: real tokens/ms folded in, and the transient 'thinking' status cleared.
    expect(models[0]).toMatchObject({ kind: "model", ms: 900, ctxTokens: 500, outTokens: 40 });
    expect(models[0]?.status).toBeUndefined();
  });

  it("leaves a live 'thinking' model step pending while llm.end has not yet arrived", () => {
    // Mid-flight (llm.start seen, llm.end not) the model step must be present and
    // marked 'thinking' so the agent node can pulse during the call.
    const run: Logical[] = [
      { type: "message.start", seq: 0, agent: "retrieval-analyst" },
      { type: "iteration.start", seq: 1, iteration: 0 },
      { type: "llm.start", seq: 2 },
    ];
    const steps = eventsToSteps(run.map(toLive), tools, { terminal: false });
    const model = steps.find((s) => s.kind === "model");
    expect(model?.status).toBe("thinking");
    expect(model?.detail).toBe("Thinking…");
  });

  it("folds a tool error into a rejected/errored result and an errored finish", () => {
    const run: Logical[] = [
      { type: "message.start", seq: 0, agent: "retrieval-analyst" },
      { type: "iteration.start", seq: 1, iteration: 0 },
      { type: "llm.end", seq: 2, durationMs: 100, finishReason: "tool_calls" },
      { type: "tool.start", seq: 3, tool: "search", args: {} },
      { type: "tool.end", seq: 4, tool: "search", error: "boom", durationMs: 5 },
      { type: "message.complete", seq: 5 },
    ];
    const live = eventsToSteps(run.map(toLive), tools);
    const persisted = eventsToSteps(run.map(toPersisted), tools);
    const result = live.find((s) => s.kind === "tool_result");
    expect(result?.status).toBe("error");
    expect(result?.note).toBe("boom");
    expect(live.at(-1)).toMatchObject({
      kind: "finish",
      status: "error",
      label: "finishReason: error",
    });
    expect(persisted).toEqual(live);
  });
});

/* ── deriveChain ───────────────────────────────────────────────────────────── */

const CHAIN_EVENTS: Logical[] = [
  { type: "message.start", seq: 0, agent: "gather" },
  { type: "tool.start", seq: 1, tool: "search" },
  { type: "tool.start", seq: 2, tool: "fetch" },
  { type: "tool.start", seq: 3, tool: "search" }, // duplicate → must dedupe
  { type: "message.start", seq: 4, agent: "curate" },
  { type: "tool.start", seq: 5, tool: "curate" },
  { type: "message.start", seq: 6, agent: "answer" },
];

const EXPECTED_CHAIN: ChainAgent[] = [
  { id: "ag:0", label: "gather", kind: "agent", tools: ["search", "fetch"] },
  { id: "ag:1", label: "curate", kind: "subagent", tools: ["curate"] },
  { id: "ag:2", label: "answer", kind: "subagent", tools: [] },
];

describe("deriveChain — agent handoff chain + per-agent tool ownership", () => {
  it("recovers the chain from framework-shaped (bare, snake_case) events", () => {
    expect(deriveChain("pipeline", [], CHAIN_EVENTS.map(toLive) as EventLite[])).toEqual(
      EXPECTED_CHAIN,
    );
  });

  it("recovers the identical chain from persisted (prefixed, camelCase) rows", () => {
    expect(deriveChain("pipeline", [], CHAIN_EVENTS.map(toPersisted) as EventLite[])).toEqual(
      EXPECTED_CHAIN,
    );
  });

  it("falls back to the arm skeleton when no events have streamed", () => {
    const sk = deriveChain("pipeline", [], []);
    expect(sk.map((a) => ({ id: a.id, label: a.label, kind: a.kind }))).toEqual([
      { id: "ag:0", label: "gather", kind: "agent" },
      { id: "ag:1", label: "curate", kind: "subagent" },
      { id: "ag:2", label: "answer", kind: "subagent" },
    ]);
    expect(
      (["single", "coordinator"] as Arm[]).map((arm) => deriveChain(arm, [], []).length),
    ).toEqual([1, 4]);
  });
});

/* ── computeFrame ──────────────────────────────────────────────────────────── */

const sorted = (s: Set<string>) => [...s].sort();

describe("computeFrame — single-agent per-frame fold", () => {
  const graph = buildRunConstellation("single", [], liveSingle as EventLite[]);
  const steps = eventsToSteps(liveSingle, tools);
  // steps indices: 0 context · 1 model · 2 tool_call · 3 tool_result · 4 model · 5 finish
  const TOOL = "tool:ag:0:search";
  const SPOKE = "e:ag:0->tool:ag:0:search";

  it("is idle before the run (cursor -1): everything pending, tool hidden", () => {
    const f = computeFrame(steps, -1, graph);
    expect(f.nodeStates).toMatchObject({ "ag:0": "pending", [TOOL]: "pending" });
    expect(f.reveals[TOOL]).toBe("hidden");
    expect(f.activeNodeId).toBeNull();
    expect(sorted(f.activeEdgeIds)).toEqual([]);
    expect(f.hud).toMatchObject({
      phase: "Idle — press Play",
      running: false,
      done: false,
      maxIter: 2,
    });
  });

  it("at the tool_call cursor (2): agent + tool running, spoke active", () => {
    const f = computeFrame(steps, 2, graph);
    expect(f.nodeStates).toMatchObject({ "ag:0": "running", [TOOL]: "running" });
    expect(f.reveals[TOOL]).toBe("shown");
    expect(f.activeNodeId).toBe(TOOL);
    expect(sorted(f.activeEdgeIds)).toEqual([SPOKE]);
    expect(sorted(f.completeEdgeIds)).toEqual([]);
    expect(f.hud).toMatchObject({
      iter: 1,
      maxIter: 2,
      tokensIn: 500,
      tokensOut: 40,
      elapsedMs: 1200,
      running: true,
    });
  });

  it("at the tool_result cursor (3): result card summarizes the returned items", () => {
    const f = computeFrame(steps, 3, graph);
    expect(f.nodeStates[TOOL]).toBe("running");
    // richResult lists the items by their human label (id here) rather than a count.
    expect(f.resultChips[TOOL]).toBe("a · b");
    expect(sorted(f.activeEdgeIds)).toEqual([SPOKE]);
  });

  it("at the finish cursor (5): agent + tool complete, spoke complete, done", () => {
    const f = computeFrame(steps, 5, graph);
    expect(f.nodeStates).toMatchObject({ "ag:0": "complete", [TOOL]: "complete" });
    expect(f.reveals[TOOL]).toBe("settled");
    expect(f.activeNodeId).toBe("ag:0");
    expect(sorted(f.activeEdgeIds)).toEqual([]);
    expect(sorted(f.completeEdgeIds)).toEqual([SPOKE]);
    expect(f.hud).toMatchObject({
      done: true,
      running: false,
      iter: 2,
      maxIter: 2,
      tokensIn: 600,
      tokensOut: 160,
      elapsedMs: 2300,
      phase: "Complete · 2 iters · 1 tool",
    });
  });
});

/* ── computeFrame · declared-composition resting ring (restBase) ─────────────── */

describe("computeFrame — declared-composition resting ring", () => {
  // the declared surface: query-surface arms TWO tools, but the run uses only `search`.
  const caps: CapabilityMeta[] = [
    {
      name: "query-surface",
      title: "Query Surface",
      surface: "Query",
      blastRadius: "read",
      tools: ["search", "fetch"],
    },
  ];
  const graph = buildConstellation("retrieval-analyst", caps, []);
  const steps = eventsToSteps(liveSingle, tools); // uses `search` only
  const last = steps.length - 1;
  const USED = "tool:query-surface:search";
  const UNUSED = "tool:query-surface:fetch";
  const UNUSED_SPOKE = "e:cap:query-surface->tool:query-surface:fetch";

  it("rests the declared-but-unused tool while lighting the used one (restBase=true)", () => {
    const f = computeFrame(steps, last, graph, true);
    expect(f.reveals[UNUSED]).toBe("resting"); // faint composition ring, never called
    expect(f.reveals[USED]).toBe("settled"); // used + done
    expect([...f.restingEdgeIds]).toContain(UNUSED_SPOKE);
  });

  it("hides the unused tool in the chain default (restBase=false)", () => {
    const f = computeFrame(steps, last, graph, false);
    expect(f.reveals[UNUSED]).toBe("hidden");
    expect(f.restingEdgeIds.size).toBe(0);
  });
});

/** Two-agent pipeline gather -> curate, each owning its own tool. */
const PIPELINE_RUN: Logical[] = [
  { type: "message.start", seq: 0, agent: "gather" },
  { type: "iteration.start", seq: 1, iteration: 0 },
  {
    type: "llm.end",
    seq: 2,
    durationMs: 50,
    inputTokens: 100,
    outputTokens: 10,
    finishReason: "tool_calls",
  },
  { type: "tool.start", seq: 3, tool: "search" },
  { type: "tool.end", seq: 4, tool: "search", result: [{ id: "x" }], durationMs: 20 },
  { type: "message.complete", seq: 5 }, // gather's complete — intermediate, NOT the finish
  { type: "message.start", seq: 6, agent: "curate" },
  { type: "iteration.start", seq: 7, iteration: 0 },
  {
    type: "llm.end",
    seq: 8,
    durationMs: 60,
    inputTokens: 200,
    outputTokens: 20,
    finishReason: "tool_calls",
  },
  { type: "tool.start", seq: 9, tool: "curate" },
  { type: "tool.end", seq: 10, tool: "curate", result: [{ id: "y" }, { id: "z" }], durationMs: 30 },
  {
    type: "llm.end",
    seq: 11,
    durationMs: 40,
    inputTokens: 250,
    outputTokens: 40,
    finishReason: "stop",
  },
  { type: "message.complete", seq: 12 }, // curate's complete — the LAST → finish
];

describe("computeFrame — pipeline handoff + per-agent tool ownership", () => {
  const livePipeline = PIPELINE_RUN.map(toLive);
  const graph = buildRunConstellation("pipeline", [], livePipeline as EventLite[]);
  const steps = eventsToSteps(livePipeline, tools);
  // steps: 0 ctx(gather) 1 model(gather) 2 call search 3 result search
  //        4 model(curate) 5 call curate 6 result curate 7 model(curate) 8 finish

  it("while curate runs its tool (cursor 5): gather complete, curate running, handoff active", () => {
    const f = computeFrame(steps, 5, graph);
    expect(f.nodeStates).toMatchObject({
      "ag:0": "complete", // gather, upstream — finished
      "ag:1": "running", // curate, active
      "tool:ag:0:search": "complete", // owned by gather → settled
      "tool:ag:1:curate": "running", // owned by curate → live now
    });
    expect(f.reveals["tool:ag:0:search"]).toBe("settled");
    expect(f.reveals["tool:ag:1:curate"]).toBe("shown");
    expect(f.activeNodeId).toBe("tool:ag:1:curate");
    // handoff gather->curate lights, curate's tool spoke lights
    expect(sorted(f.activeEdgeIds)).toEqual(["e:ag:0->ag:1", "e:ag:1->tool:ag:1:curate"]);
    // gather's tool spoke is complete
    expect(sorted(f.completeEdgeIds)).toEqual(["e:ag:0->tool:ag:0:search"]);
  });
});

/* ── buildConstellation (composition projection) ────────────────────────────── */

describe("buildConstellation — agent -> capability -> tools graph", () => {
  it("emits the agent/capability/tool nodes + tether/tool edges for a single agent", () => {
    const caps: CapabilityMeta[] = [
      {
        name: "query-surface",
        title: "Query Surface",
        surface: "Query",
        blastRadius: "read",
        tools: ["search", "fetch"],
      },
    ];
    const { nodes, edges } = buildConstellation("retrieval-analyst", caps, []);
    expect(nodes.map((n) => n.id).sort()).toEqual([
      "agent",
      "cap:query-surface",
      "tool:query-surface:fetch",
      "tool:query-surface:search",
    ]);
    const cap = nodes.find((n) => n.id === "cap:query-surface");
    expect(cap?.data).toMatchObject({
      kind: "capability",
      label: "Query Surface",
      sub: "2 tools",
      blast: "read",
    });
    expect(
      edges.map((e) => ({ id: e.id, kind: e.data?.kind })).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      { id: "e:agent->cap:query-surface", kind: "tether" },
      { id: "e:cap:query-surface->tool:query-surface:fetch", kind: "tool" },
      { id: "e:cap:query-surface->tool:query-surface:search", kind: "tool" },
    ]);
  });
});

/* ── FINDING (real bug surfaced by the port) ────────────────────────────────────
 * The framework's `agent.llm.end` sets `finishReason: "tool_calls"` when the turn
 * planned tool calls (packages/agent-runtime/src/runner/agent-runner.ts:325,777),
 * and the named-SSE adapter forwards it verbatim as `finish_reason`. But the
 * port's `planned()` predicate (trace-from-events.ts) tests `=== "tool_use"` — a
 * value NO runner emits. So on a real framework stream every model turn is
 * labelled "Composed the answer." even when it dispatched tools. Cosmetic (only
 * the model step's `detail`), but a genuine fold mismatch. The assertion below
 * is the CORRECT contract; it is pinned with `it.fails` (the assertion is NOT
 * weakened — `it.fails` passes BECAUSE the contract is currently violated, and
 * will turn RED the moment `planned()` is fixed, prompting a flip back to `it`). */
describe("FINDING: planned() does not recognize the framework's finish_reason", () => {
  it.fails(
    "SHOULD label a tool-planning model turn as 'Planned tool calls for this turn.' (currently does not)",
    () => {
      const steps = eventsToSteps(liveSingle, tools);
      const planningModel = steps.find((s) => s.kind === "model" && (s.emits?.length ?? 0) > 0);
      // A model turn that emitted tools SHOULD read as having planned them. With the
      // framework's real `finish_reason: "tool_calls"`, the port emits the answer
      // copy instead — see the FINDING note above.
      expect(planningModel?.detail).toBe("Planned tool calls for this turn.");
    },
  );
});
