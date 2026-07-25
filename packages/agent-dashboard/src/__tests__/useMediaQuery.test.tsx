import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMediaQueryCacheForTests,
  useBreakpoint,
  useMediaQuery,
} from "../hooks/useMediaQuery";
import { maxWidthQuery } from "../ui/breakpoints";

interface FakeMql {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: Array<() => void>;
}

/** Controllable matchMedia stub — returns per-query fake MQLs, records their
 *  "change" listeners so tests can fire them, and exposes the created list. */
function stubMatchMedia(matchesFor: (query: string) => boolean) {
  const created: FakeMql[] = [];
  const mm = vi.fn((query: string) => {
    const mql: FakeMql = {
      matches: matchesFor(query),
      media: query,
      listeners: [],
      addEventListener: vi.fn((_: string, cb: () => void) => {
        mql.listeners.push(cb);
      }),
      removeEventListener: vi.fn(),
    };
    created.push(mql);
    return mql as unknown as MediaQueryList;
  });
  vi.stubGlobal("matchMedia", mm);
  return { created, mm };
}

function fire(mql: FakeMql, matches: boolean) {
  mql.matches = matches;
  act(() => {
    for (const cb of mql.listeners) {
      cb();
    }
  });
}

beforeEach(() => {
  __resetMediaQueryCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMediaQueryCacheForTests();
});

describe("useMediaQuery — jsdom-unavailable guard", () => {
  it("returns false when matchMedia is undefined", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useMediaQuery("(max-width: 639px)"));
    expect(result.current).toBe(false);
  });

  it("returns desktop breakpoints when matchMedia is undefined", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toEqual({ isPhone: false, isNarrow: false, isDesktop: true });
  });

  it("returns false (no crash) when matchMedia throws", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => {
        throw new Error("boom");
      }),
    );
    const { result } = renderHook(() => useMediaQuery("(max-width: 639px)"));
    expect(result.current).toBe(false);
  });
});

describe("useMediaQuery — reactive behavior", () => {
  it("reflects the initial match on first render (no flash-of-false)", () => {
    stubMatchMedia(() => true);
    const { result } = renderHook(() => useMediaQuery("(max-width: 639px)"));
    expect(result.current).toBe(true);
  });

  it("updates when the media query list fires a change", () => {
    const { created } = stubMatchMedia(() => false);
    const { result } = renderHook(() => useMediaQuery("(max-width: 639px)"));
    expect(result.current).toBe(false);
    const mql = created[0];
    expect(mql).toBeDefined();
    if (!mql) return;
    fire(mql, true);
    expect(result.current).toBe(true);
    fire(mql, false);
    expect(result.current).toBe(false);
  });

  it("shares one MediaQueryList + one listener across instances of the same query", () => {
    const query = "(max-width: 639px)";
    const { created, mm } = stubMatchMedia(() => false);
    const { result: a } = renderHook(() => useMediaQuery(query));
    const { result: b } = renderHook(() => useMediaQuery(query));
    // one matchMedia call for the shared query, one native listener attached
    expect(mm).toHaveBeenCalledTimes(1);
    const mql = created[0];
    expect(mql).toBeDefined();
    if (!mql) return;
    expect(mql.addEventListener).toHaveBeenCalledTimes(1);
    fire(mql, true);
    expect(a.current).toBe(true);
    expect(b.current).toBe(true);
  });

  it("keeps distinct queries independent", () => {
    const { created, mm } = stubMatchMedia(() => false);
    const { result: phone } = renderHook(() => useMediaQuery("(max-width: 639px)"));
    const { result: narrow } = renderHook(() => useMediaQuery("(max-width: 899px)"));
    expect(mm).toHaveBeenCalledTimes(2);
    const narrowMql = created.find((m) => m.media === "(max-width: 899px)");
    expect(narrowMql).toBeDefined();
    if (!narrowMql) return;
    fire(narrowMql, true);
    expect(narrow.current).toBe(true);
    expect(phone.current).toBe(false);
  });
});

describe("useBreakpoint — band mapping", () => {
  it("maps phone (both queries match)", () => {
    stubMatchMedia(() => true);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toEqual({ isPhone: true, isNarrow: true, isDesktop: false });
  });

  it("maps tablet (only md matches)", () => {
    stubMatchMedia((q) => q === "(max-width: 899px)");
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toEqual({ isPhone: false, isNarrow: true, isDesktop: false });
  });

  it("maps desktop (neither matches)", () => {
    stubMatchMedia(() => false);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toEqual({ isPhone: false, isNarrow: false, isDesktop: true });
  });
});

describe("maxWidthQuery", () => {
  it("builds strict below-breakpoint queries", () => {
    expect(maxWidthQuery("sm")).toBe("(max-width: 639px)");
    expect(maxWidthQuery("md")).toBe("(max-width: 899px)");
    expect(maxWidthQuery("lg")).toBe("(max-width: 1199px)");
  });
});
