# W1-DataTable (WI-5) — DataTable responsive core: column priority + scroll fallback

**Date:** 2026-07-24
**Package:** `@pattern-stack/agentic-dashboard` (`packages/agent-dashboard/`)
**Status:** Spec — ready for implementation
**Size:** ~40 changed lines in `DataTable.tsx` + one new test file (~90 lines)

## Goal

Make the shared `DataTable` organism survive narrow viewports **once, for all
consumers** (eval runs / sets / compare pages, run detail). Two mechanisms,
both opt-out-free for existing callers:

1. **Column priority** — a new `hideBelow?: "sm" | "md"` field on `Column<T>`.
   Columns tagged `hideBelow: "md"` are dropped below 900px; `hideBelow: "sm"`
   below 640px. The component filters columns *before* render, and all colSpan
   math follows the filtered count.
2. **Scroll fallback** — the wrapper div gains `overflowX: "auto"` so tables
   whose consumers haven't (yet) pruned columns degrade to horizontal scroll
   instead of crushing every column to illegibility. Cell padding tightens on
   phone to buy back horizontal room.

This item **unblocks** the W1-EvalPages and W1-EvalCompare specs, which consume
the `hideBelow` contract.

## Dependencies (shared contract F1 — must land first)

- `packages/agent-dashboard/src/hooks/useMediaQuery.ts` exports
  `useBreakpoint(): { isPhone: boolean; isNarrow: boolean; isDesktop: boolean }`.
  - `isPhone` — viewport `< BREAKPOINTS.sm` (640px)
  - `isNarrow` — viewport `< BREAKPOINTS.md` (900px)
  - `isDesktop` — viewport `>= BREAKPOINTS.md`
- `packages/agent-dashboard/src/ui/breakpoints.ts` exports
  `BREAKPOINTS = { sm: 640, md: 900 }`.
- In jsdom the F1 hook defaults to **desktop** when `window.matchMedia` is
  unstubbed, so all existing DataTable-consuming tests keep passing untouched.

Neither file exists in this worktree yet; do not implement them here. If F1 has
not merged when this spec is picked up, this item is blocked.

## Files

```
packages/agent-dashboard/
├── src/components/organisms/DataTable.tsx        # modified
└── src/__tests__/DataTable.responsive.test.tsx   # new
```

## Design

### 1. `Column<T>` gains `hideBelow` (DataTable.tsx:14-19)

```ts
interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  /** Drop this column below the breakpoint: "sm" = <640px, "md" = <900px. */
  hideBelow?: "sm" | "md";
}
```

`Column` is currently a non-exported interface; **export it** (`export interface
Column<T>`) so W1-EvalPages / W1-EvalCompare can type their column arrays.
Keep `DataTableProps` unexported.

### 2. Filter step + colSpan fix (component body, ~lines 63-77)

```tsx
import { Fragment, type ReactNode, useMemo } from "react";
import { useBreakpoint } from "../../hooks/useMediaQuery";

export function DataTable<T>({ columns, ... }: DataTableProps<T>) {
  const { isPhone, isNarrow } = useBreakpoint();

  const visibleColumns = useMemo(
    () =>
      columns.filter((col) => {
        if (col.hideBelow === "sm") return !isPhone;
        if (col.hideBelow === "md") return !isNarrow;
        return true;
      }),
    [columns, isPhone, isNarrow],
  );

  const expandable = Boolean(onToggleExpand && renderExpanded);
  const interactive = expandable || Boolean(onRowClick);
  // MUST use the filtered count — expanded-row and empty-state cells
  // (current lines 164 and 181) otherwise overshoot the real column count.
  const totalColSpan = visibleColumns.length + (expandable ? 1 : 0);
```

Every subsequent `columns.map(...)` (header row ~line 92, body cells ~line 153)
switches to `visibleColumns.map(...)`. `totalColSpan` is already threaded to the
expanded-detail `<td colSpan>` and the "No data" `<td colSpan>` — no further
change there beyond the source variable.

### 3. Wrapper scroll fallback (~lines 80-88) + phone cell padding (~line 40)

```tsx
// wrapper div — was overflow: "hidden", which crushes wide tables
style={{
  background: "var(--paper)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-lg)",
  overflow: "hidden",          // keep: clips rounded corners vertically
  overflowX: "auto",           // wins for the x-axis; wide tables scroll
  WebkitOverflowScrolling: "touch",
}}

// cellStyle — tighter padding on phone (headerStyle inherits via spread)
const cellStyle = (align = "left", isPhone = false) =>
  ({
    padding: isPhone ? "8px 10px" : "10px 14px",
    ...
  }) as const;
```

`cellStyle`/`headerStyle` are module-level helpers; pass `isPhone` down as a
parameter (thread it through `headerStyle(align, isPhone)` the same way) rather
than converting them to hooks. Call sites inside the component pass the value
from `useBreakpoint()`; the expand-caret `<td>` (~line 141) and empty-state
`<td>` (~line 180) use the same parameterized call.

## Implementation steps

1. In `DataTable.tsx`, add `hideBelow?: "sm" | "md"` to `Column<T>` (lines
   14-19) and export the interface.
2. Import `useBreakpoint` from `../../hooks/useMediaQuery`; call it at the top
   of `DataTable`.
3. Add the `visibleColumns` `useMemo` filter (design §2); switch both
   `columns.map` call sites and the `totalColSpan` computation to it.
4. Add `isPhone` parameter to `cellStyle` / `headerStyle`; update all call
   sites; keep the exact desktop values (`10px 14px`) unchanged.
5. Update the wrapper div style: keep `overflow: "hidden"`, add
   `overflowX: "auto"` after it and `WebkitOverflowScrolling: "touch"`.
6. Write `src/__tests__/DataTable.responsive.test.tsx` per the test plan.
7. Run `bun run --filter=@pattern-stack/agentic-dashboard test` — new suite plus all
   existing DataTable consumers (EvalRunsPage, EvalSetsPage, EvalComparePage,
   EvalRunDetailPage, EvalSetDetailPage tests) must pass unmodified.
8. `bun run check` (build + typecheck + biome + vitest) before PR; land via PR
   (main is protected).

## Test plan — `src/__tests__/DataTable.responsive.test.tsx`

Conventions per existing suites (e.g. `SlotStack.test.tsx`): `@testing-library/react`
`render`/`screen`/`cleanup`, `vitest` imports, `afterEach(cleanup)`. Stub
`window.matchMedia` with `vi.stubGlobal` so `useBreakpoint` reports the desired
breakpoint; `vi.unstubAllGlobals()` in `afterEach`. A helper
`stubViewport(width: number)` implements `matchMedia` by evaluating
`(max-width|min-width)` queries against the given width.

| # | Case | Setup | Assert |
|---|------|-------|--------|
| 1 | Desktop default — all columns render | no matchMedia stub (jsdom default → desktop via F1 hook) | headers for all columns incl. `hideBelow` ones present; padding is `10px 14px` |
| 2 | Phone drops `sm` + `md` columns | `stubViewport(500)` | `hideBelow: "sm"` and `"md"` headers/cells absent; untagged columns present |
| 3 | Narrow (tablet) drops only `md` | `stubViewport(700)` | `hideBelow: "md"` absent; `hideBelow: "sm"` and untagged present |
| 4 | colSpan matches filtered count | `stubViewport(500)`, `data: []`, 4 columns (2 hidden), expandable off | "No data" `<td>` has `colSpan === 2` |
| 5 | colSpan with expandable | `stubViewport(500)`, expandable table with one row expanded | expanded-detail `<td>` `colSpan === visible + 1` |
| 6 | Wrapper scrolls, not clips | any | wrapper div style has `overflow-x: auto` |

## Contract published

Consumed by **W1-EvalPages** and **W1-EvalCompare** (do not change without
updating both):

- `Column<T>.hideBelow?: "sm" | "md"` — exported from
  `packages/agent-dashboard/src/components/organisms/DataTable.tsx`.
  Semantics: `"sm"` → column hidden when `isPhone` (<640px); `"md"` → hidden
  when `isNarrow` (<900px). Omitted → always visible.
- Behavioral guarantee: colSpan of expanded-detail and empty-state rows always
  equals the *visible* column count (+1 when expandable), and any un-pruned
  overflow degrades to horizontal scroll.

## Conventions

Strict TS (`noUncheckedIndexedAccess` etc.), biome (double quotes, 2-space,
100-char lines), vitest + jsdom. Layer rules unaffected — organism imports a
hook and a ui token, both lower in the dashboard's internal hierarchy.
