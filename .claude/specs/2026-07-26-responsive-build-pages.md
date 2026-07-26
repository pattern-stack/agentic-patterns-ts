# W2-Build — Responsive Roles, Capabilities, Agents roster

**Date:** 2026-07-26
**Status:** SPEC
**Size:** small — one substantive change (Roles instantiation matrix column pruning) +
one defensive wrap fix (Agents roster role-header row). Capabilities needed nothing:
every flex row Wave 1's brief flagged already wraps. All in `packages/agent-dashboard`.

## Goal

Verify (and where genuinely needed, fix) that the three Build-door surfaces —
`RolesPage.tsx`, `CapabilitiesPage.tsx`, `AgentsRosterPage.tsx` — don't crush content at
360-375px phone widths, reusing Wave 1's `useBreakpoint()` / `hideBelow` idioms. Desktop
output must stay byte-for-byte unchanged (jsdom default = desktop, so existing tests are
the regression guard).

## Findings per file (line numbers verified against the current tree)

### 1. `src/pages/build/RolesPage.tsx` — **one change needed**

- `RoleListView` cards (lines 74-92): the row already has `flexWrap: "wrap"` (line 79)
  and the "similar" chip's `marginLeft: "auto"` (line 86) degrades fine when wrapped —
  **no change**.
- `InstantiationMatrix` (lines 126-198): the `Card` already sets `overflowX: "auto"`
  (line 147) — the right *fallback* pattern per the brief. But the 5 columns (`Agent,
  Model, Background, Awareness, Mission`, line 128) have no `hideBelow`-style pruning
  and no `whiteSpace: nowrap`, so at 360px cells with sentence-length content (the
  `Mission` objective, `bodyCell` at lines 139-144) wrap heavily inside a squeezed
  column instead of the table simply widening past the viewport — the horizontal
  scroll never kicks in because the browser's default `table-layout: auto` shrinks
  columns by wrapping text first. This *is* the "crush" the brief asked to verify.
  **Fix:** this is a hand-rolled `<table>`, not the `DataTable` organism, so there's no
  `Column<T>.hideBelow` to annotate directly — reproduce the same idiom manually: read
  `useBreakpoint()` and drop the two lowest-value columns (`Background`, `Awareness`) on
  phone, keeping `Agent`, `Model`, `Mission` (the columns worth reading in a cramped
  viewport). Adjust `colSpan` of the empty-state row to the pruned header count (already
  derived from `headers.length`, so no separate change needed there).

### 2. `src/pages/build/CapabilitiesPage.tsx` — **no change (verified fine)**

The brief called out three ranges; all were already compliant:

- Rows ~227-290 (`ToolRow`, `disclosureRowStyle` at lines 196-206): the description
  span already has `flex: 1, minWidth: 0, overflow: hidden, textOverflow: ellipsis,
  whiteSpace: nowrap` (lines 237-247) — truncates cleanly instead of crushing. By
  design this doesn't wrap (it's a single-line disclosure trigger); that's correct, not
  a bug.
- Multi-chip row at line 500 (`tier1`'s `readManualSection(...)` buttons) — already
  `display: flex, flexWrap: wrap, gap: 8`.
- Multi-chip rows at lines 543 and 559 (`UsedByRow`'s Roles/Agents chip lists) — both
  already `display: flex, flexWrap: wrap, alignItems: center, gap: 8`.
- Swept the rest of the file for the same anti-pattern (`grep flexWrap`): every flex
  chip/action row in the file (lines 114, 396, 500, 543, 559, 657, 727) already carries
  `flexWrap: "wrap"`. Nothing left to fix — this file needs **zero code changes**.

### 3. `src/pages/build/AgentsRosterPage.tsx` — **one defensive change**

- Per-agent chip row inside `AgentCard` (line 167: `display: flex, flexWrap: wrap, gap:
  8, marginTop: 12`) — already wraps, matches the brief's "should wrap" ask with no
  further work.
- Role-header disclosure button (lines 101-133): chevron + role name + `agents.length`
  chip + optional `notReady` chip, laid out `display: flex, alignItems: center, gap: 10`
  with **no `flexWrap`**. The outer role `Card` sets `overflow: "hidden"` (line 100), so
  a long role name plus two chips at 360px would clip silently instead of wrapping or
  scrolling — no fallback at all, unlike the other two files' `overflowX: auto` or
  ellipsis patterns. Cheap, zero-desktop-risk fix: add `flexWrap: "wrap"` to that
  button's style object — a no-op when the row already fits on one line (the common,
  desktop case), and lets it drop to a second line under 360px instead of clipping.

## Implementation steps

1. `RolesPage.tsx`: import `useBreakpoint` from `../../hooks/useMediaQuery`; call it
   inside `InstantiationMatrix`; branch the `headers` array and the per-row `<td>`s for
   `Background`/`Awareness` on `isPhone`.
2. `AgentsRosterPage.tsx`: add `flexWrap: "wrap"` to the role-header button's style
   object (~line 105-114).
3. `CapabilitiesPage.tsx`: no edits.
4. Add `src/__tests__/RolesPage.responsive.test.tsx` (new — no existing Roles test
   file) covering the column-pruning behavior. Extend/add a light responsive check for
   `AgentsRosterPage.tsx` if a test file exists or is worth adding; skip a
   `CapabilitiesPage.responsive.test.tsx` since there's no behavior change to pin —
   the existing `CapabilitiesPage.test.tsx` desktop suite already covers it and stays
   green untouched.
5. `bun run --filter=@agentic-patterns/dashboard typecheck` and the targeted test
   filters (`-- Roles`, `-- Capabilities`, `-- Agents`).

## Test plan

Follow the established `stubPhone()` idiom (matches both the `sm` (639px) and `md`
(899px) queries, per `DataTable.responsive.test.tsx` / `EvalRunsPage.test.tsx`):

```ts
function stubPhone() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /max-width:\s*(639|899)px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}
```

Reset with `__resetMediaQueryCacheForTests()` from `../hooks/useMediaQuery` in
`afterEach`.

1. **RolesPage — instantiation matrix column pruning (new file):**
   - Desktop (no stub): render a role detail with `agents` populated; assert all five
     column headers (`Agent, Model, Background, Awareness, Mission`) are present.
   - Phone (stub): assert `Agent`, `Model`, `Mission` remain and
     `queryByRole("columnheader", { name: "Background" })` /
     `"Awareness"` are null.
   - Empty-agents case at phone width: the "No agents instantiate this role." row's
     `colSpan` matches the pruned (3) header count.
2. **AgentsRosterPage** — no new assertions strictly required since `flexWrap` is a
   pure style addition with no DOM/text change; if a responsive test file is added,
   assert the role-header button's `style.flexWrap === "wrap"` at both desktop and
   phone (constant across breakpoints — verifies the fix without over-testing).
3. Existing `CapabilitiesPage.test.tsx` suite stays green untouched — no responsive
   test file added for it since there is no behavior to pin.

## Conventions

- Strict TS (`noUncheckedIndexedAccess`), biome (double quotes, 2-space, semicolons,
  100-col), inline-style `isPhone ? a : b` branches (this codebase's established idiom
  — no CSS modules/media-query stylesheets).
- Reuse `useBreakpoint` from `src/hooks/useMediaQuery.ts` — do not recreate.
- Land via PR; no version bump for a dashboard-only change unless paired with a
  runtime/server/cli bump.

## Out of scope

- `AgentLensPage.tsx`, `AgentEvalsCard.tsx`, `ToolsPage.tsx`, `ToolRunner.tsx` — parallel
  builders own these.
- `DataTable.tsx` internals, `useMediaQuery.ts`, `breakpoints.ts` — Wave 1 foundation,
  already landed.
- Converting `RolesPage`'s hand-rolled instantiation-matrix `<table>` to the `DataTable`
  organism — would change desktop styling (padding, border color, font size all differ
  between the two) and isn't needed to fix the crush; column-pruning alone suffices.
