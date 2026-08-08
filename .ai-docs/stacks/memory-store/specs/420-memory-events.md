# Spec 420 — runtime: memory events — agent.memory.write/search/recall through the four guards

**Issue:** #420 · **Branch:** `dugshub/memory-store/4-memory-events` · **Size:** S · **Packages:** `@agentic-patterns/runtime` + `@agentic-patterns/dashboard`
**Depends on:** #419 (merged — `memory/` module ships `MemoryStore`, `InMemoryMemoryStore`, `SqliteMemoryStore`, conformance kit).
**Sources of record:** ADR-0007 Decision 10 (`docs/adr/0007-memory-store.md`) + the issue's pinned decisions. ADR-0008 is context only.
**Precedent to mirror:** the state-delta events (#226) — `BackpackDropEvent` et al. in `events/types.ts` (byte-capped previews AT CONSTRUCTION, duplicated-not-imported payload types where needed), and the four coordinated `sse-formatter.ts` guards + manifest regen + dashboard union extension exactly as done for `backpack.*`/`scratchpad.*`.

## Objective

Add the memory event **vocabulary** — `MemoryWriteEvent` (`agent.memory.write`), `MemorySearchEvent` (`agent.memory.search`), `MemoryRecallEvent` (`agent.memory.recall`) — through every compile-time guard: the `AgentEvent` union, the four coordinated `sse-formatter.ts` edits, the regenerated `sse-event-manifest.json`, the OBSERVABILITY event profile, and the dashboard client event union (so the drift test passes). This issue ships **types and wiring only** — nothing emits these events yet. The emitters land in #421 (`MemoryToolbox` via `ctx.emit`) and #422 (recall assembler); this vocabulary is designed for exactly those two producers.

**Pinned decisions (issue text — these win over ADR wording):**

- **Budget units are CHARS end-to-end.** The recall event reports `chars` (character count of the assembled recall block), NOT bytes. ADR-0007 D10's phrase "byte size" is superseded by the issue pin. Content *previews* remain byte-capped per the house rule (512B, `workflows/state-events.ts` precedent).
- **Recall event carries `{count, chars, truncated}`** (plus scope/budget/preview — see API surface).
- **No exporter changes** — `SQLiteExporter` is generic and persists any `AgentEvent`.
- **Event profiles: OBSERVABILITY only.** Do not add to UX/DEBUG/TOOLS — the dashboard memory lens is ADR-0007 future work, not this issue.

## Scope (exact files)

| File | Action |
|---|---|
| `packages/agent-runtime/src/events/types.ts` | **Edit** — add `MemoryRecordPreview`, `MemoryWriteEvent`, `MemorySearchEvent`, `MemoryRecallEvent`; extend `AgentEvent` union |
| `packages/agent-runtime/src/events/index.ts` | **Edit** — add the four new type names to the `./types.js` type re-export block |
| `packages/agent-runtime/src/events/event-profiles.ts` | **Edit** — add the three `agent.memory.*` types to `PROFILE_EVENT_TYPES[EventProfile.OBSERVABILITY]` |
| `packages/agent-runtime/src/transport/sse-formatter.ts` | **Edit** — the four coordinated edits (`SSEEventName` union, `SSE_WIRE_EVENT_NAMES`, `mapEventToSSE` branches, `SSE_EVENT_NAMES` map) |
| `packages/agent-runtime/src/transport/sse-event-manifest.json` | **Regenerate** — `bun run build` then `bun run tools/gen-sse-manifest.ts` (never hand-edit) |
| `packages/agent-dashboard/src/api/sse-events.ts` | **Edit** — three new `ClientEvent` members + three `CLIENT_EVENT_NAMES` entries |
| `packages/agent-runtime/src/events/__tests__/types.test.ts` | **Edit** — `createEvent` construction cases for the three memory events |
| `packages/agent-runtime/src/events/__tests__/event-profiles.test.ts` | **Edit** — `toContain` assertions for the three types in OBSERVABILITY |
| `packages/agent-runtime/src/transport/__tests__/sse-formatter.test.ts` | **Edit** — "memory lifecycle" describe block (wire names, snake_case payloads, optional-field omission) |
| `packages/agent-dashboard/src/__tests__/sse-events.drift.test.ts` | **Edit** — add an explicit-coverage `it` for the three memory names (mirrors the "#324-added kinds" block) |

No other files. NO changes to: `memory/` module, exporters, `conversation.ts` (`STATE_DELTA_EVENT_TYPES` stays as-is — memory events are not replayed state parts), `workflows/state-events.ts`, `StreamEvent` alias (memory events are bus-published, never runner-yielded — same as state-delta events), server, docs (m7's job).

## API surface (exact TypeScript signatures)

### 1. `packages/agent-runtime/src/events/types.ts`

Extend the existing core type-import (top of file) to include the memory types — importing *types* from `@agentic-patterns/core` is established precedent (`RenderArtifact`) and keeps the vocabulary drift-proof against the core molecules:

```ts
import type { MemoryKind, MemoryRecord, MemoryScope, RenderArtifact } from "@agentic-patterns/core";
```

(`MemoryRecord` only if you reference it in doc comments via `{@link}` — otherwise omit it; do not import values. `noUnusedLocals` will police this.)

Add a new section AFTER the scratchpad events (after `ScratchpadJoinEvent`, before the "Discriminated union" section):

```ts
// ---------------------------------------------------------------------------
// Memory events (ADR-0007 Decision 10, #420) — MemoryStore operations made
// visible. Emitted by the MemoryToolbox (#421, via ctx.emit) and the recall
// assembler (#422); this file only defines the vocabulary. Content previews
// are byte-capped AT CONSTRUCTION (512B, explicit "… (preview only)" marker —
// `workflows/state-events.ts` `capPreview` precedent); the formatter and every
// exporter pass them through verbatim. Budget/size figures are CHARS (issue
// pin: budget units are chars end-to-end, model-agnostic + deterministic).
// ---------------------------------------------------------------------------

/** One written record's identity + byte-capped content preview in a {@link MemoryWriteEvent}. */
export interface MemoryRecordPreview {
  /** The store-assigned record id. */
  readonly id: string;
  readonly kind: MemoryKind;
  /** Byte-capped preview of the record's content (512B, marked when clipped). */
  readonly preview: string;
  /** Id of the record this write superseded (invalidated atomically), when it did (ADR-0007 D4). */
  readonly supersededId?: string;
}

export interface MemoryWriteEvent extends BaseEvent {
  readonly type: "agent.memory.write";
  /** The partition scope written into (bound at construction — ADR-0007 D8b). */
  readonly scope: MemoryScope;
  /** Records written this batch (`=== records.length`; explicit for cheap aggregation). */
  readonly count: number;
  /** Per-record identity + byte-capped previews, input order. */
  readonly records: readonly MemoryRecordPreview[];
  /** The causing tool call, when the write happened inside a tool dispatch. */
  readonly toolCallId?: string;
}

export interface MemorySearchEvent extends BaseEvent {
  readonly type: "agent.memory.search";
  /** The partition scope searched. */
  readonly scope: MemoryScope;
  /** Byte-capped preview of the query text; absent ⇒ filtered, recency-ordered listing. */
  readonly query?: string;
  /** Kind filter, when one was applied. */
  readonly kinds?: readonly MemoryKind[];
  /** Tag filter (subset semantics), when one was applied. */
  readonly tags?: readonly string[];
  /** Effective limit AFTER schema defaults were applied (i.e. never absent). */
  readonly limit: number;
  /** Effective includeInvalidated AFTER schema defaults (never absent). */
  readonly includeInvalidated: boolean;
  readonly resultCount: number;
  /** Hit record ids, relevance order (bounded by `limit` — no content, no scores). */
  readonly resultIds: readonly string[];
  /** The causing tool call, when the search happened inside a tool dispatch. */
  readonly toolCallId?: string;
}

/**
 * The turn-1 injection event (ADR-0007 D8a/D10): what recall assembled, how
 * big it was, and whether the budget clipped it. Emitted by the recall
 * assembler (#422) — host-side, before rendering, so there is no toolCallId.
 */
export interface MemoryRecallEvent extends BaseEvent {
  readonly type: "agent.memory.recall";
  /** The partition scope recalled from. */
  readonly scope: MemoryScope;
  /** Records included in the assembled block. */
  readonly count: number;
  /** Character count of the assembled block (budget units are CHARS — issue pin). */
  readonly chars: number;
  /** The character budget the assembler ran under. */
  readonly budgetChars: number;
  /** True when the budget clipped the block — truncation is marked, never silent. */
  readonly truncated: boolean;
  /** Byte-capped preview of the assembled block (512B, marked when clipped). */
  readonly preview: string;
}
```

Extend the `AgentEvent` union — insert after `ScratchpadJoinEvent`, before `HarnessNativeEvent`:

```ts
  | ScratchpadJoinEvent
  | MemoryWriteEvent
  | MemorySearchEvent
  | MemoryRecallEvent
  | HarnessNativeEvent
```

Do NOT touch `StreamEvent`. `createEvent` needs no change (generic over `AgentEventType`).

### 2. `packages/agent-runtime/src/events/index.ts`

Add to the `export type { ... } from "./types.js"` block, after the scratchpad event names:

```ts
  MemoryRecordPreview,
  MemoryWriteEvent,
  MemorySearchEvent,
  MemoryRecallEvent,
```

### 3. `packages/agent-runtime/src/events/event-profiles.ts`

In `PROFILE_EVENT_TYPES[EventProfile.OBSERVABILITY]`, after `"agent.gate.decision"` (and its comment) and before `"agent.error"`:

```ts
    // Memory events (ADR-0007 D10, #420) — write/search/recall observability.
    // "What did it remember and why" is a query, not a mystery. Observability
    // only for now; a dashboard memory lens (UX) is ADR-0007 future work.
    "agent.memory.write",
    "agent.memory.search",
    "agent.memory.recall",
```

No other profile changes.

### 4. `packages/agent-runtime/src/transport/sse-formatter.ts` — the four coordinated edits

Wire names follow the established `agent.` prefix-strip convention (`agent.backpack.drop` → `backpack.drop`): **`memory.write`**, **`memory.search`**, **`memory.recall`**.

**(a) `SSEEventName` union** — insert after `"scratchpad.join"`, before `"error"`:

```ts
  | "memory.write"
  | "memory.search"
  | "memory.recall"
```

**(b) `SSE_WIRE_EVENT_NAMES`** — insert the same three strings after `"scratchpad.join"`, before `"error"`. (The `_MissingWireName` guard fails compile until this matches (a).)

**(c) `mapEventToSSE` branches** — insert after the `"agent.scratchpad.join"` case, before the `default`:

```ts
    case "agent.memory.write": {
      const payload: Record<string, unknown> = {
        scope: event.scope,
        count: event.count,
        // snake_case remap of MemoryRecordPreview (supersededId → superseded_id);
        // conditional-key discipline per house style — absent, never null.
        records: event.records.map((r) => {
          const rec: Record<string, unknown> = { id: r.id, kind: r.kind, preview: r.preview };
          if (r.supersededId !== undefined) rec.superseded_id = r.supersededId;
          return rec;
        }),
      };
      if (event.toolCallId !== undefined) payload.tool_call_id = event.toolCallId;
      return { name: "memory.write", payload };
    }
    case "agent.memory.search": {
      const payload: Record<string, unknown> = {
        scope: event.scope,
        limit: event.limit,
        include_invalidated: event.includeInvalidated,
        result_count: event.resultCount,
        result_ids: event.resultIds,
      };
      if (event.query !== undefined) payload.query = event.query;
      if (event.kinds !== undefined) payload.kinds = event.kinds;
      if (event.tags !== undefined) payload.tags = event.tags;
      if (event.toolCallId !== undefined) payload.tool_call_id = event.toolCallId;
      return { name: "memory.search", payload };
    }
    case "agent.memory.recall":
      return {
        name: "memory.recall",
        payload: {
          scope: event.scope,
          count: event.count,
          chars: event.chars,
          budget_chars: event.budgetChars,
          truncated: event.truncated,
          preview: event.preview,
        },
      };
```

(`scope` passes through verbatim — its keys are user data, not wire field names; the snake_case rule applies to payload field names only. Same posture as `arguments` on tool events.)

**(d) `SSE_EVENT_NAMES` map** — add after `"agent.scratchpad.join"`, before `"agent.error"`:

```ts
  "agent.memory.write": "memory.write",
  "agent.memory.search": "memory.search",
  "agent.memory.recall": "memory.recall",
```

(The `Record<AgentEventType, SSEEventName>` type fails compile until these exist.)

### 5. Manifest regeneration

```bash
bun run build                        # generator imports the BUILT runtime surface
bun run tools/gen-sse-manifest.ts    # rewrites sse-event-manifest.json (sorted)
```

Expected diff: `"memory.recall"`, `"memory.search"`, `"memory.write"` appear in sorted position (between `"llm.start"` and `"message.cancel"`). Commit the JSON. `sse-wire-manifest.test.ts` (existing, unchanged) guards freshness.

### 6. `packages/agent-dashboard/src/api/sse-events.ts`

Three new `ClientEvent` members — insert after the `"scratchpad.join"` member, before the `gate.decision` comment block. The dashboard is standalone (no runtime/core import — enforced boundary), so `kind` is typed as plain `string`:

```ts
  // Memory events (ADR-0007 D10, #420) — MemoryStore write/search/recall made
  // visible. Previews are byte-capped at construction ("… (preview only)"
  // marker); size figures are CHARS (the memory budget unit), never tokens.
  | {
      name: "memory.write";
      data: {
        scope: Record<string, string>;
        count: number;
        records: { id: string; kind: string; preview: string; superseded_id?: string }[];
        tool_call_id?: string;
      };
    }
  | {
      name: "memory.search";
      data: {
        scope: Record<string, string>;
        limit: number;
        include_invalidated: boolean;
        result_count: number;
        result_ids: string[];
        query?: string;
        kinds?: string[];
        tags?: string[];
        tool_call_id?: string;
      };
    }
  | {
      name: "memory.recall";
      data: {
        scope: Record<string, string>;
        count: number;
        chars: number;
        budget_chars: number;
        truncated: boolean;
        preview: string;
      };
    }
```

And in `CLIENT_EVENT_NAMES`, after `"scratchpad.join"`:

```ts
  "memory.write",
  "memory.search",
  "memory.recall",
```

(The `_MissingClientName` guard fails compile until both are in sync; the drift test fails until the manifest names are covered.)

## Implementation strategy

1. **`events/types.ts` first** — add the section + union members. From this moment `mapEventToSSE`'s `never` default and the `SSE_EVENT_NAMES` record type make the runtime fail typecheck: that is the guard chain working. Follow the compiler.
2. **`sse-formatter.ts`** — apply the four edits in the order (a)→(d). Placement is pinned (after scratchpad, before error/default) so the file reads in vocabulary order.
3. **`event-profiles.ts` + `events/index.ts`** — additive edits.
4. **Build + regenerate the manifest** (§5). Do this AFTER the formatter edits or the generator emits a stale list.
5. **Dashboard** — union + names array + drift-test coverage `it`.
6. **Tests** (below), then `bun run check`.

House-style notes (deliberate, do not "fix"):

- Optional event fields use the conditional-key discipline on the wire (`if (x !== undefined) payload.y = x`) — never `null`, never `undefined`-valued keys. Matches every existing branch.
- The three memory events carry **no `ordinal`** and do not extend `StateEventBase` — the state ordinal is the Backpack/Scratchpad rail's ordering key (one stream, minted by `StateEmitter`); memory events are ordinary observability events like `gate.decision`, ordered by timestamp/spanId.
- Doc comments state the byte-cap contract but this issue implements **no capping code** — the caps are applied at event construction by the emitters (#421 uses `capPreview`/`previewValue` from `workflows/state-events.ts`; #422 likewise). Formatter and exporters pass previews through verbatim (state-events precedent).
- `count` duplicates `records.length` / `resultIds.length` deliberately — cheap aggregation for exporters that drop the arrays.

## Test plan

**`packages/agent-runtime/src/events/__tests__/types.test.ts`** — extend with a `describe("memory events (#420)")`:

- `createEvent("agent.memory.write", {...})` with two records (one carrying `supersededId`) — asserts type discriminant, auto `timestamp`/`spanId`, field passthrough.
- `createEvent("agent.memory.search", {...})` with and without the optional filter fields.
- `createEvent("agent.memory.recall", {...})` — asserts the pinned `{count, chars, truncated}` trio plus `budgetChars`/`preview`.

**`packages/agent-runtime/src/transport/__tests__/sse-formatter.test.ts`** — new `describe("memory lifecycle")` following the file's existing style (build event via `createEvent`, format, split frame, parse data):

- `memory.write`: wire name is `memory.write`; payload has `scope`, `count`, `records` with snake_case `superseded_id` present only on the superseding record; `tool_call_id` present when set.
- `memory.write` omission: no `toolCallId` ⇒ no `tool_call_id` key; a record without `supersededId` ⇒ no `superseded_id` key (assert `"superseded_id" in rec === false`).
- `memory.search`: full payload incl. `include_invalidated`, `result_count`, `result_ids`, `query`, `kinds`, `tags`; and an omission case (no query/kinds/tags/toolCallId ⇒ keys absent).
- `memory.recall`: payload is exactly `{scope, count, chars, budget_chars, truncated, preview}` (+ enriched `traceId`/`timestamp`).
- `SSE_EVENT_NAMES` maps the three `agent.memory.*` types to the three wire names.

**`packages/agent-runtime/src/events/__tests__/event-profiles.test.ts`** — in the OBSERVABILITY describe: `expect(types).toContain("agent.memory.write" | ".search" | ".recall")`; assert UX does NOT contain them (pins the OBSERVABILITY-only decision).

**`packages/agent-dashboard/src/__tests__/sse-events.drift.test.ts`** — add:

```ts
it("covers the memory kinds (#420) explicitly", () => {
  const client = new Set<string>(CLIENT_EVENT_NAMES);
  for (const name of ["memory.write", "memory.search", "memory.recall"]) {
    expect(client.has(name)).toBe(true);
  }
});
```

**Existing tests that must stay green with no edits:** `sse-wire-manifest.test.ts` (proves the regen was done), the main drift-check `it`, and every exporter test (`SQLiteExporter` is generic — the issue pins zero exporter changes).

## Acceptance

- `bun run check` green (build + typecheck + lint + test, all packages) — including the dashboard drift test.
- All three exhaustiveness guards compile: `mapEventToSSE`'s `never` default, `_MissingWireName`, `_MissingClientName` (plus the `SSE_EVENT_NAMES` record type).
- `sse-event-manifest.json` regenerated by the tool (sorted, `$comment` intact), never hand-edited.
- Recall event carries the pinned `{count, chars, truncated}`; all size figures are chars, not bytes/tokens.
- Event profiles: the three types added to OBSERVABILITY only.
- Commit style: `feat(#420): memory events — agent.memory.write/search/recall through the four guards` (spec file committed alongside the code).

## Out of scope

- **Emitting the events** — MemoryToolbox `ctx.emit` wiring is #421; the recall assembler (and its `agent.memory.recall` emission) is #422.
- **Preview-capping code** — emitters cap at construction using the existing `workflows/state-events.ts` helpers; nothing to build here.
- **Exporter changes** (SQLiteExporter/Langfuse/OTel are generic or event-agnostic — issue pin).
- **Dashboard rendering** of memory events (memory lens = ADR-0007 future work; the chat reducer deliberately ignores unknown names).
- **UX/DEBUG/TOOLS profile membership**, `StreamEvent` membership, `STATE_DELTA_EVENT_TYPES` (conversation replay) membership.
- **Promotion/overlay events** (ADR-0008 Phase B) and any `memory/` module change.
- Docs refresh (m7, #423).
