# W2-Tools (deferred half of WI-9) — /tools Page + ToolRunner Responsive

**Goal:** the `/tools` page's `DataTable` declutters to its highest-value
columns on phone (matching the eval-pages precedent) instead of forcing a
wide horizontal scroll inside the card; `ToolRunner`'s parameter form rows
stack instead of squeezing a two-column grid into a narrow viewport; the
"Run tool" button gets a >=40px touch target. JSON run output is
**already contained** (see §3) — no change needed there.

**PR size estimate:** ~30 changed source lines across 2 files + ~2 new/extended
test files (~130 lines).

## 1. Dependencies (already merged — reuse, do not recreate)

- **F1** `src/hooks/useMediaQuery.ts` → `useBreakpoint(): { isPhone; isNarrow; isDesktop }`,
  `useMediaQuery`, `__resetMediaQueryCacheForTests()`. jsdom has no `matchMedia` →
  defaults to desktop (`isPhone: false`); existing tests keep seeing today's layout.
- **F1** `src/ui/breakpoints.ts` → `BREAKPOINTS = { sm: 640, md: 900, lg: 1200 }`,
  `maxWidthQuery(key)`.
- **F1 (DataTable core)** `src/components/organisms/DataTable.tsx` → `Column<T>`
  already has `hideBelow?: "sm" | "md"` (line 21) and the table's outer wrapper
  already has `overflow: "hidden"` + `overflowX: "auto"` +
  `WebkitOverflowScrolling: "touch"` (DataTable.tsx:93-101) — a table wider than
  its card scrolls **within the card**, never the page. This item only
  *consumes* `hideBelow`; it does not touch `DataTable.tsx`.
- Wave-1 touch-target precedent (chat): `.chat-composer .ap-btn { min-height: 40px; }`
  in `chat/chat.css`, landed unconditionally (harmless on desktop, not gated on
  `isPhone`). `ToolRunner.tsx` has no dedicated CSS file today (100% inline
  styles) — reproduced here as an inline `style` override on the `Button`
  rather than introducing a new stylesheet import, to keep the change scoped
  to this one file.

## 2. File Tree

```
packages/agent-dashboard/src/
├── pages/
│   └── ToolsPage.tsx                       # MODIFIED — DataTable column hideBelow
├── components/organisms/
│   └── ToolRunner.tsx                      # MODIFIED — param-row stacking, button touch target
└── __tests__/
    ├── ToolsPage.responsive.test.tsx       # NEW — phone column-priority render test
    └── ToolRunner.test.tsx                 # EXTENDED — phone stacking + touch-target cases
```

## 3. Current State (verified — real line numbers as of this spec)

### `pages/ToolsPage.tsx`

- **No filter row exists.** The page header (line 51) is a single
  `<h1>Tools</h1>` — there is no search box, dropdown, or second header
  element to collide with anything on phone. **No wrap change is needed
  here**; the "header/filter row" framing in the work item doesn't map to
  this file's actual markup, and claiming otherwise would be dishonest.
- The loading (53-72), error (74-93), and empty (95-112) early-return blocks
  each render just `{title}` + one centered `Card`/spinner — single-column,
  nothing to reflow.
- The real responsive surface is the `DataTable` at lines 118-173: 5 columns
  (`toolName`, `totalCalls`, `totalErrors`, `successRate` → "Health",
  `avgDurationMs`) with **no `hideBelow` annotations today**. On a 360-375px
  phone this is 5 columns of a data table with no natural truncation — it
  works today only because `DataTable`'s own container scrolls horizontally
  (F1, cited above), but that still asks a phone user to swipe sideways to
  see "Avg Duration" or confirm the raw error count. Per the eval-pages
  precedent (`.claude/specs/2026-07-24-responsive-eval-pages.md`), the fix is
  the same mechanical `hideBelow` tagging, not a bespoke layout:
  - `totalErrors` (lines 140-147) → `hideBelow: "sm"` — redundant with the
    "Health" badge (derived from the same errors/calls ratio); drop on phone
    only.
  - `avgDurationMs` (lines 158-163) → `hideBelow: "md"` — secondary metric;
    drop on phone AND narrow/tablet, keep desktop only.
  - `toolName`, `totalCalls`, `successRate` stay untagged (always visible) —
    identity + the two highest-signal metrics.
- `ToolAgentBreakdown` (lines 179-240, the expanded-row detail) is already a
  single-column flex list with no fixed widths and a `flex: 1` progress bar
  (line 218) — already reflows; **no change**.

### `components/organisms/ToolRunner.tsx`

- Param row (lines 105-147): each param is one `<label>` with
  `display: "grid", gridTemplateColumns: "minmax(7rem, 10rem) 1fr"` (line 110).
  On a ~360px phone, `minmax(7rem,10rem)` (112-160px) plus the 12px gap leaves
  the input ~170-190px wide, and the name+description block (lines 115-128)
  has no `minWidth: 0`/wrap guard — long param descriptions can push the row
  wider than the viewport. Fix: stack to a single column on phone.
- Run button + status line (lines 152-162): `<Button variant="primary" onClick={run} …>`
  (line 153) uses default `size="md"` → `padding: "8px 16px"`, `T.fz.md` —
  same ~35px rendered height noted in the Wave-1 chat spec, below the 40px
  touch target. Fix: `style={{ minHeight: 40 }}` on this Button, unconditional
  (matches the chat precedent, which was also unconditional, not phone-gated).
- JSON result (lines 178-184) — **verified, needs no change**:
  `JsonBlock` (`components/kit/JsonBlock.tsx:30-49`) already sets
  `whiteSpace: "pre-wrap"`, `wordBreak: "break-word"`, and `overflowX: "auto"`
  unconditionally, plus `overflow: "auto"` once `maxHeight` is passed (it is,
  `RESULT_MAX_H = 320`, line 20/181) — the same containment pattern the
  Wave-1 `/live` spec found already present in `EventStream`. The one gap
  worth closing (mirroring `/live`'s `overflowWrap: "anywhere"` addition) is
  cheap and file-scoped: pass `overflowWrap: "anywhere"` in the `style` prop
  already being spread onto this `JsonBlock` call (line 182), instead of
  editing the shared `JsonBlock` component (which is consumed by several
  eval/chat pages outside this item's scope). The root `<div>` (line 97) also
  gets `minWidth: 0` — a no-visual-effect defensive addition so this
  component behaves inside whatever flex container a caller (`CapabilitiesPage`,
  out of scope here) puts it in; without it, a flex-item ancestor could let
  the column's intrinsic content width win over `overflowX: auto`, which is
  the classic flexbox min-content overflow bug.
- The boolean checkbox input (line 130-135) and numeric/text input (137-145,
  already `width: "100%"` via `INPUT_STYLE`, line 189-198) need no change.

## 4. Implementation Steps

1. **`ToolsPage.tsx`** — add `hideBelow: "sm"` to the `totalErrors` column
   (currently lines 140-147) and `hideBelow: "md"` to the `avgDurationMs`
   column (currently lines 158-163). No other JSX changes; no new imports
   (the page doesn't call `useBreakpoint` itself — `DataTable` already does).
2. **`ToolRunner.tsx`**:
   - Import `useBreakpoint` from `../../hooks/useMediaQuery` (same relative
     path `DataTable.tsx` uses one directory over); call it at the top of
     `ToolRunner`: `const { isPhone } = useBreakpoint();`.
   - Param row style (line 110): change
     `gridTemplateColumns: "minmax(7rem, 10rem) 1fr"` to
     `gridTemplateColumns: isPhone ? "1fr" : "minmax(7rem, 10rem) 1fr"`.
   - Root div (line 97): add `minWidth: 0` to its style object.
   - Run button (line 153): add `style={{ minHeight: 40 }}`.
   - `JsonBlock` call (line 182): add `overflowWrap: "anywhere"` into the
     existing `style={{ background: "var(--fill)" }}` object.
3. Extend `src/__tests__/ToolRunner.test.tsx` with a phone-stubbed describe
   block (see §5).
4. Add `src/__tests__/ToolsPage.responsive.test.tsx` (see §5).
5. Gate: `bun run --filter=@agentic-patterns/dashboard typecheck` and
   `bun run --filter=@agentic-patterns/dashboard test -- Tool` (per the
   builder brief — not the full suite/build/lint).

Conventions: strict TS, biome (double quotes, 2-space indent, semicolons,
100-col), hooks called unconditionally at component top, no new deps, no
upward imports (`components/organisms` → `hooks` is downhill, same direction
`DataTable.tsx` already imports in).

## 5. Test Plan

### `ToolsPage.responsive.test.tsx` (new)

Reuse the `stubPhone()` helper pattern from
`src/__tests__/EvalCaseDetailPage.test.tsx:17-30` (matches both
`max-width: 639px` and `899px`) and stub `fetch` for `GET /admin/tools`
(the `useAdminData("/admin/tools")` call, `ToolsPage.tsx:25`) returning one
`ToolAnalytics` row.

1. **Desktop default:** no matchMedia stub (jsdom fallback = desktop); after
   the row loads, assert `screen.getByText("Errors")` and
   `screen.getByText("Avg Duration")` are both present (all 5 headers render).
2. **Phone: low-priority columns drop:** `stubPhone()` before render; assert
   `screen.queryByText("Errors")` is `null` (hideBelow: "sm") — `"Avg Duration"`
   is also `null` since phone width satisfies both the sm and md queries — and
   `screen.getByText("Name")`, `screen.getByText("Calls")`,
   `screen.getByText("Health")` remain present.
3. `afterEach`: `cleanup()`, `vi.unstubAllGlobals()`, `vi.restoreAllMocks()`,
   `__resetMediaQueryCacheForTests()` (F1 convention).

### `ToolRunner.test.tsx` (extended)

Add a `describe("ToolRunner — responsive (W2-Tools)")` block, reusing this
file's existing `tool` fixture (a `text` + `boolean` param — line 78-89) and
`stubInvokeFetch` helper (line 91-100):

1. **Desktop: param row is a two-column grid.** No matchMedia stub; render;
   find the `text` param's `<label>` (e.g. via
   `screen.getByPlaceholderText("string").closest("label")`); assert
   `toHaveStyle({ gridTemplateColumns: "minmax(7rem, 10rem) 1fr" })`.
2. **Phone: param row stacks to one column.** Stub `matchMedia` per the
   `stubPhone()` pattern (or inline, matching `/max-width:\s*(639|899)px/`);
   `__resetMediaQueryCacheForTests()` first; same lookup; assert
   `toHaveStyle({ gridTemplateColumns: "1fr" })`.
3. **Run button meets the 40px touch target:** desktop or phone (unconditional
   per §3) — `screen.getByRole("button", { name: "Run tool" })`; assert
   `toHaveStyle({ minHeight: "40px" })`.
4. **JSON result wraps long unbroken tokens:** `stubInvokeFetch` a result
   containing a long unbroken string (e.g. a 300-char token with no spaces);
   run the tool; find the rendered `<pre>` (the `JsonBlock` output, via
   `screen.getByText(..., { selector: "pre" })` or a container query); assert
   `toHaveStyle({ overflowWrap: "anywhere" })` alongside the pre-existing
   `whiteSpace: "pre-wrap"`.
5. `afterEach` additionally calls `__resetMediaQueryCacheForTests()` (the
   file's existing `afterEach`, line 103-107, gets this one extra line).

## 6. Out of Scope

- `src/pages/build/*` (including `CapabilitiesPage.tsx`, `ToolRunner`'s other
  call site) — parallel builder owns build/*; this item does not touch how
  `ToolRunner` is embedded there, only `ToolRunner`'s own internal layout.
- `ChatPage.tsx` / any eval/run page — parallel builders own those; `ToolRunner`
  is referenced only in a comment there (scope-form precedent), never rendered.
- `components/kit/JsonBlock.tsx` — shared across eval/chat/run pages outside
  this item; the one containment addition needed (`overflowWrap: "anywhere"`)
  is applied via the `style` prop at ToolRunner's own call site instead.
- `components/organisms/DataTable.tsx` internals (`hideBelow` filtering,
  scroll-container CSS) — already shipped by the F1 DataTable-core item; this
  spec only consumes the contract.
- `components/ToolsRail.tsx` / `tools-rail.css` — the chat Console's "Tools"
  tab catalog, a different component despite the similar name; not part of
  this work item (not listed in the builder brief's file list).
