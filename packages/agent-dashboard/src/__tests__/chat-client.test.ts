import { describe, expect, it, vi } from "vitest";
import { streamMessage } from "../api/chat-client";
import type { ClientEvent } from "../api/sse-events";

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

async function collect(gen: AsyncGenerator<ClientEvent, void, void>): Promise<ClientEvent[]> {
  const out: ClientEvent[] = [];
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
    if (events[0]?.name === "message.delta") {
      expect(events[0].data.delta).toBe("ab");
    }
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

  it("ignores frames with unknown event names", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchWithChunks([
        "event: something.custom\ndata: {}\n\n",
        'event: message.delta\ndata: {"delta":"x","chunk_index":0}\n\n',
        "event: done\ndata: {}\n\n",
      ]),
    );

    const events = await collect(streamMessage("c1", "hi"));
    expect(events.map((e) => e.name)).toEqual(["message.delta", "done"]);

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
