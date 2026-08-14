# W1-LiveRun (WI-8) — Responsive Live Run (/run): stack graph over trace; clamp the inspector

**Goal:** the constellation surface stops assuming ~1000px of width. Below the
`md` (900px) breakpoint the main row stacks vertically — graph on top (bounded
height), trace full-width beneath — and the node inspector clamps so it can
never exceed the viewport. A run trace is **primary content** on /run, so it
STACKS in flow; it is deliberately NOT hidden behind a bottom sheet.

**PR size estimate:** ~120 lines of source delta across 4 files + 2 new test
files (~180 test lines). No new components.

## Dependencies (shared contract — reproduced, do not drift)

From **F1** (`.claude/specs/2026-07-24-responsive-foundation-usebreakpoint.md`),
which must land first:

```ts
// packages/agent-dashboard/src/hooks/useMediaQuery.ts
export function useBreakpoint(): { isPhone: boolean; isNarrow: boolean; isDesktop: boolean };
// isPhone  ⇔ width < 640   ("(max-width: 639px)")
// isNarrow ⇔ width < 900   ("(max-width: 899px)"), includes phone
// isDesktop ⇔ width >= 900
// jsdom / no-matchMedia ⇒ { isPhone: false, isNarrow: false, isDesktop: true }
// → gate MOBILE variants on the flags; desktop stays the default render.
```

From **F3** (OPTIONAL for this item): `BottomSheet` in
`src/components/kit/`. **Decision: NOT used here** — see §3 NodeInspector
rationale. This item must not block on F3.

## 1. File Tree

```
packages/agent-dashboard/src/
├── pages/
│   └── RunSurfacePage.tsx                    # MODIFIED — isNarrow column stack + phone input widths
├── constellation/
│   ├── LiveTracePanel.tsx                    # MODIFIED — layout?: "side" | "stacked" prop
│   ├── NodeInspector.tsx                     # MODIFIED — PANEL_W → min() clamp
│   ├── RunBarHud.tsx                         # MODIFIED — flexWrap on the pill (1 line)
│   └── constellation.css                     # UNCHANGED — verified motion-only, no layout rules
└── __tests__/
    ├── RunSurfacePage.responsive.test.tsx    # NEW — narrow stub → column stack assertions
    └── LiveTracePanel.layout.test.tsx        # NEW — side vs stacked prop contract
```

## 2. Current State (verified line numbers)

- `pages/RunSurfacePage.tsx:700` — main row: `<div style={{ display: "flex",
  gap: 16, minHeight: 540 }}>` wrapping the graph box (`flex: 1, position:
  relative, minWidth: 0`, lines 701–711) and `<LiveTracePanel …>` (line 729).
  Fixed side-by-side: graph + 372px trace ⇒ assumes ~1000px.
- `pages/RunSurfacePage.tsx:570` and `:662` — toolbar + agent/message rows both
  already `flexWrap: "wrap"` ✅. But the `<select>` has `minWidth: 170`
  (line 667) and the message `<input>` has `flex: 1, minWidth: 220` (line 687):
  on a phone the wrapped select still forces 170px next to the Send button and
  the input's 220px floor is wasteful below 640px.
- `constellation/LiveTracePanel.tsx:20` — `const TRACE_WIDTH = 372;`, applied
  at line 326 on the root `<aside>` (`width: TRACE_WIDTH, flex: "none"`).
  Height today comes from the parent row's `minHeight: 540`; inner scroller at
  line 337 (`flex: 1, overflowY: "auto"`).
- `constellation/NodeInspector.tsx:19` — `const PANEL_W = 344;`, applied at
  line 408 on the `<aside>`. The inspector is a scrim (`flex: 1`, line 402) +
  right-anchored aside inside `position: absolute, inset: 0` (line 399) —
  scoped to the **graph box**, not the viewport. On a 360px phone the 344px
  panel leaves a 16px scrim sliver (or overflows once the graph box is
  narrower than 344px).
- `constellation/RunBarHud.tsx:28-45` — HUD pill: `display: "inline-flex"`,
  `maxWidth: "calc(100% - var(--space-6))"`, phase span ellipsizes
  (lines 58-67) but the `Meta` spans (iter/elapsed/tokens) can't shrink and
  there is no `flexWrap` — on very narrow graph boxes the metas overflow the
  pill instead of wrapping.
- `constellation/constellation.css` — keyframes + React Flow chrome only; no
  widths or layout. **No change needed** (verified 2026-07-24).

## 3. Design (pseudocode)

### 3a. RunSurfacePage — column stack below md

```tsx
// pages/RunSurfacePage.tsx
import { useBreakpoint } from "../hooks/useMediaQuery";

export function RunSurfacePage() {
  const { isPhone, isNarrow } = useBreakpoint();
  // … existing state unchanged …

  // main row (currently line 700):
  <div
    style={{
      display: "flex",
      flexDirection: isNarrow ? "column" : "row",
      gap: 16,
      // desktop keeps the fixed working height; stacked sizes itself
      minHeight: isNarrow ? undefined : 540,
    }}
  >
    <div style={{
      flex: 1, position: "relative", minWidth: 0,
      // stacked: the graph box no longer inherits 540 from the row — give it
      // its own floor so the constellation stays a usable canvas
      minHeight: isNarrow ? 320 : undefined,
      /* border/radius/overflow/background unchanged */
    }}>
      <RunBarHud … /> <ConstellationGraph … /> {selectedNode && <NodeInspector … />}
    </div>
    <LiveTracePanel … layout={isNarrow ? "stacked" : "side"} />
  </div>

  // input row (currently lines 662-698): shrink the phone floors —
  <select style={{ ...inputStyle, minWidth: isPhone ? 120 : 170 }} … />
  <input  style={{ ...inputStyle, flex: 1, minWidth: isPhone ? 140 : 220, padding: "8px 12px" }} … />
  // both rows keep flexWrap: "wrap" (already present at lines 570 / 662)
}
```

jsdom renders desktop (F1 fallback) ⇒ every existing snapshot/behavior test
sees today's layout unchanged.

### 3b. LiveTracePanel — `layout` prop

```tsx
// constellation/LiveTracePanel.tsx
const TRACE_WIDTH = 372;       // keep the constant — side layout still uses it
const STACKED_MAX_H = 420;     // stacked: cap height, scroll inside

export function LiveTracePanel({
  steps, cursor, onSeek, request, answer,
  /** "side" (default) = fixed 372px right rail; "stacked" = full-width block
   *  beneath the graph with a capped, inner-scrolling height. */
  layout = "side",
}: { …existing…; layout?: "side" | "stacked" }) {
  const stacked = layout === "stacked";
  return (
    <aside
      data-layout={layout}                       // test hook + zero visual cost
      style={{
        width: stacked ? "100%" : TRACE_WIDTH,
        flex: "none",
        maxHeight: stacked ? STACKED_MAX_H : undefined,
        // side layout keeps deriving height from the parent row (minHeight 540)
        /* border, borderRadius, display:flex column, minHeight:0,
           background, overflow:hidden — all unchanged */
      }}
    >
      {/* inner scroller (line 337) already flex:1 + overflowY:auto + minHeight:0
          — works for both layouts, no change */}
    </aside>
  );
}
```

Prop over hook: the panel stays a dumb presentational component; the page (the
one place that knows the surface's composition) picks the layout. `width?:
number | "100%"` was considered and rejected — a semantic enum keeps future
stacked-only tweaks (e.g. a collapse header) from leaking into a numeric API.

### 3c. NodeInspector — clamp, no sheet

```tsx
// constellation/NodeInspector.tsx
// line 19 — was: const PANEL_W = 344;
const PANEL_W = "min(344px, calc(100vw - 24px))";
// line 408 — width: PANEL_W (unchanged reference; type widens number → string, fine)
```

Unconditional CSS `min()` — no hook, no re-render, correct at every width:
desktop resolves to 344px exactly as today; below 368px viewport the panel
yields 24px of scrim so the tap-to-dismiss affordance survives. `100vw` (not
`100%`) is intentional: the aside's containing block is the graph box, but the
guarantee we need is *never exceed the viewport*; the graph box is full-bleed
inside the page padding, so `100vw - 24px` is always ≤ the box on narrow
screens where the clamp engages.

**F3 `BottomSheet` on phone — recommendation: DO NOT adopt it in this item.**
Justification: (1) the inspector already has the full overlay grammar — scrim,
Escape, ✕ button (lines 390–405) — so the clamp alone restores phone
usability; (2) the inspector is positioned `absolute` **inside the graph box**
(line 399), and a sheet would portal it to the viewport, changing containment,
z-index layering and scroll behavior — a semantic change beyond "stop assuming
1000px"; (3) it would make this item block on F3, which is optional by
contract. Revisit as a follow-up ("inspector as sheet on isPhone") once F3 is
proven on a lower-risk surface.

### 3d. RunBarHud — wrap instead of overflow

```tsx
// constellation/RunBarHud.tsx, container style (lines 28-45): add one property
flexWrap: "wrap",
```

Unconditional: on desktop the pill never wraps (content fits), so this is
inert; on a narrow graph box the metas fold to a second line inside the pill
instead of spilling past `maxWidth`.

## 4. Implementation Steps

1. **`constellation/LiveTracePanel.tsx`** — add the `layout?: "side" |
   "stacked"` prop (default `"side"`), `STACKED_MAX_H = 420`, the
   `width`/`maxHeight` switch and `data-layout` attribute per §3b. Update the
   component doc comment ("the right-hand live trace" → note it stacks
   full-width beneath the graph on narrow viewports).
2. **`constellation/NodeInspector.tsx`** — change `PANEL_W` (line 19) to the
   `min()` string per §3c. No other edits; line 408 already reads `PANEL_W`.
3. **`constellation/RunBarHud.tsx`** — add `flexWrap: "wrap"` to the pill
   container style per §3d.
4. **`pages/RunSurfacePage.tsx`** — import `useBreakpoint` from
   `../hooks/useMediaQuery`; destructure `{ isPhone, isNarrow }` at the top of
   `RunSurfacePage`; apply the main-row `flexDirection`/`minHeight` switch,
   the graph box `minHeight: isNarrow ? 320 : undefined`, the
   `layout={isNarrow ? "stacked" : "side"}` prop, and the phone input floors
   (§3a). Verify (no code change expected) that both toolbar rows keep
   `flexWrap: "wrap"`.
5. **Tests** — add the two files per §5.
6. **Gate** — `bun run --filter=@pattern-stack/agentic-dashboard test`,
   `… typecheck`, `… lint` (biome: double quotes, 2-space, 100-col). Full
   existing dashboard suite must pass **unchanged** (F1's jsdom-desktop
   fallback is what guarantees this).

Conventions: strict TS (`noUncheckedIndexedAccess`), no new deps, no barrel
changes (none of these components are barrel-exported), lands via PR (`main`
is protected).

## 5. Test Plan

matchMedia stubbing follows `src/__tests__/theme-mode.test.ts:17-27`
(`vi.stubGlobal("matchMedia", vi.fn(...))`) + F1's
`__resetMediaQueryCacheForTests()` in `beforeEach`; `vi.unstubAllGlobals()` +
`cleanup()` in `afterEach`.

```ts
/** Stub a NARROW viewport: max-width queries match ⇔ the bound ≥ `width`. */
function stubViewport(width: number) {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: width < Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? 0) + 1,
    media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
}
```

### `__tests__/LiveTracePanel.layout.test.tsx` (component contract — no page mocking)

Render `<LiveTracePanel steps={[]} cursor={-1} onSeek={noop} />` directly
(pattern: `NodeInspector.scopeContext.test.tsx`).

1. Default/side: root `[data-layout="side"]` aside has `style.width === "372px"`
   and no `maxHeight`.
2. `layout="stacked"`: `style.width === "100%"`, `style.maxHeight === "420px"`.
3. Behavior invariance: with a 2-step `steps` fixture, rows render and clicking
   a row calls `onSeek(index)` identically in both layouts.

### `__tests__/RunSurfacePage.responsive.test.tsx` (integration of the stack)

Mocks (RunSurfacePage's real deps are network + React Flow, neither
jsdom-viable): `vi.mock("../api/chat-client")` (`listAgents → []`, etc.),
`vi.mock("../lib/runsApi")` (`fetchRuns → { kind: "unconfigured" }`),
`vi.mock("../constellation/ConstellationGraph")` (`() => <div
data-testid="graph" />` — React Flow needs real layout). Render inside
`<MemoryRouter>` (page uses `useSearchParams`).

1. **Narrow (stubViewport(800)):** the main row (parent of the graph box) has
   `flexDirection: "column"`; the graph box has `minHeight: "320px"`; the
   trace aside is `[data-layout="stacked"]` with `width: "100%"`.
2. **Desktop (stubViewport(1280)):** row `flexDirection: "row"` (explicit now),
   `minHeight: "540px"`; trace `[data-layout="side"]`, `width: "372px"` —
   i.e. today's layout, byte-for-byte.
3. **Phone (stubViewport(390)):** agent `<select>` `minWidth: "120px"`,
   message `<input>` `minWidth: "140px"`; desktop stub keeps `170px`/`220px`.
4. **Inspector clamp** (in `NodeInspector.scopeContext.test.tsx`'s sibling
   spirit, add here or extend that file): render `<NodeInspector …>` and
   assert the aside's `style.width === "min(344px, calc(100vw - 24px))"` —
   the clamp is unconditional, so no viewport stub needed.

Regression gate: entire existing dashboard suite green with zero edits.

## 6. Risks & Out of Scope

- **Constellation touch interaction is UNVERIFIED and OUT OF SCOPE.** This
  item changes LAYOUT only. Pan/zoom/node-tap on the React Flow SVG canvas
  (`ConstellationGraph`) on touch devices has not been exercised — tap-to-
  select may conflict with pan gestures, pinch-zoom is untested, and the
  stacked 320px-tall canvas may make small tool nodes hard to hit. **Do not
  assume touch works because this PR merged.** File a follow-up
  ("constellation touch-interaction audit") when this lands; it needs a real
  device/emulator pass, which no jsdom test here can stand in for.
- `100vw` includes the scrollbar gutter on desktop platforms with classic
  scrollbars — irrelevant here since the clamp only bites below ~368px, where
  overlay scrollbars are universal.
- Stacked trace + graph exceed one phone-screen height by design (the page
  scrolls); the trace's own `STACKED_MAX_H` inner scroll prevents
  scroll-within-scroll from swallowing the whole page.
- `RunBarHud` wrapping to two lines slightly taller pill overlapping more
  canvas on narrow screens — acceptable; the alternative (dropping metas)
  loses live-run information.
