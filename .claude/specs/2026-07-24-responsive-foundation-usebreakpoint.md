# F1 — Responsive Foundation: Breakpoint Module + useMediaQuery/useBreakpoint Hooks

**Goal:** One shared, test-safe viewport primitive (`BREAKPOINTS` + `useMediaQuery` + `useBreakpoint`) that every downstream responsive item (F2, F3, Wave-1) imports — with a jsdom-safe fallback so the ~15 existing component test files stay green untouched.

**PR size estimate:** ~150 lines (2 new source files, 1 new test file, no existing files modified).

## 1. File Tree

```
packages/agent-dashboard/src/
├── ui/
│   └── breakpoints.ts                    # NEW — breakpoint constants + query builders
├── hooks/
│   └── useMediaQuery.ts                  # NEW — useMediaQuery + useBreakpoint
└── __tests__/
    └── useMediaQuery.test.tsx            # NEW — hook tests (renderHook pattern)
```

No existing file changes. Downstream items (F2/F3/Wave-1) do the importing; this PR only publishes the primitive.

## 2. Interfaces / Signatures (pseudocode)

### `packages/agent-dashboard/src/ui/breakpoints.ts`

```ts
/**
 * Dashboard viewport breakpoints (px). Single source of truth — components
 * and CSS-in-TS consumers derive max-width queries from these, never from
 * inline magic numbers.
 *   sm 640  — phone / not-phone boundary
 *   md 900  — narrow / desktop boundary
 *   lg 1200 — wide-desktop enhancements (reserved for Wave-1)
 */
export const BREAKPOINTS = { sm: 640, md: 900, lg: 1200 } as const;

export type BreakpointKey = keyof typeof BREAKPOINTS; // "sm" | "md" | "lg"

/** `"(max-width: 639px)"` — matches viewports STRICTLY BELOW the breakpoint. */
export function maxWidthQuery(key: BreakpointKey): string {
  return `(max-width: ${BREAKPOINTS[key] - 1}px)`;
}
```

`ui/breakpoints.ts` sits next to `ui/theme-mode.ts` / `ui/tokens.ts` (the existing
"design constants" home) and imports nothing — no upward imports possible.

### `packages/agent-dashboard/src/hooks/useMediaQuery.ts`

```ts
import { useSyncExternalStore } from "react";
import { maxWidthQuery } from "../ui/breakpoints";

// ---- module-level MediaQueryList cache -------------------------------------
// ONE MediaQueryList + ONE native "change" listener per unique query string,
// shared by every component instance subscribed to that query. React
// subscriber callbacks fan out from a per-query Set.
interface QueryEntry {
  mql: MediaQueryList;
  subscribers: Set<() => void>;   // React re-render callbacks
  // the single native listener: () => { for (cb of subscribers) cb(); }
}
const cache = new Map<string, QueryEntry>();

function getEntry(query: string): QueryEntry | null {
  // GUARD (critical for jsdom safety): if matchMedia is unusable, cache a
  // null sentinel so we never retry per render.
  //   if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  //   entry = cache.get(query) ?? create-and-cache:
  //     try { mql = window.matchMedia(query) } catch { return null }
  //     mql.addEventListener("change", notifyAll)   // attached ONCE, kept for module lifetime
}

/**
 * Reactive media-query match. Returns `false` when `window.matchMedia` is
 * unavailable or throws (jsdom default) — so `max-width` queries resolve to
 * "desktop" and existing component tests render the desktop layout unchanged.
 */
export function useMediaQuery(query: string): boolean {
  // subscribe/getSnapshot must be referentially stable per query — derive both
  // from the cached entry, NOT from per-render closures over new listeners.
  return useSyncExternalStore(
    (onStoreChange) => {
      const entry = getEntry(query);
      if (!entry) return () => {};              // no-op unsubscribe when unavailable
      entry.subscribers.add(onStoreChange);
      return () => entry.subscribers.delete(onStoreChange);
      // NOTE: the native mql listener is NOT removed on unsubscribe — the
      // entry lives in the module cache for the page lifetime (bounded: one
      // per unique query string; the dashboard uses 2–3).
    },
    () => getEntry(query)?.mql.matches ?? false, // getSnapshot — false when absent
    () => false,                                 // getServerSnapshot — SSR/test-safe
  );
}

export interface Breakpoint {
  isPhone: boolean;   // viewport < 640px
  isNarrow: boolean;  // viewport < 900px (includes phone)
  isDesktop: boolean; // viewport >= 900px
}

/** Semantic breakpoint flags derived from BREAKPOINTS. In jsdom (no
 *  matchMedia) both queries are false → { isPhone: false, isNarrow: false,
 *  isDesktop: true }: existing tests keep seeing the desktop layout. */
export function useBreakpoint(): Breakpoint {
  const isPhone = useMediaQuery(maxWidthQuery("sm"));   // "(max-width: 639px)"
  const isNarrow = useMediaQuery(maxWidthQuery("md"));  // "(max-width: 899px)"
  return { isPhone, isNarrow, isDesktop: !isNarrow };
}
```

Key wiring decisions, spelled out:

- **`useSyncExternalStore`, not `useState`+`useEffect`** — no first-frame flash of the
  wrong layout, no effect-ordering hazards, concurrent-render safe (React 19).
- **Module-level cache** — the `Map<string, QueryEntry>` and the single native
  `"change"` listener per query are module state, exactly like the
  `mediaListenerAttached` module flag in `ui/theme-mode.ts:144-161`. N mounted
  components subscribing to the same query share one `MediaQueryList`.
- **Availability guard** — `typeof window.matchMedia !== "function"` check plus
  `try/catch` around the `window.matchMedia(query)` call (mirrors the
  `prefersDarkOS()` try/catch at `ui/theme-mode.ts:78-84`, but resolving to
  `false`/desktop rather than theme-mode's default-dark bias). This is what keeps
  the ~15 existing jsdom component test files (e.g.
  `src/__tests__/DashboardPage.test.tsx`, `src/__tests__/ChatPage.*.test.tsx`)
  green without edits once downstream items adopt the hook.
- **`getServerSnapshot` returns `false`** — same "no viewport ⇒ desktop" contract
  in any non-DOM render path.

## 3. Implementation Steps

1. **Create `packages/agent-dashboard/src/ui/breakpoints.ts`** — `BREAKPOINTS`
   const (frozen via `as const`), `BreakpointKey` type, `maxWidthQuery(key)`
   helper. No imports. ~20 lines with doc comments.
2. **Create `packages/agent-dashboard/src/hooks/useMediaQuery.ts`**:
   a. Module cache `Map<string, QueryEntry>` + `getEntry(query)` with the
      unavailable-guard and single-native-listener attach.
   b. `useMediaQuery(query)` via `useSyncExternalStore` as sketched above.
      Keep `subscribe` stable: memoize per query (e.g. `useCallback` keyed on
      `query`, or store the subscribe fn on the cache entry — either is fine;
      the entry-stored fn is simpler and allocation-free).
   c. `Breakpoint` interface + `useBreakpoint()` composing two `useMediaQuery`
      calls with `maxWidthQuery("sm")` / `maxWidthQuery("md")`.
   d. For tests only, export an internal cache-reset helper
      `__resetMediaQueryCacheForTests(): void` (clears the Map) so stubbed
      `matchMedia` implementations don't leak between tests. Name it with the
      `__…ForTests` prefix and a doc comment; do not re-export from any barrel.
3. **Create `packages/agent-dashboard/src/__tests__/useMediaQuery.test.tsx`**
   per the test plan below.
4. **Verify no regression**:
   `bun run --filter=@agentic-patterns/dashboard test` (all existing suites),
   `bun run --filter=@agentic-patterns/dashboard typecheck`,
   `bun run --filter=@agentic-patterns/dashboard lint`.

Conventions: strict TS (`noUncheckedIndexedAccess` — note `cache.get()` returns
`T | undefined`, handle it), biome formatting (double quotes, 2-space indent,
100-col), ESM imports with no upward layer imports (`hooks/` → `ui/` only).

## 4. Test Plan — `src/__tests__/useMediaQuery.test.tsx`

Uses `renderHook`/`act` from `@testing-library/react` (established pattern:
`src/__tests__/useSortedRows.test.tsx`, `src/chat/__tests__/useChat.test.ts`)
and the matchMedia stubbing approach from
`src/__tests__/theme-mode.test.ts:17-27` (`vi.stubGlobal("matchMedia", vi.fn(...))`)
extended to capture `"change"` listeners so tests can fire them:

```ts
// Controllable stub — returns per-query fake MQLs and records their listeners
function stubMatchMedia(matchesFor: (query: string) => boolean) {
  const created: FakeMql[] = [];
  vi.stubGlobal("matchMedia", vi.fn((query: string) => {
    const mql = {
      matches: matchesFor(query), media: query,
      addEventListener: vi.fn((_, cb) => listeners.push(cb)),
      removeEventListener: vi.fn(),
    };
    created.push(mql);
    return mql;
  }));
  return created;
}
// beforeEach: __resetMediaQueryCacheForTests(); afterEach: vi.unstubAllGlobals()
```

Cases:

1. **jsdom-unavailable guard (the compat contract):**
   `vi.stubGlobal("matchMedia", undefined)` (as in `theme-mode.test.ts:58`) →
   `useMediaQuery("(max-width: 639px)")` returns `false`; `useBreakpoint()`
   returns `{ isPhone: false, isNarrow: false, isDesktop: true }`. Also: a
   `matchMedia` stub that **throws** → same result, no test crash.
2. **Initial match:** stub with `matchesFor = () => true` → `useMediaQuery`
   returns `true` on first render (no flash-of-false — `useSyncExternalStore`
   snapshot, not effect).
3. **Resize simulation:** render the hook, then inside `act()` flip the fake
   MQL's `matches` and invoke its captured `"change"` listener → hook re-renders
   with the new value. Flip back → value follows.
4. **Shared-listener assertion (the perf contract):** render THREE hook
   instances with the SAME query string (single `renderHook` whose callback
   calls `useMediaQuery(q)` three times, plus a second `renderHook` instance) →
   assert `window.matchMedia` was called **once** for that query and the fake
   MQL's `addEventListener` was called **once**. Then fire the one listener in
   `act()` → all instances update.
5. **Distinct queries are independent:** two different query strings → two
   `matchMedia` calls; firing one query's listener updates only its
   subscribers' values.
6. **`useBreakpoint` band mapping** (drive via `matchesFor` on the exact query
   strings `"(max-width: 639px)"` / `"(max-width: 899px)"`):
   - both match → `{ isPhone: true, isNarrow: true, isDesktop: false }` (phone)
   - only md matches → `{ isPhone: false, isNarrow: true, isDesktop: false }` (tablet)
   - neither → `{ isPhone: false, isNarrow: false, isDesktop: true }` (desktop)
7. **`maxWidthQuery` unit check:** `maxWidthQuery("sm") === "(max-width: 639px)"`,
   `maxWidthQuery("md") === "(max-width: 899px)"`, `maxWidthQuery("lg") === "(max-width: 1199px)"`.

Regression gate: full existing dashboard suite must pass unchanged
(`bun run --filter=@agentic-patterns/dashboard test`).

## 5. Contract Published to Downstream Items (F2 / F3 / Wave-1 depend on this — do not drift)

**Breakpoint values** (from `packages/agent-dashboard/src/ui/breakpoints.ts`):

```ts
export const BREAKPOINTS = { sm: 640, md: 900, lg: 1200 } as const;
```

**Hook signatures** (from `packages/agent-dashboard/src/hooks/useMediaQuery.ts`):

```ts
export function useMediaQuery(query: string): boolean;
export function useBreakpoint(): { isPhone: boolean; isNarrow: boolean; isDesktop: boolean };
```

Semantics downstream code may rely on:

- `isPhone` ⇔ viewport width < 640px; `isNarrow` ⇔ width < 900px (phone
  included); `isDesktop` ⇔ width >= 900px. Exactly one of
  phone / (narrow ∧ !phone) / desktop bands is active; `isNarrow || isDesktop`
  partitions all viewports.
- In any environment without a working `window.matchMedia` (jsdom, SSR),
  `useMediaQuery` returns `false` and `useBreakpoint()` returns
  `{ isPhone: false, isNarrow: false, isDesktop: true }` — desktop layout.
  Downstream components must therefore gate MOBILE variants on the flags
  (render mobile when `isNarrow`), never gate the desktop variant on a
  positive `min-width` match.
- One shared listener per unique query string — downstream items may call
  `useBreakpoint()` in as many components as they like at zero marginal
  listener cost.
- `maxWidthQuery(key)` is exported for any downstream item that needs a raw
  query string consistent with `BREAKPOINTS` (e.g. Wave-1 `lg` usage).
