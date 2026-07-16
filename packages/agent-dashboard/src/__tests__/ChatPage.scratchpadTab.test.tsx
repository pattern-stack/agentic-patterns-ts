/**
 * ChatPage Scratchpad rail tab (#226) — the side panel gains a third
 * Segmented tab (Tools | Trace | Scratchpad), and the `chat:seek-rail`
 * bridge (a Δ frame's `.d-key` click) flips the panel to the Scratchpad tab
 * synchronously — inside flushSync, so the rail is mounted before the
 * dispatching click handler returns and the row seek never lands on a
 * hidden rail.
 */
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "../pages/ChatPage";

describe("ChatPage Scratchpad tab (#226)", () => {
  beforeEach(() => {
    // Every mount-time fetch (GET /agents, GET /admin/conversations) is happy
    // with an empty list — the rail plumbing under test is data-free.
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

  it("offers Tools | Trace | Scratchpad; picking Scratchpad renders the teaching rail", async () => {
    const { container, getByRole } = render(<ChatPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    const tabs = getByRole("tablist", { name: "Side panel" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Tools", "Trace", "Scratchpad"]);

    fireEvent.click(within(tabs).getByRole("tab", { name: "Scratchpad" }));
    const rail = container.querySelector(".scratchpad-rail");
    expect(rail).not.toBeNull();
    expect(rail?.querySelector(".rail-head .t")?.textContent).toBe("Scratchpad");
    // No events yet — the teaching empty state, never a fabricated inventory.
    expect(rail?.querySelector(".rail-teach")?.textContent).toContain(
      "What this run carries between stages.",
    );
  });

  it("bridges chat:seek-rail: flips to the Scratchpad tab synchronously during the dispatch", async () => {
    const { container, getByRole } = render(<ChatPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(container.querySelector(".scratchpad-rail")).toBeNull(); // Tools tab
    const layout = container.querySelector<HTMLElement>("[data-density]");
    expect(layout).not.toBeNull();

    // The SlotKey click handler seeks the rail row right after dispatchEvent
    // returns — capture mount state at that exact moment (flushSync pin).
    let railMountedWhenDispatchReturned = false;
    act(() => {
      layout?.dispatchEvent(
        new CustomEvent("chat:seek-rail", {
          detail: { key: "brief.highlights" },
          bubbles: true,
        }),
      );
      railMountedWhenDispatchReturned = container.querySelector(".scratchpad-rail") != null;
    });
    expect(railMountedWhenDispatchReturned).toBe(true);

    const tabs = getByRole("tablist", { name: "Side panel" });
    expect(
      within(tabs).getByRole("tab", { name: "Scratchpad" }).getAttribute("aria-selected"),
    ).toBe("true");
  });
});
