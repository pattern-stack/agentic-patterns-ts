import { useCallback, useSyncExternalStore } from "react";
import { maxWidthQuery } from "../ui/breakpoints";

// ---- module-level MediaQueryList cache -------------------------------------
// ONE MediaQueryList + ONE native "change" listener per unique query string,
// shared by every component instance subscribed to that query. React
// subscriber callbacks fan out from a per-query Set. This mirrors the
// module-level listener state in `ui/theme-mode.ts`.
interface QueryEntry {
  mql: MediaQueryList;
  subscribers: Set<() => void>;
}

const cache = new Map<string, QueryEntry>();

/**
 * Return the cached entry for `query`, creating it on first use. Returns `null`
 * when `window.matchMedia` is unavailable or throws (jsdom / SSR) — callers then
 * resolve to `false` (desktop), keeping existing component tests green.
 */
function getEntry(query: string): QueryEntry | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  const existing = cache.get(query);
  if (existing) {
    return existing;
  }
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia(query);
  } catch {
    return null;
  }
  const entry: QueryEntry = { mql, subscribers: new Set() };
  // Attached ONCE and kept for the module lifetime (bounded: one per unique
  // query string; the dashboard uses a small handful).
  mql.addEventListener("change", () => {
    for (const cb of entry.subscribers) {
      cb();
    }
  });
  cache.set(query, entry);
  return entry;
}

/**
 * Reactive media-query match. Returns `false` when `window.matchMedia` is
 * unavailable or throws (jsdom default) — so `max-width` queries resolve to
 * "desktop" and existing component tests render the desktop layout unchanged.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const entry = getEntry(query);
      if (!entry) {
        return () => {};
      }
      entry.subscribers.add(onStoreChange);
      return () => {
        entry.subscribers.delete(onStoreChange);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(() => getEntry(query)?.mql.matches ?? false, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export interface Breakpoint {
  isPhone: boolean; // viewport < 640px
  isNarrow: boolean; // viewport < 900px (includes phone)
  isDesktop: boolean; // viewport >= 900px
}

/**
 * Semantic breakpoint flags derived from `BREAKPOINTS`. In jsdom (no
 * `matchMedia`) both queries are false → `{ isPhone: false, isNarrow: false,
 * isDesktop: true }`: existing tests keep seeing the desktop layout.
 */
export function useBreakpoint(): Breakpoint {
  const isPhone = useMediaQuery(maxWidthQuery("sm")); // "(max-width: 639px)"
  const isNarrow = useMediaQuery(maxWidthQuery("md")); // "(max-width: 899px)"
  return { isPhone, isNarrow, isDesktop: !isNarrow };
}

/**
 * Test-only: clears the module media-query cache so stubbed `matchMedia`
 * implementations don't leak between tests. Not re-exported from any barrel.
 */
export function __resetMediaQueryCacheForTests(): void {
  cache.clear();
}
