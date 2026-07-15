/**
 * useChat's create-conversation de-duplication (#268 Gate 2.5 review note 6) —
 * two `send()` calls landing in the same synchronous frame (before React has
 * flushed the `streaming` state update either closure guard reads) must join
 * ONE in-flight `createConversation`, not fire a second real server-side
 * `instantiate` side effect for the same thread.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../useChat";

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("useChat double-send guard (#268)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("two same-frame sends fire exactly one createConversation and converge on the same conversationId", async () => {
    let createCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";

        if (url === "/conversations" && method === "POST") {
          createCalls += 1;
          return {
            ok: true,
            status: 201,
            statusText: "Created",
            json: async () => ({ id: `c${createCalls}`, agent_id: "a1" }),
          } as unknown as Response;
        }
        if (/^\/conversations\/[^/]+\/messages$/.test(url) && method === "POST") {
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

    const { result } = renderHook(() => useChat("a1"));

    // Both calls read `result.current.send` from the SAME pre-update render
    // (neither has awaited yet, so React hasn't re-rendered in between) — the
    // exact same-frame race the review flagged.
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = result.current.send("hello");
      p2 = result.current.send("world");
    });
    await act(async () => {
      await Promise.all([p1, p2]);
    });

    expect(createCalls).toBe(1);
    expect(result.current.conversationId).toBe("c1");
    // Both turns still landed (joined the shared conversation) — the guard
    // de-dupes the CREATE call, it doesn't drop either send.
    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(2);
  });
});
