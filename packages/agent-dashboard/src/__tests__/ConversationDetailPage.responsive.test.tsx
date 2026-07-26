/**
 * ConversationDetailPage responsive (W3-B) — content containment.
 *
 * 1. The error banner wraps long unbroken tokens (`overflowWrap: "anywhere"`).
 * 2. The assistant Markdown branch is wrapped in a locally-scrolling,
 *    flex-safe container (`minWidth: 0, overflowX: "auto"`) — `Markdown`'s own
 *    `.md-pre` fenced-code-block output has no CSS anywhere in the repo
 *    outside `chat.css` (not loaded on this page), so an unbroken code line
 *    would otherwise blow out the page.
 * 3. The user-text branch keeps its `whiteSpace: "pre-wrap"` and gains
 *    `overflowWrap: "anywhere"` alongside it.
 *
 * Fetch stubbing follows the sequential-dependent-fetch precedent this page
 * itself established (see `EvalRunDetailPage.test.tsx`'s header comment) —
 * route by URL substring across the three calls
 * (`/conversations/:id`, `/conversations/:id/messages`, `/messages/:id/parts`).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationMessagePart,
} from "../api/types";
import { ConversationDetailPage } from "../pages/ConversationDetailPage";

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

const longToken = "x".repeat(300);

const detail: ConversationDetail = {
  id: "c1",
  agentConfigId: null,
  status: "error",
  agentName: "retrieval-analyst",
  model: "claude-sonnet",
  tokenCount: 100,
  messageCount: 2,
  startedAt: "2026-07-20T00:00:00Z",
  completedAt: null,
  error: `Error: unhandled rejection at ${longToken}`,
  createdAt: "2026-07-20T00:00:00Z",
  updatedAt: "2026-07-20T00:00:00Z",
};

const messages: ConversationMessage[] = [
  {
    id: "m-user",
    conversationId: "c1",
    kind: "request",
    runId: null,
    inputTokens: 0,
    outputTokens: 0,
    content: null,
    metadata: null,
    createdAt: "2026-07-20T00:00:00Z",
    updatedAt: "2026-07-20T00:00:00Z",
  },
  {
    id: "m-assistant",
    conversationId: "c1",
    kind: "response",
    runId: null,
    inputTokens: 5,
    outputTokens: 5,
    content: null,
    metadata: null,
    createdAt: "2026-07-20T00:01:00Z",
    updatedAt: "2026-07-20T00:01:00Z",
  },
];

const partsByMessage: Record<string, ConversationMessagePart[]> = {
  "m-user": [
    {
      id: "p-user",
      messageId: "m-user",
      type: "user_prompt",
      content: `check this path: /${longToken}`,
      metadata: null,
      position: 0,
      createdAt: "2026-07-20T00:00:00Z",
      updatedAt: "2026-07-20T00:00:00Z",
    },
  ],
  "m-assistant": [
    {
      id: "p-assistant",
      messageId: "m-assistant",
      type: "text",
      content: `here is some code:\n\`\`\`\n${longToken}\n\`\`\``,
      metadata: null,
      position: 0,
      createdAt: "2026-07-20T00:01:00Z",
      updatedAt: "2026-07-20T00:01:00Z",
    },
  ],
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const partsMatch = url.match(/\/messages\/([^/]+)\/parts/);
      if (partsMatch) {
        const messageId = partsMatch[1] as string;
        return mkFetchResponse(200, partsByMessage[messageId] ?? []);
      }
      if (url.includes("/conversations/c1/messages")) {
        return mkFetchResponse(200, messages);
      }
      if (url.includes("/conversations/c1")) {
        return mkFetchResponse(200, detail);
      }
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/conversations/c1"]}>
      <Routes>
        <Route path="/conversations/:id" element={<ConversationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ConversationDetailPage — responsive containment (W3-B)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("error banner wraps long unbroken tokens", async () => {
    stubFetch();
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveStyle({ overflowWrap: "anywhere" });
  });

  it("assistant markdown is wrapped in a contained, scrollable box", async () => {
    stubFetch();
    const { container } = renderPage();

    await waitFor(() => expect(container.querySelector(".answer.md")).toBeTruthy());
    const markdownRoot = container.querySelector(".answer.md") as HTMLElement;
    const wrapper = markdownRoot.parentElement as HTMLElement;
    expect(wrapper).toHaveStyle({ minWidth: 0, overflowX: "auto" });
  });

  it("user text keeps pre-wrap and gains overflowWrap", async () => {
    stubFetch();
    renderPage();

    const userText = await screen.findByText(new RegExp(`check this path: /${longToken}`));
    expect(userText).toHaveStyle({ whiteSpace: "pre-wrap", overflowWrap: "anywhere" });
  });
});
