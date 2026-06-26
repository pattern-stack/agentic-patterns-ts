/**
 * Fold the retrieval cockpit's event stream into the `TraceStep[]` contract the
 * constellation renders — the local analogue of swe-brain's run-trace-from-rows.
 *
 * Two wire shapes, ONE fold (per the blueprint event spec):
 *   (a) LIVE over SSE — the raw `AgentEvent` object, camelCase
 *       (`toolName`, `arguments`, `result`, `durationMs`, `delta`, `agentName`,
 *       `agentConfig`, `stepName`, `inputTokens/outputTokens`, `model`).
 *   (b) PERSISTED rows — promoted SNAKE_CASE columns (`tool_name`, `args_json`,
 *       `result_json`, `error`, `duration_ms`, `tokens`) PLUS `payload_json`
 *       whose keys are CAMELCASE (the whole event, untouched). So the fold reads
 *       the promoted column first, then the camelCase payload/live field.
 *
 * NOTE: this module is bundled for the browser — it must NOT import the server
 * store (which pulls bun:sqlite). The row shapes below are structural, matching
 * the JSON the /api/runs/:id endpoint returns.
 */
import type { BlastRadius, RunTrace, TraceStep } from "./types";

/** Persisted `event` row (subset) — promoted columns + the camelCase payload blob. */
export interface EventLike {
  type: string;
  seq?: number;
  tool_name?: string | null;
  tool_call_id?: string | null;
  args_json?: string | null;
  result_json?: string | null;
  error?: string | null;
  duration_ms?: number | null;
  tokens?: number | null;
  payload_json?: string;
  // live SSE objects carry camelCase fields directly:
  [k: string]: unknown;
}

/** Persisted `run` row (subset) — what the RunTrace envelope needs. */
export interface RunLike {
  id: string;
  question: string;
  model: string;
  mode?: string;
  system_prompt?: string | null;
  final_answer?: string | null;
  finish_reason?: string | null;
  status?: string;
  iterations?: number | null;
  tool_calls?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  elapsed_ms?: number | null;
}

/** tool name → {capability, blast} — built by composition.ts from the static inventory. */
export type ToolIndex = Map<string, { capabilityName: string; blast: BlastRadius }>;

/* ── accessors (column → camelCase payload → snake_case payload fallback) ──── */
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const safeJson = (s: unknown): unknown => {
  try {
    return typeof s === "string" ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
};

/** A normalized view of either wire shape: discriminate by the payload_json string. */
interface NormEvent {
  type: string;
  seq: number;
  col: Record<string, unknown>; // promoted snake_case columns (row) OR camelCase (live)
  p: Record<string, unknown>; // the camelCase event body
}
function normalize(e: EventLike, i: number): NormEvent {
  const isRow = typeof e.payload_json === "string" || "run_id" in e;
  const col = e as Record<string, unknown>;
  const p = isRow ? rec(safeJson(e.payload_json) ?? {}) : col;
  const seq = typeof e.seq === "number" ? e.seq : i;
  return { type: String(e.type), seq, col, p };
}

const toolNameOf = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  str(col.tool_name) ?? str(p.toolName) ?? str(p.tool_name);
const argsOf = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  p.arguments ?? safeJson(col.args_json) ?? p.args;
const resultOf = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  p.result ?? safeJson(col.result_json);
const errOf = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  str(col.error) ?? str(p.error) ?? str(p.message);
const durMs = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  num(col.duration_ms) ?? num(p.durationMs) ?? num(p.duration_ms) ?? 0;
const ctxTok = (p: Record<string, unknown>) => num(p.inputTokens) ?? num(p.input_tokens);
const outTok = (p: Record<string, unknown>) => num(p.outputTokens) ?? num(p.output_tokens);
const planned = (p: Record<string, unknown>): boolean =>
  typeof p.hasToolCalls === "boolean"
    ? p.hasToolCalls
    : (str(p.finishReason) ?? str(p.finish_reason)) === "tool_use";
// FOLD FIX 2(b): the framework streams bare `message.start {agent_name}` (snake_case),
// while persisted cockpit rows carry `agentName`. Read both so every live TraceStep
// carries its `agent` tag — without it `computeFrame`'s chain-mode tool reveal
// (owns: s.agent === agentLabel) never matches and tools never light.
const agentNameOf = (p: Record<string, unknown>) => str(p.agentName) ?? str(p.agent_name);

const bareType = (t: string): string => t.replace(/^(agent|pattern)\./, "");

/** Result row-count note for a tool result (`2 rows`), tolerant of non-arrays. */
function resultNote(result: unknown): string | undefined {
  if (Array.isArray(result)) return `${result.length} row${result.length === 1 ? "" : "s"}`;
  const r = rec(result);
  if (Array.isArray(r.ids)) return `${(r.ids as unknown[]).length} ids`;
  if (typeof r.total === "number") return `${r.total} total`;
  return undefined;
}

/**
 * Fold ordered events (rows OR live objects) into `TraceStep[]`. `terminal`
 * (default true) promotes the LAST `agent.message.complete` to a `finish` step —
 * pass `false` while a live stream is still arriving so the graph reads
 * "running" between phases, then re-fold with `true` on the `done` frame.
 */
export function eventsToSteps(
  events: EventLike[],
  tools: ToolIndex,
  opts: { terminal?: boolean } = {},
): TraceStep[] {
  const terminal = opts.terminal ?? true;
  const view = events.map(normalize).sort((a, b) => a.seq - b.seq);
  const steps: TraceStep[] = [];
  let iter = 0;
  let n = 0;
  let sawFirstStart = false;
  let curAgent: string | undefined;
  const push = (s: Omit<TraceStep, "seq">) => steps.push({ ...s, seq: ++n });

  // the last terminal completion in the stream → the `finish` step (no per-phase
  // END event exists; only the LAST message.complete closes the run).
  const lastCompleteIdx = terminal
    ? view.reduce((acc, v, i) => (bareType(v.type) === "message.complete" ? i : acc), -1)
    : -1;
  let errored = false;

  view.forEach(({ type, col, p }, i) => {
    switch (bareType(type)) {
      case "message.start": {
        const name = agentNameOf(p);
        if (!sawFirstStart) {
          sawFirstStart = true;
          curAgent = name;
          push({
            iter: 0,
            kind: "context",
            label: "Compile request context",
            ms: 0,
            detail: "System prompt + tool definitions assembled from the agent composition.",
            agent: name,
          });
        } else {
          // a sub-agent / pipeline phase boundary — iter restarts per sub-agent.
          curAgent = name;
          iter = 0;
        }
        break;
      }
      case "iteration.start": {
        const raw = num(p.iteration);
        iter = raw === undefined ? iter + 1 : raw + 1; // runtime emits 0-based
        break;
      }
      case "llm.end":
        push({
          iter: iter || 1,
          kind: "model",
          label: `Model call · iteration ${iter || 1}`,
          ms: durMs(col, p),
          ctxTokens: ctxTok(p),
          outTokens: outTok(p),
          detail: planned(p) ? "Planned tool calls for this turn." : "Composed the answer.",
          agent: curAgent,
        });
        break;
      case "tool.start": {
        const tool = toolNameOf(col, p);
        const meta = tool ? tools.get(tool) : undefined;
        push({
          iter: iter || 1,
          kind: "tool_call",
          tool,
          capability: meta?.capabilityName,
          blast: meta?.blast ?? "read",
          ms: durMs(col, p),
          args: argsOf(col, p),
          agent: curAgent,
        });
        break;
      }
      case "tool.end": {
        const tool = toolNameOf(col, p);
        const meta = tool ? tools.get(tool) : undefined;
        const out = resultOf(col, p);
        const isErr = !!errOf(col, p);
        if (isErr) errored = true;
        push({
          iter: iter || 1,
          kind: "tool_result",
          tool,
          capability: meta?.capabilityName,
          blast: meta?.blast ?? "read",
          ms: durMs(col, p),
          status: isErr ? "error" : "ok",
          output: out,
          note: isErr ? errOf(col, p) : resultNote(out),
          agent: curAgent,
        });
        break;
      }
      case "tool.rejected": {
        const tool = toolNameOf(col, p);
        const meta = tool ? tools.get(tool) : undefined;
        push({
          iter: iter || 1,
          kind: "tool_result",
          tool,
          capability: meta?.capabilityName,
          blast: meta?.blast ?? "external",
          ms: 0,
          status: "rejected",
          note: str(p.reason) ?? errOf(col, p),
          detail: str(p.reason),
          agent: curAgent,
        });
        break;
      }
      case "error":
        errored = true;
        push({
          iter: iter || 1,
          kind: "finish",
          label: "finishReason: error",
          ms: 0,
          status: "error",
          detail: errOf(col, p) ?? "Run errored.",
          agent: curAgent,
        });
        break;
      case "message.complete":
        if (i === lastCompleteIdx) {
          push({
            iter: iter || 1,
            kind: "finish",
            label: errored ? "finishReason: error" : "finishReason: stop",
            ms: 0,
            status: errored ? "error" : "ok",
            agent: curAgent,
          });
        }
        break;
      // chunk / iteration.end / llm.start / tool.intent / tool.progress /
      // reasoning / step.start → no own TraceStep (step.start drives handoff edges,
      // which the constellation derives structurally, not from the flat trace).
      default:
        break;
    }
  });

  backfillEmits(steps);
  return steps;
}

/** Each `model` step's `emits[]` = the tool names called in the same iter+agent. */
function backfillEmits(steps: TraceStep[]): void {
  for (const s of steps) {
    if (s.kind !== "model") continue;
    s.emits = steps
      .filter((t) => t.kind === "tool_call" && t.iter === s.iter && t.agent === s.agent && t.tool)
      .map((t) => t.tool as string);
  }
}

/** Compose the RunTrace envelope from a persisted run row + its events. */
export function rowsToRunTrace(run: RunLike, events: EventLike[], tools: ToolIndex): RunTrace {
  const errored = run.status === "error" || run.finish_reason === "error";
  const steps = eventsToSteps(events, tools, { terminal: true });
  const firstAgent =
    str(
      events.map((e) => normalize(e, 0)).find((v) => bareType(v.type) === "message.start")?.p
        ?.agentName,
    ) ??
    run.mode ??
    "agent";
  return {
    runId: run.id,
    agentName: firstAgent,
    model: run.model,
    request: run.question,
    result: {
      inputTokens: run.input_tokens ?? 0,
      outputTokens: run.output_tokens ?? 0,
      toolCallsCount: run.tool_calls ?? 0,
      iterations: run.iterations ?? 0,
      finishReason: run.finish_reason ?? (errored ? "error" : "stop"),
      totalMs: run.elapsed_ms ?? 0,
    },
    steps,
  };
}
