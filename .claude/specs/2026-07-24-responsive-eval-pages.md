# W1-EvalPages (WI-6) — Responsive eval list + detail pages

**Date:** 2026-07-24
**Status:** SPEC
**Size:** ~200-300 changed lines across 7 eval-page files (+1 kit-adjacent wrapper), all in
`packages/agent-dashboard`. Mostly mechanical: `hideBelow` column annotations and
`isPhone` grid/flex branches. No new components, no API changes.

## Goal

Single-column reflow of the eval CRUD surfaces (`/eval`, `/eval/sets`, `/eval/sets/:id`,
`/eval/runs/:id`, `/eval/sets/:id/cases/:caseId`) on phone viewports (<640px):

1. Annotate every eval-page `DataTable` column list with `hideBelow` so low-value columns
   are pruned on phone/narrow instead of forcing a horizontal scroll of the whole table.
2. Collapse the two-column `1fr 1fr` JSON compare grids to `1fr` below sm.
3. Make the fixed-min-width aggregate rows and header/action rows wrap instead of overflow.

## Dependencies (shared contract — delivered by the foundation work items; verify before starting)

- **F1 — `useBreakpoint()`**: hook at `packages/agent-dashboard/src/hooks/useBreakpoint.ts`
  returning `{ isPhone; isNarrow; isDesktop }`, where **`isPhone` = viewport < 640px** (sm).
  As of this writing the hook does **not exist yet** in
  `packages/agent-dashboard/src/hooks/` (`useAdminData.ts`, `useEvalRunStream.ts`,
  `useEventStream.ts`, `useSortedRows.ts` only) — this item is blocked until F1 lands.
- **W1-DataTable**: `Column<T>` in
  `packages/agent-dashboard/src/components/organisms/DataTable.tsx` (currently lines 14-19:
  `key`, `header`, `render?`, `align?`) gains `hideBelow?: "sm" | "md"` and the table
  filters columns internally (`"sm"` = hidden when `isPhone`; `"md"` = hidden when
  `isPhone || isNarrow`). The table wrapper (currently the `overflow: "hidden"` div at
  lines 80-87) already provides an `overflowX: "auto"` fallback for whatever columns
  remain. **This spec only annotates column arrays** — no DataTable internals change here.

Semantics used throughout: `hideBelow: "sm"` prunes on phone only; `hideBelow: "md"`
prunes on phone *and* narrow. Keep-columns are the identity/status/outcome columns.

## File tree

```
packages/agent-dashboard/src/pages/eval/
├── EvalRunsPage.tsx          # column annotations only (filter row already wraps)
├── EvalSetsPage.tsx          # column annotations only
├── EvalSetDetailPage.tsx     # actions-row wrap + two tables' annotations
├── EvalRunDetailPage.tsx     # header-row wrap + results-table annotations
├── EvalCaseDetailPage.tsx    # isPhone 1fr grids + history-table annotations
├── SplitAggregatesPanel.tsx  # bucket row wraps on phone
├── RunLaunchForm.tsx         # control width clamp (already single-column)
└── RunLauncher.tsx           # drop minWidth:320 on phone (RunLaunchForm's inline host)

packages/agent-dashboard/src/__tests__/
├── EvalCaseDetailPage.test.tsx   # + grid-collapse assertions
└── EvalRunsPage.test.tsx         # + column-pruning assertions
```

## Per-file changes

Line numbers verified against the current tree; re-confirm before editing.

### 1. `src/pages/eval/EvalRunsPage.tsx`

- Filter row (line 180) already has `flexWrap: "wrap"` — **no change**.
- Columns array of the runs `DataTable` (lines 250-301): add annotations
  - `targetId` (line 278) → `hideBelow: "sm"`
  - `variant` (line 279) → `hideBelow: "md"`
  - `split` (lines 280-284) → `hideBelow: "sm"`
  - `model` (line 295) → `hideBelow: "md"`
  - Keep always: `select`, `id`, `setId`, `status`, `passed`, `tsStart`.

```tsx
{ key: "targetId", header: "Target", hideBelow: "sm", render: (row) => row.targetId ?? "—" },
{ key: "variant", header: "Variant", hideBelow: "md", render: (row) => row.variant ?? "—" },
```

### 2. `src/pages/eval/EvalSetsPage.tsx`

- Columns array (lines 117-168):
  - `splits` (lines 158-162) → `hideBelow: "sm"`
  - `createdTs` (lines 163-167) → `hideBelow: "md"`
  - Keep always: `id`, `name`, `caseCount`. (The Name cell's description already
    ellipsizes at `maxWidth: 440` — fine as-is.)

### 3. `src/pages/eval/EvalSetDetailPage.tsx`

- Header row (lines 151-178): the outer row and title cluster already wrap; the
  **actions div at line 167** (`display: "flex", gap: 8` — Run eval / Edit set / New case)
  does not. Add `flexWrap: "wrap"`:

```tsx
<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
```

- Cases-by-split `DataTable` (columns at lines 268-336):
  - `expected` (lines 280-288) → `hideBelow: "sm"`
  - `tags` (lines 289-304) → `hideBelow: "md"`
  - Keep always: `caseId`, `input`, `actions` (row actions must stay reachable on phone).
- "Runs against this set" `DataTable` (columns at lines 358-381):
  - `variant` (line 369) → `hideBelow: "md"`
  - `split` (lines 370-374) → `hideBelow: "sm"`
  - Keep always: `id`, `targetId`, `status`, `tsStart`.

### 4. `src/pages/eval/EvalRunDetailPage.tsx`

- Stats grid (lines 303-331) is already `repeat(auto-fit, minmax(110px, 1fr))` — **no change**.
- Title row (line 227, `display: "flex", alignItems: "center", gap: 10` holding the
  back link + mono run id + status badges): add `flexWrap: "wrap"` — long run ids
  overflow a 375px viewport otherwise.
- Results `DataTable` (columns at lines 334-375):
  - `runStatus` (lines 353-362) → `hideBelow: "sm"`
  - `tokens` (lines 363-368) → `hideBelow: "sm"`
  - `elapsedMs` (lines 369-374) → `hideBelow: "md"`
  - Keep always: `caseId`, `pass`, `scores` (the expanded `CaseDetail` row still shows
    everything, so pruned data stays one tap away).

### 5. `src/pages/eval/EvalCaseDetailPage.tsx`

- Import the hook and read it once at the top of `EvalCaseDetailPage` (after line 48):

```tsx
import { useBreakpoint } from "../../hooks/useBreakpoint";
// inside the component:
const { isPhone } = useBreakpoint();
```

- Input/Expected grid (line 155):

```tsx
<div style={{ display: "grid", gridTemplateColumns: isPhone ? "1fr" : "1fr 1fr", gap: 12, marginTop: 14 }}>
```

- Expected/Actual grid inside `renderExpanded` (line 233) — same component scope, the
  same `isPhone` binding applies:

```tsx
<div style={{ display: "grid", gridTemplateColumns: isPhone ? "1fr" : "1fr 1fr", gap: 12 }}>
```

- History `DataTable` (columns at lines 180-226):
  - `targetId` (line 192) → `hideBelow: "sm"`
  - `variant` (line 193) → `hideBelow: "md"`
  - `split` (lines 194-198) → `hideBelow: "md"`
  - `runStatus` (lines 204-213) → `hideBelow: "sm"`
  - `tokens` (lines 214-219) → `hideBelow: "sm"`
  - `elapsedMs` (lines 220-225) → `hideBelow: "md"`
  - Keep always: `evalRunId`, `tsStart`, `pass`.

### 6. `src/pages/eval/SplitAggregatesPanel.tsx`

- `SplitBucketRow` (lines 151-183) is a fixed row: badge `minWidth: 72` + counts
  `minWidth: 150` + flex meter + pct `minWidth: 36` ≈ 300px of floor before the meter
  gets any width. On phone, wrap the meter onto its own line. `SplitBucketRow` is a
  component — call the hook directly inside it:

```tsx
function SplitBucketRow({ bucket }: { bucket: SplitAggregate }) {
  const { isPhone } = useBreakpoint();
  const pct = ...;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12,
                  flexWrap: isPhone ? "wrap" : undefined }}>
      <Badge ... />                                       {/* unchanged, minWidth: 72 */}
      <div style={{ fontSize: 12, color: "var(--ink-2)",
                    minWidth: isPhone ? 0 : 150 }}>...</div>
      <div style={{ /* meter */ flex: isPhone ? "1 1 100%" : 1, ... }}>...</div>
      <div style={{ ...pct, minWidth: 36 }}>...</div>     {/* unchanged */}
    </div>
  );
}
```

  Result on phone: line 1 = split badge + counts, line 2 = full-width meter + pct.
- Panel header row (lines 76-88) is title + short caption — fits at 375px, no change.

### 7. `src/pages/eval/RunLaunchForm.tsx` (+ its inline host `RunLauncher.tsx`)

- **Finding:** the form itself is already a single-column stack
  (`flexDirection: "column"`, line 184) with `Field` (flex-column label) wrapping each
  control — no row reflow needed. Two mechanical fixes remain:
  1. Selects with long option text (set ids, agent names) refuse to shrink below their
     intrinsic width. Clamp every control: define one local
     `const controlStyle = { ...inputStyle, width: "100%", minWidth: 0 } as const;`
     and replace `style={inputStyle}` on the selects/input at lines 194-207, 223-236,
     244-250, 254-265, 280-292 (preserve the two preset-label spreads at lines 188 and
     217 by spreading `controlStyle` there instead of `inputStyle`).
  2. `RunLauncher.tsx` line 25 hosts the form inline in the Eval Runs page header with
     `minWidth: 320` — wider than a 375px phone column once header padding is taken.
     Add `const { isPhone } = useBreakpoint()` and change to
     `minWidth: isPhone ? 0 : 320, maxWidth: "100%"`.
     (`RunLaunchModal` needs nothing — the Modal owns its own responsive width.)

## Implementation steps

1. Confirm F1 + W1-DataTable have landed: `useBreakpoint` exported from
   `src/hooks/useBreakpoint.ts` and `hideBelow` present on `Column<T>` in
   `src/components/organisms/DataTable.tsx`. If not, stop — this item is blocked.
2. Annotate columns in `EvalRunsPage.tsx` and `EvalSetsPage.tsx` (changes 1-2). These
   are pure object-literal additions; typecheck catches any drift from the W1-DataTable
   contract immediately.
3. Apply `EvalSetDetailPage.tsx` and `EvalRunDetailPage.tsx` (changes 3-4): the two
   `flexWrap: "wrap"` additions plus column annotations.
4. Apply `EvalCaseDetailPage.tsx` (change 5): hook import, `isPhone` binding, both grid
   branches, history-table annotations.
5. Apply `SplitAggregatesPanel.tsx` (change 6) and `RunLaunchForm.tsx` +
   `RunLauncher.tsx` (change 7).
6. Extend the two test files per the test plan below.
7. `bun run --filter=@pattern-stack/agentic-dashboard typecheck && bun run lint && bun run --filter=@pattern-stack/agentic-dashboard test`
   (or full `bun run check`).

## Test plan

Vitest + jsdom + Testing Library, extending the existing suites in
`packages/agent-dashboard/src/__tests__/` (`EvalRunsPage.test.tsx`,
`EvalCaseDetailPage.test.tsx` already mock the eval API fetchers and render via
react-router). jsdom has **no `window.matchMedia`**, so `useBreakpoint` resolves its
desktop default — desktop assertions need no setup; phone assertions stub `matchMedia`
the way `src/__tests__/theme-mode.test.ts` (lines 17-25) already does:

```ts
function stubPhone() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /max-width:\s*639/.test(query), // matches the hook's sm query; verify against F1
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}
```

Install the stub **before** `render(...)` (the hook reads it on mount) and
`vi.unstubAllGlobals()` in `afterEach`. Match the stub's query predicate to whatever
media query F1's hook actually issues (or to its resize/innerWidth mechanism if F1 is
not matchMedia-based — adjust the stub to `window.innerWidth = 375` + `resize` dispatch
in that case).

Spot-checks (per the shared plan, two surfaces stand in for the mechanical rest):

1. **Grid collapse — `EvalCaseDetailPage.test.tsx`**
   - Desktop (no stub): render with a case that has `expected`; assert the container of
     the "Input" micro-heading's parent grid has `gridTemplateColumns: "1fr 1fr"`
     (walk up from `screen.getByText("Input")` two levels; assert via
     `toHaveStyle({ gridTemplateColumns: "1fr 1fr" })`).
   - Phone (stub): same query, assert `"1fr"`.
   - Phone + expanded history row: toggle a history row, assert the Expected/Actual
     grid also reports `"1fr"`.
2. **Column pruning — `EvalRunsPage.test.tsx`**
   - Desktop: after the mocked runs load, assert headers `Target`, `Variant`, `Split`,
     `Model` are all present (`screen.getByText(...)` scoped to `columnheader` roles).
   - Phone (stub): assert `Run`, `Set`, `Status`, `Passed`, `Started` remain and
     `queryByRole("columnheader", { name: "Target" })` (and Variant/Split/Model) is null.
3. Existing suites for the other pages must stay green untouched — desktop-default jsdom
   means every current assertion sees the same DOM as before (the only desktop-visible
   deltas are additive `flexWrap`/`maxWidth` styles).

No new test files; no snapshot tests (inline-style churn makes them brittle).

## Conventions

- Strict TS (`noUncheckedIndexedAccess` etc.) — `hideBelow` values are the literal union
  from the W1-DataTable contract; no casts.
- biome: double quotes, semicolons, 2-space indent, 100-char lines — the annotated
  column literals stay one-property-per-line where they already are.
- Inline `style` objects with `isPhone ? a : b` branches are this codebase's idiom
  (no CSS modules / media-query stylesheets in pages) — follow it; do not introduce
  class-based breakpoints here.
- Land via PR (`main` is protected); no version bump — dashboard ships with the
  lockstep group only when runtime/server/cli bump.

## Out of scope

- `DataTable.tsx` internals (`hideBelow` filtering, `overflowX` wrapper) — W1-DataTable.
- `useBreakpoint` itself — F1.
- `EvalComparePage.tsx`, `CaseDetail.tsx`, and the modals (`CaseEditModal`,
  `SetEditModal`, `RunLaunchModal`, `ConfirmModal`) — separate work items / already
  modal-responsive.
- Any behavioral change: pruned columns are presentation-only; sorting keys, row
  navigation, and expansion are untouched.
