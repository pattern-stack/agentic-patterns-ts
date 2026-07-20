/**
 * Chat organism data model — the reusable Part-union + ChatMessage contract.
 * Ported from the cockpit chat; retargeted to the dashboard's FRAMEWORK SSE
 * vocabulary (post-`toEventLike` `EventLike` — flat `{ type, ...snake_case }`).
 *
 * One discriminated `Part` union covers every assistant emission — text,
 * thinking, tool calls, errors — so a single dispatcher renders any surface.
 * Messages are assembled INCREMENTALLY by `applyParts`: streaming is the
 * default mode, not an add-on.
 *
 * FOLD-FIX (vs the cockpit): the framework emits `message.delta` (not
 * `message.chunk`); the delta case aliases both. The tool/thinking/error cases
 * match the framework names verbatim (`tool.start|end|rejected`, `thinking`,
 * `thinking.complete`, `error`, `message.complete` — see api/sse-events.ts).
 *
 * This module is browser-bundled and dependency-free (no server imports).
 */
import type { EventLike } from "../graph/trace-from-events";
import {
  type StateDeltaPart,
  type StateRowPreview,
  type TravelRecord,
  stateDeltaFromFields,
} from "./state-accessors";

export type Role = "user" | "assistant";

export type Part =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string; complete: boolean }
  | {
      kind: "tool_call";
      id: string;
      name: string;
      arguments?: unknown;
      result?: unknown;
      error?: string;
      durationMs?: number;
      rejected?: boolean;
    }
  | {
      // A pipeline STAGE delegated to a sub-agent (agent.step.*) — rendered as an
      // AGENT, distinct from a tool the model called. `children` holds any
      // `tool_call` the delegated agent made (nested by parentSpanId).
      kind: "agent_step";
      id: string;
      name: string;
      agentName?: string;
      arguments?: unknown;
      result?: unknown;
      error?: string;
      durationMs?: number;
      children: Part[];
    }
  | {
      // A human-in-the-loop pause: the run is BLOCKED awaiting a decision
      // (an approval gate, or a tool asking the user to pick / type). Rendered
      // as an inline card that POSTs the answer back to unblock the run.
      kind: "input_request";
      correlationId: string;
      inputKind: "approval" | "select" | "text";
      prompt: string;
      options?: string[];
      toolName?: string;
      arguments?: unknown;
    }
  // A Backpack/Scratchpad mutation (#226) — one Δ/◇/⇄ frame per state event,
  // nested under the causing tool via tool_call_id, standalone at boundaries.
  // Shape defined in state-accessors.ts (shared with the Scratchpad rail fold).
  | StateDeltaPart
  // Render-time coalescing product (3+ consecutive explicit write frames from
  // one site fold into one summary card) — produced by `coalesceStateParts`,
  // never by `applyParts`.
  | { kind: "state_group"; parts: StateDeltaPart[] }
  // Gate-decision audit row (F-2, #324) — an allow/block record for a tool
  // intent, with its provenance (who settled it) and the evaluation trail.
  | {
      kind: "gate_decision";
      toolName: string;
      outcome: "allow" | "block";
      settledBy: string;
      blockedBy?: string;
      reason?: string;
      trail: { gate: string; result: string }[];
    }
  // Harness-native envelope (#323/#324) — a harness-specific event (compaction
  // boundary, subagent progress, rate-limit notice) shown as a collapsed panel.
  | { kind: "harness_native"; harness: string; name: string; payload: unknown }
  | { kind: "error"; errorType: string; message: string };

export interface ChatMessage {
  id: string;
  role: Role;
  parts: Part[];
  /** Wall-clock the turn began — drives the relative timestamp. ISO or epoch ms. */
  at?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** #324: total run cost in USD, when the harness reported it (CC runs only). */
  costUsd?: number;
  /** Live: content is still streaming into this message. */
  streaming?: boolean;
  /** Live: streaming was aborted by the user. */
  aborted?: boolean;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const safeJson = (s: unknown): unknown => {
  try {
    return typeof s === "string" ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
};

/** Strip the `agent.` / `pattern.` namespace so live + persisted types unify. */
const bare = (t: string): string => t.replace(/^(agent|pattern)\./, "");

/* Field accessors tolerant of BOTH wire shapes (live camelCase obj OR persisted
 * row with promoted snake_case columns + a camelCase payload_json blob). Mirrors
 * trace-from-events so the chat thread and the constellation read identically. */
function fields(e: EventLike): { p: Record<string, unknown>; col: Record<string, unknown> } {
  const isRow = typeof e.payload_json === "string" || "run_id" in e;
  const col = e as Record<string, unknown>;
  const p = isRow ? rec(safeJson(e.payload_json) ?? {}) : col;
  return { p, col };
}
const toolName = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  str(col.tool_name) ?? str(p.toolName) ?? str(p.tool_name) ?? "tool";
const toolId = (e: EventLike, col: Record<string, unknown>, p: Record<string, unknown>) =>
  str(e.tool_call_id) ?? str(p.toolCallId) ?? str(p.tool_call_id) ?? toolName(col, p);
const toolArgs = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  p.arguments ?? safeJson(col.args_json) ?? p.args;
const toolResult = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  p.result ?? safeJson(col.result_json);
const toolErr = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  str(col.error) ?? str(p.error) ?? str(p.message);
const durMs = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  num(col.duration_ms) ?? num(p.durationMs) ?? num(p.duration_ms);
const stepName = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  str(col.step_name) ?? str(p.stepName) ?? str(p.step_name) ?? "step";
const agentName = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  str(col.agent_name) ?? str(p.agentName) ?? str(p.agent_name);
const spanId = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  str(col.span_id) ?? str(p.spanId) ?? str(p.span_id);
const parentSpanId = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  str(col.parent_span_id) ?? str(p.parentSpanId) ?? str(p.parent_span_id);

/* Where a child (tool) part lives: nested in the agent_step whose id matches the
 * event's parentSpanId, else the top-level list. Returns the list to read + an
 * immutable writer that folds a new list back into `next`. This is what makes a
 * delegated agent's tool calls render UNDER their step, not as siblings. */
function childTarget(
  next: Part[],
  parent: string | undefined,
): { list: Part[]; write: (list: Part[]) => Part[] } {
  if (parent != null) {
    const idx = next.findIndex((pt) => pt.kind === "agent_step" && pt.id === parent);
    if (idx >= 0) {
      const step = next[idx] as Extract<Part, { kind: "agent_step" }>;
      return {
        list: step.children,
        write: (children) => {
          const copy = next.slice();
          copy[idx] = { ...step, children };
          return copy;
        },
      };
    }
  }
  return { list: next, write: (list) => list };
}

/* ── state-delta placement (#226) ───────────────────────────────────────────
 * A state frame nests UNDER its causing tool: inserted immediately after the
 * `tool_call` part whose id matches the event's tool_call_id (searched at the
 * top level, then inside every agent_step's children), after any frames that
 * tool already caused (arrival order preserved). No tool anchor → standalone
 * append at the end (boundary frames: innate stage writes, fork/join, reads).
 * `next` is the caller's fresh copy — top-level splices are safe; a nested
 * step's children array is copied before insertion (immutability for React).
 */

/** Count prior DropRecords (drops + absorbs) for a pack — mints `dropSeq`. */
export function countDropFrames(parts: Part[], key: string): number {
  let n = 0;
  for (const pt of parts) {
    if (pt.kind === "state_delta" && (pt.op === "drop" || pt.op === "absorb") && pt.key === key)
      n++;
    else if (pt.kind === "agent_step") n += countDropFrames(pt.children, key);
    else if (pt.kind === "state_group") n += countDropFrames(pt.parts, key);
  }
  return n;
}

/** Insertion point just past the anchor tool and any frames it already caused. */
function afterToolDeltas(list: Part[], anchorIdx: number, toolCallId: string): number {
  let at = anchorIdx + 1;
  while (at < list.length) {
    const pt = list[at];
    if (pt && pt.kind === "state_delta" && pt.toolCallId === toolCallId) at++;
    else break;
  }
  return at;
}

function insertStateDelta(next: Part[], frame: StateDeltaPart): Part[] {
  const enriched: StateDeltaPart =
    frame.op === "drop" || frame.op === "absorb"
      ? { ...frame, dropSeq: countDropFrames(next, frame.key) }
      : frame;
  const tid = enriched.toolCallId;
  if (tid != null) {
    const at = next.findIndex((pt) => pt.kind === "tool_call" && pt.id === tid);
    if (at >= 0) {
      const anchor = next[at] as Extract<Part, { kind: "tool_call" }>;
      next.splice(afterToolDeltas(next, at, tid), 0, { ...enriched, via: anchor.name });
      return next;
    }
    for (let i = 0; i < next.length; i++) {
      const step = next[i];
      if (!step || step.kind !== "agent_step") continue;
      const cat = step.children.findIndex((pt) => pt.kind === "tool_call" && pt.id === tid);
      if (cat < 0) continue;
      const anchor = step.children[cat] as Extract<Part, { kind: "tool_call" }>;
      const children = step.children.slice();
      children.splice(afterToolDeltas(children, cat, tid), 0, { ...enriched, via: anchor.name });
      next[i] = { ...step, children };
      return next;
    }
  }
  next.push(enriched);
  return next;
}

/* ── TRAVEL derivation (#226, v1: UI-derived — no runtime emitter) ──────────
 * At each top-level stage boundary (`step.start` with no parent span), every
 * pack that has received drops "travels" into the new stage: one ⇄ frame per
 * key, summarizing the manifest (records + covered counts + latest previews).
 * A pack unchanged since its last travel frame renders the honest quiet
 * variant ("no new drops since <stage>") instead of pretending motion.
 */

interface PackCarry {
  items: number;
  records: TravelRecord[];
  previews: Map<number, string>;
  sinceStep?: string;
}

function collectCarry(
  parts: Part[],
  stepName: string | undefined,
  packs: Map<string, PackCarry>,
  travels: Map<string, { records: number; items: number }>,
): void {
  for (const pt of parts) {
    if (pt.kind === "agent_step") {
      collectCarry(pt.children, pt.name, packs, travels);
      continue;
    }
    if (pt.kind === "state_group") {
      collectCarry(pt.parts, stepName, packs, travels);
      continue;
    }
    if (pt.kind !== "state_delta") continue;
    if (pt.op === "drop" || pt.op === "absorb") {
      let entry = packs.get(pt.key);
      if (!entry) {
        entry = { items: 0, records: [], previews: new Map() };
        packs.set(pt.key, entry);
      }
      entry.items = pt.sizeAfter;
      entry.records.push({
        drop: entry.records.length,
        covered: pt.op === "drop" ? pt.indexes.length : pt.appendedIndexes.length,
      });
      if (pt.op === "drop")
        for (const row of pt.previews) entry.previews.set(row.index, row.preview);
      if (stepName) entry.sinceStep = stepName;
    } else if (pt.op === "travel") {
      travels.set(pt.key, { records: pt.records.length, items: pt.items });
    }
  }
}

function deriveTravelParts(parts: Part[], toStep: string): StateDeltaPart[] {
  const packs = new Map<string, PackCarry>();
  const travels = new Map<string, { records: number; items: number }>();
  collectCarry(parts, undefined, packs, travels);
  const out: StateDeltaPart[] = [];
  for (const [key, carry] of packs) {
    const prior = travels.get(key);
    const quiet =
      prior != null && prior.records === carry.records.length && prior.items === carry.items;
    const previews: StateRowPreview[] = [...carry.previews.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, preview]) => ({ index, op: "added" as const, preview }));
    out.push({
      kind: "state_delta",
      op: "travel",
      key,
      origin: "innate",
      derived: true,
      toStep,
      items: carry.items,
      records: carry.records,
      previews,
      ...(quiet ? { quiet: true } : {}),
      ...(quiet && carry.sinceStep ? { sinceStep: carry.sinceStep } : {}),
    });
  }
  return out;
}

/* ── render-time coalescing (#226) ──────────────────────────────────────────
 * 3+ CONSECUTIVE explicit write frames (drop / write / absorb, uninterrupted
 * by any other part — i.e. one write site: a Loop body, a parallel-drop tool)
 * fold into one expandable `state_group` summary. Reads, travel frames, and
 * innate frames break runs and never coalesce — a stage boundary's frame trio
 * stays legible. Pure derived view: `applyParts` output is untouched; callers
 * (MessageRow) apply this at render.
 */

const isCoalescible = (pt: Part): pt is StateDeltaPart =>
  pt.kind === "state_delta" &&
  pt.origin === "explicit" &&
  (pt.op === "drop" || pt.op === "write" || pt.op === "absorb");

export function coalesceStateParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  let run: StateDeltaPart[] = [];
  const flush = () => {
    if (run.length >= 3) out.push({ kind: "state_group", parts: run });
    else out.push(...run);
    run = [];
  };
  for (const pt of parts) {
    if (isCoalescible(pt)) {
      run.push(pt);
      continue;
    }
    flush();
    out.push(pt.kind === "agent_step" ? { ...pt, children: coalesceStateParts(pt.children) } : pt);
  }
  flush();
  return out;
}

/* ── incremental reducer ────────────────────────────────────────────────────
 * applyParts folds ONE SSE event into an assistant message's parts, in place of
 * arrival order. Returns a NEW parts array (immutable for React). This is the
 * streaming-first core: each frame mutates exactly the affected part.
 */
export function applyParts(
  parts: Part[],
  e: EventLike,
): { parts: Part[]; meta?: Partial<ChatMessage> } {
  const { p, col } = fields(e);
  const next = parts.slice();
  const last = next[next.length - 1];

  switch (bare(String(e.type))) {
    // FOLD-FIX: framework emits `message.delta`; keep `message.chunk` as alias
    // for the persisted/cockpit lineage. Same body.
    case "message.delta":
    case "message.chunk": {
      const delta = str(e.delta) ?? str(p.delta) ?? str(p.content);
      if (delta == null) return { parts };
      if (last && last.kind === "text")
        next[next.length - 1] = { kind: "text", content: last.content + delta };
      else next.push({ kind: "text", content: delta });
      return { parts: next };
    }
    case "reasoning":
    case "thinking": {
      const content = str(p.content) ?? str(p.delta) ?? str(e.delta) ?? "";
      if (last && last.kind === "thinking" && !last.complete)
        next[next.length - 1] = {
          kind: "thinking",
          content: last.content + content,
          complete: false,
        };
      else next.push({ kind: "thinking", content, complete: false });
      return { parts: next };
    }
    case "thinking.complete":
    case "reasoning.complete": {
      for (let i = next.length - 1; i >= 0; i--) {
        const part = next[i];
        if (part && part.kind === "thinking") {
          const content = str(p.content) ?? part.content;
          next[i] = { kind: "thinking", content, complete: true };
          break;
        }
      }
      return { parts: next };
    }
    // Step / delegation lifecycle — a pipeline stage delegated to a sub-agent.
    // Rendered as an AGENT (kind: agent_step), keyed by its span id so start/end
    // upsert and child tool calls can nest under it.
    case "step.start": {
      const id = spanId(col, p) ?? stepName(col, p);
      if (next.some((part) => part.kind === "agent_step" && part.id === id)) return { parts };
      // #226: a TOP-LEVEL stage boundary — any pack dropped into so far
      // "travels" into the new stage (UI-derived ⇄ frames; nested sub-steps
      // carry a parent span and don't re-announce the pack).
      if (parentSpanId(col, p) == null) next.push(...deriveTravelParts(next, stepName(col, p)));
      next.push({
        kind: "agent_step",
        id,
        name: stepName(col, p),
        agentName: agentName(col, p),
        arguments: toolArgs(col, p),
        children: [],
      });
      return { parts: next };
    }
    case "step.end": {
      const id = spanId(col, p) ?? stepName(col, p);
      const idx = next.findIndex((part) => part.kind === "agent_step" && part.id === id);
      const existing = idx >= 0 ? (next[idx] as Extract<Part, { kind: "agent_step" }>) : undefined;
      const filled: Part = {
        kind: "agent_step",
        id,
        name: stepName(col, p),
        agentName: agentName(col, p) ?? existing?.agentName,
        arguments: existing?.arguments ?? toolArgs(col, p),
        result: toolResult(col, p),
        error: str(col.error) ?? str(p.error),
        durationMs: durMs(col, p),
        children: existing?.children ?? [],
      };
      if (idx >= 0) next[idx] = filled;
      else next.push(filled);
      return { parts: next };
    }
    case "tool.start":
    case "tool.intent": {
      const id = toolId(e, col, p);
      const { list, write } = childTarget(next, parentSpanId(col, p));
      // tool.intent then tool.start can both fire — upsert by id, don't double.
      if (list.some((part) => part.kind === "tool_call" && part.id === id)) return { parts };
      return {
        parts: write(
          list.concat({
            kind: "tool_call",
            id,
            name: toolName(col, p),
            arguments: toolArgs(col, p),
          }),
        ),
      };
    }
    case "tool.end": {
      const id = toolId(e, col, p);
      const { list, write } = childTarget(next, parentSpanId(col, p));
      const err = toolErr(col, p);
      const idx = list.findIndex((part) => part.kind === "tool_call" && part.id === id);
      const existing = idx >= 0 ? (list[idx] as Extract<Part, { kind: "tool_call" }>) : undefined;
      const filled: Part = {
        kind: "tool_call",
        id,
        name: toolName(col, p),
        arguments: existing ? existing.arguments : toolArgs(col, p),
        result: toolResult(col, p),
        error: err,
        durationMs: durMs(col, p),
      };
      const copy = list.slice();
      if (idx >= 0) copy[idx] = filled;
      else copy.push(filled);
      return { parts: write(copy) };
    }
    case "tool.rejected": {
      const id = toolId(e, col, p);
      const { list, write } = childTarget(next, parentSpanId(col, p));
      const reason = str(p.reason) ?? toolErr(col, p) ?? "rejected";
      const idx = list.findIndex((part) => part.kind === "tool_call" && part.id === id);
      const filled: Part = {
        kind: "tool_call",
        id,
        name: toolName(col, p),
        error: reason,
        rejected: true,
      };
      const copy = list.slice();
      if (idx >= 0) copy[idx] = filled;
      else copy.push(filled);
      return { parts: write(copy) };
    }
    // Human-in-the-loop request — the run is blocked awaiting a decision. Push
    // an inline card (dedupe by correlationId; a re-delivered request is a
    // no-op). The card component resolves it via POST /conversations/:id/input.
    case "input.request": {
      const correlationId =
        str(col.correlation_id) ?? str(p.correlationId) ?? str(p.correlation_id);
      if (correlationId == null) return { parts };
      if (next.some((pt) => pt.kind === "input_request" && pt.correlationId === correlationId))
        return { parts };
      const rawKind = str(col.kind) ?? str(p.kind);
      const inputKind: "approval" | "select" | "text" =
        rawKind === "select" || rawKind === "text" ? rawKind : "approval";
      const rawOptions = col.options ?? p.options;
      next.push({
        kind: "input_request",
        correlationId,
        inputKind,
        prompt: str(col.prompt) ?? str(p.prompt) ?? "Approval required",
        options: Array.isArray(rawOptions)
          ? rawOptions.filter((o): o is string => typeof o === "string")
          : undefined,
        toolName: str(col.tool_name) ?? str(p.toolName) ?? str(p.tool_name),
        arguments: toolArgs(col, p),
      });
      return { parts: next };
    }
    // State-delta events (#226) — one Δ/◇ frame per Backpack/Scratchpad
    // mutation, built by the shared tolerant accessor module (state-accessors,
    // also consumed by the Scratchpad rail fold so the surfaces never drift).
    case "backpack.drop":
    case "backpack.read":
    case "backpack.absorb":
    case "scratchpad.write":
    case "scratchpad.read":
    case "scratchpad.fork":
    case "scratchpad.join": {
      const frame = stateDeltaFromFields(bare(String(e.type)), { ...col, ...p });
      if (!frame) return { parts };
      return { parts: insertStateDelta(next, frame) };
    }
    case "error": {
      next.push({
        kind: "error",
        errorType: str(p.errorType) ?? str(p.error_type) ?? "error",
        message: toolErr(col, p) ?? "Run errored.",
      });
      return { parts: next };
    }
    case "message.complete":
    case "llm.end": {
      const meta: Partial<ChatMessage> = {};
      const model = str(p.model);
      const inT = num(p.inputTokens) ?? num(p.input_tokens);
      const outT = num(p.outputTokens) ?? num(p.output_tokens);
      // #324: cost rides on message.complete only (llm.end carries none). Read
      // both wire (snake_case `cost_usd`) and persisted (camelCase `costUsd`).
      const cost = num(p.costUsd) ?? num(p.cost_usd);
      if (model) meta.model = model;
      if (inT != null) meta.inputTokens = inT;
      if (outT != null) meta.outputTokens = outT;
      if (cost != null) meta.costUsd = cost;
      return { parts, meta: Object.keys(meta).length ? meta : undefined };
    }
    // Gate-decision audit row (F-2, #324) — one allow/block record per intent.
    case "gate.decision": {
      const rawTrail = Array.isArray(col.trail) ? col.trail : Array.isArray(p.trail) ? p.trail : [];
      const trail = rawTrail
        .map((t) => {
          const r = rec(t);
          const gate = str(r.gate);
          const result = str(r.result);
          return gate && result ? { gate, result } : undefined;
        })
        .filter((t): t is { gate: string; result: string } => t != null);
      next.push({
        kind: "gate_decision",
        toolName: str(col.tool_name) ?? str(p.toolName) ?? str(p.tool_name) ?? "tool",
        outcome: (str(col.outcome) ?? str(p.outcome)) === "block" ? "block" : "allow",
        settledBy: str(col.settled_by) ?? str(p.settledBy) ?? str(p.settled_by) ?? "gate",
        blockedBy: str(col.blocked_by) ?? str(p.blockedBy) ?? str(p.blocked_by),
        reason: str(col.reason) ?? str(p.reason),
        trail,
      });
      return { parts: next };
    }
    // Harness-native envelope (#323/#324) — passthrough, shown as a collapsed panel.
    case "harness.native": {
      next.push({
        kind: "harness_native",
        harness: str(col.harness) ?? str(p.harness) ?? "harness",
        name: str(col.name) ?? str(p.name) ?? "native",
        payload: p.payload ?? col.payload,
      });
      return { parts: next };
    }
    default:
      return { parts };
  }
}

/**
 * Fold a COMPLETE event list into a single assistant message — for replaying a
 * persisted run or seeding a thread. Same fold as the live reducer, run to end.
 */
export function eventsToAssistantMessage(
  id: string,
  events: EventLike[],
  at?: number,
): ChatMessage {
  let parts: Part[] = [];
  let meta: Partial<ChatMessage> = {};
  const sorted = events.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const e of sorted) {
    const r = applyParts(parts, e);
    parts = r.parts;
    if (r.meta) meta = { ...meta, ...r.meta };
  }
  return { id, role: "assistant", parts, at, ...meta };
}

/** Convenience constructor for a plain text message. */
export function textMessage(id: string, role: Role, content: string, at?: number): ChatMessage {
  return { id, role, parts: [{ kind: "text", content }], at };
}
