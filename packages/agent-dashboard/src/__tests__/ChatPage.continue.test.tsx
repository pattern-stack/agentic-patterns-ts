/**
 * ChatPage session continuation (#480) — a persisted conversation can be
 * pulled up and KEPT GOING, not just replayed read-only.
 *
 * The two doors:
 *   1. Sessions ▾ → a session (read-only replay) → "Continue" on the banner.
 *   2. `?continue=<id>` deep link (`continueConversationId` prop, threaded by
 *      `App.tsx`'s ChatRoute) — what the Conversations pages navigate to.
 *
 * Both must land on the SAME contract: the composer goes live with the
 * restored transcript above it, and the next send posts to
 * `POST /conversations/<stored id>/messages` — never `POST /conversations`
 * (which would fork a second, empty thread and lose the history the user just
 * pulled up: exactly the bug #480 reports).
 *
 * Fetch stubbing follows `ChatPage.scopeChip.test.tsx`'s router precedent,
 * extended with the two replay endpoints (`/conversations/:id/messages` GET +
 * `/messages/:id/parts`).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "../pages/ChatPage";

const STORED_ID = "conv-stored-1";

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

interface Calls {
  creates: number;
  posted: string[];
}

/** One agent, one stored session with a two-message transcript. The stored
 *  message ids are deliberately `m1`/`m2` — the SAME shape `useChat.nextId`
 *  mints — so a regression that lets a live turn reuse a restored message's
 *  key (React drops/duplicates the row) fails loudly here. */
function buildFetchRouter(calls: Calls): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url === "/agents" && method === "GET") {
      return jsonResponse([{ id: "a1", name: "Agent One", description: "" }]);
    }
    if (url.startsWith("/admin/conversations")) {
      return jsonResponse([
        {
          conversationId: STORED_ID,
          agentName: "Agent One",
          messageCount: 2,
          tokenCount: 12,
          startedAt: "2026-08-01T00:00:00Z",
          lastMessageAt: "2026-08-01T00:01:00Z",
          status: "completed",
        },
      ]);
    }
    if (url === "/conversations" && method === "POST") {
      calls.creates += 1;
      return jsonResponse({ id: "c-new", agent_id: "a1" }, 201);
    }
    if (url === `/conversations/${STORED_ID}/messages` && method === "GET") {
      return jsonResponse([
        {
          id: "m1",
          conversationId: STORED_ID,
          kind: "request",
          runId: null,
          inputTokens: 0,
          outputTokens: 0,
          content: null,
          metadata: null,
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
        },
        {
          id: "m2",
          conversationId: STORED_ID,
          kind: "response",
          runId: "run-1",
          inputTokens: 6,
          outputTokens: 6,
          content: null,
          metadata: null,
          createdAt: "2026-08-01T00:01:00Z",
          updatedAt: "2026-08-01T00:01:00Z",
        },
      ]);
    }
    if (url === "/messages/m1/parts") {
      return jsonResponse([
        {
          id: "p1",
          messageId: "m1",
          type: "user_prompt",
          content: "what did we decide?",
          metadata: null,
          position: 0,
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
        },
      ]);
    }
    if (url === "/messages/m2/parts") {
      return jsonResponse([
        {
          id: "p2",
          messageId: "m2",
          type: "text",
          content: "we shipped the gateway adapter",
          metadata: null,
          position: 0,
          createdAt: "2026-08-01T00:01:00Z",
          updatedAt: "2026-08-01T00:01:00Z",
        },
      ]);
    }
    const post = /^\/conversations\/([^/]+)\/messages$/.exec(url);
    if (post && method === "POST") {
      calls.posted.push(post[1] as string);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: sseBody([
          'event: text.delta\ndata: {"delta":"sure"}\n\n',
          "event: done\ndata: {}\n\n",
        ]),
      } as unknown as Response;
    }
    throw new Error(`unmocked fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe("ChatPage session continuation (#480)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("Sessions ▾ → Continue turns the read-only replay into the live thread, and sends post to the stored id", async () => {
    const calls: Calls = { creates: 0, posted: [] };
    vi.stubGlobal("fetch", buildFetchRouter(calls));

    const { getByRole, getByText, getByPlaceholderText, findByText, queryByRole } = render(
      <ChatPage />,
    );
    await waitFor(() => expect(getByRole("button", { name: /^Sessions \(1\)/ })).toBeTruthy());

    fireEvent.click(getByRole("button", { name: /^Sessions \(1\)/ }));
    fireEvent.click(getByText(STORED_ID.slice(0, 8)));

    // Replay first: read-only (no composer at all) with the restored transcript.
    await findByText("what did we decide?");
    expect(queryByRole("button", { name: "Send" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Continue" }));

    // Live now — transcript preserved, composer back, banner says so.
    const textarea = await waitFor(() =>
      getByPlaceholderText((text: string) => text.startsWith("Message Agent One")),
    );
    await findByText(/Continuing session/);
    expect(getByText("what did we decide?")).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "and what's next?" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    await waitFor(() => expect(calls.posted).toEqual([STORED_ID]));
    // The whole point of #480: no second conversation was forked.
    expect(calls.creates).toBe(0);
  });

  it("?continue=<id> (the deep link) restores the thread live on mount", async () => {
    const calls: Calls = { creates: 0, posted: [] };
    vi.stubGlobal("fetch", buildFetchRouter(calls));

    const { getByRole, getByPlaceholderText, findByText } = render(
      <ChatPage continueConversationId={STORED_ID} />,
    );

    await findByText("we shipped the gateway adapter");
    await findByText(/Continuing session/);

    const textarea = getByPlaceholderText((text: string) => text.startsWith("Message Agent One"));
    fireEvent.change(textarea, { target: { value: "keep going" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    await waitFor(() => expect(calls.posted).toEqual([STORED_ID]));
    expect(calls.creates).toBe(0);
  });

  it("New Chat leaves the continued thread — the next send creates a fresh conversation", async () => {
    const calls: Calls = { creates: 0, posted: [] };
    vi.stubGlobal("fetch", buildFetchRouter(calls));

    const { getByRole, getByPlaceholderText, findByText, queryByText } = render(
      <ChatPage continueConversationId={STORED_ID} />,
    );
    await findByText(/Continuing session/);

    fireEvent.click(getByRole("button", { name: "New Chat" }));
    await waitFor(() => expect(queryByText(/Continuing session/)).toBeNull());

    const textarea = getByPlaceholderText((text: string) => text.startsWith("Message Agent One"));
    fireEvent.change(textarea, { target: { value: "fresh start" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    await waitFor(() => expect(calls.creates).toBe(1));
    expect(calls.posted).toEqual(["c-new"]);
  });
});
