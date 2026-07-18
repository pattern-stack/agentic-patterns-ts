import { describe, expect, it, vi } from "vitest";
import { createConversation, streamMessage } from "../api/chat-client";
import type { WireFrame } from "../api/sse-events";

/** Build a minimal fetch Response whose body streams the given chunks. */
function mockFetchWithChunks(chunks: string[]): typeof fetch {
  const encoder = new TextEncoder();
  return vi.fn(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: stream,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function collect(gen: AsyncGenerator<WireFrame, void, void>): Promise<WireFrame[]> {
  const out: WireFrame[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("streamMessage SSE parser", () => {
  it("parses a full conversation stream end-to-end", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchWithChunks([
        'event: conversation.start\ndata: {"conversation_id":"c1","agent_name":"math"}\n\n',
        'event: message.delta\ndata: {"delta":"Hello","chunk_index":0}\n\n',
        'event: message.delta\ndata: {"delta":" world","chunk_index":1}\n\n',
        'event: message.complete\ndata: {"content":"Hello world","input_tokens":1,"output_tokens":2,"model":"sonnet"}\n\n',
        'event: conversation.end\ndata: {"conversation_id":"c1","reason":"completed"}\n\n',
        "event: done\ndata: {}\n\n",
      ]),
    );

    const events = await collect(streamMessage("c1", "hi"));
    const names = events.map((e) => e.name);
    expect(names).toEqual([
      "conversation.start",
      "message.delta",
      "message.delta",
      "message.complete",
      "conversation.end",
      "done",
    ]);

    const complete = events.find((e) => e.name === "message.complete");
    expect(complete?.data).toMatchObject({
      content: "Hello world",
      model: "sonnet",
      input_tokens: 1,
      output_tokens: 2,
    });

    vi.unstubAllGlobals();
  });

  it("handles chunked frames split across reads", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchWithChunks([
        "event: message",
        '.delta\ndata: {"delta":"ab',
        '","chunk_index":0}\n',
        "\n",
        "event: done\ndata: {}\n\n",
      ]),
    );

    const events = await collect(streamMessage("c1", "hi"));
    expect(events[0]?.name).toBe("message.delta");
    expect(events[0]?.data.delta).toBe("ab");
    expect(events[events.length - 1]?.name).toBe("done");

    vi.unstubAllGlobals();
  });

  it("returns after `done` even if more data arrives", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchWithChunks([
        "event: done\ndata: {}\n\n",
        // trailing garbage — should be ignored
        "event: message.delta\ndata: {}\n\n",
      ]),
    );

    const events = await collect(streamMessage("c1", "hi"));
    expect(events).toEqual([{ name: "done", data: {} }]);

    vi.unstubAllGlobals();
  });

  it("passes unknown event names THROUGH — the reducer, not the parser, decides rendering", async () => {
    // Was previously "ignores unknown event names" — that allowlist behavior is
    // exactly what silently ate `agent.step.*`. The parser is now name-agnostic.
    vi.stubGlobal(
      "fetch",
      mockFetchWithChunks([
        "event: something.custom\ndata: {}\n\n",
        'event: message.delta\ndata: {"delta":"x","chunk_index":0}\n\n',
        "event: done\ndata: {}\n\n",
      ]),
    );

    const events = await collect(streamMessage("c1", "hi"));
    expect(events.map((e) => e.name)).toEqual(["something.custom", "message.delta", "done"]);

    vi.unstubAllGlobals();
  });

  it("does NOT drop agent.step.* frames (regression: pipeline steps must reach the chat)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchWithChunks([
        'event: step.start\ndata: {"span_id":"s1","step_name":"interpret","agent_name":"Interpreter","arguments":{"question":"hi"}}\n\n',
        'event: step.end\ndata: {"span_id":"s1","step_name":"interpret","result":{"requests":1},"duration_ms":12}\n\n',
        "event: done\ndata: {}\n\n",
      ]),
    );

    const events = await collect(streamMessage("c1", "hi"));
    expect(events.map((e) => e.name)).toEqual(["step.start", "step.end", "done"]);
    const start = events.find((e) => e.name === "step.start");
    expect(start?.data).toMatchObject({ step_name: "interpret", agent_name: "Interpreter" });

    vi.unstubAllGlobals();
  });

  it("throws on non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        body: null,
      })) as unknown as typeof fetch,
    );

    await expect(collect(streamMessage("unknown", "hi"))).rejects.toThrow(/404 Not Found/);

    vi.unstubAllGlobals();
  });
});

/** Build a minimal `fetch` mock that captures the request body and answers
 *  with the given JSON payload — the `createConversation` (#268) precedent
 *  to `mockFetchWithChunks` above, for the non-streaming create route. */
function mockJsonFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 201,
      statusText: opts.ok === false ? "Bad Request" : "Created",
      json: async () => body,
    } as unknown as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("createConversation (#268, #308)", () => {
  it("posts `scope` only when the caller provides one", async () => {
    const { fn, calls } = mockJsonFetch({ id: "c1", agent_id: "a1" });
    vi.stubGlobal("fetch", fn);

    await createConversation("a1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/conversations");
    expect(calls[0]?.body).toEqual({ agent_id: "a1" }); // no `scope` key at all

    vi.unstubAllGlobals();
  });

  it("posts the given scope object under the `context` body key (works against pre-#308 servers too) alongside agent_id", async () => {
    const { fn, calls } = mockJsonFetch({
      id: "c1",
      agent_id: "a1",
      context: { tenant: "acme" },
    });
    vi.stubGlobal("fetch", fn);

    const result = await createConversation("a1", { tenant: "acme" });

    expect(calls[0]?.body).toEqual({ agent_id: "a1", context: { tenant: "acme" } });
    // The RETURN VALUE is the server's echo — this is the chip's source of truth.
    expect(result.context).toEqual({ tenant: "acme" });

    vi.unstubAllGlobals();
  });

  it("surfaces the server's {error} body on failure instead of a bare status", async () => {
    const { fn } = mockJsonFetch(
      { error: "instantiate failed: dead tenant DB" },
      { ok: false, status: 502 },
    );
    vi.stubGlobal("fetch", fn);

    await expect(createConversation("a1", { tenant: "dead" })).rejects.toThrow(
      /instantiate failed: dead tenant DB/,
    );

    vi.unstubAllGlobals();
  });
});
