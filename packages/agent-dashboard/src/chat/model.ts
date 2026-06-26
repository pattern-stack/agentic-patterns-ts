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
import type { EventLike } from '../graph/trace-from-events';

export type Role = 'user' | 'assistant';

export type Part =
  | { kind: 'text'; content: string }
  | { kind: 'thinking'; content: string; complete: boolean }
  | {
      kind: 'tool_call';
      id: string;
      name: string;
      arguments?: unknown;
      result?: unknown;
      error?: string;
      durationMs?: number;
      rejected?: boolean;
    }
  | { kind: 'error'; errorType: string; message: string };

export interface ChatMessage {
  id: string;
  role: Role;
  parts: Part[];
  /** Wall-clock the turn began — drives the relative timestamp. ISO or epoch ms. */
  at?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Live: content is still streaming into this message. */
  streaming?: boolean;
  /** Live: streaming was aborted by the user. */
  aborted?: boolean;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const safeJson = (s: unknown): unknown => {
  try {
    return typeof s === 'string' ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
};

/** Strip the `agent.` / `pattern.` namespace so live + persisted types unify. */
const bare = (t: string): string => t.replace(/^(agent|pattern)\./, '');

/* Field accessors tolerant of BOTH wire shapes (live camelCase obj OR persisted
 * row with promoted snake_case columns + a camelCase payload_json blob). Mirrors
 * trace-from-events so the chat thread and the constellation read identically. */
function fields(e: EventLike): { p: Record<string, unknown>; col: Record<string, unknown> } {
  const isRow = typeof e.payload_json === 'string' || 'run_id' in e;
  const col = e as Record<string, unknown>;
  const p = isRow ? rec(safeJson(e.payload_json) ?? {}) : col;
  return { p, col };
}
const toolName = (col: Record<string, unknown>, p: Record<string, unknown>) =>
  str(col.tool_name) ?? str(p.toolName) ?? str(p.tool_name) ?? 'tool';
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

/* ── incremental reducer ────────────────────────────────────────────────────
 * applyParts folds ONE SSE event into an assistant message's parts, in place of
 * arrival order. Returns a NEW parts array (immutable for React). This is the
 * streaming-first core: each frame mutates exactly the affected part.
 */
export function applyParts(parts: Part[], e: EventLike): { parts: Part[]; meta?: Partial<ChatMessage> } {
  const { p, col } = fields(e);
  const next = parts.slice();
  const last = next[next.length - 1];

  switch (bare(String(e.type))) {
    // FOLD-FIX: framework emits `message.delta`; keep `message.chunk` as alias
    // for the persisted/cockpit lineage. Same body.
    case 'message.delta':
    case 'message.chunk': {
      const delta = str(e.delta) ?? str(p.delta) ?? str(p.content);
      if (delta == null) return { parts };
      if (last && last.kind === 'text') next[next.length - 1] = { kind: 'text', content: last.content + delta };
      else next.push({ kind: 'text', content: delta });
      return { parts: next };
    }
    case 'reasoning':
    case 'thinking': {
      const content = str(p.content) ?? str(p.delta) ?? str(e.delta) ?? '';
      if (last && last.kind === 'thinking' && !last.complete)
        next[next.length - 1] = { kind: 'thinking', content: last.content + content, complete: false };
      else next.push({ kind: 'thinking', content, complete: false });
      return { parts: next };
    }
    case 'thinking.complete':
    case 'reasoning.complete': {
      for (let i = next.length - 1; i >= 0; i--) {
        const part = next[i];
        if (part && part.kind === 'thinking') {
          const content = str(p.content) ?? part.content;
          next[i] = { kind: 'thinking', content, complete: true };
          break;
        }
      }
      return { parts: next };
    }
    case 'tool.start':
    case 'tool.intent': {
      const id = toolId(e, col, p);
      // tool.intent then tool.start can both fire — upsert by id, don't double.
      if (next.some((part) => part.kind === 'tool_call' && part.id === id)) return { parts };
      next.push({ kind: 'tool_call', id, name: toolName(col, p), arguments: toolArgs(col, p) });
      return { parts: next };
    }
    case 'tool.end': {
      const id = toolId(e, col, p);
      const err = toolErr(col, p);
      const idx = next.findIndex((part) => part.kind === 'tool_call' && part.id === id);
      const existing = idx >= 0 ? (next[idx] as Extract<Part, { kind: 'tool_call' }>) : undefined;
      const filled: Part = {
        kind: 'tool_call',
        id,
        name: toolName(col, p),
        arguments: existing ? existing.arguments : toolArgs(col, p),
        result: toolResult(col, p),
        error: err,
        durationMs: durMs(col, p),
      };
      if (idx >= 0) next[idx] = filled;
      else next.push(filled);
      return { parts: next };
    }
    case 'tool.rejected': {
      const id = toolId(e, col, p);
      const reason = str(p.reason) ?? toolErr(col, p) ?? 'rejected';
      const idx = next.findIndex((part) => part.kind === 'tool_call' && part.id === id);
      const filled: Part = { kind: 'tool_call', id, name: toolName(col, p), error: reason, rejected: true };
      if (idx >= 0) next[idx] = filled;
      else next.push(filled);
      return { parts: next };
    }
    case 'error': {
      next.push({
        kind: 'error',
        errorType: str(p.errorType) ?? str(p.error_type) ?? 'error',
        message: toolErr(col, p) ?? 'Run errored.',
      });
      return { parts: next };
    }
    case 'message.complete':
    case 'llm.end': {
      const meta: Partial<ChatMessage> = {};
      const model = str(p.model);
      const inT = num(p.inputTokens) ?? num(p.input_tokens);
      const outT = num(p.outputTokens) ?? num(p.output_tokens);
      if (model) meta.model = model;
      if (inT != null) meta.inputTokens = inT;
      if (outT != null) meta.outputTokens = outT;
      return { parts, meta: Object.keys(meta).length ? meta : undefined };
    }
    default:
      return { parts };
  }
}

/**
 * Fold a COMPLETE event list into a single assistant message — for replaying a
 * persisted run or seeding a thread. Same fold as the live reducer, run to end.
 */
export function eventsToAssistantMessage(id: string, events: EventLike[], at?: number): ChatMessage {
  let parts: Part[] = [];
  let meta: Partial<ChatMessage> = {};
  const sorted = events.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const e of sorted) {
    const r = applyParts(parts, e);
    parts = r.parts;
    if (r.meta) meta = { ...meta, ...r.meta };
  }
  return { id, role: 'assistant', parts, at, ...meta };
}

/** Convenience constructor for a plain text message. */
export function textMessage(id: string, role: Role, content: string, at?: number): ChatMessage {
  return { id, role, parts: [{ kind: 'text', content }], at };
}
