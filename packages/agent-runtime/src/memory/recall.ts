/**
 * Recall assembler — the turn-1 recall surface (#422, ADR-0007 D8a +
 * §"Recall assembly").
 *
 * TURN-1 ORDERING (pinned): the HOST calls {@link assembleRecall} at
 * FIRST-MESSAGE time — when the first user text exists to serve as `query` —
 * NOT at conversation creation, and passes `result.block` via
 * `RenderContext.recall` into `agent.renderInitialPrompt({ scope, recall })`.
 * Render purity is a hard gate (ADR-0005): this function is the ONE place
 * recall fetching, formatting, and budgeting live; core only places the
 * finished string (`Awareness.fromRecall`).
 *
 * Assembly order is fixed: profile-kind records first, then (optionally)
 * pinned targeted candidates, then search hits against the first user text.
 * Reads honor the reserved `agent` scope-key convention (ADR-0008 D8) via the
 * same post-filter as MemoryToolbox. Truncation is marked in the block, never
 * silent (house rule). Emits `agent.memory.recall` — host-side, so the caller
 * supplies correlation explicitly (no ToolExecutionContext exists here).
 */

import {
  type MemoryHit,
  type MemoryRecord,
  type MemoryScope,
  MemoryScopeSchema,
  canonicalMemoryScope,
} from "@agentic-patterns/core";
import type { EventBus } from "../events/event-bus.js";
import { createEvent } from "../events/types.js";
import { capPreview } from "../workflows/state-events.js";
import type { MemoryStore } from "./store.js";
import { RESERVED_AGENT_SCOPE_KEY, matchesAgentConvention } from "./toolbox.js";

/** Default recall character budget (guide.md §Recall tuning; issue pin: chars, not tokens). */
export const DEFAULT_RECALL_BUDGET_CHARS = 4000;

/** Correlation + bus for the agent.memory.recall emission — host-supplied (host-side, no ToolExecutionContext exists here). */
export interface RecallEmitOptions {
  bus: EventBus;
  traceId: string;
  runId: string;
  parentSpanId?: string;
}

export interface AssembleRecallOptions {
  /** Character budget for the WHOLE block, header + marker included. Positive integer. @default 4000 */
  budgetChars?: number;
  /** The first user text. Absent ⇒ the hits tier is a filtered, recency-ordered listing. */
  query?: string;
  /**
   * Reserved slots for targeted candidate records (ADR-0008 D4 "candidates
   * earn exposure" — forward hook only; no promotion machinery). Up to this
   * many valid records with `target !== undefined`, newest first, are
   * included between the profile tier and the hits tier. @default 0 (off)
   */
  pinCandidates?: number;
  /** When provided, emits agent.memory.recall (best-effort: awaited, errors swallowed). */
  emit?: RecallEmitOptions;
}

export interface RecallResult {
  /** The finished block for RenderContext.recall — "" when nothing was recalled (or nothing fit). */
  block: string;
  /** Records included in the block (excludes budget-omitted records). */
  count: number;
  /** block.length — always <= budgetChars. */
  chars: number;
  /** True when the budget clipped the assembly (marker present in a non-empty block). */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Module-private constants (documented bounds)
// ---------------------------------------------------------------------------

const PROFILE_FETCH_LIMIT = 50; // profile tier page — a scope holding more has bloated (guide: "at most a handful")
const CANDIDATE_FETCH_LIMIT = 100; // pinned-candidate scan page (targeted records are rare in v1)
const RECALL_SEARCH_LIMIT = 20; // hits tier page — the char budget is the real cap

/** The fixed block scaffold — header + framing line, each tier's entries follow. */
const SCAFFOLD_LINES: readonly string[] = [
  "## Recalled Memories",
  "",
  "From prior sessions, most relevant first — verify anything that may have changed:",
  "",
];

/** One block entry per record — kind + UTC date (store-assigned `createdAt` is `toISOString()`). */
function formatEntry(record: MemoryRecord): string {
  return `- [${record.kind} · ${record.createdAt.slice(0, 10)}] ${record.content}`;
}

/** Truncation marker line — always the block's final line when the budget clipped (never silent). */
function truncationMarker(omitted: number): string {
  return `… [recall budget reached — ${omitted} more record(s) omitted]`;
}

/**
 * Assemble the turn-1 recall block (ADR-0007 D8a + §Recall assembly).
 *
 * TURN-1 ORDERING (pinned): the HOST calls this at FIRST-MESSAGE time — when
 * the first user text exists to serve as `query` — NOT at conversation
 * creation, and passes `result.block` via `RenderContext.recall` into
 * `agent.renderInitialPrompt({ scope, recall })`. Render purity is a hard
 * gate (ADR-0005): this function is the ONE place recall fetching, formatting,
 * and budgeting live; core only places the finished string.
 *
 * Profile-kind records first, then (optionally) pinned targeted candidates,
 * then search hits. Reads honor the reserved `agent` scope-key convention
 * (ADR-0008 D8) via the same post-filter as MemoryToolbox. Truncation is
 * marked in the block, never silent (house rule).
 */
export async function assembleRecall(
  store: MemoryStore,
  scope: MemoryScope,
  options?: AssembleRecallOptions,
): Promise<RecallResult> {
  // 1. Validate scope — empty would make recall an unscoped search.
  const bound = canonicalMemoryScope(MemoryScopeSchema.parse(scope));
  if (Object.keys(bound).length === 0) {
    throw new Error(
      "assembleRecall requires a non-empty partition scope — an empty scope is an unscoped search (ADR-0007)",
    );
  }

  // 2. Validate knobs.
  const budgetChars = options?.budgetChars ?? DEFAULT_RECALL_BUDGET_CHARS;
  if (!Number.isInteger(budgetChars) || budgetChars <= 0) {
    throw new Error(`assembleRecall budgetChars must be a positive integer, got ${budgetChars}`);
  }
  const pinCandidates = options?.pinCandidates ?? 0;
  if (!Number.isInteger(pinCandidates) || pinCandidates < 0) {
    throw new Error(
      `assembleRecall pinCandidates must be a non-negative integer, got ${pinCandidates}`,
    );
  }

  // 3. Derive the read filter exactly as MemoryToolbox does: the bound scope
  //    minus the reserved `agent` key. Subset-matching with `agent` IN the
  //    filter would exclude shared agent-unset records — the exact ADR-0008
  //    D8 problem; fetches use this filter plus the matchesAgentConvention
  //    post-filter instead. Same documented v1 consequence as the toolbox:
  //    no over-fetch compensation — a page may yield fewer than `limit`
  //    records after the post-filter.
  const me = bound[RESERVED_AGENT_SCOPE_KEY];
  const readFilter = canonicalMemoryScope(
    Object.fromEntries(Object.entries(bound).filter(([key]) => key !== RESERVED_AGENT_SCOPE_KEY)),
  );
  const visible = (hits: MemoryHit[]): MemoryRecord[] =>
    hits.map((hit) => hit.record).filter((record) => matchesAgentConvention(record.scope, me));

  // 4. Fetch tiers, dedupe by record id in tier order.
  const included = new Map<string, MemoryRecord>();

  // Profile tier — no `query`, so recency-ordered per the D5 listing contract.
  const profiles = visible(
    await store.search({ scope: readFilter, kinds: ["profile"], limit: PROFILE_FETCH_LIMIT }),
  );
  for (const record of profiles) {
    if (!included.has(record.id)) included.set(record.id, record);
  }

  // Pinned-candidate tier (ADR-0008 D4 exposure — recency-ordered; the ADR's
  // "recency-rotated" needs state and is deferred past v1).
  if (pinCandidates > 0) {
    const candidates = visible(
      await store.search({ scope: readFilter, limit: CANDIDATE_FETCH_LIMIT }),
    ).filter((record) => record.target !== undefined && !included.has(record.id));
    for (const record of candidates.slice(0, pinCandidates)) {
      included.set(record.id, record);
    }
  }

  // Hits tier — with `query` absent this is deliberately the recency listing
  // (guide: "without it, profile + recency listing only").
  const query = options?.query;
  const hits = visible(
    await store.search({
      ...(query !== undefined ? { query } : {}),
      scope: readFilter,
      limit: RECALL_SEARCH_LIMIT,
    }),
  );
  for (const record of hits) {
    if (!included.has(record.id)) included.set(record.id, record);
  }

  // 5+6. Format under the budget — whole-record granularity, marker counts
  // against the budget (capPreview precedent: never exceed the cap).
  const result = buildBlock([...included.values()], budgetChars);

  // 7. Emit when wired — best-effort, awaited (deterministic tests), never
  //    throws (fire-and-forget sink — mirror toolbox._emit). "Nothing
  //    recalled" is a signal, so the emission fires on empty results too.
  const emit = options?.emit;
  if (emit !== undefined) {
    try {
      await emit.bus.publish(
        createEvent("agent.memory.recall", {
          traceId: emit.traceId,
          runId: emit.runId,
          ...(emit.parentSpanId !== undefined ? { parentSpanId: emit.parentSpanId } : {}),
          // The full canonical bound scope, agent key included (mirrors MemoryWriteEvent).
          scope: bound,
          count: result.count,
          chars: result.chars,
          budgetChars,
          truncated: result.truncated,
          preview: capPreview(result.block),
        }),
      );
    } catch {
      // Swallow — emit is a fire-and-forget sink.
    }
  }

  return result;
}

/**
 * Greedy whole-record assembly under `budgetChars`. Entries append while they
 * fit; the first entry that does not fit stops assembly. When anything was
 * omitted the marker line is appended — and counts against the budget, so
 * already-included entries are dropped (last first) until it fits. A
 * non-empty block always satisfies `block.length <= budgetChars`.
 */
function buildBlock(records: MemoryRecord[], budgetChars: number): RecallResult {
  if (records.length === 0) {
    return { block: "", count: 0, chars: 0, truncated: false };
  }

  const scaffold = SCAFFOLD_LINES.join("\n");
  const entries = records.map(formatEntry);

  const kept: string[] = [];
  let running = scaffold.length;
  for (const entry of entries) {
    if (running + 1 + entry.length > budgetChars) break; // first non-fit stops assembly
    kept.push(entry);
    running += 1 + entry.length;
  }
  let omitted = entries.length - kept.length;

  if (omitted === 0) {
    const block = [...SCAFFOLD_LINES, ...kept].join("\n");
    return { block, count: kept.length, chars: block.length, truncated: false };
  }

  // Budget clipped: the marker must fit too — drop included entries (last
  // first, recomputing the marker) until it does.
  let marker = truncationMarker(omitted);
  while (running + 1 + marker.length > budgetChars && kept.length > 0) {
    const dropped = kept.pop();
    if (dropped === undefined) break;
    running -= 1 + dropped.length;
    omitted += 1;
    marker = truncationMarker(omitted);
  }
  if (running + 1 + marker.length > budgetChars) {
    // Degenerate budget: even scaffold + marker exceed it. Nothing rendered
    // is better than an over-budget or unmarked block.
    return { block: "", count: 0, chars: 0, truncated: true };
  }
  const block = [...SCAFFOLD_LINES, ...kept, marker].join("\n");
  return { block, count: kept.length, chars: block.length, truncated: true };
}
