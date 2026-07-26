/**
 * TokensPage responsive (W3-A) — column priority on the `/admin/tokens`
 * DataTable. Desktop (jsdom default, no matchMedia stub) must render every
 * column unchanged; phone drops the droppable `Input Tokens`/`Output Tokens`
 * breakdown (both `hideBelow: "sm"`) while identity (`key`), the headline
 * `Total`, and `Conversations` stay — same pattern as
 * `ToolsPage.responsive.test.tsx`.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenUsageGroup } from "../api/types";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { TokensPage } from "../pages/TokensPage";

/**
 * Stubs `window.matchMedia` so `useBreakpoint` reports a phone viewport
 * (isPhone AND isNarrow true) — pattern mirrors
 * `src/__tests__/ToolsPage.responsive.test.tsx`'s `stubPhone()`.
 */
function stubPhone() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /max-width:\s*(639|899)px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

const rows: TokenUsageGroup[] = [
  {
    key: "agent-1",
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    conversationCount: 4,
  },
];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => rows,
    })),
  );
}

describe("TokensPage — responsive (W3-A)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetMediaQueryCacheForTests();
  });

  it("desktop: all 5 columns render, including Input/Output Tokens", async () => {
    stubFetch();
    render(<TokensPage />);

    await waitFor(() => screen.getByText("agent-1"));
    expect(screen.getByText("Input Tokens")).toBeTruthy();
    expect(screen.getByText("Output Tokens")).toBeTruthy();
    expect(screen.getByText("Total")).toBeTruthy();
    expect(screen.getByText("Conversations")).toBeTruthy();
  });

  it("phone: Input/Output Tokens drop, identity + Total + Conversations stay", async () => {
    stubPhone();
    stubFetch();
    render(<TokensPage />);

    await waitFor(() => screen.getByText("agent-1"));
    expect(screen.getByText("Total")).toBeTruthy();
    expect(screen.getByText("Conversations")).toBeTruthy();
    expect(screen.queryByText("Input Tokens")).toBeNull();
    expect(screen.queryByText("Output Tokens")).toBeNull();
  });
});
