import { describe, expect, it } from "vitest";
import { createEvent } from "../../events/types.js";
import { SSE_EVENT_NAMES, formatSSE } from "../../transport/sse-formatter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseFields = {
  traceId: "trace-1",
  runId: "run-1",
} as const;

function parseSSE(result: string): { event: string; data: Record<string, unknown> } {
  const lines = result.split("\n");
  const eventLine = lines[0]!;
  const dataLine = lines[1]!;
  return {
    event: eventLine.replace("event: ", ""),
    data: JSON.parse(dataLine.replace("data: ", "")) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// SSE_EVENT_NAMES
// ---------------------------------------------------------------------------

describe("SSE_EVENT_NAMES", () => {
  it("maps all expected event types", () => {
    expect(SSE_EVENT_NAMES["agent.message.chunk"]).toBe("message.delta");
    expect(SSE_EVENT_NAMES["agent.message.complete"]).toBe("message.complete");
    expect(SSE_EVENT_NAMES["agent.reasoning"]).toBe("thinking");
    expect(SSE_EVENT_NAMES["agent.tool.start"]).toBe("tool.start");
    expect(SSE_EVENT_NAMES["agent.tool.end"]).toBe("tool.end");
    expect(SSE_EVENT_NAMES["agent.tool.rejected"]).toBe("tool.rejected");
    expect(SSE_EVENT_NAMES["agent.error"]).toBe("error");
  });

  it("has exactly 7 mappings", () => {
    expect(Object.keys(SSE_EVENT_NAMES)).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// formatSSE — mapped events
// ---------------------------------------------------------------------------

describe("formatSSE", () => {
  it("formats message.chunk as message.delta", () => {
    const event = createEvent("agent.message.chunk", {
      ...baseFields,
      delta: "hello",
      chunkIndex: 0,
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name, data } = parseSSE(result!);
    expect(name).toBe("message.delta");
    expect(data.delta).toBe("hello");
    expect(data.chunkIndex).toBe(0);
    expect(data.traceId).toBe("trace-1");
    expect(data.timestamp).toBeDefined();
  });

  it("formats message.complete", () => {
    const event = createEvent("agent.message.complete", {
      ...baseFields,
      content: "done",
      inputTokens: 100,
      outputTokens: 50,
      model: "gpt-4",
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name, data } = parseSSE(result!);
    expect(name).toBe("message.complete");
    expect(data.content).toBe("done");
    expect(data.inputTokens).toBe(100);
    expect(data.outputTokens).toBe(50);
    expect(data.model).toBe("gpt-4");
  });

  it("formats reasoning as thinking", () => {
    const event = createEvent("agent.reasoning", {
      ...baseFields,
      content: "thinking...",
      isComplete: false,
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name, data } = parseSSE(result!);
    expect(name).toBe("thinking");
    expect(data.content).toBe("thinking...");
    expect(data.isComplete).toBe(false);
  });

  it("formats tool.start", () => {
    const event = createEvent("agent.tool.start", {
      ...baseFields,
      toolCallId: "tc-1",
      toolName: "search",
      arguments: { query: "test" },
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name, data } = parseSSE(result!);
    expect(name).toBe("tool.start");
    expect(data.toolCallId).toBe("tc-1");
    expect(data.toolName).toBe("search");
    expect(data.arguments).toEqual({ query: "test" });
  });

  it("formats tool.end", () => {
    const event = createEvent("agent.tool.end", {
      ...baseFields,
      toolCallId: "tc-1",
      toolName: "search",
      arguments: { query: "test" },
      result: { items: [] },
      durationMs: 150,
      resultTokens: 25,
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name, data } = parseSSE(result!);
    expect(name).toBe("tool.end");
    expect(data.toolCallId).toBe("tc-1");
    expect(data.toolName).toBe("search");
    expect(data.result).toEqual({ items: [] });
    expect(data.durationMs).toBe(150);
  });

  it("formats tool.end with error", () => {
    const event = createEvent("agent.tool.end", {
      ...baseFields,
      toolCallId: "tc-1",
      toolName: "search",
      arguments: {},
      result: null,
      error: "timeout",
      durationMs: 5000,
      resultTokens: 0,
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { data } = parseSSE(result!);
    expect(data.error).toBe("timeout");
  });

  it("formats tool.rejected", () => {
    const event = createEvent("agent.tool.rejected", {
      ...baseFields,
      toolName: "rm",
      reason: "blocked by safety gate",
      gateName: "safety",
      gateCategory: "safety",
      originalIntent: createEvent("agent.tool.intent", {
        ...baseFields,
        toolCallId: "tc-1",
        toolName: "rm",
        arguments: { path: "/" },
      }),
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name, data } = parseSSE(result!);
    expect(name).toBe("tool.rejected");
    expect(data.toolName).toBe("rm");
    expect(data.reason).toBe("blocked by safety gate");
    expect(data.gateName).toBe("safety");
  });

  it("formats error", () => {
    const event = createEvent("agent.error", {
      ...baseFields,
      errorType: "RuntimeError",
      message: "something broke",
      recoverable: false,
      context: {},
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name, data } = parseSSE(result!);
    expect(name).toBe("error");
    expect(data.errorType).toBe("RuntimeError");
    expect(data.message).toBe("something broke");
    expect(data.recoverable).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Unmapped events return null
  // ---------------------------------------------------------------------------

  it("returns null for message.start", () => {
    const event = createEvent("agent.message.start", {
      ...baseFields,
      agentName: "test",
    });
    expect(formatSSE(event)).toBeNull();
  });

  it("returns null for iteration.start", () => {
    const event = createEvent("agent.iteration.start", {
      ...baseFields,
      iteration: 1,
      maxIterations: 10,
    });
    expect(formatSSE(event)).toBeNull();
  });

  it("returns null for iteration.end", () => {
    const event = createEvent("agent.iteration.end", {
      ...baseFields,
      iteration: 1,
      toolCallsCount: 0,
      hasMore: false,
    });
    expect(formatSSE(event)).toBeNull();
  });

  it("returns null for llm.start", () => {
    const event = createEvent("agent.llm.start", {
      ...baseFields,
      model: "gpt-4",
      messageCount: 5,
      hasTools: true,
    });
    expect(formatSSE(event)).toBeNull();
  });

  it("returns null for llm.end", () => {
    const event = createEvent("agent.llm.end", {
      ...baseFields,
      model: "gpt-4",
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 1000,
      hasToolCalls: false,
      finishReason: "stop",
    });
    expect(formatSSE(event)).toBeNull();
  });

  it("returns null for tool.intent", () => {
    const event = createEvent("agent.tool.intent", {
      ...baseFields,
      toolCallId: "tc-1",
      toolName: "search",
      arguments: {},
    });
    expect(formatSSE(event)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // SSE format
  // ---------------------------------------------------------------------------

  it("produces valid SSE format with double newline terminator", () => {
    const event = createEvent("agent.message.chunk", {
      ...baseFields,
      delta: "x",
      chunkIndex: 0,
    });
    const result = formatSSE(event)!;
    expect(result).toMatch(/^event: .+\ndata: .+\n\n$/);
  });

  it("includes traceId and timestamp in all payloads", () => {
    const event = createEvent("agent.reasoning", {
      ...baseFields,
      content: "test",
      isComplete: true,
    });
    const { data } = parseSSE(formatSSE(event)!);
    expect(data.traceId).toBe("trace-1");
    expect(typeof data.timestamp).toBe("string");
  });
});
