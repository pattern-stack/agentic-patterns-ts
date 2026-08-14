# W1-EvalCompare (WI-7) — Responsive Eval Compare Page

**Goal:** `/eval/compare/:aId/:bId` works on a phone. The A/B provenance cards and every
per-case A/B panel stack to one column below `sm` (640px) with the existing explicit
A/B labels keeping the stacked order legible; the comparison `DataTable` prunes columns
so Case + Δ survive on a phone screen without horizontal scroll.

**PR size estimate:** ~130 lines (1 source file modified, 1 new test file).

## Dependencies (shared contract — reproduce, do not re-implement)

- **F1 — `useBreakpoint`** (spec `2026-07-24-responsive-foundation-usebreakpoint.md`,
  files `src/ui/breakpoints.ts` + `src/hooks/useMediaQuery.ts`):
  `useBreakpoint(): { isPhone; isNarrow; isDesktop }` where `isPhone` ⇔ viewport < 640px,
  `isNarrow` ⇔ < 900px, `isDesktop` ⇔ >= 900px. In jsdom without `matchMedia` all
  queries resolve `false` → `{ isPhone: false, isNarrow: false, isDesktop: true }`, so
  the existing `EvalComparePage.test.tsx` suite keeps rendering the desktop layout
  unchanged. Mobile variants gate on the flags (`isPhone`), never the reverse.
- **W1-DataTable:** `Column<T>` in
  `src/components/organisms/DataTable.tsx` gains `hideBelow?: "sm" | "md"` — the table
  filters out columns whose breakpoint matches (hidden when viewport < that breakpoint)
  — and the table wrapper div provides an `overflowX: "auto"` fallback for whatever
  still doesn't fit. This spec only *consumes* `hideBelow`; it must land after (or with)
  the DataTable change.

## File Tree

```
packages/agent-dashboard/src/
├── pages/eval/
│   └── EvalComparePage.tsx                      # MODIFIED — the only source change
└── __tests__/
    └── EvalComparePage.responsive.test.tsx      # NEW — phone-stubbed render suite
```

`EvalComparePage.test.tsx` (existing desktop suite) is untouched — the jsdom fallback
guarantees it.

## Changes — `pages/eval/EvalComparePage.tsx`

Current line anchors (verified against the file):

| Line | Grid | Change |
|------|------|--------|
| 211 | Summary: `ProvenanceCard` A/B, `"1fr 1fr"` | `isPhone ? "1fr" : "1fr 1fr"` |
| 217–222 | Stat strip, `repeat(auto-fit, minmax(110px, 1fr))` | **leave as-is** (already fluid) |
| 247–268 | `DataTable` columns | add `hideBelow` per column (below) |
| 369 | `CompareCaseExpanded` Input/Expected, `"1fr 1fr"` | `isPhone ? "1fr" : "1fr 1fr"` |
| 382 | `SideActualPanel` A/B grid | same branch |
| 387 | `SideScoresPanel` A/B grid | same branch |
| 392 | Trace A/B grid | same branch |

### Pseudocode

```tsx
import { useBreakpoint } from "../../hooks/useMediaQuery";

const sideBySide = (isPhone: boolean) => (isPhone ? "1fr" : "1fr 1fr");

export function EvalComparePage() {
  const { isPhone } = useBreakpoint();
  // ...
  // line 211 — summary cards:
  <div data-testid="compare-summary-grid"
       style={{ display: "grid", gridTemplateColumns: sideBySide(isPhone), gap: 16 }}>
    <ProvenanceCard label="A · baseline" run={a.run} />
    <ProvenanceCard label="B · candidate" run={b.run} />
  </div>
  // lines 217-222 — stat strip: UNCHANGED (auto-fit already wraps on narrow widths)
}

// DataTable columns (lines 247-268) — phone keeps Case + Δ only:
columns={[
  { key: "caseId",  header: "Case", render: ... },                    // always visible
  { key: "a",       header: "A", hideBelow: "sm", render: ... },
  { key: "b",       header: "B", hideBelow: "sm", render: ... },
  { key: "delta",   header: "Δ", render: ... },                       // always visible
  { key: "scoresA", header: "Scores A", hideBelow: "md", render: ... },
  { key: "scoresB", header: "Scores B", hideBelow: "md", render: ... },
]}

// CompareCaseExpanded (line 358) — own hook call; each named grid branches:
function CompareCaseExpanded({ row, caseRow }) {
  const { isPhone } = useBreakpoint();
  const cols = sideBySide(isPhone);
  // line 369: <div data-testid="expanded-input-grid"  style={{ ..., gridTemplateColumns: cols }}>
  // line 382: <div data-testid="expanded-actual-grid" style={{ ..., gridTemplateColumns: cols }}>
  // line 387: <div data-testid="expanded-scores-grid" style={{ ..., gridTemplateColumns: cols }}>
  // line 392: <div data-testid="expanded-trace-grid"  style={{ ..., gridTemplateColumns: cols }}>
}
```

**A/B label legibility when stacked — confirmed in the current file, no change needed:**
`SideActualPanel` renders `{label} · Actual` (line 313), `SideScoresPanel` renders
`{label} · Scores` (line 333), and the trace grid hardcodes `A · Trace` / `B · Trace`
headings (lines 394/398); the Input/Expected grid has `Input` / `Expected` micro-headings
(lines 371/375). Every cell self-identifies, so a single stacked column stays readable.

## Implementation Steps

1. Import `useBreakpoint` from `../../hooks/useMediaQuery`; add the tiny
   `sideBySide(isPhone)` helper (module scope, next to `mutedStyle`).
2. In `EvalComparePage`, call `useBreakpoint()` (top of component, before any early
   return — line 89 area, alongside the existing `useState` calls) and branch the
   line-211 summary grid. Add `data-testid="compare-summary-grid"`.
3. Add `hideBelow: "sm"` to the `a` and `b` columns and `hideBelow: "md"` to `scoresA`
   / `scoresB` in the `DataTable` columns array (lines 247–268). `caseId` and `delta`
   get no `hideBelow`.
4. In `CompareCaseExpanded`, call `useBreakpoint()` and branch the four grids at lines
   369 / 382 / 387 / 392 with `sideBySide(isPhone)`; add the four `data-testid`s.
5. Leave the stat strip (217–222) and everything else untouched. Do NOT modify
   `DataTable.tsx` here — that's W1-DataTable's PR.
6. Verify: `bun run --filter=@pattern-stack/agentic-dashboard test`, `typecheck`, `lint`.
   Conventions: strict TS (`noUnusedLocals` — don't destructure flags you don't use),
   biome (double quotes, 2-space, 100-col).

## Test Plan — `src/__tests__/EvalComparePage.responsive.test.tsx`

Reuse the fetch-stub idiom and `mkRun`/`mkResult`/`detailA`/`detailB` fixture shapes
from `src/__tests__/EvalComparePage.test.tsx` (URL-branching fetch stub:
`/eval/runs/:id`, `/eval/sets/:id/cases`, `/admin/events/recent`), rendered under
`MemoryRouter` at `/eval/compare/run-a/run-b`. Stub matchMedia to *phone* per the F1
spec's stubbing pattern: `vi.stubGlobal("matchMedia", ...)` with
`matchesFor = (q) => q === "(max-width: 639px)" || q === "(max-width: 899px)"`;
`beforeEach` calls `__resetMediaQueryCacheForTests()`, `afterEach` calls
`vi.unstubAllGlobals()` + `cleanup()`.

1. **Summary stacks on phone:** after load, `getByTestId("compare-summary-grid")` has
   `style.gridTemplateColumns === "1fr"`; both `A · baseline` and `B · candidate`
   labels are in the document (order preserved: A before B in `compareDocumentPosition`).
2. **Column pruning on phone:** header cells `Case` and `Δ` present; `Scores A`,
   `Scores B` absent; the `A` / `B` header cells absent (query `columnheader` roles —
   avoids matching badge text in rows).
3. **Expanded grids stack on phone with A/B labels:** click the `case-regress` row;
   all four testids (`expanded-input-grid`, `expanded-actual-grid`,
   `expanded-scores-grid`, `expanded-trace-grid`) report
   `gridTemplateColumns === "1fr"`; texts `A · Actual`, `B · Actual`, `A · Scores`,
   `B · Scores`, `A · Trace`, `B · Trace` all present.
4. **Desktop unchanged (guard):** one test with `matchesFor = () => false` — summary
   grid is `"1fr 1fr"`, all six column headers present. (The legacy suite double-covers
   this via the jsdom fallback but this pins the explicit-stub path.)

Regression gate: full dashboard suite passes
(`bun run --filter=@pattern-stack/agentic-dashboard test`).

## Risk — expanded rows inside a horizontally-scrolling table

The expanded content renders inside a `<td colSpan={totalColSpan}>`. Once W1-DataTable
wraps the table in `overflowX: auto`, a table wider than the viewport gives that `<td>`
the table's **scroll width, not the viewport width** — a `1fr 1fr` grid in there would
lay out at (say) 900px inside a 390px viewport, and the A/B panels would sit off-screen
until the user horizontally scrolls *the table* to read *expanded prose*. That is the
worst reading experience on the page.

Mitigation (this spec's design):

- **Stack by viewport, not by container.** The expanded grids branch on `isPhone`
  (viewport media query), so on a phone they are always one column regardless of how
  wide the scroll container happens to be. We deliberately do NOT rely on the table
  scroll fallback for expanded content.
- **Prune so the scroll fallback is a no-op on phone.** With `a`/`b`/`scoresA`/`scoresB`
  hidden below `sm`, the phone table is Case + Δ (+ expand affordance) — comfortably
  under 390px, so scroll width ≈ viewport width and the stacked expanded column gets
  true viewport width anyway. Pruning and stacking are belt-and-braces for each other.
- **Verify against the scroll container, not just jsdom:** manual check at 390px
  (devtools) — expand a row and confirm (a) no horizontal scrollbar on the table
  wrapper, (b) the expanded panels' rendered width equals the wrapper width, not wider.
  If a future column addition reintroduces phone-width overflow, the expanded content
  will still stack correctly but will regain excess width — keep this invariant in
  mind when touching the columns array.
