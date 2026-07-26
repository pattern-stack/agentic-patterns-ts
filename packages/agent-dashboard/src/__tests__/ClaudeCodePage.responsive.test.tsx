/**
 * ClaudeCodePage responsive (W3-B) — header row wrap on phone. This page is a
 * structural twin of `LivePage.tsx` (title + connection badge on the left,
 * count badges + Clear button on the right) — Wave 1 fixed `LivePage.tsx`'s
 * identical header shape with an `isPhone`-gated `flexWrap: "wrap", rowGap: 8`
 * spread; this reproduces the exact same fix here. Desktop (jsdom default, no
 * matchMedia stub) must render unchanged.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { ClaudeCodePage } from "../pages/ClaudeCodePage";

/** Stubs `window.matchMedia` so `useBreakpoint` reports phone or desktop. */
function stubMatchMedia(phone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: phone && (query === "(max-width: 639px)" || query === "(max-width: 899px)"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  private readonly listeners = new Map<string, Array<(e: { data: string }) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, cb: (e: { data: string }) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(cb);
    this.listeners.set(name, list);
  }

  close(): void {
    this.closed = true;
  }
}

function stubRecentEventsFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ events: [] }),
    })),
  );
}

beforeEach(() => {
  __resetMediaQueryCacheForTests();
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  FakeEventSource.instances = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetMediaQueryCacheForTests();
});

describe("ClaudeCodePage — responsive header (W3-B)", () => {
  it("does not wrap the header row on desktop", async () => {
    stubMatchMedia(false);
    stubRecentEventsFetch();
    render(<ClaudeCodePage />);

    const heading = await screen.findByText("Claude Code Sessions");
    const headerRow = heading.parentElement?.parentElement as HTMLElement;
    expect(headerRow.style.flexWrap).toBeFalsy();
  });

  it("wraps the header row on phone", async () => {
    stubMatchMedia(true);
    stubRecentEventsFetch();
    render(<ClaudeCodePage />);

    const heading = await screen.findByText("Claude Code Sessions");
    const headerRow = heading.parentElement?.parentElement as HTMLElement;
    await waitFor(() => expect(headerRow.style.flexWrap).toBe("wrap"));
    expect(headerRow.style.rowGap).toBe("8px");
  });
});
