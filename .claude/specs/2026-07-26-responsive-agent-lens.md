# W2-AgentLens — Responsive /agents/:id

**Goal:** the Agent lens (`/agents/:id`) works on a phone. The two-column
Overview grid (instance delta | inherited identity + prompt) collapses to one
column below `md` (900px); the Runs lens's 6-stat strip reflows to a two-row
`3×2` grid on phone instead of forcing 6 fixed-content columns into ~360px;
the run-picker `<select>` drops its `minWidth: 260` floor on phone so it can
shrink to the available width. `AgentEvalsCard` gets two small unconditional
overflow fixes (no breakpoint dependency) so its per-eval row and latest-run
line don't spill past a narrow card.

**PR size estimate:** ~40 lines of source delta across 2 files + 1 new test
file (~150 test lines). No new components, no new deps.

## Dependencies (shared contract — reproduced, do not re-implement)

From Wave 1's foundation (already merged):

```ts
// packages/agent-dashboard/src/hooks/useMediaQuery.ts
export function useBreakpoint(): { isPhone: boolean; isNarrow: boolean; isDesktop: boolean };
// isPhone  ⇔ viewport < 640  ("(max-width: 639px)")
// isNarrow ⇔ viewport < 900  ("(max-width: 899px)"), includes phone
// isDesktop ⇔ viewport >= 900
// jsdom / no-matchMedia ⇒ { isPhone: false, isNarrow: false, isDesktop: true }
// → mobile variants gate on the flags; desktop stays the default render.
export function __resetMediaQueryCacheForTests(): void;
```

```ts
// packages/agent-dashboard/src/ui/breakpoints.ts
export const BREAKPOINTS = { sm: 640, md: 900, lg: 1200 } as const;
export function maxWidthQuery(key: "sm" | "md" | "lg"): string;
```

`components/organisms/DataTable.tsx`'s `hideBelow` and `components/kit/BottomSheet.tsx`
are **not used** in this item — the Agent lens has no `DataTable` and nothing
here warrants an overlay (see §3 rationale below).

## 1. File Tree

```
packages/agent-dashboard/src/
├── pages/build/
│   ├── AgentLensPage.tsx                        # MODIFIED — grid collapse, stat-strip reflow, select floor
│   └── AgentEvalsCard.tsx                       # MODIFIED — two unconditional overflow fixes
└── __tests__/
    └── AgentLensPage.responsive.test.tsx        # NEW — phone/desktop stubbed render suite
```

## 2. Current State (verified against the file — line numbers as of this spec)

- `pages/build/AgentLensPage.tsx:264-271` — the Overview two-column grid:
  ```tsx
  <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 5fr) minmax(0, 7fr)",
                 gap: 16, alignItems: "start" }}>
  ```
  Fixed 5fr/7fr split — on a phone the left column (instance delta, delivered
  composer, evals, coherence) and right column (rendered prompt, inherited
  identity) both get squeezed into fractions of ~360px instead of each taking
  the full width.
- `pages/build/AgentLensPage.tsx:471` — the Runs lens's 6-stat strip:
  ```tsx
  <div style={{ display: "grid", gridTemplateColumns: "repeat(6, auto)" }}>
  ```
  inside `RunStatStrip` (lines 419-506). Six auto-sized cells (iterations /
  tool calls / input tok / output tok / total / finish), each `padding: "11px
  18px"` with a `borderRight` divider computed as `i === items.length - 1 ?
  "none" : "1px solid var(--line-2)"` (line 477). Six content-sized columns
  cannot fit a phone viewport — today the row would overflow (the `Card` at
  line 441 has no `overflowX`, so it doesn't even give a fallback scrollbar
  — the strip just clips/overflows the page).
- `pages/build/AgentLensPage.tsx:630-641` (`RunsLens`, run picker) — the run
  `<select>`:
  ```tsx
  <select style={{ ...inputStyle, minWidth: 260 }}>
  ```
  260px is a reasonable desktop floor (option text is `shortId · Nt ·
  relTime`) but wastes phone width and can force the row (`display: flex,
  alignItems: center, gap: 8`, line 628) to overflow on a 360px viewport.
- `pages/build/AgentLensPage.tsx:139-153` — `AgentLensPage`'s own state/hooks
  block (right after `useParams`), the natural place to add `useBreakpoint()`.
  Its two early returns (loading/error, lines 155-180) already render inside
  `DetailPageShell` and need no grid — **no change needed there**.
- `pages/build/AgentLensPage.tsx:392-404` — "Inherited identity" block inside
  the right column: already a simple `flexDirection: column` stack
  (`SlotStack` + a heading row that's `alignItems: baseline, gap: 8` with
  `flexWrap` NOT set, but both spans are short static text — **no overflow
  risk, no change needed**).
- `pages/build/AgentLensPage.tsx:251-257` (`PAGE_LENS_OPTIONS` `Segmented`)
  and `:392-404` and the hero `Card` (233-249) already reflow fine (`Segmented`
  is a Wave-1 component with its own internal wrap handling; text blocks wrap
  naturally) — **verified, no change needed**.
- `pages/build/AgentEvalsCard.tsx:49` — `LatestRunLine`'s row:
  ```tsx
  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12 }}>
  ```
  holding a `Badge`, pass-rate text, `passed/cases` counts, an optional model
  `Chip`, and a date `Link` — up to 5 inline items with no `flexWrap`. On a
  narrow card this can overflow horizontally (no scroll affordance on this
  span either).
- `pages/build/AgentEvalsCard.tsx:127-139` — the per-eval-ref row:
  ```tsx
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <Link style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--accent)",
                    textDecoration: "none", flex: 1 }}>{ref.setId}</Link>
    {ref.step && <Chip tone="neutral">step · {ref.step}</Chip>}
    <Button size="sm" variant="ghost" onClick={...}>Run</Button>
  </div>
  ```
  the `Link` is `flex: 1` but has no `minWidth: 0` — a long `setId` grows the
  row past the card instead of eliding, potentially pushing the `Run` button
  off-screen.
- `pages/build/AgentEvalsCard.tsx:109-114` (card header) and `:145-149` (the
  `ref.grades` description line) — plain text, already wraps — **verified, no
  change needed**.

## 3. Design

### 3a. Overview grid — collapse below `md`

```tsx
// AgentLensPage.tsx — top of component (after useParams/useAdminData, ~line 153)
const { isNarrow } = useBreakpoint();

// line 264-271:
<div
  data-testid="agent-lens-grid"
  style={{
    display: "grid",
    gridTemplateColumns: isNarrow ? "1fr" : "minmax(0, 5fr) minmax(0, 7fr)",
    gap: 16,
    alignItems: "start",
  }}
>
```
Established idiom (foundation contract). On phone/narrow the instance-delta
column renders first (unchanged DOM order), then the prompt + inherited
identity column — reading order matches the existing visual priority (the
instantiation delta is "owned here"; the prompt/role stack is linked
identity), so no reordering is needed, just stacking.

### 3b. Runs lens — 6-stat strip reflows to `3×2` on phone

**Decision: two-row `repeat(3, auto)`, not horizontal scroll.** Justification:
these six numbers are the primary at-a-glance summary of a run (iterations,
tool calls, tokens in/out, elapsed, finish reason) — exactly the kind of
"primary content" the Wave-1 Live Run spec (`2026-07-24-responsive-live-run.md`
§goal) says should stack in flow rather than hide behind scroll/sheet. A user
opening a run's stats on a phone should see all six without a horizontal
swipe; an `overflowX: auto` fallback would technically fit them but leaves 4
of 6 stats invisible off-canvas with no visible affordance that more exist.

```tsx
// RunStatStrip — receives isPhone as a prop (RunsLens already calls
// useBreakpoint(); prop-over-hook keeps this a dumb presentational row, same
// call as W1-LiveRun's LiveTracePanel `layout` prop).
function RunStatStrip({
  runId, request, model, sample, stats, isPhone,
}: { …existing…; isPhone: boolean }) {
  const columns = isPhone ? 3 : 6;
  // … header row unchanged …
  <div
    data-testid="run-stat-grid"
    style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, auto)` }}
  >
    {items.map((it, i) => (
      <div
        key={it.l}
        style={{
          padding: "11px 18px",
          borderRight: (i + 1) % columns === 0 ? "none" : "1px solid var(--line-2)",
          borderBottom: isPhone && i < columns ? "1px solid var(--line-2)" : undefined,
        }}
      >
        {/* n / l unchanged */}
      </div>
    ))}
  </div>
}
```
`borderRight` switches from "only the last cell has none" to "the last cell of
each row has none" (`(i + 1) % columns === 0`) — on desktop `columns` is still
6 and `items.length` is exactly 6, so `(i+1) % 6 === 0` is true ONLY at `i ===
5`, identical to today's `i === items.length - 1`. Desktop output is
byte-for-byte unchanged. `borderBottom` is new but only fires when
`isPhone` — `undefined` (no property) on desktop, so desktop is unaffected.

### 3c. Run picker `<select>` — drop the phone floor

```tsx
// RunsLens — already needs its own useBreakpoint() call (isPhone) to pass to
// RunStatStrip per §3b; reuse it here too.
<select
  value={effectiveRunId ?? ""}
  onChange={...}
  style={{ ...inputStyle, minWidth: isPhone ? 0 : 260, flex: isPhone ? 1 : undefined }}
>
```
`flex: 1` only on phone: the row (line 628, `display: flex, alignItems:
center, gap: 8`) has just the label span + this select, so letting the select
grow to fill the row on phone matches the "collapse floors, let flex take
over" idiom already used for the message `<input>` in `RunSurfacePage.tsx`
(W1-LiveRun §3a: `minWidth: isPhone ? 140 : 220`). On desktop `flex: undefined`
+ `minWidth: 260` is exactly today's style object.

### 3d. `AgentEvalsCard` — two unconditional overflow fixes

Neither needs `useBreakpoint()` — both are inert on desktop (the content
already fits there) and only engage when the row is actually too narrow,
matching the Wave-1 precedent of unconditional CSS fixes (`RunBarHud`'s
`flexWrap: "wrap"`, `NodeInspector`'s `min()` clamp — spec
`2026-07-24-responsive-live-run.md` §3c/3d).

```tsx
// LatestRunLine, line 49 — add flexWrap:
<span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12,
                flexWrap: "wrap" }}>

// per-eval-ref row's Link, lines 130-136 — add minWidth:0 + ellipsis:
<Link
  style={{
    fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--accent)",
    textDecoration: "none", flex: 1,
    minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  }}
>
```

## 4. Implementation Steps

1. **`AgentLensPage.tsx`** — import `useBreakpoint` from `../../hooks/useMediaQuery`.
   In `AgentLensPage()`, destructure `{ isNarrow }` near the top (after the
   early-return guards resolve, i.e. after the `loading`/`error` checks so the
   hook still runs unconditionally before them — actually: call
   `useBreakpoint()` BEFORE the early returns, same position as the other
   `useState` calls, to satisfy the rules of hooks). Apply the grid collapse
   at (current) lines 264-271 per §3a, adding `data-testid="agent-lens-grid"`.
2. In `RunsLens`, destructure `{ isPhone }` from `useBreakpoint()` alongside
   its existing `useState` calls. Apply the phone `minWidth`/`flex` switch to
   the `<select>` per §3c. Pass `isPhone` to `<RunStatStrip … isPhone={isPhone} />`.
3. In `RunStatStrip`, add the `isPhone: boolean` prop, compute `columns`,
   switch `gridTemplateColumns` and the per-cell `borderRight`/`borderBottom`
   per §3b, and add `data-testid="run-stat-grid"`.
4. **`AgentEvalsCard.tsx`** — apply the two unconditional style additions per
   §3d. No hook import needed in this file.
5. **Tests** — add `__tests__/AgentLensPage.responsive.test.tsx` per §5.
6. **Gate** (per task instructions — do NOT run build/lint/full check):
   `bun run --filter=@agentic-patterns/dashboard typecheck` and
   `bun run --filter=@agentic-patterns/dashboard test -- AgentLens`.

Conventions: strict TS (`noUnusedLocals`/`noUnusedParameters` — don't
destructure `isPhone`/`isNarrow` where unused), biome (double quotes,
2-space, semicolons, 100-col), no new deps, no barrel changes (neither file is
barrel-exported).

## 5. Test Plan — `src/__tests__/AgentLensPage.responsive.test.tsx`

matchMedia stubbing follows the F1 pattern (`vi.stubGlobal("matchMedia", …)`)
plus `__resetMediaQueryCacheForTests()` in `beforeEach` / `vi.unstubAllGlobals()`
+ `cleanup()` in `afterEach`, exactly as
`__tests__/EvalComparePage.responsive.test.tsx` and
`__tests__/RunSurfacePage.responsive.test.tsx` do.

```ts
function stubViewport(matchesFor: (query: string) => boolean) { /* … */ }
const PHONE = (q: string) => q === "(max-width: 639px)" || q === "(max-width: 899px)";
const NARROW_NOT_PHONE = (q: string) => q === "(max-width: 899px)";
```

Render inside `MemoryRouter` at `/agents/demo-agent` with a `Route
path="/agents/:id"` (the page reads `useParams().id`). Stub global `fetch`:
URL-branch on `/agents/demo-agent/composition` → 200 with a fixture typed as
`AgentComposition` (`instantiation: undefined` so the "Delivered instance"
card is absent — keeps the fixture minimal; `evals: []` so `AgentEvalsCard`
doesn't mount in these tests — its reflow is pinned by its own assertions
below via direct import, no need to route through the network fixture).

1. **Desktop (guard):** `stubViewport(() => false)` — after
   `screen.findByText(fixture.name)`, `getByTestId("agent-lens-grid").style
   .gridTemplateColumns === "minmax(0, 5fr) minmax(0, 7fr)"` — byte-for-byte
   today's value.
2. **Narrow/phone (`NARROW_NOT_PHONE` and `PHONE`):** same grid's
   `gridTemplateColumns === "1fr"` for both stubs (confirms the `md` threshold,
   not `sm`, governs this collapse).
3. **Runs lens — stat strip reflow:** switch to the "Runs" page lens
   (`fireEvent.click(getByRole("tab", { name: "Runs" }))` or the `Segmented`'s
   button role — verify actual accessible role/name via `Segmented`'s
   rendered output) with `fetchRuns` resolving `{ kind: "ok", data: [] }` (via
   `vi.mock("../lib/runsApi")`, `fetchRuns` → empty, which the page already
   degrades to the deterministic `SAMPLE_EVENTS` fixture — no need to mock
   `fetchRun`/`fetchRunEvents` for the sample path). Assert:
   - Desktop: `getByTestId("run-stat-grid").style.gridTemplateColumns ===
     "repeat(6, auto)"`.
   - Phone: `"repeat(3, auto)"`.
4. **Run picker select — phone vs desktop.** Requires `runs.length > 1` (the
   `<select>` only renders then, line 627) — mock `fetchRuns` to resolve two
   `RunSummary` rows for this test. Assert the `<select>`'s inline style:
   phone → `minWidth: "0"` and `flex: "1 1 0%"`; desktop → `minWidth:
   "260px"`, `flex` unset/empty string. **Confirmed against the real DOM**:
   React's `dangerousStyleValue` doesn't append `"px"` when the value is the
   literal number `0` (only non-zero numbers get the unit), and jsdom's
   `cssstyle` expands the `flex` shorthand's *getter* to its longhand triple
   (`flex-grow flex-shrink flex-basis`) even though only `flexGrow` was set —
   so `flex: 1` reads back as `"1 1 0%"`, not `"1"`. Separately, jsdom's
   `cssstyle` rejects the shorthand value `border-right: none` / `border-
   right-style: none` outright (the property is never set), so "no border"
   reads back as `""`, not the literal string `"none"` — the stat-strip
   border assertions below check for `""` accordingly.
5. **Desktop regression guard for the border/columns math:** with the sample
   fallback (6 items), desktop's last cell (`finish`) has `borderRight:
   "none"` and the 5 before it have the line — pin at least the last cell via
   `getAllByText(...)`'s DOM ancestor or a `data-testid` per-cell if needed
   for a robust assertion (avoid over-specifying every cell's border; the
   `columns`/modulo math is simple enough that one boundary check per side —
   last cell no border-right, phone's 3rd cell has `borderBottom` — suffices).

### `AgentEvalsCard` reflow — extend or add a focused describe block

Given `AgentEvalsCard.tsx` currently has no dedicated test file, add a small
`describe` block (either inline in the same responsive test file, imported
directly — no router/fetch needed beyond stubbing `fetchEvalRuns` via
`vi.mock("../lib/evalApi")` — or a new
`AgentEvalsCard.responsive.test.tsx` sibling; prefer the latter to keep the
page-level suite focused):

1. Render `<AgentEvalsCard agentId="a1" agentName="Agent One" evals={[{ setId:
   "a-very-long-eval-set-identifier-that-would-overflow-a-narrow-card" }]} />`
   with `fetchEvalRuns` mocked to resolve `{ kind: "none" }` — assert the
   `Link`'s inline style includes `textOverflow: "ellipsis"` and `minWidth: "0px"`.
2. With a mocked `{ kind: "ok", run: <fixture with model chip + summary> }`,
   assert `LatestRunLine`'s row (`getByText(run.status)`'s closest `span`
   ancestor, or a `data-testid` if easier to target) has `flexWrap: "wrap"`.
   These two are unconditional — no viewport stub needed, run under the
   default (no `matchMedia` stub / desktop-fallback) jsdom setup.

Regression gate: `bun run --filter=@agentic-patterns/dashboard test -- AgentLens`
plus the existing `AgentLensPage`/`AgentEvalsCard` behavior (no prior dedicated
suite existed for either — confirmed via repo search before writing this spec)
so there is no legacy suite to keep green beyond the broader dashboard run
the task asks to skip (build/lint/full check are explicitly out of scope for
this item per the task's STRICT process rules; typecheck + the `AgentLens`-
filtered test run are the required self-verification gates).

## 6. Risks & Out of Scope

- The "Delivered instance" composer card, the coherence card, and
  `RenderedPromptView`/`SlotStack` internals are Wave-1/pre-existing
  components rendered unchanged inside the now-single-column stack — their
  OWN internal responsiveness (e.g. `RenderedPromptView`'s section width) is
  out of scope for this item; verified they don't hard-code a min-width that
  would fight a 1-column phone layout (both already render inside
  `minWidth: 0` flex columns today).
- `JsonBlock`/`Markdown` content inside `DataBlock` (Background/Awareness/
  Mission) can itself be arbitrarily wide (JSON dumps) — pre-existing on
  desktop too (no scroll wrapper), not introduced or worsened by this item,
  and out of scope to fix here.
- Two-row stat grid on phone is deliberately NOT equal-width columns
  (`1fr`) — kept `auto` (desktop-identical sizing logic) so each cell hugs its
  own content; the row as a whole may not span the full card width on phone.
  Accepted trade-off: matches "byte-for-byte desktop, minimal-diff phone"
  over pixel-perfect edge-to-edge phone alignment. A follow-up could switch to
  `repeat(3, minmax(0, 1fr))` on phone if user feedback wants the strip to
  fill the card.
