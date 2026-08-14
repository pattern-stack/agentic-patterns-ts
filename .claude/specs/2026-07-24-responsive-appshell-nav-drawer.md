# F2 — AppShell viewport-driven nav drawer + mobile app bar

**Date:** 2026-07-24
**Package:** `@pattern-stack/agentic-dashboard` (`packages/agent-dashboard/`)
**Status:** Spec — ready for implementation
**Size estimate:** ~230 lines of new/changed source + ~150 lines of tests

## Goal

Below the `md` breakpoint (900px), replace the fixed 220px sidebar with a top
app bar (hamburger + title + ThemeToggle) and a portalled overlay nav drawer.
Desktop (≥900px) behavior — **including the `apdash-nav-collapsed` density
toggle** (`AppShell.tsx` lines 37–65) — stays byte-for-byte untouched in
behavior. This is a FOUNDATION item: it also publishes the `--shell-pad-y` /
`--appbar-h` CSS-var contract that Wave-1 full-height pages (esp. Chat)
consume.

## Dependencies (from F1 — must land first)

This spec depends on the F1 shared breakpoint contract, reproduced verbatim:

- `BREAKPOINTS = { sm: 640, md: 900, lg: 1200 }` exported from
  `packages/agent-dashboard/src/ui/breakpoints.ts`.
- Hooks in `packages/agent-dashboard/src/hooks/useMediaQuery.ts`:
  `useBreakpoint(): { isPhone; isNarrow; isDesktop }` where
  **`isNarrow` = viewport < 900px** and `isPhone` = viewport < 640px.
- The hook is **jsdom-safe**: when `window.matchMedia` is absent it defaults
  to desktop, so existing tests render the desktop branch unchanged.
- Inline-style layout branches read `useBreakpoint()`; CSS-file rules use
  `@media (max-width: 899px)` (or `max-width: 639px` for phone) with a
  comment pointing at `breakpoints.ts`.

Neither F1 file exists in the tree yet (`src/ui/` holds only `theme-mode.ts` +
`tokens.ts`; `src/hooks/` has no `useMediaQuery.ts`). **Do not start F2 until
F1 is merged**, or implement F1 first on the same branch.

## Contract published

The `<main>` element in `AppShell.tsx` sets two CSS custom properties that
downstream full-height pages (Chat, Live Run, eval detail) consume via
`calc()`. **These names and values are load-bearing — state them verbatim in
any consuming spec:**

| Variable | Desktop (≥900px) | Narrow tablet (640–899px) | Phone (<640px) |
|---|---|---|---|
| `--appbar-h` | `0px` | `48px` | `48px` |
| `--shell-pad-y` | `24px` | `24px` | `12px` |

- `--appbar-h` — height of the mobile app bar. `0px` on desktop so consumers
  can always write `calc(100vh - var(--appbar-h) - 2 * var(--shell-pad-y))`
  without branching.
- `--shell-pad-y` — the vertical padding `<main>` applies (top and bottom
  each). Horizontal padding is NOT published as a var: it is `24px` desktop /
  narrow-tablet, `16px` phone, applied directly in the `padding` shorthand.

Both vars are set inline on `<main>` (they must track the JS breakpoint state,
not a parallel CSS media query, so the JS and CSS worlds can never disagree).

## File tree

```
packages/agent-dashboard/
├── src/components/templates/
│   ├── AppShell.tsx              # MODIFIED — export navGroups; narrow branch
│   └── MobileNavDrawer.tsx       # NEW — portalled overlay drawer
├── src/styles/
│   └── globals.css               # MODIFIED — drawer keyframes + iOS zoom guard
└── src/__tests__/
    └── AppShell.responsive.test.tsx  # NEW
```

## Current state (for orientation)

`AppShell.tsx` (171 lines):
- Lines 5–34: module-level `navGroups` const (3 groups: Build / Run /
  Evaluate, items typed `{ to; label; end? }`).
- Lines 37–53: `NAV_COLLAPSED_KEY = "apdash-nav-collapsed"` +
  `readCollapsedPref()` / `writeCollapsedPref()` localStorage helpers.
- Lines 55–65: `AppShell({ children })` with `collapsed` state + `toggle`.
- Lines 67–169: row flex wrapper → `<nav>` (lines 69–166, width
  `collapsed ? 36 : 220`, groups, `ThemeToggle` at bottom) → `<main>` (line
  167: `{ flex: 1, padding: 24, overflow: "auto" }`).

`AppShell` renders inside `BrowserRouter` (`App.tsx` lines 26–27), so router
hooks (`useLocation`) are legal inside it.

Portal precedent: `src/components/atoms/Modal.tsx` — `createPortal` to
`document.body`, Esc listener + body scroll lock in a `useEffect` (lines
25–37), scrim `zIndex: 1000` with `color-mix(in oklch, var(--ink) 45%,
transparent)` background, backdrop-click close via `e.target ===
e.currentTarget`. The drawer follows this pattern exactly.

## Design

### 1. `AppShell.tsx` changes

**Export `navGroups`** (line 5): `const navGroups` → `export const navGroups`.
`MobileNavDrawer` imports it from `"./AppShell"`. Yes, that is a module cycle
(AppShell imports MobileNavDrawer for rendering; MobileNavDrawer imports the
`navGroups` const). It is benign: `navGroups` is a top-of-module const,
initialized before either component's first render, and only *read* at render
time. Biome does not flag it. Add a one-line comment on the export noting
this. (Do NOT move `navGroups` to a new file — the sidebar and drawer must
provably render the same data, and one source file makes drift impossible.)

**New state + effects** inside `AppShell`:

```tsx
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { useBreakpoint } from "../../hooks/useMediaQuery";
import { MobileNavDrawer } from "./MobileNavDrawer";

const { isPhone, isNarrow } = useBreakpoint();
const { pathname } = useLocation();

// EPHEMERAL. Never persisted — a rotated tablet must not write a collapsed
// desktop pref. NEVER touch NAV_COLLAPSED_KEY from the drawer path.
const [drawerOpen, setDrawerOpen] = useState(false);

// Close on route change (drawer nav click → navigate → close).
useEffect(() => { setDrawerOpen(false); }, [pathname]);
// Close if the viewport widens past md while open (drawer branch unmounts;
// without this, re-narrowing would surprise-reopen it).
useEffect(() => { if (!isNarrow) setDrawerOpen(false); }, [isNarrow]);
```

The existing `collapsed` state, `toggle`, and both localStorage helpers are
**unchanged** — they simply live only in the desktop branch.

**Shared `<main>` style** (replaces line 167's literal; used by BOTH
branches so the CSS-var contract always holds):

```tsx
const padY = isPhone ? 12 : 24;                    // --shell-pad-y
const padX = isPhone ? 16 : 24;                    // phone: 16px horizontal
const mainStyle = {
  flex: 1,
  padding: `${padY}px ${padX}px`,
  overflow: "auto",
  "--shell-pad-y": `${padY}px`,
  "--appbar-h": isNarrow ? "48px" : "0px",
} as CSSProperties;                                 // cast: custom props aren't in CSSProperties
```

**Return shape** — two branches on `isNarrow`:

```tsx
if (isNarrow) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header
        style={{
          position: "sticky", top: 0, zIndex: 20,          // above page content, below drawer (1000)
          height: 48, flexShrink: 0,
          display: "flex", alignItems: "center", gap: 10,
          padding: "0 12px",
          background: "var(--fill)", borderBottom: "1px solid var(--border)",
        }}
      >
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          style={/* 32x32 hit target, borderless, inline-flex center, color var(--ink-2), cursor pointer */}
        >
          <Menu size={18} />
        </button>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.01em" }}>
          Agentic Patterns
        </span>
        <div style={{ marginLeft: "auto" }}><ThemeToggle /></div>
      </header>
      <MobileNavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <main style={mainStyle}>{children}</main>
    </div>
  );
}
// desktop: EXACTLY the existing JSX (lines 67-169), with <main style={mainStyle}>
return ( /* existing row-flex wrapper + <nav> unchanged */ );
```

Note: hooks (`useBreakpoint`, `useLocation`, both states, both effects) run
before the branch — no conditional hooks. The desktop `<nav>` JSX (lines
69–166) is copied verbatim; only `<main>`'s style literal changes.

### 2. New `MobileNavDrawer.tsx`

```tsx
/**
 * MobileNavDrawer — portalled left-anchored overlay nav for viewports below
 * md (900px — see ../../ui/breakpoints.ts). Reuses AppShell's navGroups so
 * sidebar and drawer can never drift. Follows the Modal atom's portal/Esc/
 * scroll-lock pattern (components/atoms/Modal.tsx).
 */
import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import { ThemeToggle } from "../ThemeToggle";   // OPTIONAL — see below; default OMIT
import { navGroups } from "./AppShell";

export function MobileNavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Esc + body scroll lock — Modal.tsx lines 25-37 pattern, gated on `open`.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prevOverflow; };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div /* scrim */
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1000,
               background: "color-mix(in oklch, var(--ink) 45%, transparent)" }}
    >
      <div /* panel */
        role="dialog" aria-modal="true" aria-label="Navigation" tabIndex={-1}
        style={{ position: "absolute", top: 0, left: 0, bottom: 0,
                 width: "min(280px, 85vw)",
                 display: "flex", flexDirection: "column",
                 background: "var(--fill)", borderRight: "1px solid var(--border)",
                 padding: "20px 0", overflowY: "auto",
                 animation: "apdash-drawer-in 160ms ease-out" }}
      >
        {/* header row: title + X button (aria-label="Close navigation") */}
        {/* nav groups: navGroups.map(...) — IDENTICAL markup/styles to the
            sidebar's group render (AppShell lines 127-160): heading div
            (11px uppercase var(--ink-3)) + NavLink items (8px 20px padding,
            active = var(--fill-2) bg + 2px var(--accent) left border).
            Each NavLink additionally gets onClick={onClose} — the route-change
            effect misses clicks on the CURRENT route (pathname unchanged). */}
      </div>
    </div>,
    document.body,
  );
}
```

The drawer contains **nav groups only** — ThemeToggle lives in the app bar
(per the F2 goal), so omit it from the drawer (drop the import shown above).
Biome will require the same two `biome-ignore` comments Modal.tsx carries
(`useKeyWithClickEvents` on the scrim, `useSemanticElements` on the dialog
div) — copy them with their justifications.

### 3. `globals.css` additions

Append after the `apdash-spin` keyframes (line 61-65):

```css
/* Drawer slide-in — used by components/templates/MobileNavDrawer.tsx. */
@keyframes apdash-drawer-in {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}

/* Phone-only (< sm = 640px — keep in sync with src/ui/breakpoints.ts):
   iOS Safari zooms the page when a focused form control's font-size is
   below 16px. Force >=16px so tapping inputs never triggers zoom. */
@media (max-width: 639px) {
  input, select, textarea { font-size: max(16px, 1em); }
}
```

## Numbered implementation steps

1. Confirm F1 is present: `src/ui/breakpoints.ts` exports `BREAKPOINTS` and
   `src/hooks/useMediaQuery.ts` exports `useBreakpoint`. If not, stop.
2. `AppShell.tsx`: add `export` to `navGroups` (line 5) with the benign-cycle
   comment.
3. `AppShell.tsx`: add imports (`CSSProperties`, `useEffect`, `useLocation`,
   `Menu` from lucide-react, `useBreakpoint`, `MobileNavDrawer`).
4. `AppShell.tsx`: add `drawerOpen` state + the two close effects (route
   change, `!isNarrow`); build `mainStyle` with the CSS-var contract values.
5. `AppShell.tsx`: wrap the existing return in the `isNarrow` branch per the
   pseudocode — desktop JSX untouched except `<main style={mainStyle}>`.
6. Create `MobileNavDrawer.tsx` per §2 (portal, scrim, panel, Esc, scroll
   lock, `onClose` on every NavLink, no localStorage anywhere).
7. Append the two `globals.css` blocks (§3).
8. Write `src/__tests__/AppShell.responsive.test.tsx` (below).
9. Run `bun run --filter=@pattern-stack/agentic-dashboard test`, `typecheck`,
   `lint` (biome: double quotes, 2-space, 100-char). Then repo `bun run check`.

## Test plan — `src/__tests__/AppShell.responsive.test.tsx`

Setup: render `<MemoryRouter><AppShell><div>page body</div></AppShell></MemoryRouter>`
(NavLink needs a router; use `initialEntries` where routes matter).
`afterEach`: cleanup + `localStorage.clear()` + delete any `matchMedia` stub.

Narrow-viewport helper (F1's hook is jsdom-safe → **no stub = desktop**):

```tsx
function stubMatchMedia(width: number) {
  window.matchMedia = (query: string) => {
    const max = query.match(/max-width:\s*(\d+(?:\.\d+)?)px/);
    const min = query.match(/min-width:\s*(\d+(?:\.\d+)?)px/);
    const matches = (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
    return { matches, media: query, addEventListener() {}, removeEventListener() {},
             addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList;
  };
}
```

(Adjust to match F1's actual query shape; if F1 ships its own test helper,
import that instead.)

Cases:

1. **Desktop default (no stub)** — sidebar renders: "Collapse navigation"
   button present; "Open navigation" absent; `<main>` style contains
   `--shell-pad-y: 24px` and `--appbar-h: 0px`.
2. **Desktop collapse unchanged** — click "Collapse navigation"; nav links
   disappear, `localStorage.getItem("apdash-nav-collapsed") === "1"`
   (guards the persistence path F2 must not break).
3. **Narrow (stub 800)** — "Open navigation" hamburger + "Agentic Patterns"
   app-bar title render; "Collapse navigation" absent; no
   `role="dialog"` yet; `<main>` has `--appbar-h: 48px`,
   `--shell-pad-y: 24px` (tablet keeps 24).
4. **Phone (stub 400)** — `<main>` has `--shell-pad-y: 12px`.
5. **Drawer opens/closes** — click hamburger → `role="dialog"`
   (`aria-label="Navigation"`) with a link for every `navGroups` item; click
   "Close navigation" → gone; reopen, click the scrim → gone.
6. **Esc closes** — open, `fireEvent.keyDown(document, { key: "Escape" })`,
   drawer gone.
7. **Route change closes** — `initialEntries: ["/tools"]`; open drawer, click
   the "Roles" link → drawer gone (and still gone after clicking the
   current-route link, via the NavLink `onClose`).
8. **Drawer never touches localStorage** —
   `const spy = vi.spyOn(Storage.prototype, "setItem")` before render (narrow);
   open + close drawer + Esc + route-change close; expect no call with
   `"apdash-nav-collapsed"` as the first arg.

## Out of scope

- Any change to desktop `<nav>` markup, the `apdash-nav-collapsed` key,
  or `readCollapsedPref`/`writeCollapsedPref`.
- Page-level responsive work (Wave 1 consumes the published vars; this spec
  only publishes them).
- Focus trapping inside the drawer (Modal.tsx doesn't trap either; keep
  parity — Esc + scrim + close button suffice for now).
- Swipe gestures / drawer close animation.

## Conventions checklist

- Strict TS (`noUncheckedIndexedAccess` etc.) — the `matchMedia` regex
  captures are `string | undefined`; guard before `Number(...)`.
- biome: double quotes, semicolons, 2-space indent, 100-char lines; carry
  over Modal.tsx's `biome-ignore` justifications verbatim.
- vitest + @testing-library/react, jsdom env (see `vitest.config.ts`).
- lucide-react icons only (`Menu`, `X`) — already a dependency (^1.21.0).
- No upward imports: templates → `../../hooks/`, `../../ui/`, `../ThemeToggle`
  only; `MobileNavDrawer` → `./AppShell` (same layer, documented benign cycle).
