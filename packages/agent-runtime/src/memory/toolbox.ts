/**
 * MemoryToolbox — the agent-facing memory surface (#421).
 *
 * Four tools — `memory_save`, `memory_search`, `memory_list`,
 * `memory_invalidate` — over a {@link MemoryStore}, with the partition scope
 * **bound at construction** (ADR-0007 D8b/D9, ADR-0004 instantiate seam): a
 * tool physically cannot read or write outside its conversation's partition,
 * and no unscoped search is reachable. There is deliberately no
 * `memory_delete` (ADR-0007 D4: `delete` is host/privacy-only) and no `scope`
 * parameter on any tool.
 *
 * `memory_save` enforces the ADR-0008 D2 write-time nudge for **targeted**
 * records: a second save with the same scope + same target returns a
 * structured conflict envelope instead of silently duplicating. Reads honor
 * the reserved `agent` scope-key convention (ADR-0008 D8) via a client-side
 * post-filter — a runtime helper, not a store change. Consequence (documented
 * v1 behavior): a page may return fewer than `limit` hits when foreign-agent
 * records occupied slots; no over-fetch compensation in v1 (#422 makes the
 * same call).
 *
 * Tools emit the #420 `agent.memory.write` / `agent.memory.search` events via
 * `ctx.emit` (best-effort, never awaited, never throws past the tool); the
 * runner's `buildToolCtx` bridge passes them through typed.
 */

import {
  Capability,
  MemoryKindSchema,
  type MemoryRecord,
  type MemoryScope,
  MemoryScopeSchema,
  type MemoryTarget,
  MemoryTargetSchema,
  TextManual,
  type ToolDefinition,
  type ToolEvent,
  type ToolExecutionContext,
  Toolbox,
  canonicalMemoryScope,
  defineTool,
} from "@pattern-stack/agentic-core";
import { z } from "zod";
import { capPreview } from "../workflows/state-events.js";
import type { MemoryStore } from "./store.js";

// ---------------------------------------------------------------------------
// Reserved `agent` scope key (ADR-0008 D8)
// ---------------------------------------------------------------------------

/** The reserved scope key naming which agent a record is specific to (ADR-0008 D8). */
export const RESERVED_AGENT_SCOPE_KEY = "agent";

/**
 * ADR-0008 D8 read convention: a record is visible to agent `me` when its
 * scope's reserved `agent` key is unset (shared) or equals `me`. `me`
 * undefined ⇒ agent-unset records only. Exported for reuse by the recall
 * assembler (#422) — the convention is a runtime helper, not a store change.
 */
export function matchesAgentConvention(scope: MemoryScope, me?: string): boolean {
  return scope[RESERVED_AGENT_SCOPE_KEY] === undefined || scope[RESERVED_AGENT_SCOPE_KEY] === me;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Upper bound on the candidate fetch for the targeted-collision check
 * (ADR-0008 D2). The store has no target filter, so this is an UNFILTERED
 * recency page (createdAt desc) of the partition — the target match is a
 * client-side post-filter. Documented bound: once the partition holds more
 * than 500 valid records of ANY kind newer than an existing targeted record,
 * that record falls off the page and its collision slips past the gate.
 */
const COLLISION_SCAN_LIMIT = 500;

/** True when `scope[k] === filter[k]` for every key in the filter (store.ts `scopeMatches` semantics, deliberately not exported from there). */
function subsetMatches(filter: MemoryScope, scope: MemoryScope): boolean {
  return Object.entries(filter).every(([key, value]) => scope[key] === value);
}

/** Deep equality of two scope maps, key-by-key (subset match alone would also accept narrower partitions). */
function scopesEqual(a: MemoryScope, b: MemoryScope): boolean {
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => a[key] === b[key]);
}

/**
 * Structural equality of two targets: discriminant switch comparing every
 * field of the matching arm — no `JSON.stringify` key-ordering gamble.
 */
function sameTarget(a: MemoryTarget, b: MemoryTarget): boolean {
  if (a.primitive !== b.primitive) return false;
  switch (a.primitive) {
    case "background":
      return b.primitive === "background" && a.section === b.section && a.key === b.key;
    case "judgment":
      return b.primitive === "judgment" && a.domain === b.domain && a.slot === b.slot;
    case "example":
      return b.primitive === "example" && a.judgmentDomain === b.judgmentDomain;
    case "awareness":
    case "recovery":
      return true; // discriminant-only arms
    case "manual":
      return b.primitive === "manual" && a.capability === b.capability && a.section === b.section;
  }
}

// ---------------------------------------------------------------------------
// Tool parameter / return schemas (module-private)
// ---------------------------------------------------------------------------

/**
 * The record view returned to the model (shared by search/list hits and the
 * conflict envelope). No `score` (ordering is the contract, scores advisory —
 * ADR-0007 D5), no `payload`/`provenance`/`supports` (budget noise), no
 * `expiresAt`.
 */
const MemoryRecordViewSchema = z.object({
  id: z.string(),
  kind: MemoryKindSchema,
  content: z.string(),
  scope: MemoryScopeSchema,
  tags: z.array(z.string()).optional(),
  createdAt: z.string(),
  invalidAt: z.string().optional(),
  supersededBy: z.string().optional(),
  target: MemoryTargetSchema.optional(),
});

type MemoryRecordView = z.infer<typeof MemoryRecordViewSchema>;

const SaveParamsSchema = z.object({
  kind: MemoryKindSchema.describe(
    "profile = durable identity fact about the user (name, role, who they are) — always " +
      "injected before search runs next session (and also returned by search like any " +
      "record), so keep these to a handful; " +
      "fact = atomic statement still true next week; " +
      "preference = how the user wants things done; " +
      "episode = what happened and what it taught you. " +
      "fact/preference/episode are only recalled when the next question's wording matches them.",
  ),
  content: z.string().min(1).describe("One durable fact, prompt-ready, standalone"),
  tags: z.array(z.string().min(1)).optional(),
  target: MemoryTargetSchema.optional().describe(
    "Where this memory could land in the composition — a proposal, not a promotion",
  ),
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Structured form required by example/awareness targets"),
  supersedes: z
    .string()
    .min(1)
    .optional()
    .describe("Id of the record this save corrects — it is invalidated atomically"),
});

const SaveReturnsSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("saved"),
    id: z.string(),
    supersededId: z.string().optional(),
  }),
  // ADR-0008 D2 conflict envelope — never silently duplicate a targeted record.
  z.object({
    status: z.literal("conflict"),
    existing: MemoryRecordViewSchema,
    guidance: z.string(),
  }),
  // `supersedes` id unknown OR not visible in this partition (scope confinement).
  z.object({ status: z.literal("not_found"), id: z.string() }),
]);

const SearchFilterShape = {
  kinds: z.array(MemoryKindSchema).optional(),
  tags: z.array(z.string().min(1)).optional().describe("Record must carry every tag"),
  includeInvalidated: z
    .boolean()
    .default(false)
    .describe("Include superseded/invalidated records — audit only"),
};

const SearchParamsSchema = z.object({
  query: z.string().min(1).describe("Keyword query — relevance-ranked"),
  ...SearchFilterShape,
  limit: z.number().int().min(1).max(50).default(10),
});

const ListParamsSchema = z.object({
  ...SearchFilterShape,
  limit: z.number().int().min(1).max(50).default(20),
});

const HitsReturnsSchema = z.object({ hits: z.array(MemoryRecordViewSchema) });

const InvalidateParamsSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1).optional(),
});

const InvalidateReturnsSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("invalidated"), id: z.string() }),
  // Unknown OR out-of-partition — never leak existence across partitions.
  z.object({ status: z.literal("not_found"), id: z.string() }),
]);

// ---------------------------------------------------------------------------
// MemoryToolbox
// ---------------------------------------------------------------------------

export interface MemoryToolboxOptions {
  store: MemoryStore;
  /**
   * The partition scope, bound at construction (ADR-0007 D9 / ADR-0004
   * instantiate seam). Must be non-empty — an empty scope would make every
   * read an unscoped search (ADR-0007 consequences). May include the
   * reserved `agent` key: when present, writes are tagged to that agent and
   * reads see that agent's records plus shared (agent-unset) ones; when
   * absent, writes are shared and reads see shared records only.
   */
  scope: MemoryScope;
}

/**
 * The agent-facing memory surface — see the module docblock for the scope
 * binding, the D2 write-time nudge, and the D8 agent-key read convention
 * (including the documented under-`limit` page behavior).
 */
export class MemoryToolbox extends Toolbox {
  readonly name = "Memory";
  readonly description =
    "Persistent cross-session memory — save, search, list, and invalidate durable records, partitioned to this conversation's bound scope.";
  readonly tools: Record<string, ToolDefinition>;

  private readonly _store: MemoryStore;
  /** The full bound scope (canonical) — writes use it verbatim, agent tag included. */
  private readonly _scope: MemoryScope;
  /** `_scope[RESERVED_AGENT_SCOPE_KEY]` — who "me" is for the D8 read convention. */
  private readonly _me: string | undefined;
  /**
   * The bound scope minus the `agent` key — the store-side read filter.
   * Subset-matching with `agent` IN the filter would exclude shared
   * (agent-unset) records — the exact D8 problem; reads use this filter plus
   * the {@link matchesAgentConvention} post-filter instead.
   */
  private readonly _readFilter: MemoryScope;

  constructor(options: MemoryToolboxOptions) {
    super();
    const parsed = MemoryScopeSchema.parse(options.scope);
    if (Object.keys(parsed).length === 0) {
      throw new Error(
        "MemoryToolbox requires a non-empty partition scope — an empty scope is an unscoped search (ADR-0007)",
      );
    }
    this._store = options.store;
    this._scope = canonicalMemoryScope(parsed);
    this._me = this._scope[RESERVED_AGENT_SCOPE_KEY];
    this._readFilter = canonicalMemoryScope(
      Object.fromEntries(
        Object.entries(this._scope).filter(([key]) => key !== RESERVED_AGENT_SCOPE_KEY),
      ),
    );

    this.tools = {
      memory_save: defineTool({
        description:
          "Save one durable memory record into this conversation's partition. A targeted save that collides with an existing record for the same target returns a conflict envelope — supersede it or change the target key. Use `supersedes` to correct an existing record (it is invalidated atomically).",
        parameters: SaveParamsSchema,
        returns: SaveReturnsSchema,
        execute: async (args, ctx) => this._save(args, ctx),
      }),
      memory_search: defineTool({
        description:
          "Keyword-search this conversation's memory partition, relevance-ranked. Records tagged to other agents are filtered out, so a page may return fewer than `limit` hits.",
        parameters: SearchParamsSchema,
        returns: HitsReturnsSchema,
        execute: async (args, ctx) => this._query(args, ctx),
      }),
      memory_list: defineTool({
        description:
          "List this conversation's memory partition, newest first. Records tagged to other agents are filtered out, so a page may return fewer than `limit` hits.",
        parameters: ListParamsSchema,
        returns: HitsReturnsSchema,
        execute: async (args, ctx) => this._query(args, ctx),
      }),
      memory_invalidate: defineTool({
        // Emits no event — the #420 vocabulary has exactly three memory
        // events (ADR-0007 D10) and invalidation is not one of them.
        description:
          "Mark a memory record in this partition as no longer valid (curation, not deletion — the record is kept for audit). Prefer memory_save with `supersedes` when you have a correction.",
        parameters: InvalidateParamsSchema,
        returns: InvalidateReturnsSchema,
        execute: async (args) => this._invalidate(args),
      }),
    };
  }

  // -- memory_save ----------------------------------------------------------

  private async _save(
    args: z.infer<typeof SaveParamsSchema>,
    ctx?: ToolExecutionContext,
  ): Promise<z.input<typeof SaveReturnsSchema>> {
    // 1. Targeted-collision check (ADR-0008 D2, the write-time nudge). Only
    //    targeted saves get the hard gate — untargeted duplicates are the
    //    Manual's "memory_search first" soft nudge.
    //    The gate is EXACT-scope (scopesEqual against the bound scope, agent
    //    key included) while D8 reads union shared + own. Intended v1
    //    consequence: a shared (agent-unset) record and an agent-tagged one
    //    may both validly target the same slot, so an agent-bound reader can
    //    see two live records for one slot. Loosening the gate to a subset
    //    match would instead let one agent block another agent's write.
    if (args.target !== undefined) {
      const candidates = await this._store.search({
        scope: this._scope,
        limit: COLLISION_SCAN_LIMIT,
        includeInvalidated: false,
      });
      const target = args.target;
      const collisions = candidates
        .map((hit) => hit.record)
        .filter(
          (record) =>
            scopesEqual(record.scope, this._scope) &&
            record.target !== undefined &&
            sameTarget(record.target, target),
        );
      // Multiple collisions (pre-existing dirty data): pick the newest.
      const collision = collisions.reduce<MemoryRecord | undefined>(
        (newest, record) =>
          newest === undefined || record.createdAt > newest.createdAt ? record : newest,
        undefined,
      );
      if (collision !== undefined && args.supersedes !== collision.id) {
        // No write, no event.
        return {
          status: "conflict",
          existing: this._view(collision),
          guidance: `A record already targets this slot in this scope. Either save again with supersedes: '${collision.id}' to correct it, or change the target key.`,
        };
      }
    }

    // 2. Supersedes confinement — a memory tool must not invalidate another
    //    partition's record via the store's global id space.
    if (args.supersedes !== undefined) {
      const existing = await this._store.get(args.supersedes);
      if (
        existing === null ||
        !subsetMatches(this._readFilter, existing.scope) ||
        !matchesAgentConvention(existing.scope, this._me)
      ) {
        return { status: "not_found", id: args.supersedes };
      }
    }

    // 3. Write — full bound scope verbatim (agent tag included when bound).
    const provenance = {
      ...(ctx?.runId !== undefined ? { runId: ctx.runId } : {}),
      ...(this._me !== undefined ? { author: this._me } : {}),
    };
    const written = await this._store.write([
      {
        scope: this._scope,
        kind: args.kind,
        content: args.content,
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.target !== undefined ? { target: args.target } : {}),
        ...(args.payload !== undefined ? { payload: args.payload } : {}),
        ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
        ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
      },
    ]);
    const record = written[0];
    if (record === undefined) {
      throw new Error("MemoryStore.write returned no record for a one-record batch");
    }

    // 4. Emit + return.
    this._emit(ctx, {
      type: "agent.memory.write",
      data: {
        scope: this._scope,
        count: 1,
        records: [
          {
            id: record.id,
            kind: record.kind,
            preview: capPreview(record.content),
            ...(args.supersedes !== undefined ? { supersededId: args.supersedes } : {}),
          },
        ],
      },
    });
    return {
      status: "saved",
      id: record.id,
      ...(args.supersedes !== undefined ? { supersededId: args.supersedes } : {}),
    };
  }

  // -- memory_search / memory_list ------------------------------------------

  private async _query(
    args: z.infer<typeof ListParamsSchema> & { query?: string },
    ctx?: ToolExecutionContext,
  ): Promise<z.input<typeof HitsReturnsSchema>> {
    const hits = await this._store.search({
      ...(args.query !== undefined ? { query: args.query } : {}),
      scope: this._readFilter,
      ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      limit: args.limit,
      includeInvalidated: args.includeInvalidated,
    });
    // ADR-0008 D8 post-filter — no over-fetch in v1 (see class docblock).
    const visible = hits.filter((hit) => matchesAgentConvention(hit.record.scope, this._me));
    this._emit(ctx, {
      type: "agent.memory.search",
      data: {
        scope: this._readFilter,
        ...(args.query !== undefined ? { query: capPreview(args.query) } : {}),
        ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        limit: args.limit,
        includeInvalidated: args.includeInvalidated,
        resultCount: visible.length,
        resultIds: visible.map((hit) => hit.record.id),
      },
    });
    return { hits: visible.map((hit) => this._view(hit.record)) };
  }

  // -- memory_invalidate ----------------------------------------------------

  private async _invalidate(
    args: z.infer<typeof InvalidateParamsSchema>,
  ): Promise<z.input<typeof InvalidateReturnsSchema>> {
    const existing = await this._store.get(args.id);
    if (
      existing === null ||
      !subsetMatches(this._readFilter, existing.scope) ||
      !matchesAgentConvention(existing.scope, this._me)
    ) {
      // Unknown OR out-of-partition — never leak existence.
      return { status: "not_found", id: args.id };
    }
    await this._store.invalidate(args.id, args.reason);
    return { status: "invalidated", id: args.id };
  }

  // -- shared helpers -------------------------------------------------------

  /** Project a stored record to the model-facing view (conditional-key discipline). */
  private _view(record: MemoryRecord): MemoryRecordView {
    return {
      id: record.id,
      kind: record.kind,
      content: record.content,
      scope: record.scope,
      ...(record.tags !== undefined ? { tags: [...record.tags] } : {}),
      createdAt: record.createdAt,
      ...(record.invalidAt !== undefined ? { invalidAt: record.invalidAt } : {}),
      ...(record.supersededBy !== undefined ? { supersededBy: record.supersededBy } : {}),
      ...(record.target !== undefined ? { target: record.target } : {}),
    };
  }

  /**
   * Best-effort emission (#420): never awaited, never throws past the tool —
   * mirrors the runner's non-throw contract. The bridge stamps BaseEvent
   * correlation + `toolCallId`; the payload carries only the domain fields.
   */
  private _emit(ctx: ToolExecutionContext | undefined, event: ToolEvent): void {
    try {
      ctx?.emit?.(event);
    } catch {
      // Swallow — emit is a fire-and-forget sink.
    }
  }
}

// ---------------------------------------------------------------------------
// memoryCapability
// ---------------------------------------------------------------------------

export interface MemoryCapabilityOptions {
  /** Domain save-policy guidance appended after the built-in Manual text. */
  guidance?: string;
  /** Capability name override. @default "Memory" */
  name?: string;
}

/**
 * Baseline save-policy Manual text — adapted from docs/memory/guide.md
 * §"Writing the Manual that makes the agent save well". Bias toward
 * selective saving: over-saving poisons the recall budget; under-saving just
 * stays forgetful.
 */
const BASELINE_MANUAL = [
  "You have persistent memory scoped to this conversation's partition. What was recalled at",
  "the start of this conversation is already in your context — do not search for it again.",
  "",
  "Save a memory (memory_save) when you learn something durable:",
  "- a preference the user states or demonstrates,",
  "- a fact about their environment that will still be true next week,",
  "- the outcome of an approach you tried — what worked, what failed, and why.",
  "",
  "Do NOT save:",
  "- anything already visible in this conversation or in your recall block,",
  "- secrets, credentials, or tokens of any kind,",
  "- transient state ('the build is currently red'),",
  "- restatements of instructions you were just given.",
  "",
  "CHOOSING A KIND decides whether you will ever see the memory again, so choose deliberately:",
  "- `profile` — durable identity facts about the person you work with: their name, their role,",
  "  what they are building. These are injected at the START of every future session without a",
  "  search, so they are the ONLY kind that survives a question worded differently from the",
  "  memory. They are also permanent context cost: keep them to a handful of short lines.",
  "- `preference` — how they want things done ('prefers concise answers', 'deploys on Fridays').",
  "- `fact` — an atomic statement about their environment that is still true next week.",
  "- `episode` — what happened and what it taught you.",
  "",
  "`fact`, `preference`, and `episode` are recalled by keyword search against the next",
  "conversation's opening message. If a later question would be phrased with none of the words",
  "you are about to write, search will not find it — that is what `profile` is for. When a fact",
  "is identity-grade, save it as `profile`; when it is merely durable, do not.",
  "",
  "Write one fact per record, in plain declarative language that makes sense without this",
  "conversation. Before saving something you suspect you already know, memory_search first.",
  "When new information contradicts an existing memory, save the correction with `supersedes`",
  "set to the old record's id — never leave two contradictory records standing.",
  "",
  'A targeted save that returns `status: "conflict"` means a record already occupies that',
  "target in this scope: save again with `supersedes` set to the existing record's id, or",
  "change the target key. When in doubt, save less — selective memory beats noisy memory.",
].join("\n");

/**
 * Toolbox + built-in Manual in one Capability. The Manual carries the
 * standing "you have memory" instruction and the curation protocol; layer a
 * domain save policy on top via `opts.guidance`.
 */
export function memoryCapability(
  store: MemoryStore,
  scope: MemoryScope,
  opts?: MemoryCapabilityOptions,
): Capability {
  const toolbox = new MemoryToolbox({ store, scope });
  const manual = new TextManual(
    "memory-policy",
    opts?.guidance !== undefined ? `${BASELINE_MANUAL}\n\n${opts.guidance}` : BASELINE_MANUAL,
  );
  return new Capability(
    opts?.name ?? "Memory",
    "Persistent cross-session memory for this conversation's partition, with a standing save policy.",
    toolbox,
    manual,
  );
}
