/**
 * LivePage responsive — header row wrap on phone (W1-Live) + EventStream
 * expanded-payload containment. Desktop (jsdom default, no matchMedia stub)
 * must render unchanged so every existing LivePage test keeps passing.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { LivePage } from "../pages/LivePage";

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

  emit(name: string, data: unknown): void {
    for (const cb of this.listeners.get(name) ?? []) {
      cb({ data: JSON.stringify(data) });
    }
  }
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

describe("LivePage — responsive header", () => {
  it("wraps the header row on phone", () => {
    stubMatchMedia(true);
    render(<LivePage />);

    const heading = screen.getByText("Live Events");
    const headerRow = heading.parentElement?.parentElement as HTMLElement;
    expect(headerRow.style.flexWrap).toBe("wrap");
    expect(headerRow.style.rowGap).toBe("8px");
  });

  it("does not wrap the header row on desktop", () => {
    stubMatchMedia(false);
    render(<LivePage />);

    const heading = screen.getByText("Live Events");
    const headerRow = heading.parentElement?.parentElement as HTMLElement;
    expect(headerRow.style.flexWrap).toBeFalsy();
  });
});

describe("LivePage — EventStream expanded payload containment on phone", () => {
  it("reduces left indent and adds overflowWrap on phone", () => {
    stubMatchMedia(true);
    const { container } = render(<LivePage />);

    const source = FakeEventSource.instances[0];
    expect(source).toBeTruthy();

    const longToken = "x".repeat(500);
    act(() => {
      source?.emit("tool.start", { toolName: "search", token: longToken });
    });

    const rowButton = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(rowButton).toBeTruthy();
    fireEvent.click(rowButton);
    expect(rowButton.getAttribute("aria-expanded")).toBe("true");

    const pre = container.querySelector("pre") as HTMLPreElement;
    expect(pre).toBeTruthy();
    expect(pre.style.whiteSpace).toBe("pre-wrap");
    expect(pre.style.overflowWrap).toBe("anywhere");
    // jsdom serializes the 4-value shorthand down to 3 when left === right
    // (14px === 14px), so assert the longhand rather than the shorthand
    // string — no 40px left indent is the actual assertion under test.
    expect(pre.style.paddingLeft).toBe("14px");
    expect(pre.style.paddingTop).toBe("8px");
    expect(pre.style.paddingRight).toBe("14px");
    expect(pre.style.paddingBottom).toBe("12px");
  });
});
