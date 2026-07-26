# Artifacts dashboard slice (ADR-0006)

**Date:** 2026-07-26
**Package:** `@agentic-patterns/dashboard` (`packages/agent-dashboard/`)
**Status:** Spec — ready for implementation
**Source of truth:** `docs/adr/0006-render-artifacts.md` (Accepted, read off
`docs/adr-render-artifacts` branch — not yet on `main`/this worktree's `docs/`).

## Goal

Render `RenderArtifact`s that arrive on `tool.end` / `message.complete` SSE
events directly in chat — no resolution step, no fetch. A `table` artifact
becomes a real table (reusing the already-responsive `DataTable` organism); an
unknown `displayType` degrades to the existing JSON/CodeBlock fallback; a
ceiling marker (`data` absent) renders an honest placeholder. This closes the
gap named in the ADR: a terminal tool's structured answer today renders as raw
JSON with an inert `[ref_key: …]` string, even though the run produced a
renderable table.

## Pinned wire contract (do not change — a parallel builder emits this)

```
artifacts: [ { id: string, display_type: string, data?: unknown, title?: string, truncated?: boolean } ]
```

- Key absent when there are no artifacts. Optional on both `tool.end` and
  `message.complete`.
- `display_type: "table"` → `data` is `{ columns: string[], rows: unknown[][] }`.
- `display_type` is an open string — unknown types must degrade (render JSON),
  never crash.
- `data` may be absent even for `table` — a ceiling marker (payload dropped for
  size). Render a placeholder, never a partial/fabricated table.
- `truncated: true` — producer advisory, surface it (a chip).

## Dashboard has no core/runtime dependency (verified)

`packages/agent-dashboard/package.json` deps: `@xyflow/react`, `lucide-react`,
`react`, `react-dom`, `react-router-dom` only — no `@agentic-patterns/core` or
`zod`. Confirmed by the existing precedent at `api/types.ts:122-125`
("hand-mirrored... the dashboard has no runtime dependency"). This slice
follows the same pattern: local types + a hand-written structural guard
instead of importing `TableArtifactDataSchema`/`isTableArtifact` from core.

## What already exists and is sufficient — no changes needed

- **`DataTable`** (`src/components/organisms/DataTable.tsx`) already has
  column-priority pruning (`hideBelow`) and a horizontal-scroll wrapper
  (`overflow: hidden` + `overflowX: "auto"` on the outer div, line 93-101) —
  Wave 1 (`W1-DataTable`) shipped this. No `white-space: nowrap` anywhere in
  its cell styles (`cellStyle`, line 41-47), so the "nowrap cell reports
  min-content width under `table-layout: auto`" trap the task description
  warns about does **not** apply to this component as-is — verified by
  reading the full file, not assumed. We reuse it unmodified.
- **`.chat-body`** (`chat.css:51`) already carries `min-width: 0` (its parent,
  `.chat-row`, is not itself a flex container the artifact block sits in
  directly, but `.chat-body` — the flex-column ancestor of every rendered
  part — is). The `.md-table-wrap` markdown-table precedent (`chat.css:797`)
  proves this containment pattern already works for wide tabular content in
  this exact column. We follow the same shape: give the new artifact wrapper
  divs `min-width: 0` too (belt-and-suspenders on a flex-column child, since a
  flex item's automatic minimum width is content-based unless overridden).
- **`MessageRow.tsx`** dispatches every `ChatMessage.parts` entry through
  `PartView` after `coalesceStateParts` (`MessageRow.tsx:49,72`).
  `coalesceStateParts` (`model.ts:336-354`) only special-cases
  `state_delta`/`agent_step` kinds and passes everything else through
  unchanged — so a new top-level `kind: "artifacts"` Part requires **no
  change** to `MessageRow.tsx` or `coalesceStateParts`; adding the `PartView`
  dispatch case is sufficient.

## Design

### 1. `src/chat/model.ts` — parse + fold

**New types** (placed after the existing field-accessor helpers, ~line 153,
before the `childTarget` comment block):

```ts
export interface ChatArtifact {
  readonly id: string;
  readonly displayType: string;
  readonly data?: unknown;
  readonly title?: string;
  readonly truncated?: boolean;
}

export interface TableArtifactData {
  readonly columns: string[];
  readonly rows: unknown[][];
}

export function isTableArtifactData(data: unknown): data is TableArtifactData {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const r = data as Record<string, unknown>;
  return (
    Array.isArray(r.columns) &&
    r.columns.every((c) => typeof c === "string") &&
    Array.isArray(r.rows) &&
    r.rows.every((row) => Array.isArray(row))
  );
}

function parseArtifacts(v: unknown): ChatArtifact[] | undefined { /* tolerant parse, see below */ }
function collectArtifactIds(parts: Part[]): Set<string> { /* dedup helper, see below */ }
```

`parseArtifacts` reads the wire array, tolerant of both `display_type` (wire)
and a stray `displayType` (defensive, matches this module's existing dual-case
accessor convention e.g. `toolName`/`durMs`). Drops entries missing `id` or
`displayType` rather than throwing — a malformed artifact must not lose the
rest of the turn. `data`/`title`/`truncated` copied through only when present
(conditional spread, mirrors `render-artifact.ts`'s `tableArtifact()` builder
in core, read for the pattern even though not imported).

`collectArtifactIds` walks `parts` (recursing into `agent_step.children`) to
find ids already carried by a `tool_call.artifacts` or a prior standalone
`artifacts` part — used to dedupe `message.complete`'s list against what
`tool.end` already emitted (ADR §3: "emitting the same payload in both places
is wasteful, not illegal" — the client is expected to reconcile).

**`Part` union** (lines 28-89): add `artifacts?: ChatArtifact[]` to the
`tool_call` variant (line 32-40), and one new top-level variant:

```ts
| { kind: "artifacts"; items: ChatArtifact[] }
```

**`applyParts` — `tool.end` case (line 461-480):** thread
`artifacts: parseArtifacts(p.artifacts ?? col.artifacts)` into `filled`
alongside the existing `result`/`error`/`durationMs` fields.

**`applyParts` — `message.complete`/`llm.end` case (line 546-560):** artifacts
ride on `message.complete` only (mirrors the existing `cost_usd` comment at
line 552-553 — "cost rides on message.complete only"). Guard with
`bare(String(e.type)) === "message.complete"` since the case is shared with
`llm.end`. Parse `p.artifacts ?? col.artifacts`, dedupe via
`collectArtifactIds(parts)` (the pre-fold list — a tool.end earlier in this
same reduce already landed its artifacts into `next`/`parts`), and if any
survive, append one `{ kind: "artifacts", items: fresh }` part. The case
currently returns the **original** `parts` unchanged (bug-compatible
no-op start point) — change to return the possibly-appended array instead of
always `parts`, but only construct a new array when there's something to
append (avoid a needless identity change on every plain `message.complete`
with no artifacts).

**Replay (`eventsToAssistantMessage`, line 602-616):** no change — it already
fans every persisted event through the same `applyParts`. Per ADR
Consequences, artifacts are not persisted (v1), so a persisted event row
simply won't carry the `artifacts` field and nothing renders on replay — the
same degraded view as today, not a regression this slice owns fixing.

### 2. `src/chat/parts.tsx` — render

Import `DataTable`/`Column` from `../components/organisms/DataTable` and
`ChatArtifact`/`isTableArtifactData` from `./model`.

New section (placed after the state-delta block, before the gate-decision
block, ~line 887):

- `ArtifactHead({ artifact })` — small header: `title ?? displayType` label +
  a `truncated` chip when `artifact.truncated`.
- `TableArtifactBlock({ artifact })` — requires `isTableArtifactData(artifact.data)`
  already true (caller-checked); builds `Column<unknown[]>[]` from
  `columns` (`header`, `render: (row) => fmt(row[i])`, reusing the module's
  existing `fmt` JSON/string formatter) and renders `<DataTable columns={cols}
  data={rows} />` (no `rowKey` — falls back to `DataTable`'s internal
  index-based default, since positional rows have no stable identity field).
- `CeilingPlaceholder({ artifact })` — `artifact.data === undefined` case:
  `"<displayType> — too large to display"`, styled as a dashed placeholder
  (`.artifact-placeholder`), never a table.
- `JsonArtifactBlock({ artifact })` — the degrade-gracefully path for any
  non-table `displayType`, or a `table` whose `data` fails
  `isTableArtifactData` (contract violation from a buggy producer — same
  fallback as a genuinely unknown type, never a crash): reuses `fmt` +
  `CodeBlock` exactly like `ToolCallPart`'s existing `output` rendering.
- `ArtifactBlock({ artifact })` — dispatcher: `data === undefined` →
  `CeilingPlaceholder`; `displayType === "table" && isTableArtifactData(data)`
  → `TableArtifactBlock`; else → `JsonArtifactBlock`. Exported for tests.

Wiring:

- `ToolCallPart` (line 209-245): after the existing `output`/`error` block
  inside `.tool-io`, add (only when `part.artifacts?.length`):
  ```tsx
  <div>
    <div className="io-label">artifacts</div>
    <div className="chat-artifacts">
      {part.artifacts.map((a) => <ArtifactBlock key={a.id} artifact={a} />)}
    </div>
  </div>
  ```
- `PartView` dispatcher (line 962-993): add
  ```tsx
  case "artifacts":
    return (
      <div className="chat-artifacts">
        {part.items.map((a) => <ArtifactBlock key={a.id} artifact={a} />)}
      </div>
    );
  ```

### 3. `src/chat/chat.css` — containment

New block near the existing `.chat-tool .tool-io` rules (~line 267):

```css
.chat-artifacts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.artifact-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.artifact-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fz-tiny);
  color: var(--ink-2);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 500;
}
.artifact-chip {
  font-size: 10px;
  text-transform: none;
  letter-spacing: normal;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--fill-2);
  color: var(--ink-2);
}
.artifact-placeholder {
  padding: 9px 11px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  color: var(--mute);
  font-size: var(--fz-small);
  font-style: italic;
}
```

`min-width: 0` on both wrapper levels: a flex-column child's automatic minimum
width defaults to its content's min-content size, which for a nested
`DataTable` could exceed the column's available width and stretch the whole
chat message — the same class of bug the `.md-table-wrap` precedent
(`chat.css:797-820`) already guards against for markdown tables. Belt-and-
suspenders since `DataTable`'s own wrapper already clips with
`overflow-x: auto`, but cheap insurance and matches the existing
`.chat-body`/`scratchpad-rail.css` pattern of stacking `min-width: 0` down the
flex chain.

## Explicitly out of scope (confirmed, not touched)

- `packages/agent-runtime/**`, `packages/agent-core/**`, `packages/agent-server/**`.
- `[#N]` / `crm_table:` ref-expansion in prose (`linkifyCites`, `parts.tsx:50`)
  — ADR follow-up, not this slice.
- Heuristic JSON-answer unwrapping in `TextPart`/`AssistantText` — the ADR
  rejects this as the primary fix (§9, Alternatives); no change to text
  rendering.

## Test plan

New/extended per existing conventions (vitest + `@testing-library/react`,
`afterEach(cleanup)`, `vi.stubGlobal("matchMedia", …)` for phone assertions
per `TokensPage.responsive.test.tsx`).

**`src/chat/model.test.ts`** (extend):
- `tool.end` carrying a wire-shaped `artifacts` array (snake_case
  `display_type`) lands on `tool_call.artifacts`.
- `tool.end` with no `artifacts` key → `tool_call.artifacts` is `undefined`.
- A malformed entry (missing `id` or `display_type`) is dropped, not thrown.
- `message.complete` carrying `artifacts` (no matching prior tool) produces a
  standalone `{ kind: "artifacts", items }` part appended after existing
  parts.
- `message.complete` artifacts whose `id` already appeared on an earlier
  `tool.end` in the same fold are deduped (no second render of that id) —
  confirms `collectArtifactIds` correctly reads the tool_call's list.
- `llm.end` carrying an `artifacts` field is ignored (artifacts ride on
  `message.complete` only, per ADR — mirrors the existing `cost_usd`
  precedent test if one exists, else a fresh assertion).
- A ceiling marker (`data` absent, `truncated: true`, no `columns`/`rows`)
  parses into a `ChatArtifact` with `data: undefined` — not fabricated.

**New `src/chat/__tests__/render-artifacts.test.tsx`** (mirrors
`state-delta-parts.test.tsx`'s `renderPart` helper):
- Valid `table` artifact on a `tool_call` part renders a real `<table>` with
  the given headers and cell text (via `PartView` with a `tool_call` Part
  carrying `artifacts`).
- `table` artifact with `data` absent renders the honest placeholder text
  (`"table — too large to display"`) and **no** `<table>` element.
- Unknown `displayType` (e.g. `"chart"`) with data present renders the JSON
  fallback (`.chat-code` present, contains the stringified payload) — proves
  graceful degradation, never a crash.
- `table` artifact whose `data` fails the shape guard (e.g. `columns` present
  but not an array of strings) also degrades to the JSON fallback rather than
  crashing `DataTable`.
- `truncated: true` renders the `.artifact-chip` chip; absent/`false` does not.
- Standalone `{ kind: "artifacts", items: [...] }` part (the `message.complete`
  path) renders via `PartView` directly (not nested under a tool card) —
  assert the `.chat-artifacts` wrapper is a sibling of, not inside, `.chat-tool`.
- Phone breakpoint smoke test (stub `matchMedia` per the phone pattern): a
  table artifact still renders without throwing and its `DataTable` wrapper
  still carries the scroll-fallback `overflow-x: auto` (delegated behavior,
  not re-tested in depth — `DataTable.responsive.test.tsx` already owns that
  contract).

## Verification

- `bun run --filter=@agentic-patterns/dashboard typecheck`
- `bun run --filter=@agentic-patterns/dashboard test` (full 494+ suite must
  stay green; new tests add to the count)
- Do **not** run `build`/`lint`/full `check` per the task's process rules.
