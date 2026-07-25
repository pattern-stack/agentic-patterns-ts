/**
 * ChatPage responsive stack (W1-Chat): below the `md` (900px) breakpoint the
 * Console rail (Tools / Trace / Scratchpad) becomes a BottomSheet opened from
 * a header "Console" trigger instead of the always-visible side aside, and
 * the root wrapper's full-height calc consumes the F2 AppShell CSS-var
 * contract (`--appbar-h` / `--shell-pad-y`) instead of a hard-coded 48px.
 *
 * jsdom has no `matchMedia`, so per the F1 contract `useBreakpoint()` resolves
 * desktop by default — the four pre-existing ChatPage suites (density,
 * scopeChip, scopeForm, scratchpadTab) keep seeing today's side-rail tree
 * unmodified. This file stubs `matchMedia` (F1's `theme-mode.test.ts` /
 * `useMediaQuery.test.tsx` pattern) to exercise the narrow/sheet branches.
 */
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { ChatPage } from "../pages/ChatPage";

/** Stub `matchMedia`: `matchesFor` decides whether a given query string
 *  matches. Mirrors the F1 pattern (`useMediaQuery.test.tsx`). */
function stubViewport(matchesFor: (query: string) => boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: matchesFor(query),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

/** Only the `md` (899px) query matches — phone's `sm` (639px) query doesn't —
 *  i.e. "narrow but not phone", the band this item cares about. */
const NARROW = (q: string) => q === "(max-width: 899px)";

describe("ChatPage — responsive Console rail (W1-Chat)", () => {
  beforeEach(() => {
    __resetMediaQueryCacheForTests();
    // Every mount-time fetch (GET /agents, GET /admin/conversations) is happy
    // with an empty list — the rail/trigger plumbing under test is data-free.
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
    __resetMediaQueryCacheForTests();
    vi.restoreAllMocks();
  });

  it("desktop: no Console trigger; the rail tablist renders inline", async () => {
    stubViewport(() => false);
    const { queryByRole, getByRole } = render(<ChatPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(queryByRole("button", { name: "Open console" })).toBeNull();
    expect(getByRole("tablist", { name: "Side panel" })).toBeTruthy();
  });

  it("narrow default: sheet closed — trigger present, tab strip absent", async () => {
    stubViewport(NARROW);
    const { getByRole, queryByRole } = render(<ChatPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(getByRole("button", { name: "Open console" })).toBeTruthy();
    // Sheet closed renders null — no 22px collapsed reopen strip either.
    expect(queryByRole("tablist", { name: "Side panel" })).toBeNull();
  });

  it("trigger opens the sheet; closing it restores the closed state", async () => {
    stubViewport(NARROW);
    const { getByRole, queryByRole } = render(<ChatPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    fireEvent.click(getByRole("button", { name: "Open console" }));

    const tabs = getByRole("tablist", { name: "Side panel" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Tools", "Trace", "Scratchpad"]);

    // Switching tabs works inside the sheet.
    fireEvent.click(within(tabs).getByRole("tab", { name: "Trace" }));
    expect(within(tabs).getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    // BottomSheet's own close affordance (F3: aria-label="Close").
    fireEvent.click(getByRole("button", { name: "Close" }));

    expect(queryByRole("tablist", { name: "Side panel" })).toBeNull();
    expect(getByRole("button", { name: "Open console" })).toBeTruthy();
  });

  it("height contract: root wrapper consumes the F2 CSS-var contract", async () => {
    stubViewport(() => false);
    const { container } = render(<ChatPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    const root = container.firstElementChild as HTMLElement;
    expect(root.style.height).toContain("100dvh");
    expect(root.style.height).toContain("var(--appbar-h, 0px)");
    expect(root.style.height).toContain("var(--shell-pad-y, 24px)");
  });

  it("chat:seek-rail opens the sheet on the Scratchpad tab on narrow", async () => {
    stubViewport(NARROW);
    const { container, getByRole, queryByRole } = render(<ChatPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(queryByRole("tablist", { name: "Side panel" })).toBeNull();
    const layout = container.querySelector<HTMLElement>("[data-density]");
    expect(layout).not.toBeNull();

    act(() => {
      layout?.dispatchEvent(
        new CustomEvent("chat:seek-rail", {
          detail: { key: "brief.highlights" },
          bubbles: true,
        }),
      );
    });

    const tabs = getByRole("tablist", { name: "Side panel" });
    expect(
      within(tabs).getByRole("tab", { name: "Scratchpad" }).getAttribute("aria-selected"),
    ).toBe("true");
  });
});
