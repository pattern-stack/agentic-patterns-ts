# F3 — Overlay kit: BottomSheet primitive + ConsoleRail sheet mode + Modal phone polish

**Date:** 2026-07-24
**Package:** `@pattern-stack/agentic-dashboard` (`packages/agent-dashboard/`)
**Size:** ~300 lines (1 new component ~110, 1 new test ~120, ConsoleRail delta ~40, Modal delta ~10, barrel +1)

## Goal

Build the reusable **"rail → sheet"** overlay pattern once, so every rail-bearing page can adopt
it. Today the dashboard's right-hand rails (`ConsoleRail` and its `flex: none` siblings) are
fixed-width asides that squeeze the content column into unusability below the `md`/narrow
breakpoint. This spec introduces:

1. A portalled **`BottomSheet`** kit primitive — bottom-anchored, full-width, own scroll body,
   Esc/scrim close, body-scroll-lock — mirroring the `Modal` atom's overlay discipline.
2. A **`mode?: "side" | "sheet"`** prop on `ConsoleRail` so the chat Console's tab strip + body
   can render inside a `BottomSheet` on narrow viewports instead of the fixed 328px aside.
3. A **phone branch in `Modal`** (full-width panel, reduced top padding) so existing dialogs
   stop clipping at 520px + 8vh on small screens.

This is a FOUNDATION item: it publishes the contract that W1-Chat (and optionally W1-LiveRun)
consume. No page adopts sheet mode in this PR — `ConsoleRail`'s default stays `"side"` and all
existing call sites (`src/pages/ChatPage.tsx` line 675) are untouched.

## Dependencies (shared contract from F1 — must land first)

This spec **depends on** the F1 responsive-foundation contract (files do not exist yet on this
branch — verify they exist before starting):

- `packages/agent-dashboard/src/hooks/useMediaQuery.ts` exports
  `useBreakpoint(): { isPhone: boolean; isNarrow: boolean; isDesktop: boolean }`
  where **`isNarrow` = viewport `< 900px`** (the `md` boundary) and `isPhone` is the smallest
  tier. Implemented on `window.matchMedia`; in jsdom (no real `matchMedia`) the hook resolves
  to **desktop** unless tests stub `window.matchMedia`.
- `packages/agent-dashboard/src/ui/breakpoints.ts` exports the `BREAKPOINTS` constants the hook
  is built on. F3 never hardcodes pixel breakpoints — it only consumes `useBreakpoint()`.

## File tree

```
packages/agent-dashboard/src/
├── components/
│   ├── kit/
│   │   ├── BottomSheet.tsx          [NEW]  portalled bottom-anchored sheet primitive
│   │   └── index.ts                 [EDIT] + export { BottomSheet, type BottomSheetProps }
│   ├── ConsoleRail.tsx              [EDIT] + mode?: "side" | "sheet"
│   └── atoms/
│       └── Modal.tsx                [EDIT] phone CSS-value branch via useBreakpoint
└── __tests__/
    └── BottomSheet.test.tsx         [NEW]  portal/close/scroll-lock + ConsoleRail modes
```

## Pseudocode signatures

### `src/components/kit/BottomSheet.tsx` (new)

```tsx
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface BottomSheetProps {
  title: string;                 // aria-label for the dialog + header text
  onClose: () => void;
  children: ReactNode;           // sheet body — gets a bounded, own-scrolling slot
  /** Max sheet height as % of viewport height. Default 75. */
  maxHeightPct?: number;
}

export function BottomSheet({ title, onClose, children, maxHeightPct = 75 }: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Mirror Modal's effect (src/components/atoms/Modal.tsx lines 25-37) verbatim in shape:
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";       // body-scroll-lock
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow; // release on unmount
    };
  }, [onClose]);

  return createPortal(
    // Scrim: fixed inset 0, same background recipe as Modal's backdrop
    // (`color-mix(in oklch, var(--ink) 45%, transparent)`), zIndex 1000,
    // display flex, alignItems "flex-end" (bottom-anchored — vs Modal's "flex-start"),
    // onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    // + the same biome-ignore lint/a11y/useKeyWithClickEvents comment as Modal line 40.
    <div onClick={scrimClose} style={{ position: "fixed", inset: 0, ..., alignItems: "flex-end", zIndex: 1000 }}>
      <div
        ref={panelRef}
        role="dialog"            // + biome-ignore lint/a11y/useSemanticElements (as Modal line 59)
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{
          width: "100%",                       // full-width
          maxHeight: `${maxHeightPct}vh`,
          display: "flex", flexDirection: "column", minHeight: 0,
          background: "var(--paper)",
          border: "1px solid var(--line)", borderBottom: "none",
          borderRadius: "var(--radius-lg) var(--radius-lg) 0 0",  // top corners only
          boxShadow: "var(--shadow-3)", outline: "none", overflow: "hidden",
        }}
      >
        <header style={{ flex: "none", display: "flex", alignItems: "center",
                         justifyContent: "space-between", padding: "10px 14px",
                         borderBottom: "1px solid var(--line)" }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
        </header>
        {/* Own scroll body — the sheet scrolls, not the page */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto",
                      display: "flex", flexDirection: "column" }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

Imports: `Button` from `../atoms/Button` (kit → atoms is established precedent —
`kit/AsyncState.tsx` lines 18-20 import `atoms/Card`, `atoms/Spinner`).

### `src/components/ConsoleRail.tsx` (edit)

```tsx
export interface ConsoleRailProps<V extends string> {
  open: boolean;
  onToggle: () => void;
  tab: V;
  onTab: (v: V) => void;
  tabs: SegmentedOption<V>[];
  children: ReactNode;
  width?: number;                     // side mode only (default 328)
  /** "side" (default) = current fixed-width aside. "sheet" = render inside BottomSheet. */
  mode?: "side" | "sheet";
}
```

Render logic (top of the function body, before the existing `if (!open)` at line 44):

```tsx
if (mode === "sheet") {
  if (!open) return null;   // NO reopen strip — host page supplies its own trigger
  return (
    <BottomSheet title="Console" onClose={onToggle}>
      {/* tab strip: same Segmented row as the side-mode header (lines 87-122)
          but WITHOUT the ›-collapse button — BottomSheet's ✕ owns closing */}
      <div style={{ flex: "none", padding: "7px 8px", borderBottom: "1px solid var(--line)" }}>
        <Segmented options={tabs} value={tab} onChange={onTab} size="sm" aria-label="Side panel" />
      </div>
      <div role="tabpanel" aria-label={activeLabel}
           style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </BottomSheet>
  );
}
// …existing side-mode code (collapsed strip lines 44-70, open aside lines 72-133) unchanged.
```

### `src/components/atoms/Modal.tsx` (edit — pure CSS-value branch)

```tsx
const { isPhone } = useBreakpoint();   // from "../../hooks/useMediaQuery"
// Backdrop (line 52): padding: isPhone ? "12px 12px 12px" : "8vh 16px 16px"
// Panel   (line 69): maxWidth: isPhone ? "100%" : 520
//                    (width: "100%" at line 68 already makes this min(520px, 100%) behavior)
```

No structural/JSX changes — only the two style values branch. Behavior on desktop is
byte-identical to today.

## Implementation steps

1. **Verify F1 landed.** Confirm `src/hooks/useMediaQuery.ts` (exporting `useBreakpoint`) and
   `src/ui/breakpoints.ts` exist. If not, stop — this item is blocked on F1.
2. **Create `src/components/kit/BottomSheet.tsx`** per the signature above. Copy the
   Esc/scroll-lock/focus effect shape from `src/components/atoms/Modal.tsx` lines 25-37
   exactly (including `prevOverflow` save/restore), and reuse Modal's two biome-ignore
   comments (lines 40 and 59) for the scrim click handler and `role="dialog"` div.
   `BottomSheet` itself does NOT call `useBreakpoint` — responsiveness is the caller's choice.
3. **Export from the barrel.** In `src/components/kit/index.ts`, add (alphabetical, between
   `AsyncState` and `DropdownMenu`):
   `export { BottomSheet, type BottomSheetProps } from "./BottomSheet";`
4. **Add `mode` to `ConsoleRail`** (`src/components/ConsoleRail.tsx`): extend
   `ConsoleRailProps` with `mode?: "side" | "sheet"`, default `"side"` in the destructure.
   Add the sheet branch before the existing collapsed-strip branch. Import `BottomSheet` from
   `"./kit/BottomSheet"`. Key behaviors:
   - sheet + `!open` → render `null` (never the 22px reopen strip at lines 44-69);
   - sheet + `open` → `BottomSheet` wrapping tab strip + tabpanel body; `onToggle` is the
     sheet's `onClose`;
   - `width` is ignored in sheet mode (document in the prop's JSDoc).
   Side mode renders exactly as today — zero diff in that branch.
5. **Phone branch in `Modal`** (`src/components/atoms/Modal.tsx`): import `useBreakpoint`,
   branch the backdrop `padding` (line 52) and panel `maxWidth` (line 69) as shown above.
6. **Write `src/__tests__/BottomSheet.test.tsx`** per the test plan below.
7. **Update `ConsoleRail`'s header comment** (lines 1-16) with one sentence noting the new
   sheet mode. Do NOT touch `src/pages/ChatPage.tsx` — adoption is W1-Chat's job.
8. Run `bun run --filter=@pattern-stack/agentic-dashboard typecheck`, `bun run lint`,
   `bun run --filter=@pattern-stack/agentic-dashboard test`.

## Test plan — `src/__tests__/BottomSheet.test.tsx`

Follow `src/__tests__/Modal.test.tsx` conventions: `@testing-library/react`,
`afterEach(cleanup)`, `screen`-scoped queries (portals render into `document.body`, so the
render container is empty). Vitest env is jsdom (`vitest.config.ts`: `environment: "jsdom"`).

**matchMedia stubbing:** jsdom has no `matchMedia`, so the F1 `useBreakpoint` hook defaults to
desktop. Tests that exercise sheet/phone behavior in components that call the hook (Modal) must
stub it. `BottomSheet` and `ConsoleRail mode="sheet"` do NOT read the hook — mode is a prop —
so only add the stub where a hook-reading component is under test:

```tsx
const stubMatchMedia = (matches: (query: string) => boolean) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query), media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
};
afterEach(() => vi.unstubAllGlobals());
```

(Adjust the stub to F1's actual query strings from `src/ui/breakpoints.ts` once F1 lands.)

Cases:

1. **Portal mount** — renders `title` + children; `screen.getByRole("dialog", { name })`
   resolves; `container.firstChild` is null (proves portal, not in-tree render).
2. **Esc closes** — `fireEvent.keyDown(document, { key: "Escape" })` → `onClose` called once.
3. **Scrim closes, panel click doesn't** — click `getByRole("dialog")` → not called; click
   `dialog.parentElement` (the scrim) → called once. Also the ✕ button (`getByLabelText("Close")`).
4. **Scroll lock applied/released** — after render, `document.body.style.overflow === "hidden"`;
   after `unmount()`, restored to its pre-render value.
5. **`maxHeightPct` default/override** — dialog style `maxHeight` is `"75vh"` by default,
   `"50vh"` with `maxHeightPct={50}`.
6. **ConsoleRail side vs sheet** — render `ConsoleRail` with two tabs:
   - default (side) + `open` → an aside with the tab strip and collapse button
     (`getByLabelText("Collapse panel")`), no dialog role;
   - `mode="sheet"` + `open` → `getByRole("dialog", { name: "Console" })` present, tab
     `Segmented` (`getByRole("tablist", ...)`) inside it, `onToggle` fired by ✕/Esc;
   - `mode="sheet"` + `open={false}` → renders nothing: no dialog, and
     `queryByLabelText("Show panel")` (the side-mode reopen strip) is null.
7. **Modal phone branch** — with matchMedia stubbed to phone, `Modal`'s dialog style has
   `maxWidth: "100%"` and its parent padding starts with `"12px"`; with desktop stub (or no
   stub), `maxWidth` is `520` and padding `"8vh 16px 16px"`.

## Contract published (consumed by W1-Chat, optionally W1-LiveRun)

- **`BottomSheet`** from `@/components/kit` (barrel `src/components/kit/index.ts`):
  `BottomSheet({ title, onClose, children, maxHeightPct = 75 })` — portalled to
  `document.body`, bottom-anchored, full-width, top-rounded, `zIndex: 1000`, own scroll body,
  Esc/scrim/✕ close, body-scroll-lock while mounted. Presentation-only: callers decide *when*
  to render it (typically `isNarrow` from `useBreakpoint()`).
- **`ConsoleRail`** gains `mode?: "side" | "sheet"` (default `"side"`, fully
  backward-compatible). In `"sheet"` mode there is **no reopen strip** — the host page must
  supply its own trigger (e.g. a toolbar button) that flips `open`; `onToggle` doubles as the
  sheet's close. W1-Chat wires `mode={isNarrow ? "sheet" : "side"}` in
  `src/pages/ChatPage.tsx` (line 675 call site).

## Conventions

- Strict TS (`noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`); biome (double quotes,
  semicolons, 2-space indent, 100-char lines); vitest + Testing Library, jsdom.
- No upward imports: dashboard-internal only — kit may import atoms (existing precedent), and
  `ConsoleRail` may import kit; nothing imports from pages. No new dependencies.
- Inline `style` objects with CSS custom properties (`var(--paper)`, `var(--line)`,
  `var(--radius-lg)`, `var(--shadow-3)`) per existing kit/atoms style.
