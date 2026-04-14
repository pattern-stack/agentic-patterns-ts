/**
 * Unit tests for the useChat hook's event-to-parts reducer.
 *
 * We don't drive the hook through React here — we call `send()` against
 * a stubbed fetch that yields a scripted SSE stream and assert the
 * resulting `messages[...].parts` shape. This covers the interleaving
 * rules (text-delta, thinking, tool calls, errors) without the overhead
 * of rendering.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../hooks/useChat";

const encoder = new TextEncoder();

interface MockResponses {
  "/conversations"?: { ok: boolean; json?: unknown };
  streamFrames?: string[];
}

function installFetchMock({
  "/conversations": convRes = { ok: true, json: { id: "c1", agent_id: "a1" } },
  streamFrames = [],
}: MockResponses = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/conversations") {
      return {
        ok: convRes.ok,
        status: convRes.ok ? 201 : 500,
        statusText: convRes.ok ? "Created" : "Internal Server Error",
        json: async () => convRes.json,
      } as unknown as Response;
    }
    // Streaming messages endpoint.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of streamFrames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const agent = { id: "a1", name: "Test", description: "t" } as const;

describe("useChat reducer", () => {
  beforeEach(() => {
    installFetchMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("accumulates message.delta into a single text part", async () => {
    installFetchMock({
      streamFrames: [
        'event: message.delta\ndata: {"delta":"Hello","chunk_index":0}\n\n',
        'event: message.delta\ndata: {"delta":" world","chunk_index":1}\n\n',
        "event: done\ndata: {}\n\n",
      ],
    });
    const { result } = renderHook(() => useChat(agent));
    await act(async () => {
      await result.current.send("hi");
    });
    const assistant = result.current.messages.find((m) => m.role === "assistant");
    expect(assistant?.parts).toEqual([{ kind: "text", content: "Hello world" }]);
  });

  it("interleaves text, tool calls, and thinking in arrival order", async () => {
    installFetchMock({
      streamFrames: [
        'event: thinking\ndata: {"content":"Let me think"}\n\n',
        'event: thinking.complete\ndata: {"content":"Let me think about this carefully"}\n\n',
        'event: message.delta\ndata: {"delta":"First","chunk_index":0}\n\n',
        'event: tool.start\ndata: {"tool_call_id":"t1","tool_name":"add","arguments":{"a":1,"b":2}}\n\n',
        'event: tool.end\ndata: {"tool_call_id":"t1","tool_name":"add","result":3,"duration_ms":5}\n\n',
        'event: message.delta\ndata: {"delta":"done","chunk_index":1}\n\n',
        "event: done\ndata: {}\n\n",
      ],
    });
    const { result } = renderHook(() => useChat(agent));
    await act(async () => {
      await result.current.send("hi");
    });
    const assistant = result.current.messages.find((m) => m.role === "assistant");
    expect(assistant?.parts).toEqual([
      { kind: "thinking", content: "Let me think about this carefully", complete: true },
      { kind: "text", content: "First" },
      {
        kind: "tool_call",
        id: "t1",
        name: "add",
        arguments: { a: 1, b: 2 },
        result: 3,
        durationMs: 5,
        error: undefined,
      },
      { kind: "text", content: "done" },
    ]);
  });

  it("captures model + token counts from message.complete", async () => {
    installFetchMock({
      streamFrames: [
        'event: message.delta\ndata: {"delta":"hi","chunk_index":0}\n\n',
        'event: message.complete\ndata: {"content":"hi","input_tokens":3,"output_tokens":1,"model":"sonnet"}\n\n',
        "event: done\ndata: {}\n\n",
      ],
    });
    const { result } = renderHook(() => useChat(agent));
    await act(async () => {
      await result.current.send("hi");
    });
    const assistant = result.current.messages.find((m) => m.role === "assistant");
    expect(assistant?.model).toBe("sonnet");
    expect(assistant?.inputTokens).toBe(3);
    expect(assistant?.outputTokens).toBe(1);
  });

  it("appends an error part on stream error event", async () => {
    installFetchMock({
      streamFrames: [
        'event: error\ndata: {"error_type":"rate_limit","message":"slow down","recoverable":false}\n\n',
        "event: done\ndata: {}\n\n",
      ],
    });
    const { result } = renderHook(() => useChat(agent));
    await act(async () => {
      await result.current.send("hi");
    });
    const assistant = result.current.messages.find((m) => m.role === "assistant");
    expect(assistant?.parts).toEqual([
      { kind: "error", errorType: "rate_limit", message: "slow down" },
    ]);
  });

  it("tracks exchangeCount from user messages", async () => {
    installFetchMock({
      streamFrames: ["event: done\ndata: {}\n\n"],
    });
    const { result } = renderHook(() => useChat(agent));
    expect(result.current.exchangeCount).toBe(0);
    await act(async () => {
      await result.current.send("one");
    });
    await waitFor(() => expect(result.current.exchangeCount).toBe(1));
    await act(async () => {
      await result.current.send("two");
    });
    await waitFor(() => expect(result.current.exchangeCount).toBe(2));
  });
});
