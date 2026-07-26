/**
 * ToolsPage responsive (W2-Tools) — column priority on the `/admin/tools`
 * DataTable. Desktop (jsdom default, no matchMedia stub) must render every
 * column unchanged; phone drops the low-priority `Errors` (hideBelow: "sm")
 * and `Avg Duration` (hideBelow: "md") columns per the eval-pages precedent.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolAnalytics } from "../api/types";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { ToolsPage } from "../pages/ToolsPage";

/**
 * Stubs `window.matchMedia` so `useBreakpoint` reports a phone viewport
 * (isPhone AND isNarrow true) — pattern mirrors
 * `src/__tests__/EvalCaseDetailPage.test.tsx`'s `stubPhone()`.
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

const rows: ToolAnalytics[] = [
  {
    toolName: "slugify",
    totalCalls: 42,
    totalErrors: 2,
    totalDurationMs: 4200,
    avgDurationMs: 100,
    agentBreakdown: [],
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

describe("ToolsPage — responsive (W2-Tools)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetMediaQueryCacheForTests();
  });

  it("desktop: all 5 columns render, including Errors and Avg Duration", async () => {
    stubFetch();
    render(<ToolsPage />);

    await waitFor(() => screen.getByText("slugify"));
    expect(screen.getByText("Calls")).toBeTruthy();
    expect(screen.getByText("Errors")).toBeTruthy();
    expect(screen.getByText("Health")).toBeTruthy();
    expect(screen.getByText("Avg Duration")).toBeTruthy();
  });

  it("phone: Errors and Avg Duration drop, identity + core metrics stay", async () => {
    stubPhone();
    stubFetch();
    render(<ToolsPage />);

    await waitFor(() => screen.getByText("slugify"));
    expect(screen.getByText("Calls")).toBeTruthy();
    expect(screen.getByText("Health")).toBeTruthy();
    expect(screen.queryByText("Errors")).toBeNull();
    expect(screen.queryByText("Avg Duration")).toBeNull();
  });
});
