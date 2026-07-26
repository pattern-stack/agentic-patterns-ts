/**
 * ConversationsPage responsive (W3-B) — column priority on the
 * `/admin/conversations` DataTable. Desktop (jsdom default, no matchMedia
 * stub) renders all 7 columns unchanged; phone drops the low-priority
 * `Messages` (hideBelow: "sm"), `Tokens` and `Started` (hideBelow: "md")
 * columns per the eval-pages / ToolsPage precedent.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../api/types";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { ConversationsPage } from "../pages/ConversationsPage";

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

const rows: ConversationSummary[] = [
  {
    conversationId: "11111111-1111-1111-1111-111111111111",
    agentName: "retrieval-analyst",
    messageCount: 4,
    tokenCount: 1234,
    startedAt: "2026-07-20T00:00:00Z",
    lastMessageAt: "2026-07-20T00:05:00Z",
    status: "completed",
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/conversations"]}>
      <ConversationsPage />
    </MemoryRouter>,
  );
}

describe("ConversationsPage — responsive (W3-B)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetMediaQueryCacheForTests();
  });

  it("desktop: all 7 columns render, including Messages, Tokens, and Started", async () => {
    stubFetch();
    renderPage();

    await waitFor(() => screen.getByText("retrieval-analyst"));
    expect(screen.getByText("Conversation")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Messages")).toBeTruthy();
    expect(screen.getByText("Tokens")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    // "Started" is the default sort column, so its header cell also renders a
    // " ▼" sort-direction marker in the same element — match by prefix.
    expect(screen.getByText(/^Started/)).toBeTruthy();
    expect(screen.getByText("Last Message")).toBeTruthy();
  });

  it("phone: Messages, Tokens, and Started drop; identity/status/recency stay", async () => {
    stubPhone();
    stubFetch();
    renderPage();

    await waitFor(() => screen.getByText("retrieval-analyst"));
    expect(screen.getByText("Conversation")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    // The recency column survives but its header shortens to "Last" — the full
    // "Last Message" label was the widest remaining header and pushed the table
    // past a 390px viewport (verified against a real 390px capture).
    expect(screen.getByText("Last")).toBeTruthy();
    expect(screen.queryByText("Last Message")).toBeNull();
    expect(screen.queryByText("Messages")).toBeNull();
    expect(screen.queryByText("Tokens")).toBeNull();
    expect(screen.queryByText(/^Started/)).toBeNull();
  });
});
