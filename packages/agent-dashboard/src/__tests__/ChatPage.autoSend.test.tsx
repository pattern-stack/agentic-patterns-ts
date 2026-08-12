/**
 * ChatPage quick-action auto-send — the `/actions` Run hand-off.
 *
 * The contract that matters is EXACTLY ONCE: a quick action spends real tokens,
 * so a re-render (or the prompt prop simply staying put) must never fire a
 * second run. The other half of that guarantee lives in `App.tsx`'s ChatRoute,
 * which burns the router state on arrival so a refresh/Back can't re-deliver
 * the prompt at all — here we prove the page-level half.
 *
 * Fetch stubbing follows `ChatPage.scopeChip.test.tsx`'s router precedent.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "../pages/ChatPage";

const PROMPT = "Run the morning brief.";

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

interface Calls {
  creates: number;
  sent: string[];
}

function stubFetch(calls: Calls) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === "/agents" && method === "GET") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [{ id: "a1", name: "Agent One", description: "" }],
        } as unknown as Response;
      }
      if (url.startsWith("/admin/conversations")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [],
        } as unknown as Response;
      }
      if (url === "/conversations" && method === "POST") {
        calls.creates += 1;
        return {
          ok: true,
          status: 201,
          statusText: "Created",
          json: async () => ({ id: `c${calls.creates}`, agent_id: "a1" }),
        } as unknown as Response;
      }
      if (/^\/conversations\/[^/]+\/messages$/.test(url) && method === "POST") {
        calls.sent.push(JSON.parse(String(init?.body)).content);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: sseBody(["event: done\ndata: {}\n\n"]),
        } as unknown as Response;
      }
      throw new Error(`unmocked fetch: ${method} ${url}`);
    }),
  );
}

describe("ChatPage quick-action auto-send", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the prompt once as the first message of a NEW conversation, and re-renders never re-fire it", async () => {
    const calls: Calls = { creates: 0, sent: [] };
    stubFetch(calls);

    const { rerender, findByText } = render(<ChatPage autoSendPrompt={PROMPT} />);

    await waitFor(() => expect(calls.sent).toEqual([PROMPT]));
    // Ordinary create-on-first-send path — exactly one conversation created.
    expect(calls.creates).toBe(1);
    // The prompt shows up as the user's own message in the transcript.
    expect(await findByText(PROMPT)).toBeTruthy();

    // Same prop, several more renders: still one run.
    rerender(<ChatPage autoSendPrompt={PROMPT} />);
    rerender(<ChatPage autoSendPrompt={PROMPT} />);
    await waitFor(() => expect(calls.sent).toEqual([PROMPT]));
    expect(calls.creates).toBe(1);
  });

  it("does nothing without a prompt — the composer is just a normal empty chat", async () => {
    const calls: Calls = { creates: 0, sent: [] };
    stubFetch(calls);

    const { getByPlaceholderText } = render(<ChatPage />);
    await waitFor(() =>
      expect(getByPlaceholderText((t: string) => t.startsWith("Message Agent One"))).toBeTruthy(),
    );

    expect(calls.creates).toBe(0);
    expect(calls.sent).toEqual([]);
  });

  it("a later hand-off of a DIFFERENT prompt starts a fresh conversation rather than appending", async () => {
    const calls: Calls = { creates: 0, sent: [] };
    stubFetch(calls);

    const { rerender } = render(<ChatPage autoSendPrompt={PROMPT} />);
    await waitFor(() => expect(calls.sent).toEqual([PROMPT]));

    rerender(<ChatPage autoSendPrompt="Second action" />);
    await waitFor(() => expect(calls.sent).toEqual([PROMPT, "Second action"]));
    // A second conversation — actions promise a fresh run, not an append.
    expect(calls.creates).toBe(2);
  });

  it("a typed follow-up after the auto-sent action stays in the SAME conversation", async () => {
    const calls: Calls = { creates: 0, sent: [] };
    stubFetch(calls);

    const { getByRole, getByPlaceholderText } = render(<ChatPage autoSendPrompt={PROMPT} />);
    await waitFor(() => expect(calls.sent).toEqual([PROMPT]));

    const textarea = getByPlaceholderText((t: string) => t.startsWith("Message Agent One"));
    fireEvent.change(textarea, { target: { value: "and the second half?" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    await waitFor(() => expect(calls.sent).toEqual([PROMPT, "and the second half?"]));
    expect(calls.creates).toBe(1);
  });
});
