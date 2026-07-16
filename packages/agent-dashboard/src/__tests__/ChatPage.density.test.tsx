/**
 * ChatPage scratchpad-density reveal (#226) — pins the flushSync contract the
 * [#N] cite seek depends on: parts.tsx's seekCite dispatches
 * `chat:reveal-state-frames` and then SYNCHRONOUSLY measures the minting
 * frame's rect, so ChatPage's listener must commit the Off→Writes flip before
 * dispatchEvent returns (React's automatic batching would otherwise render it
 * a frame later and the seek would measure a display:none frame — zero rect,
 * scroll to nowhere). jsdom has no layout, so the pin is on the DOM attribute
 * the CSS keys off, read at the exact moment seekCite would read the rect.
 */
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "../pages/ChatPage";

describe("ChatPage scratchpad density (#226)", () => {
  beforeEach(() => {
    // Every mount-time fetch (GET /agents, GET /admin/conversations) is happy
    // with an empty list — the density plumbing under test is data-free.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [],
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("commits the Off→Writes reveal synchronously during the dispatch (the seek measures right after)", async () => {
    const { container, getByRole } = render(<ChatPage />);
    // let the mount fetches settle inside act
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    const layout = container.querySelector<HTMLElement>("[data-density]");
    expect(layout).not.toBeNull();
    expect(layout?.getAttribute("data-density")).toBe("writes"); // the #226 default

    // The density control now lives in the header's ⚙ Settings menu — open it,
    // then flip to Off via the toggle.
    fireEvent.click(getByRole("button", { name: /Settings/ }));
    const toggle = getByRole("tablist", { name: "Scratchpad frame density" });
    fireEvent.click(within(toggle).getByRole("tab", { name: "Off" }));
    expect(layout?.getAttribute("data-density")).toBe("off");

    // seekCite reads the frame's rect synchronously after dispatchEvent
    // returns — capture the attribute at that exact moment.
    let densityWhenDispatchReturned: string | null = null;
    act(() => {
      layout?.dispatchEvent(new CustomEvent("chat:reveal-state-frames", { bubbles: true }));
      densityWhenDispatchReturned = layout?.getAttribute("data-density") ?? null;
    });
    expect(densityWhenDispatchReturned).toBe("writes");
  });

  it("leaves All alone on reveal — only Off is dishonest to seek under", async () => {
    const { container, getByRole } = render(<ChatPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const layout = container.querySelector<HTMLElement>("[data-density]");
    fireEvent.click(getByRole("button", { name: /Settings/ }));
    const toggle = getByRole("tablist", { name: "Scratchpad frame density" });
    fireEvent.click(within(toggle).getByRole("tab", { name: "All" }));
    expect(layout?.getAttribute("data-density")).toBe("all");
    act(() => {
      layout?.dispatchEvent(new CustomEvent("chat:reveal-state-frames", { bubbles: true }));
    });
    expect(layout?.getAttribute("data-density")).toBe("all");
  });
});
