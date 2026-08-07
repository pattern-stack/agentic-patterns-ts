# Spec #422 — recall surface: RenderContext.recall + Awareness.fromRecall + recall assembler

**Issue:** #422 · **Branch:** `dugshub/memory-store/6-recall-surface` · **Depends on:** #421 (merged — `matchesAgentConvention` + `RESERVED_AGENT_SCOPE_KEY` exist in `memory/toolbox.ts`)
**Specs of record:** ADR-0007 Decision 8a + §"Recall assembly" (`docs/adr/0007-memory-store.md:86-113`); ADR-0008 Decision 8 (reserved `agent` scope key — **context only**, no promotion/overlay code).
**Design docs:** `docs/memory/guide.md` (§"4. Enable turn-1 recall", §"Recall tuning", open questions 3 + 4 — this issue answers both).

## Objective

Ship the turn-1 recall surface, split cleanly across the core/runtime purity seam (ADR-0005 hard gate: render fns never fetch):

- **Core:** widen `RenderContext` with `recall?: string` — a **pre-formatted, pre-budgeted** finished block (the assembler owns all formatting; the renderer owns nothing but placement). Add `Awareness.fromRecall`, an instance render fn mirroring `fromScope` exactly — including the `replace()` override so `withDomain`/`withDomains`/`withCapabilities` preserve it — with **byte-identical rendering when `ctx.recall` is absent** (or the hook is absent).
- **Runtime:** new `packages/agent-runtime/src/memory/recall.ts` exporting `assembleRecall(store, scope, options?)`: profile-kind records first, then search hits (query = first user text when available), the ADR-0008 D8 `agent`-key post-filter, a char-budget cap with a **marked** truncation line (house rule: never silently clip), returning `{ block, count, chars, truncated }` and emitting `agent.memory.recall` (the #420 vocabulary's last producer-less event).
- **Turn-1 ordering pinned:** the HOST calls `assembleRecall` at **first-message time** (when the first user text exists — not at conversation creation) and passes the block via `RenderContext.recall` into `renderInitialPrompt`. Documented in the module docblock and corrected in `docs/memory/guide.md`.

## Scope (exact files)

| File | Change |
|---|---|
| `packages/agent-core/src/atoms/base.ts` | `RenderContext` gains `readonly recall?: string` (+ docblock update) |
| `packages/agent-core/src/atoms/awareness.ts` | `AwarenessRecallRenderFn` type; constructor gains 3rd param `recallRender?`; `static fromRecall(...)`; `toPrompt(ctx)` appends recall text; `replace()` override forwards `recallRender` |
| `packages/agent-core/src/atoms/index.ts` | Export `type AwarenessRecallRenderFn` (root `index.ts` is `export *` — no other barrel edit) |
| `packages/agent-runtime/src/memory/recall.ts` | **New.** `assembleRecall`, `AssembleRecallOptions`, `RecallEmitOptions`, `RecallResult`, `DEFAULT_RECALL_BUDGET_CHARS` |
| `packages/agent-runtime/src/memory/index.ts` | Barrel exports for the five names above (root `index.ts` is `export *` — no other barrel edit) |
| `packages/agent-core/src/atoms/__tests__/atoms.test.ts` | New `describe("Awareness.fromRecall")` beside the existing `fromScope` describe (~line 348) |
| `packages/agent-runtime/src/memory/__tests__/recall.test.ts` | **New.** Assembler unit tests (Test plan) |
| `docs/memory/guide.md` | Corrections only — see Implementation §6 |

No other files. Explicitly untouched: `rendering/` (ContextSection already forwards `ctx` to `Awareness.toPrompt(ctx)` — `sections/context.ts:32`), `organisms/agent.ts` (`renderInitialPrompt(ctx)`/`renderSections(ctx)` already thread `RenderContext`), `renderContinuationPrompt` (ADR-0007: recall is turn-1 only in v1), `store.ts` / `sqlite-store.ts` / `conformance.ts` / `toolbox.ts` (reuse `matchesAgentConvention` + `RESERVED_AGENT_SCOPE_KEY`, imported — not moved), `events/types.ts` / `sse-formatter.ts` / manifest / event-profiles / dashboard (#420 shipped the whole vocabulary; `MemoryRecallEvent` exists at `events/types.ts:620-635`), `agent-runner.ts` (its #421 passthrough deliberately excludes `agent.memory.recall` — host-side, never tool-side; see the comment at `agent-runner.ts:406`).

## API surface (exact TypeScript signatures)

### Core — `packages/agent-core/src/atoms/base.ts`

```ts
export interface RenderContext {
  readonly scope?: Readonly<Record<string, unknown>>;
  /**
   * Pre-formatted, pre-budgeted turn-1 recall block assembled by the runtime
   * host (ADR-0007 D8a) — a finished string, never structured data. Rendering
   * stays pure: core places it (Awareness.fromRecall), never fetches or
   * formats it. Absent ⇒ byte-identical pre-recall rendering.
   */
  readonly recall?: string;
}
```

### Core — `packages/agent-core/src/atoms/awareness.ts`

```ts
/**
 * A recall-derived render hook attached to an Awareness INSTANCE (not schema
 * data — Zod-validated frozen data can't carry functions). Receives the
 * host-assembled `ctx.recall` block; returns the text to append (empty string
 * ⇒ skipped). See {@link Awareness.fromRecall}.
 */
export type AwarenessRecallRenderFn = (recall: string) => string;

export class Awareness extends AgenticModel<typeof AwarenessSchema.shape> {
  readonly scopeRender?: AwarenessScopeRenderFn;    // existing
  readonly recallRender?: AwarenessRecallRenderFn;  // NEW

  // 3rd param NEW; existing 1- and 2-arg call sites unaffected.
  constructor(
    data: z.input<typeof AwarenessSchema>,
    scopeRender?: AwarenessScopeRenderFn,
    recallRender?: AwarenessRecallRenderFn,
  );

  /**
   * Build an Awareness whose `toPrompt(ctx)` appends the host-assembled
   * `ctx.recall` block when one is supplied. The `fromScope` sibling — no new
   * Section subclass, no render impurity. `fn` defaults to identity: the
   * block arrives pre-formatted and pre-budgeted from the runtime assembler
   * (ADR-0007 D8a), so the default renders it verbatim. Supply `fn` only to
   * re-wrap the finished block (never to fetch or reformat records).
   */
  static fromRecall(
    fn?: AwarenessRecallRenderFn,
    base?: z.input<typeof AwarenessSchema>,
  ): Awareness;

  // toPrompt(ctx?) — unchanged signature; recall append documented below.
  // replace(updates) — override now forwards BOTH scopeRender and recallRender.
}
```

`fromScope` keeps its exact current signature and body (`new Awareness(base ?? {}, fn as ...)` — `recallRender` implicitly undefined). `fromRecall()` (zero-arg) is the documented guide usage.

### Runtime — `packages/agent-runtime/src/memory/recall.ts`

```ts
import {
  type MemoryHit,
  type MemoryRecord,
  type MemoryScope,
  MemoryScopeSchema,
  canonicalMemoryScope,
} from "@agentic-patterns/core";
import { type EventBus } from "../events/event-bus.js";
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
): Promise<RecallResult>;
```

Module-private constants (pinned values, each with a one-line "documented bound" comment):

```ts
const PROFILE_FETCH_LIMIT = 50;    // profile tier page — a scope holding more has bloated (guide: "at most a handful")
const CANDIDATE_FETCH_LIMIT = 100; // pinned-candidate scan page (targeted records are rare in v1)
const RECALL_SEARCH_LIMIT = 20;    // hits tier page — the char budget is the real cap
```

## Implementation strategy

### 1. Core: `RenderContext.recall` (`base.ts`)

Add the field exactly as in the API surface. Update the interface docblock's "currently just an optional server-parsed session scope bag" phrasing to name both fields. No other change — `AgenticModel` untouched.

### 2. Core: `Awareness.fromRecall` (`awareness.ts`) — mirror `fromScope` exactly

- **Constructor:** append `recallRender?: AwarenessRecallRenderFn` as the third parameter; assign to the new `readonly recallRender?` instance field. (Instance-carried, not schema data — same rationale comment as `scopeRender`.)
- **`fromRecall(fn?, base?)`:** returns `new Awareness(base ?? {}, undefined, fn ?? ((recall) => recall))`. The identity default is what makes `Awareness.fromRecall()` (the guide's zero-arg usage) work.
- **`toPrompt(ctx?)`** — extend the existing tail. After the current `scopeRender` append, add the recall append with identical semantics, **scope text first, recall text last** (pinned order — recall is "what you remember", placed after available sources):

  ```ts
  let out = base;
  if (this.scopeRender && ctx?.scope !== undefined) {
    const extra = this.scopeRender(ctx.scope as Record<string, unknown>);
    if (extra !== "") out = `${out}\n\n${extra}`;
  }
  if (this.recallRender && ctx?.recall !== undefined) {
    const extra = this.recallRender(ctx.recall);
    if (extra !== "") out = `${out}\n\n${extra}`;
  }
  return out;
  ```

  This is a pure refactor of the existing early-return into an accumulator; when `recallRender`/`ctx.recall` are absent the emitted bytes are identical to today for every input (the byte-identical acceptance bar). An empty-string `ctx.recall` with the identity fn yields `extra === ""` ⇒ skipped — so hosts may pass `recall: result.block` unconditionally.
- **`replace()` override:** widen the `Ctor` cast to the 3-arg constructor and pass `this.recallRender` as the third argument. Update its docblock ("would silently drop `scopeRender`/`recallRender`…"). This is what keeps the hook alive across `withDomain`/`withDomains`/`withCapabilities` (all build on `replace()`).
- **`toPrompt` docblock:** extend with the recall paragraph (mirroring the scope paragraph): appended after the existing content *and after any scope-derived text*, blank-line separated, empty result skipped, byte-identical when absent.
- **Barrel:** add `type AwarenessRecallRenderFn` to the `awareness.js` export group in `atoms/index.ts`.

### 3. Runtime: `assembleRecall` (`recall.ts`)

Order of operations (all store reads go through `search` — no new protocol surface):

1. **Validate scope:** `canonicalMemoryScope(MemoryScopeSchema.parse(scope))`. Throw on empty scope with the toolbox's exact rationale: `"assembleRecall requires a non-empty partition scope — an empty scope is an unscoped search (ADR-0007)"`.
2. **Validate budget:** `budgetChars ?? DEFAULT_RECALL_BUDGET_CHARS`; throw `Error` unless a positive integer. Validate `pinCandidates ?? 0` the same way (non-negative integer).
3. **Derive the read filter** exactly as `MemoryToolbox` does: `me = scope[RESERVED_AGENT_SCOPE_KEY]`; `readFilter` = the canonical scope minus the `agent` key (subset-matching with `agent` IN the filter would exclude shared agent-unset records — the D8 problem). All three fetches use `readFilter` and post-filter hits with `matchesAgentConvention(hit.record.scope, me)`. Same documented v1 consequence as the toolbox: no over-fetch compensation — a page may yield fewer than `limit` after the post-filter.
4. **Fetch tiers, dedupe by record id in tier order:**
   - **Profile:** `store.search({ scope: readFilter, kinds: ["profile"], limit: PROFILE_FETCH_LIMIT })` — no `query`, so recency-ordered per the D5 listing contract.
   - **Pinned candidates** (only when `pinCandidates > 0`): `store.search({ scope: readFilter, limit: CANDIDATE_FETCH_LIMIT })`; keep records with `target !== undefined` not already included; take the first `pinCandidates` (recency order; ADR-0008's "recency-rotated" is deferred — note it in a comment).
   - **Hits:** `store.search({ ...(query !== undefined ? { query } : {}), scope: readFilter, limit: RECALL_SEARCH_LIMIT })`; drop ids already included. With `query` absent this is deliberately the recency listing (guide: "without it, profile + recency listing only").
5. **Format** (the assembler owns ADK-style formatting discipline — guide open question 3 resolved: `RenderContext.recall` is a finished string). Pinned exactly:
   - Scaffold (4 lines): `"## Recalled Memories"`, `""`, `"From prior sessions, most relevant first — verify anything that may have changed:"`, `""`.
   - One entry per record: `` `- [${record.kind} · ${record.createdAt.slice(0, 10)}] ${record.content}` `` (store-assigned `createdAt` is `toISOString()`, so `.slice(0, 10)` is the UTC date).
   - Block = scaffold lines + included entries, joined with `"\n"`.
   - Truncation marker (its own final line): `` `… [recall budget reached — ${omitted} more record(s) omitted]` ``.
6. **Budget cap — whole-record granularity, marker counts against the budget** (`capPreview` precedent: the result never exceeds the cap):
   - If the deduped record list is empty: return `{ block: "", count: 0, chars: 0, truncated: false }` (emit still fires — "nothing recalled" is a signal).
   - Greedily append entries: starting from `running = scaffold.length` (the joined 4-line scaffold), an entry is included when `running + 1 + entry.length <= budgetChars`; the first entry that does not fit stops assembly (`omitted = total - included`).
   - If `omitted > 0`: `truncated = true`; append the marker line; while `running + 1 + marker.length > budgetChars`, drop the last included entry (recomputing `omitted`/marker) — if every entry is dropped and scaffold + marker still exceed the budget, return `{ block: "", count: 0, chars: 0, truncated: true }` (degenerate budget; nothing rendered is better than an over-budget or unmarked block).
   - Invariant: a non-empty `block` always has `block.length <= budgetChars`; `count` counts only records present in the block; `chars = block.length`.
7. **Emit** when `options.emit` is provided — best-effort, awaited, never throws:

   ```ts
   try {
     await emit.bus.publish(
       createEvent("agent.memory.recall", {
         traceId: emit.traceId,
         runId: emit.runId,
         ...(emit.parentSpanId !== undefined ? { parentSpanId: emit.parentSpanId } : {}),
         scope,               // the full canonical bound scope, agent key included (mirrors MemoryWriteEvent)
         count, chars, budgetChars, truncated,
         preview: capPreview(block),
       }),
     );
   } catch { /* fire-and-forget sink — mirror toolbox._emit */ }
   ```

   Host-side there is no `ToolExecutionContext`, hence the explicit correlation bag (`MemoryRecallEvent` has no `toolCallId` — `events/types.ts:615-618`). Awaiting (vs the runner's `void`) keeps tests deterministic while the catch preserves the non-throw contract.
8. **Return** `{ block, count, chars, truncated }`.

Module docblock carries the pinned TURN-1 ORDERING paragraph (see API surface) — this is the normative statement the guide correction points at.

### 4. Runtime barrel (`memory/index.ts`)

```ts
export {
  assembleRecall,
  DEFAULT_RECALL_BUDGET_CHARS,
} from "./recall.js";
export type { AssembleRecallOptions, RecallEmitOptions, RecallResult } from "./recall.js";
```

### 5. Import-rule note

`recall.ts` (memory module) imports from `../events/` (layer 5) and `./toolbox.js` (same module) — both already-established edges (`toolbox.ts` exports `matchesAgentConvention` "for reuse by the recall assembler (#422)" verbatim in its docblock). No new cross-layer edges.

### 6. Docs correction (`docs/memory/guide.md`)

Corrections only — no restructuring:

1. **§"4. Enable turn-1 recall"** (~lines 153-176): update the snippet to the pinned signature — `assembleRecall(store, memoryScope(s), { query: firstUserText, budgetChars: 4_000 })` (scope is the second **positional** argument, not an options field); fix the emission comment to `{ count, chars, truncated }` (chars, not bytes) and note the event fires only when `emit` is wired; replace "recall assembly is the host's job at conversation creation" with "recall assembly is the host's job at **first-message time** — the first user text is the search query" (the issue's pinned correction).
2. **§"Recall tuning" → Budgets** (~line 342): `{ count, bytes, truncated }` → `{ count, chars, truncated }`.
3. **Open questions 3 and 4** (~lines 531-539): prefix each with `**Resolved (#422):**` and one sentence — Q3: the assembler owns formatting; `RenderContext.recall` is a finished string; `fromRecall(fn?, base?)` defaults to identity. Q4: the knob is `AssembleRecallOptions.budgetChars`, default `DEFAULT_RECALL_BUDGET_CHARS = 4000`; server-registration wiring remains open (question 5).

## Test plan

### Core — extend `atoms.test.ts` with `describe("Awareness.fromRecall")` (mirror the `fromScope` describe at ~348)

1. `fromRecall()` + `toPrompt({ recall: "block" })` appends `\n\nblock` after the base content (assert against the no-sources fallback base).
2. Custom fn: `fromRecall((r) => `wrapped: ${r}`)` renders the wrapped text.
3. `base` param: domains render first, recall appended last.
4. Byte-identical when `ctx` omitted: `fromRecall().toPrompt() === new Awareness({}).toPrompt()`.
5. Byte-identical when `ctx.recall` undefined (e.g. `{ scope: {...} }` only).
6. Byte-identical for a hook-less instance receiving `{ recall: "block" }` (field present, no `recallRender`).
7. Empty append skipped: `ctx.recall === ""` with the identity default ⇒ no trailing blank lines (byte-identical to no-recall).
8. Survives `withDomain` / `withDomains` / `withCapabilities` (the `replace()` override) — chain then assert recall still renders; also assert `scopeRender` still survives the same chains (regression guard on the widened override).
9. Ordering when both hooks fire: `new Awareness({}, scopeFn, recallFn)` + `{ scope, recall }` renders base, scope text, recall text in that order, blank-line separated.

### Runtime — new `memory/__tests__/recall.test.ts` (InMemoryMemoryStore; seed via `store.write`)

**Ordering / tiers**
1. Profile-first: a profile record and a strongly query-matching fact — profile entry precedes the fact entry in `block`.
2. Multiple profiles: recency order (newest first) within the profile tier.
3. Query hits: relevance-ranked hits follow profiles; a non-matching record is absent.
4. No `query`: hits tier is the recency listing (recent facts appear without any query).
5. Dedupe: a profile record matching the query appears exactly once (profile tier position).

**Agent post-filter (ADR-0008 D8)**
6. Scope `{ tenant, user, agent: "me" }`: recalls agent-unset and `agent: "me"` records; excludes `agent: "other"` — for BOTH tiers.
7. Scope without `agent` key: agent-tagged records excluded, shared included (`me` undefined).

**Budget / truncation**
8. Everything fits: `truncated === false`, no marker substring, `count` = total, `chars === block.length <= budgetChars`.
9. Budget clips: `truncated === true`; `block` ends with the exact marker line (assert the pinned `… [recall budget reached — N more record(s) omitted]` string with correct N); `count` counts only included records; `chars <= budgetChars`.
10. Whole-record granularity: no partial record content in a truncated block.
11. Degenerate budget (smaller than scaffold + marker, records exist): `{ block: "", count: 0, chars: 0, truncated: true }`.
12. Default budget: omitted `budgetChars` behaves as 4000 (construct records straddling it) — or assert `DEFAULT_RECALL_BUDGET_CHARS === 4000` plus one boundary case.

**Empty / validation**
13. No records: `{ block: "", count: 0, chars: 0, truncated: false }`.
14. Empty scope `{}` throws (message mentions unscoped search / ADR-0007).
15. `budgetChars: 0` / negative / non-integer throws; `pinCandidates: -1` throws.

**pinCandidates**
16. `pinCandidates: 1` with two targeted + several untargeted records: exactly the newest targeted record appears between profile tier and hits tier; `pinCandidates` omitted ⇒ no targeted record surfaces except via normal hit matching.

**Event emission**
17. With `emit: { bus, traceId, runId }` (real `EventBus`, subscribe to `agent.memory.recall`): event received once with matching `traceId`/`runId`, `scope` = full canonical scope (agent key included), correct `count`/`chars`/`budgetChars`/`truncated`, and `preview` = `capPreview(block)` (assert 512B cap with a large block).
18. Empty-recall emission: no records still publishes `count: 0, chars: 0, truncated: false`.
19. No `emit` option: no publish (spy bus untouched).
20. Bus/gate throwing (subscribe with a throwing gate or stub `publish` to reject): `assembleRecall` resolves normally.

## Acceptance

- `bun run check` green (build + typecheck + lint + test, both packages).
- Core renders **byte-identical** without `ctx.recall` — the four byte-identity tests (core tests 4-7) pass, and no existing rendering/organism/section test changes.
- Assembler unit tests cover the four issue-pinned areas: budget, profile-first ordering, truncation marker, agent-key post-filter.
- No render fn fetches (ADR-0005): `awareness.ts` gains no imports; all store access lives in `recall.ts`.
- `agent.memory.recall` now has its producer; the event shape is the untouched #420 vocabulary.
- `docs/memory/guide.md` matches the shipped signature and the first-message-time ordering.

## Out of scope

- **Promotion / overlay / corroboration** (ADR-0008 Decisions 1-7): no `promote`/`demote`, no `applyMemoryOverlay`, no ledger. `pinCandidates` is exposure only — a filter over existing search results.
- **Recency *rotation*** for pinned candidates (ADR-0008 D4) — needs state; v1 is recency-ordered.
- **Per-turn re-injection** — `renderContinuationPrompt` untouched (ADR-0007 §Recall assembly: turn-1 only; the toolbox covers mid-conversation).
- **Server wiring** (registration `memory:` field, conversation-creation seam) — guide open question 5 stays open; #423 covers docs.
- **Over-fetch compensation** for the agent post-filter (same documented v1 call as #421).
- **Store/protocol changes** — no new `MemoryStore` methods; no `sse-formatter`/manifest/dashboard edits (#420 shipped them).
- **Token budgeting / tokenizers** (rejected in ADR-0007).
