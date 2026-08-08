# Spec #421 — MemoryToolbox: memory_save/search/list/invalidate, scope-bound at instantiate

**Issue:** #421 · **Branch:** `dugshub/memory-store/5-memory-toolbox` · **Depends on:** #420 (merged — vocabulary exists, nothing emits yet)
**Specs of record:** ADR-0007 Decisions 8b + 9 (`docs/adr/0007-memory-store.md`), ADR-0008 Decision 2 (write-time nudge, §62) + Decision 8 (reserved `agent` scope key) — context only, no promotion/overlay code.
**Design docs:** `docs/memory/guide.md` (Quickstart §3, "Writing the Manual that makes the agent save well"), `docs/authoring-a-toolbox.md` (tool-name collision guidance).

## Objective

Ship the agent-facing memory surface: a `MemoryToolbox extends Toolbox` in `packages/agent-runtime/src/memory/toolbox.ts` exposing exactly four tools — `memory_save`, `memory_search`, `memory_list`, `memory_invalidate` — built with `defineTool` (typed args, validated returns). The partition scope is **bound at construction** (ADR-0004 instantiate seam): a tool physically cannot read or write outside its conversation's partition, and no unscoped search is reachable. `memory_save` enforces the ADR-0008 D2 write-time nudge for **targeted** records (same scope + same target ⇒ structured conflict envelope, never a silent duplicate). Reads honor the reserved `agent` scope-key convention (ADR-0008 D8): post-filter to `agent ∈ {me, unset}`. Tools emit the #420 `agent.memory.write` / `agent.memory.search` events via `ctx.emit`, and the runner's `buildToolCtx` bridge gains a narrow passthrough so those events reach the bus **typed** (today every `ToolEvent` is coerced to `agent.tool.progress`; without the passthrough the #420 write/search vocabulary has no producer — #422 covers recall only, #423 is docs). Also ship `memoryCapability(store, scope, opts)` wrapping the toolbox with a built-in Manual. `delete` is **not** exposed to the agent.

## Scope (exact files)

| File | Change |
|---|---|
| `packages/agent-runtime/src/memory/toolbox.ts` | **New.** `MemoryToolbox`, `MemoryToolboxOptions`, `memoryCapability`, `MemoryCapabilityOptions`, `RESERVED_AGENT_SCOPE_KEY`, `matchesAgentConvention` |
| `packages/agent-runtime/src/memory/index.ts` | Add barrel exports for the six names above |
| `packages/agent-runtime/src/runner/agent-runner.ts` | `buildToolCtx` `emit` gains the memory-event passthrough (one adapter, all three dispatch sites — see Implementation §5) |
| `packages/agent-runtime/src/memory/__tests__/memory-toolbox.test.ts` | **New.** Unit tests (Test plan) |
| `packages/agent-runtime/src/runner/__tests__/agent-runner.test.ts` | Extend the existing Channel-B describe (~line 739) with passthrough cases |

No other files. Explicitly untouched: core (no molecule changes needed — all schemas exist), `sse-formatter.ts` / manifest / event-profiles / dashboard (done in #420), `recall.ts` (#422), docs (#423), `store.ts` / `sqlite-store.ts` / `conformance.ts`.

Scope-deviation note (mirror of the #420 precedent): the issue's stated file scope is `memory/toolbox.ts`; the `agent-runner.ts` edit is forced by the issue pin "Emits the m4 events via ctx.emit" — the pin is meaningless end-to-end while the bridge coerces every `ToolEvent` to `agent.tool.progress`. The edit is confined to the single `buildToolCtx` adapter (comment at agent-runner.ts:347 — "Single adapter so the three call sites don't drift").

## API surface (exact TypeScript signatures)

All in `packages/agent-runtime/src/memory/toolbox.ts` unless noted.

```ts
import {
  Capability,
  type MemoryScope,
  type MemoryTarget,
  MemoryKindSchema,
  MemoryScopeSchema,
  MemoryTargetSchema,
  TextManual,
  type ToolDefinition,
  type ToolExecutionContext,
  Toolbox,
  canonicalMemoryScope,
  defineTool,
} from "@agentic-patterns/core";
import { z } from "zod";
import { capPreview } from "../workflows/state-events.js";
import type { MemoryStore } from "./store.js";

/** The reserved scope key naming which agent a record is specific to (ADR-0008 D8). */
export const RESERVED_AGENT_SCOPE_KEY = "agent";

/**
 * ADR-0008 D8 read convention: a record is visible to agent `me` when its
 * scope's reserved `agent` key is unset (shared) or equals `me`. `me`
 * undefined ⇒ agent-unset records only. Exported for reuse by the recall
 * assembler (#422) — the convention is a runtime helper, not a store change.
 */
export function matchesAgentConvention(scope: MemoryScope, me?: string): boolean;

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

export class MemoryToolbox extends Toolbox {
  readonly name = "Memory";
  readonly description: string; // one sentence, mentions persistence + partition scoping
  readonly tools: Record<string, ToolDefinition>;
  constructor(options: MemoryToolboxOptions);
}

export interface MemoryCapabilityOptions {
  /** Domain save-policy guidance appended after the built-in Manual text. */
  guidance?: string;
  /** Capability name override. @default "Memory" */
  name?: string;
}

/**
 * Toolbox + built-in Manual in one Capability (issue pin). The Manual carries
 * the standing "you have memory" instruction and the curation protocol,
 * adapted from docs/memory/guide.md §"Writing the Manual…".
 */
export function memoryCapability(
  store: MemoryStore,
  scope: MemoryScope,
  opts?: MemoryCapabilityOptions,
): Capability;
```

### Tool parameter / return schemas (module-private consts, exact shapes)

The record view returned to the model (shared by search/list hits and the conflict envelope). No `score` (ordering is the contract, scores advisory — ADR-0007 D5), no `payload`/`provenance`/`supports` (budget noise), no `expiresAt`:

```ts
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
```

**`memory_save`** — parameters (note: NO `scope` arg exists; the bound scope is not model-addressable):

```ts
z.object({
  kind: MemoryKindSchema.describe("fact | preference | episode | profile"),
  content: z.string().min(1).describe("One durable fact, prompt-ready, standalone"),
  tags: z.array(z.string().min(1)).optional(),
  target: MemoryTargetSchema.optional()
    .describe("Where this memory could land in the composition — a proposal, not a promotion"),
  payload: z.record(z.string(), z.unknown()).optional()
    .describe("Structured form required by example/awareness targets"),
  supersedes: z.string().min(1).optional()
    .describe("Id of the record this save corrects — it is invalidated atomically"),
})
```

returns:

```ts
z.discriminatedUnion("status", [
  z.object({
    status: z.literal("saved"),
    id: z.string(),
    supersededId: z.string().optional(),
  }),
  // ADR-0008 D2 conflict envelope — never silently duplicate a targeted record.
  z.object({
    status: z.literal("conflict"),
    existing: MemoryRecordViewSchema,
    guidance: z.string(), // "A record already targets this slot in this scope. Either save again with supersedes: '<id>' to correct it, or change the target key."
  }),
  // `supersedes` id unknown OR not visible in this partition (scope confinement).
  z.object({ status: z.literal("not_found"), id: z.string() }),
])
```

**`memory_search`** — parameters:

```ts
z.object({
  query: z.string().min(1).describe("Keyword query — relevance-ranked"),
  kinds: z.array(MemoryKindSchema).optional(),
  tags: z.array(z.string().min(1)).optional().describe("Record must carry every tag"),
  limit: z.number().int().min(1).max(50).default(10),
  includeInvalidated: z.boolean().default(false)
    .describe("Include superseded/invalidated records — audit only"),
})
```

returns: `z.object({ hits: z.array(MemoryRecordViewSchema) })`

**`memory_list`** — parameters: same as `memory_search` minus `query`, with `limit` default **20** (max 50). returns: same `{ hits }` shape. (Listing = `search` with `query` absent ⇒ recency-ordered, ADR-0007 D5.)

**`memory_invalidate`** — parameters:

```ts
z.object({
  id: z.string().min(1),
  reason: z.string().min(1).optional(),
})
```

returns:

```ts
z.discriminatedUnion("status", [
  z.object({ status: z.literal("invalidated"), id: z.string() }),
  z.object({ status: z.literal("not_found"), id: z.string() }), // unknown OR out-of-partition — never leak existence
])
```

There is deliberately **no** `memory_delete` (ADR-0007 D4: `delete` is host/privacy-only) and **no** scope parameter on any tool.

## Implementation strategy

### 1. Construction (scope binding)

- `constructor(options)`: parse `options.scope` with `MemoryScopeSchema`; **throw** `Error("MemoryToolbox requires a non-empty partition scope — an empty scope is an unscoped search (ADR-0007)")` when it has zero keys. Store `this._scope = canonicalMemoryScope(parsed)` and `this._store = options.store`.
- Derive once: `this._me = this._scope[RESERVED_AGENT_SCOPE_KEY]` (may be `undefined`) and `this._readFilter` = the bound scope **minus** the `agent` key (subset-match with `agent` in the filter would exclude shared records — the exact D8 problem). Writes use the full bound scope verbatim (agent tag included when bound); reads use `_readFilter` + post-filter.
- Build `this.tools` in the constructor with `defineTool` (MessagingToolbox shape: class field record, but defineTool factories per issue pin — `validateReturns` stays default `true`).
- `matchesAgentConvention(scope, me)` = `scope[RESERVED_AGENT_SCOPE_KEY] === undefined || scope[RESERVED_AGENT_SCOPE_KEY] === me`.

### 2. `memory_save`

1. **Targeted-collision check (ADR-0008 D2, the write-time nudge).** Only when `args.target` is present: fetch candidates via `this._store.search({ scope: this._scope, limit: COLLISION_SCAN_LIMIT, includeInvalidated: false })` (`const COLLISION_SCAN_LIMIT = 500` — targeted records are rare in v1; document the bound). A **collision** is a hit whose record has (a) scope deep-equal to the bound scope (canonical maps, key-by-key — subset match alone also returns narrower partitions), and (b) target equal to `args.target` via a private `sameTarget(a, b)` — discriminant switch comparing every field of the matching arm (no `JSON.stringify` ordering gamble). If a collision exists and `args.supersedes !== collision.id` ⇒ return the `conflict` envelope with `existing: view(collision)` — **no write, no event**. Multiple collisions (pre-existing dirty data): pick the newest (`createdAt` max). If `args.supersedes === collision.id`, or no collision ⇒ proceed.
2. **Supersedes confinement.** When `args.supersedes` is set: `get(supersedes)`; if `null`, or `!subsetMatches(this._readFilter, record.scope)`, or `!matchesAgentConvention(record.scope, this._me)` ⇒ return `{ status: "not_found", id: supersedes }` — a memory tool must not invalidate another partition's record via the store's global id space. (`subsetMatches(filter, scope)` is a 3-line private helper — same semantics as store.ts's private `scopeMatches`, deliberately not exported from there.)
3. **Write.** `store.write([{ scope: this._scope, kind, content, ...optional tags/target/payload/supersedes, provenance }])` where `provenance` carries `runId: ctx?.runId` and `author: this._me` (include keys only when defined; omit `provenance` entirely when both undefined).
4. **Emit** `agent.memory.write` (§4) and return `{ status: "saved", id, supersededId: args.supersedes? }`.

Untargeted saves get **no** hard duplicate gate — the Manual's "memory_search first" instruction is the soft nudge (issue pins the hard gate to targeted collisions only).

### 3. `memory_search` / `memory_list`

- Build the store query: `{ query? , scope: this._readFilter, kinds?, tags?, limit, includeInvalidated }` (tool-schema defaults already applied by Zod). `memory_list` omits `query`.
- Post-filter hits with `matchesAgentConvention(hit.record.scope, this._me)`. **No over-fetch in v1**: pass the caller's `limit` through and accept that a page may return fewer than `limit` when foreign-agent records occupied slots — document this in the tool description and class docblock (the convention is "a runtime helper, not a store change", ADR-0008 D8; #422 makes the same call).
- Map to `MemoryRecordViewSchema` shape (private `view(record)` helper; include only defined optional keys — conditional-key discipline).
- Emit `agent.memory.search` (§4), return `{ hits }`.

### 4. Event emission (`ctx.emit`, #420 vocabulary)

Tools receive `ctx?: ToolExecutionContext` as `defineTool`'s second execute arg. Emission is best-effort: `ctx?.emit?.({ type, data })`, never awaited, never throws past the tool (wrap in try/catch mirroring the runner's non-throw contract). `data` carries the #420 payload fields **minus** `BaseEvent` correlation and minus `toolCallId` — the bridge stamps those:

- After a successful write:
  `{ type: "agent.memory.write", data: { scope: this._scope, count, records } }` where `records` is `MemoryRecordPreview[]`: `{ id, kind, preview: capPreview(record.content), ...(supersededId ? { supersededId } : {}) }` — `capPreview` from `../workflows/state-events.js`, 512B default, marker counts against the budget (#420: previews byte-capped AT CONSTRUCTION; formatter passes through verbatim). No import cycle: `workflows` never imports `memory`.
- After search/list (post-filter applied first):
  `{ type: "agent.memory.search", data: { scope: this._readFilter, ...(query ? { query: capPreview(query) } : {}), ...(kinds ? { kinds } : {}), ...(tags ? { tags } : {}), limit, includeInvalidated, resultCount: hits.length, resultIds: hits.map(h => h.record.id) } }` — `limit`/`includeInvalidated` are post-default (never absent, per the event doc), `resultIds` reflect what the agent actually saw.
- Conflict/not_found paths emit **nothing** (no store mutation happened). `memory_invalidate` emits **nothing** — the #420 vocabulary has no invalidate event (ADR-0007 D10 is exactly three); note this in its doc comment.

### 5. Runner bridge passthrough (`agent-runner.ts` `buildToolCtx`)

Inside the existing `emit: (e) => { try { ... } catch {} }` body, **before** the progress coercion:

```ts
if (e.type === "agent.memory.write" || e.type === "agent.memory.search") {
  void this.eventBus
    .publish(
      createEvent(e.type, {
        ...(e.data ?? {}),
        traceId: a.traceId,
        runId: a.runId,
        parentSpanId: a.parentSpanId,
        toolCallId: a.parentToolCallId,
      } as never),
    )
    .catch(() => {});
  return;
}
```

- Correlation fields are spread **last** so `e.data` can never override them.
- The `as never` (or an equivalent single localized cast) is required because `ToolEvent.data` is `Record<string, unknown>`; document that the sole producer is `MemoryToolbox`, whose payloads are constructed against the typed event interfaces (and pinned by the tests). Do not add runtime validation here — `emit` is the fire-and-forget sink (#99 non-throw contract).
- `agent.memory.recall` is deliberately **not** bridged — it is host-side (#422), never tool-side.
- Everything else falls through to the existing `agent.tool.progress` path unchanged. The `parentSpanId`/`spanId` invariants documented at agent-runner.ts:347–365 are untouched (`createEvent` generates a fresh `spanId`; `parentSpanId: a.parentSpanId` nests under the invoking tool call — same anchoring as progress events).

### 6. `memoryCapability`

```ts
export function memoryCapability(store, scope, opts) {
  const toolbox = new MemoryToolbox({ store, scope });
  const baseline = /* built-in policy text */;
  const manual = new TextManual(
    "memory-policy",
    opts?.guidance ? `${baseline}\n\n${opts.guidance}` : baseline,
  );
  return new Capability(opts?.name ?? "Memory", <description>, toolbox, manual);
}
```

The baseline Manual text adapts `docs/memory/guide.md` §"Writing the Manual that makes the agent save well" and MUST cover: (1) standing "you have persistent memory scoped to this conversation; recall already in context — don't re-search it"; (2) save when durable (preference / environment fact / outcome-and-lesson), one fact per record, standalone declarative content; (3) do NOT save transcript restatements, secrets/credentials, transient state; (4) `memory_search` before saving something you may already know; (5) corrections use `supersedes` — never leave two contradictory records standing; (6) a targeted save that returns `status: "conflict"` means supersede the existing record or change the target key. Bias toward selective saving (guide: over-saving poisons the recall budget; under-saving just stays forgetful).

### 7. Barrel

`memory/index.ts` adds:

```ts
export {
  matchesAgentConvention,
  MemoryToolbox,
  memoryCapability,
  RESERVED_AGENT_SCOPE_KEY,
} from "./toolbox.js";
export type { MemoryCapabilityOptions, MemoryToolboxOptions } from "./toolbox.js";
```

(`src/index.ts` already does `export * from "./memory/index.js"`.)

## Test plan

### `packages/agent-runtime/src/memory/__tests__/memory-toolbox.test.ts` (new; `InMemoryMemoryStore` throughout; drive tools via `toolbox.execute(name, args, ctx?)`)

**Construction & surface**
1. Empty scope `{}` throws (message mentions unscoped search).
2. `getToolNames()` is exactly `["memory_save", "memory_search", "memory_list", "memory_invalidate"]` — no delete tool.
3. Tool-name collision pin (issue acceptance): the four names are disjoint from `new MessagingToolbox(...).getToolNames()` (`send_message`, `broadcast`, `list_team`) — comment cites `docs/authoring-a-toolbox.md` ("Name every play distinctly from every tool reachable by the agent"; tool-wins shadowing on the ToolboxExecutor path, FATAL on the SDK-bridge path).

**Scope confinement (issue acceptance)**
4. `memory_save` writes the canonical bound scope; a `scope` key smuggled into args is stripped by Zod (record's scope unchanged).
5. Seed the store directly with records in a foreign partition; `memory_search`/`memory_list` never return them.
6. `memory_invalidate` on a foreign-partition record id ⇒ `{ status: "not_found" }` and the record stays valid in the store.
7. `memory_save` with `supersedes` pointing at a foreign-partition record ⇒ `{ status: "not_found" }`, nothing written, foreign record untouched.

**Supersede nudge (issue acceptance)**
8. Save targeted record A (`background` arm); second targeted save, same scope + same target, no `supersedes` ⇒ `{ status: "conflict", existing.id === A.id }`, store still holds exactly one valid record.
9. Same collision **with** `supersedes: A.id` ⇒ `{ status: "saved", supersededId: A.id }`; A is invalidated with `supersededBy` = new id.
10. Re-key (same arm, different `key`) ⇒ saved, both valid.
11. Untargeted duplicate content ⇒ no gate, both saved.
12. Collision check ignores invalidated records (invalidate A, then same-target save succeeds without `supersedes`).

**Agent-key post-filter (issue acceptance)**
13. Bound `{ tenant, user, agent: "support" }`: seed records at `{tenant,user}` (shared), `{tenant,user,agent:"support"}` (mine), `{tenant,user,agent:"researcher"}` (theirs). `memory_list` returns shared + mine, never theirs; `memory_save` tags writes `agent: "support"`; provenance `author === "support"`.
14. Bound without `agent`: agent-tagged records are excluded from reads.
15. `matchesAgentConvention` unit cases: unset ⇒ true always; equal ⇒ true; other ⇒ false; `me` undefined + tagged ⇒ false.

**Event emission (issue acceptance; capture via fake `ctx = { emit: spy, runId: "r1" }`)**
16. `memory_save` emits one `agent.memory.write` with `scope` = bound scope, `count: 1`, `records[0].{id,kind,preview}`; content > 512 bytes ⇒ preview capped, ends with the `… (preview only)` marker, ≤ 512 bytes; supersede path carries `supersededId`.
17. `memory_search` emits `agent.memory.search` with `query` present, `scope` = read filter (no `agent` key), post-default `limit`/`includeInvalidated`, `resultIds` = post-filter ids; `memory_list` emits with `query` absent.
18. Conflict and `not_found` paths emit nothing; `memory_invalidate` emits nothing; calling any tool with `ctx` undefined does not throw.

**Returns & capability**
19. `memory_search` hit shape parses against the documented view (no `score`, no `payload`); `defineTool` returns-validation is active (verified implicitly by successful parse of every result above).
20. `memoryCapability(store, scope)` returns `instanceof Capability` with the toolbox + a Manual whose `toPrompt()` contains "supersedes" and a do-not-save clause; `opts.guidance` text is appended; `opts.name` overrides.

### `packages/agent-runtime/src/runner/__tests__/agent-runner.test.ts` (extend the ctx-capture test around line 739)

21. Captured `ctx.emit({ type: "agent.memory.write", data: { scope, count, records } })` ⇒ bus receives a typed `agent.memory.write` with `traceId`/`runId`/`parentSpanId`/`toolCallId` stamped from the dispatch context and the data fields passed through; an `e.data.runId` cannot override the stamped `runId`.
22. `ctx.emit({ type: "progress", ... })` still produces `agent.tool.progress` (regression pin on the fall-through).

## Acceptance

- `bun run check` green (build + typecheck + lint + test), including the untouched dashboard drift test.
- All Test-plan cases pass; issue-pinned test areas covered: scope confinement, supersede nudge, agent-key post-filter, event emission, tool-name collision pin.
- Four tools only; no `delete`, no scope parameter, no unscoped search path.
- The implementer commits this spec file together with the code (gate:auto — no separate spec PR).

## Out of scope

- **Promotion/overlay anything** (`promote`/`demote`/`corroborate`, `applyMemoryOverlay`, tiers, ledger) — ADR-0008 Phase B+; `target`/`payload` are stored and returned untouched.
- **Recall surface** — `RenderContext.recall`, `Awareness.fromRecall`, `recall.ts` assembler, `agent.memory.recall` emission and its bridge (#422).
- **Docs refresh** — guide/store-family/CHANGELOG corrections (#423). No doc edits here.
- **Store/protocol/conformance changes** — no new `MemoryStore` methods, no `MemorySearchQuery` target filter (the collision scan compares client-side), no conformance-kit additions.
- **Over-fetch / pagination compensation** for the agent post-filter — documented v1 behavior, revisit with #422 learnings.
- **Auto-capture, provenance.conversationId stamping, expiry sweeping** — later program milestones (ADR-0007 D12 / follow-ups).
- **Runtime validation in the runner bridge** — `emit` stays the fire-and-forget, non-throwing sink; the toolbox is the sole producer.
