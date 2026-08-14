# W1-Chat (WI-4) — Responsive Chat Page (/chat, /chat/:agentId)

**Goal:** Below the `md` (900px) breakpoint the chat column takes the full width and
the Console (Tools / Trace / Scratchpad) rail becomes a BottomSheet opened from a
"Console" trigger button in the header; the page's full-height math survives the
narrow-mode app bar via the F2 CSS-variable contract. Desktop (≥900px) renders
pixel-identical to today.

**PR size estimate:** ~120 changed lines across 4 files + 1 new test file
(~150 lines). No new source files in this item (BottomSheet ships in F3).

## 1. Dependencies (shared contract — reproduced verbatim; do not drift)

This item consumes three foundation PRs. It must NOT re-implement any of them.

- **F1 — breakpoint hook** (`packages/agent-dashboard/src/hooks/useMediaQuery.ts`,
  constants in `src/ui/breakpoints.ts`, `BREAKPOINTS = { sm: 640, md: 900, lg: 1200 }`):

  ```ts
  export function useBreakpoint(): { isPhone: boolean; isNarrow: boolean; isDesktop: boolean };
  // isPhone ⇔ width < 640px; isNarrow ⇔ width < 900px (includes phone).
  // jsdom / no matchMedia → { isPhone: false, isNarrow: false, isDesktop: true }
  // — existing tests keep seeing the desktop layout. Gate MOBILE variants on the
  // flags (render mobile when isNarrow); never gate desktop on a min-width match.
  ```

- **F2 — AppShell CSS-var contract:** AppShell's `<main>` sets
  `--appbar-h` (`0px` desktop → ~`48px` narrow, where the top app bar appears) and
  `--shell-pad-y` (`24px` desktop → `12px` phone). Full-height pages compute:

  ```
  height: calc(100dvh - var(--appbar-h, 0px) - 2 * var(--shell-pad-y, 24px))
  ```

  The fallbacks reproduce today's desktop math exactly (`0 + 2*24 = 48px`, the
  constant currently hard-coded in ChatPage) — see §7 for the release-train coupling.

- **F3 — BottomSheet + ConsoleRail sheet mode:**
  `BottomSheet({ title, onClose, children, maxHeightPct })` in
  `src/components/kit/`; `ConsoleRail` (in `src/components/ConsoleRail.tsx`)
  gains `mode?: "side" | "sheet"` (default `"side"`, today's behavior).
  In `mode="sheet"`: `open === true` renders the tab strip + body inside a
  BottomSheet (its close affordance calls `onToggle`); `open === false` renders
  **null** — no 22px collapsed reopen strip (the page-owned trigger replaces it).

## 2. File Tree

```
packages/agent-dashboard/src/
├── pages/
│   ├── ChatPage.tsx                       # MODIFIED — height calc, isNarrow wiring,
│   │                                      #   ConsoleRail mode, Console trigger in Header
│   └── chat-route.css                     # VERIFIED, unchanged (no fixed heights/widths;
│                                          #   .chat-route is already height:100% / min-height:0)
├── chat/
│   ├── chat.css                           # MODIFIED — 700px media → 639px; composer touch pass
│   └── ChatComposer.tsx                   # MODIFIED — ≥40px touch targets on Send/Stop
└── __tests__/
    └── ChatPage.responsive.test.tsx       # NEW — sheet/trigger behavior under stubbed matchMedia
```

## 3. Current State (cited — line numbers as of this spec)

- `pages/ChatPage.tsx:586` — root wrapper `height: "calc(100vh - 48px)"`, with the
  comment at :583-585 explaining the 48 = AppShell's `padding: 24` top+bottom.
  This is the F2 coordination point.
- `pages/ChatPage.tsx:635` — the split row
  `<div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16 }}>` holding the
  chat column (:636-674, `flex: 1, minWidth: 0`) and `<ConsoleRail …>` (:675-709,
  driven by `railOpen`/`railTab` state declared at :258-259).
- `pages/ChatPage.tsx:285-305` — the `chat:seek-rail` listener does
  `flushSync(() => { setRailOpen(true); setRailTab("scratchpad"); … })`. Unchanged:
  on narrow this now opens the *sheet* on the Scratchpad tab, which is the correct
  behavior for a cite-seek on a phone.
- `pages/ChatPage.tsx:820-916` — `Header`. Row 1 (:825-873) already has
  `flexWrap: "wrap"` (:830). Row 2 (:877-905) holds the truncating description,
  `CopyChatMenu` (:893), `CaptureCasePanel` (:898), `ScopeContextPanel` (:904).
- `components/ConsoleRail.tsx:20-30` — current props
  `{ open, onToggle, tab, onTab, tabs, children, width = 328 }`; collapsed state is
  a 22px full-height reopen strip (:44-70).
- `chat/chat.css:666` — `@media (max-width: 700px)` (stacks the `.ba` before/after
  grid). The only width media query in the file; off-convention value.
- `chat/chat.css:733-755` — `.chat-composer` (textarea `min-height: 40px` already);
  `chat/ChatComposer.tsx:64-72` — Send/Stop use `Button` default `size="md"`
  (`padding: "8px 16px"`, `T.fz.md` → ~35px rendered height, below the 40px target).

## 4. Pseudocode

### 4a. `ChatPage` — breakpoint wiring + height calc (root, ~:577-588)

```tsx
import { useBreakpoint } from "../hooks/useMediaQuery";   // F1

// inside ChatPage(), near the rail state (:258)
const { isNarrow } = useBreakpoint();

return (
  <div
    style={{
      display: "flex", flexDirection: "column", gap: 16,
      // F2 contract: AppShell <main> publishes --appbar-h / --shell-pad-y.
      // Fallbacks reproduce the old desktop constant (0 + 2*24 = the 48px
      // this calc previously hard-coded); 100dvh (not 100vh) so the phone
      // browser chrome collapsing doesn't push the composer off-screen.
      height: "calc(100dvh - var(--appbar-h, 0px) - 2 * var(--shell-pad-y, 24px))",
      minHeight: 0,
    }}
  >
```

### 4b. Split row — ConsoleRail mode (~:635, :675)

```tsx
<div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16 }}>
  <div ref={chatColRef} className="chat-route" style={{ flex: 1, minWidth: 0 }} …>
    <ChatPanel … />                {/* unchanged; now full-width when the rail is a sheet */}
  </div>
  <ConsoleRail
    mode={isNarrow ? "sheet" : "side"}   // F3 prop; "side" branch is byte-identical to today
    open={railOpen}
    onToggle={() => setRailOpen((v) => !v)}
    tab={railTab} onTab={setRailTab} tabs={RAIL_TAB_OPTIONS}
  >
    {…existing tools/trace/scratchpad children, untouched…}
  </ConsoleRail>
</div>
```

State intersection to spec exactly: `railOpen` currently initializes `useState(true)`
(:258). Keep it — on desktop the rail stays open-by-default; in sheet mode
"open by default" would cover the chat on every phone load, so ChatPage adds one
narrowing effect:

```tsx
// Sheet must not auto-cover the transcript on a phone load / rotation-to-narrow.
useEffect(() => {
  if (isNarrow) setRailOpen(false);
}, [isNarrow]);
```

(Rotating back to desktop leaves `railOpen` as the user last set it — acceptable;
the side rail's own collapse strip handles reopening.)

### 4c. Console trigger — Header row 2 (~:877-905)

`Header` gets one new optional prop; ChatPage passes it only when narrow:

```tsx
// HeaderProps (~:761)
/** Non-null on narrow viewports — renders the "Console" sheet trigger. */
onOpenConsole?: (() => void) | null;

// ChatPage call site (~:590)
<Header … onOpenConsole={isNarrow ? () => setRailOpen(true) : null} />

// Header row 2 (~:877) — trigger sits with the other occasional actions,
// before CopyChatMenu:
<div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
  <div title={description || undefined} style={{ …existing truncating description… }} />
  {onOpenConsole && (
    <Button variant="ghost" size="sm" onClick={onOpenConsole} aria-label="Open console">
      Console
    </Button>
  )}
  <CopyChatMenu … />
  <CaptureCasePanel … />
  {contextAvailable && !viewing && <ScopeContextPanel {...scopeForm} />}
</div>
```

No new state: the trigger drives the *existing* `railOpen`; the sheet's close
(BottomSheet `onClose` → ConsoleRail `onToggle`) drives it back.

### 4d. CSS — `chat/chat.css`

```css
/* :666 — migrate to the shared sm boundary (BREAKPOINTS.sm - 1 = 639) */
@media (max-width: 639px) {          /* was 700px */
  .ba { grid-template-columns: 1fr; }
  .ba .arr { transform: rotate(90deg); }
}

/* composer touch pass — append near .chat-composer (:733). Button renders
   className "ap-btn" (components/atoms/Button.tsx), so no atom change needed. */
.chat-composer .ap-btn {
  min-height: 40px;                  /* md button is ~35px; textarea is already 40 */
}
@media (max-width: 639px) {
  .chat-composer textarea {
    font-size: 16px;                 /* < 16px focus-zooms the page on iOS Safari */
  }
}
```

`ChatComposer.tsx` itself needs **no logic change** — the touch pass lands in CSS.
Only touch the TSX if review prefers inline style over the `.ap-btn` selector
(then: `style={{ minHeight: 40 }}` on both the Stop and Send `Button`s, :64-72).

`pages/chat-route.css` — verified: 13 lines, flex column + `height: 100%` +
`min-height: 0`, no widths, no media queries. **No change.**

## 5. Implementation Steps

1. **ChatPage.tsx — height calc (:586).** Replace `"calc(100vh - 48px)"` with
   `"calc(100dvh - var(--appbar-h, 0px) - 2 * var(--shell-pad-y, 24px))"` and
   rewrite the :583-585 comment to cite the F2 AppShell contract instead of the
   hard-coded padding sum.
2. **ChatPage.tsx — breakpoint wiring.** Import `useBreakpoint` from
   `../hooks/useMediaQuery`; read `const { isNarrow } = useBreakpoint()` near the
   rail state (:258); add the `isNarrow → setRailOpen(false)` effect (§4b).
3. **ChatPage.tsx — ConsoleRail mode (:675).** Pass
   `mode={isNarrow ? "sheet" : "side"}`. Children and all other props unchanged.
4. **ChatPage.tsx — Header trigger.** Add `onOpenConsole?: (() => void) | null` to
   `HeaderProps` (:761-792), thread it at the `<Header>` call (:590-624) as
   `isNarrow ? () => setRailOpen(true) : null`, render the ghost `Button` in row 2
   per §4c. (Note `noUnusedParameters`: destructure it in `Header`'s parameter
   list, :794-819.)
5. **chat.css.** `:666` `700px → 639px`; append the `.chat-composer .ap-btn`
   min-height rule and the ≤639px textarea `font-size: 16px` rule (§4d).
6. **Header row 1 chip overflow at 360px — verify, no code expected.** Row 1
   already wraps (:830). Manually confirm at 360px (devtools) that the wrapped
   order stays sane: `Chat` + agent picker + `Sessions` on line one; chips
   (`ScopeChip`, exchanges, streaming badges, :853-865) and `RunSettingsMenu`
   wrap below. Only if a chip's content itself overflows (long scope values)
   add `minWidth: 0` / ellipsis to that chip — do not restructure the row.
7. **New test file** `src/__tests__/ChatPage.responsive.test.tsx` (§6).
8. **Gates.** `bun run --filter=@pattern-stack/agentic-dashboard test` (all existing
   ChatPage suites must pass **unedited** — see §6 regression note), then
   `typecheck`, `lint`, `build`.

## 6. Test Plan

**Regression (free, load-bearing):** jsdom has no `matchMedia`, so per the F1
contract `useBreakpoint()` returns desktop and ChatPage renders exactly today's
tree. The four existing suites — `ChatPage.density.test.tsx`,
`ChatPage.scopeChip.test.tsx`, `ChatPage.scopeForm.test.tsx`,
`ChatPage.scratchpadTab.test.tsx` — must pass **without modification**. They click
the inline rail's Segmented tabs; any accidental narrow-gating of the side rail
breaks them loudly.

**New — `src/__tests__/ChatPage.responsive.test.tsx`.** Reuse the fetch-mock
scaffold from `ChatPage.density.test.tsx` (agents + conversations stubs, `render(<ChatPage />)`,
`cleanup`/`vi.restoreAllMocks` in `afterEach`). Stub viewport via the F1 pattern
(`theme-mode.test.ts:17-27` style):

```ts
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";

function stubViewport(matchesFor: (query: string) => boolean) {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: matchesFor(query), media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
}
// beforeEach: __resetMediaQueryCacheForTests()
// afterEach: vi.unstubAllGlobals()
const NARROW = (q: string) => q === "(max-width: 899px)"; // md matches, sm doesn't
```

Cases:

1. **Desktop explicit** (`matchesFor = () => false`): no `Open console` button;
   the rail tablist (`aria-label="Side panel"`) is present inline.
2. **Narrow default = sheet closed:** with `NARROW`, after load the header shows
   the `Open console` trigger (`getByRole("button", { name: "Open console" })`),
   and the rail tab strip is **absent** (sheet closed renders null — no 22px strip).
3. **Trigger opens the sheet:** click the trigger → the BottomSheet appears with
   the Tools/Trace/Scratchpad Segmented; switching to Trace works inside it.
   Close (BottomSheet's close affordance, per F3's accessible name) → tab strip
   gone again, trigger still present.
4. **Height contract:** root wrapper's inline style contains
   `100dvh`, `var(--appbar-h, 0px)` and `var(--shell-pad-y, 24px)` (string
   assertion on `style.height` — jsdom won't compute `calc`, exact-substring is
   the honest check).
5. **Seek opens the sheet** (guards the :285-305 flushSync path): with `NARROW`
   and the sheet closed, dispatch `chat:seek-rail` (CustomEvent with a `key`) on
   the chat column → sheet opens on the Scratchpad tab. (Mirror the event
   plumbing from `ChatPage.scratchpadTab.test.tsx`.)

## 7. Release-Train Coupling (explicit)

**This PR must land in the same release train as F2.** The height calc in §4a
consumes `--appbar-h` / `--shell-pad-y`, which only F2's AppShell publishes:

- *This item without F2:* desktop is safe (fallbacks `0px`/`24px` reproduce the
  old `- 48px` exactly), but **narrow is wrong** — the F2 app bar doesn't exist
  yet, and once it ships the sheet/trigger UI would have shipped against an
  unfinished shell. Ordering: F1 → F2 → F3 → this.
- *F2 without this item:* ChatPage's hard-coded `calc(100vh - 48px)` breaks under
  the narrow app bar (composer pushed below the fold by ~48px). This PR is the fix.

Do not merge to `main` (auto-publish on version change) unless F1, F2, and F3 are
already in or in the same train.

## 8. Conventions

- Strict TS (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`);
  biome (double quotes, 2-space indent, 100-col); vitest (jsdom, existing
  `@testing-library/react` patterns).
- No upward imports: `pages/` → `hooks/` → `ui/` is downhill; ChatPage already
  imports from `components/` and `chat/`. No dashboard file imports runtime/core.
- Line numbers cited here are pre-F3; ConsoleRail's `mode` prop insertion may
  shift `components/ConsoleRail.tsx` — re-verify `ChatPage.tsx` anchors
  (`:586`, `:635`, `:675`, `:877`) against the rebased tree before editing.
