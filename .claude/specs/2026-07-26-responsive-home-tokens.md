# W3-A — Responsive Dashboard home (`/`) + Tokens (`/tokens`)

**Goal:** verify and (where actually needed) fix phone/narrow rendering for
the two simplest remaining pages in the responsive rollout. Verified against
the files on disk today: `DashboardPage.tsx` is 163 lines, `TokensPage.tsx`
is 118 lines — matches the task's line-count estimate, confirms this spec is
against the current file versions.

**Headline finding: `DashboardPage.tsx` needs ZERO changes.** Every element
on the page is already responsive by construction (Wave-1 kit components +
one CSS-grid `auto-fit` that already reflows without any JS). `TokensPage.tsx`
needs one small change: add `hideBelow` priority to two of its five
`DataTable` columns, following the exact idiom already used by `ToolsPage`,
`EvalRunsPage`, `EvalRunDetailPage`, etc.

**PR size estimate:** ~4 lines of source delta in 1 file (`TokensPage.tsx`)
+ 1 new test file (~70 lines). No new components, no new deps, no changes to
`DashboardPage.tsx`.

## Dependencies (shared contract — reproduced, do not re-implement)

```ts
// packages/agent-dashboard/src/hooks/useMediaQuery.ts
export function useBreakpoint(): { isPhone: boolean; isNarrow: boolean; isDesktop: boolean };
// isPhone  ⇔ viewport < 640  ("(max-width: 639px)")
// isNarrow ⇔ viewport < 900  ("(max-width: 899px)"), includes phone
// jsdom / no-matchMedia ⇒ { isPhone: false, isNarrow: false, isDesktop: true }
export function __resetMediaQueryCacheForTests(): void;
```

```ts
// packages/agent-dashboard/src/components/organisms/DataTable.tsx
export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  hideBelow?: "sm" | "md"; // "sm" = hidden only on phone (<640px); "md" = hidden <900px
}
```
`DataTable` already owns `useBreakpoint()` internally, filters
`visibleColumns` by `hideBelow`, wraps the `<table>` in a
`overflowX: "auto"` scroll container, and fixes up `colSpan` for the
empty-state row and expanded-row detail cell. None of that is re-implemented
here — `TokensPage.tsx` only supplies `hideBelow` on its column definitions.

Neither `BottomSheet` nor a hand-rolled `<table>` is relevant to this item —
`DashboardPage.tsx` has no table at all (a `Card` grid + a `<ul>`), and
`TokensPage.tsx`'s one table is the `DataTable` organism, which already has
its own responsive core (Wave-1 `2026-07-24-responsive-datatable-core.md`).

## 1. File Tree

```
packages/agent-dashboard/src/
├── pages/
│   ├── DashboardPage.tsx                     # UNCHANGED — verified already responsive
│   └── TokensPage.tsx                        # MODIFIED — 2 columns get hideBelow
└── __tests__/
    └── TokensPage.responsive.test.tsx        # NEW — phone/desktop column-visibility suite
```

## 2. Current State — verified against the file, per section

### 2a. `DashboardPage.tsx` — verified already responsive, no change

- **Lines 40-71** — the 6-tile stat grid:
  ```tsx
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
  ```
  `auto-fit` + `minmax(180px, 1fr)` is a pure-CSS reflow: the browser computes
  how many 180px-minimum columns fit the container and lets each stretch to
  fill remaining space — no JS breakpoint needed. Traced against `AppShell`'s
  actual phone padding (`components/templates/AppShell.tsx:97`, `padX = 16` on
  phone): at a 360px viewport the content box is `360 - 2*16 = 328px`. Two
  180px columns + one 16px gap = `376px > 328px`, so the grid naturally drops
  to 1 column on a small phone and 2-3 on a larger one — exactly the
  "reflow, don't clip" behavior the other Wave 1-3 items had to hand-build
  with `useBreakpoint()`. This page gets it for free. **No change needed.**
- **Lines 109-163** (`AgentList`) — the per-agent `<li>` row is already
  `display: flex, flexWrap: "wrap"` (line 119) and its trailing badge cluster
  (lines 131-138, `marginLeft: auto`) is *also* already `flexWrap: "wrap"`
  with `justifyContent: "flex-end"`. A long badge run (agent name + status +
  4 metric badges) wraps to a second line on a narrow card instead of
  overflowing. **No change needed.**
- **Lines 81-103** (`EmptyAgents`) — centered column, text-only, already
  `textAlign: "center"`, no fixed widths. **No change needed.**
- `PageHeader` (line 5 import), `SectionHeading` (line 6), `AsyncState`
  (line 4), `Card`/`Badge`/`Stat` (kit atoms) are all Wave-1 components
  already audited for phone rendering (`PageHeader` wraps + has a flex
  spacer; `SectionHeading`'s eyebrow row is `minWidth: 0` + ellipsis-safe;
  `Badge` is `whiteSpace: nowrap` `inline-flex`, sized to content). Nothing
  in this page calls any of them in a way that reintroduces overflow.
- There is no `<table>` anywhere on this page — the Wave 2 "hand-rolled table
  crushed by `table-layout: auto`" failure mode cited in the task brief does
  not apply here.

**Conclusion:** `DashboardPage.tsx` is left untouched. This mirrors the
Wave 1-2 precedent (`CapabilitiesPage`, `JsonBlock`, `chat-route.css`) where
honestly reporting "already correct" was more valuable than inventing a
speculative diff.

### 2b. `TokensPage.tsx` — one small change

- **Lines 70-114** — the `DataTable<TokenUsageGroup>` with 5 columns: `key`
  (Agent/Model identity, badge + text), `inputTokens` (right-aligned number),
  `outputTokens` (right-aligned number), `totalTokens` (right-aligned,
  rendered as a filled `Badge` — the headline roll-up), `conversationCount`
  (right-aligned plain number). None currently has `hideBelow`. `DataTable`
  itself already has `overflowX: auto` (organism-level, Wave 1), so nothing
  is clipped today — but per the established idiom (`ToolsPage.tsx:144,163`,
  `EvalRunsPage.tsx:281,287`, `EvalRunDetailPage.tsx:356,368,375`,
  `EvalCaseDetailPage.tsx`), every other `DataTable` consumer prunes
  lower-priority columns on phone instead of relying solely on horizontal
  scroll for a 5-column-wide table on a 360px screen.
- Priority read: `key` (identity) and `totalTokens` (the headline sum,
  visually distinguished as the only filled `Badge` in the row) are the two
  columns a phone user needs at a glance. `inputTokens`/`outputTokens` are
  the *breakdown* of that sum — droppable detail, matching the exact
  precedent set by `EvalRunDetailPage.tsx:364-370`, which merges input/output
  into one combined `"Tokens"` column and marks it `hideBelow: "sm"`
  precisely because the split is phone-droppable while a summary metric
  (there, "Scores"; here, `totalTokens`) stays. `conversationCount` is kept
  visible at every width — it's an independent metric (not derivable from the
  other four) and is short (small integer), so it doesn't crowd the row.
- **Lines 24-37** (`header`, the `PageHeader` + `Segmented` group-by toggle)
  — `PageHeader` already wraps (`flexWrap: "wrap"`, kit component); the
  `Segmented` control has only 2 options ("By Agent"/"By Model"), short
  labels, `inline-flex` sized to content — no overflow risk at any width.
  **No change needed.**
- **Lines 39-61** (loading/error/empty early returns) — plain `AsyncState`
  inside a `Card` or bare `div`, no fixed widths. **No change needed.**

## 3. Design

```tsx
// TokensPage.tsx, columns array (current lines 71-108) — only two entries change:
{
  key: "inputTokens",
  header: "Input Tokens",
  align: "right",
  hideBelow: "sm", // NEW — droppable detail; totalTokens carries the summary on phone
  render: (row) => row.inputTokens.toLocaleString(),
},
{
  key: "outputTokens",
  header: "Output Tokens",
  align: "right",
  hideBelow: "sm", // NEW — same rationale
  render: (row) => row.outputTokens.toLocaleString(),
},
```
`key`, `totalTokens`, and `conversationCount` columns are untouched — byte
identical to today. On desktop/tablet (`isPhone === false`, i.e. `isNarrow`
false OR true-but-not-phone) all 5 columns render exactly as before —
`hideBelow: "sm"` only removes a column when `isPhone` is `true`, so a
tablet-width viewport (640-899px) still sees all 5 columns; only phones
(<640px) drop the two.

## 4. Implementation Steps

1. **`TokensPage.tsx`** — add `hideBelow: "sm"` to the `inputTokens` and
   `outputTokens` column definitions (per §3). No import changes (`Column`
   type is inferred from the `DataTable` generic; `hideBelow` is just a new
   object key). No other lines touched.
2. **`DashboardPage.tsx`** — no changes (§2a).
3. **Tests** — add `__tests__/TokensPage.responsive.test.tsx` per §5.
4. **Gate** (per task's STRICT process rules — do NOT run build/lint/full
   check): `bun run --filter=@pattern-stack/agentic-dashboard typecheck` and
   `bun run --filter=@pattern-stack/agentic-dashboard test -- Tokens` (also rerun
   `test -- Dashboard` to confirm the untouched `DashboardPage.test.tsx`
   still passes, as a regression guard for the "no change" claim).

## 5. Test Plan

### `TokensPage.responsive.test.tsx` (new)

Follows the exact `stubPhone()` + `__resetMediaQueryCacheForTests()` pattern
established in `ToolsPage.responsive.test.tsx`:

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

Stub `fetch` to resolve a small `TokenUsageGroup[]` fixture (one row is
enough — this suite is about column visibility, not sorting/grouping, both
already covered elsewhere).

1. **Desktop (no matchMedia stub — jsdom default):** render `<TokensPage />`,
   wait for the fixture row, assert `screen.getByText("Input Tokens")`,
   `screen.getByText("Output Tokens")`, and `screen.getByText("Conversations")`
   all present — all 5 headers render, byte-for-byte today's output.
2. **Phone (`stubPhone()`):** same render, assert
   `screen.queryByText("Input Tokens")` and `screen.queryByText("Output
   Tokens")` are both `null`, while `screen.getByText("Conversations")` and
   the group-by header (`"Agent"` or `"Model"`, whichever the fixture's
   `groupBy` default renders) are still present — confirms only the two
   intended columns drop and the identity/summary/conversations columns
   survive.

Regression gate: `bun run --filter=@pattern-stack/agentic-dashboard test -- Tokens`
plus re-running the existing `DashboardPage.test.tsx` unmodified (`test --
Dashboard`) to confirm the "no change" claim in §2a doesn't regress the one
existing dashboard test.

## 6. Risks & Out of Scope

- `DataTable`'s own `overflowX: auto` fallback is unconditionally present
  regardless of `hideBelow` — even if a future column is added without a
  `hideBelow` tag, the table degrades to a horizontal scroll rather than
  clipping. This item only tunes *which* columns are hidden vs. scrollable,
  not the fallback mechanism itself (owned by Wave 1's DataTable core spec).
- Sort behavior (`useSortedRows`, `key`-keyed `sortKey`) is untouched —
  `hideBelow` only affects visual rendering in `DataTable`, not the
  `TokensPage` sort state, which still operates over the full (unfiltered)
  column key space. Hidden columns remain sortable via other UI (e.g. if a
  future affordance exposes a sort menu) without code changes here.
- No changes to `api/types.ts` (`TokenUsageGroup`) — the fixture in the new
  test file is a plain object literal matching the existing shape used in
  `TokensPage.tsx`'s render callsites (`inputTokens`, `outputTokens`,
  `totalTokens`, `conversationCount`, `key`).
