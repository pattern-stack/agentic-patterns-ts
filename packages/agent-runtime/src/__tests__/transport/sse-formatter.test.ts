import { describe, expect, it } from "vitest";
import { createEvent } from "../../events/types.js";
import { SSEFormatter, SSE_EVENT_NAMES, formatSSE } from "../../transport/sse-formatter.js";

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
    // New in B2
    expect(SSE_EVENT_NAMES["agent.conversation.start"]).toBe("conversation.start");
    expect(SSE_EVENT_NAMES["agent.conversation.end"]).toBe("conversation.end");
    expect(SSE_EVENT_NAMES["agent.message.start"]).toBe("message.start");
    expect(SSE_EVENT_NAMES["agent.message.cancel"]).toBe("message.cancel");
    expect(SSE_EVENT_NAMES["agent.thinking.start"]).toBe("thinking.start");
    expect(SSE_EVENT_NAMES["agent.tool.intent"]).toBe("tool.intent");
    expect(SSE_EVENT_NAMES["agent.tool.progress"]).toBe("tool.progress");
    expect(SSE_EVENT_NAMES["agent.iteration.start"]).toBe("iteration.start");
    expect(SSE_EVENT_NAMES["agent.iteration.end"]).toBe("iteration.end");
    expect(SSE_EVENT_NAMES["agent.llm.start"]).toBe("llm.start");
    expect(SSE_EVENT_NAMES["agent.llm.end"]).toBe("llm.end");
    expect(SSE_EVENT_NAMES["agent.step.start"]).toBe("step.start");
    expect(SSE_EVENT_NAMES["agent.step.end"]).toBe("step.end");
    expect(SSE_EVENT_NAMES["agent.input.request"]).toBe("input.request");
    // State-delta events (#226)
    expect(SSE_EVENT_NAMES["agent.backpack.drop"]).toBe("backpack.drop");
    expect(SSE_EVENT_NAMES["agent.backpack.read"]).toBe("backpack.read");
    expect(SSE_EVENT_NAMES["agent.backpack.absorb"]).toBe("backpack.absorb");
    expect(SSE_EVENT_NAMES["agent.scratchpad.write"]).toBe("scratchpad.write");
    expect(SSE_EVENT_NAMES["agent.scratchpad.read"]).toBe("scratchpad.read");
    expect(SSE_EVENT_NAMES["agent.scratchpad.fork"]).toBe("scratchpad.fork");
    expect(SSE_EVENT_NAMES["agent.scratchpad.join"]).toBe("scratchpad.join");
  });

  it("has exactly 29 mappings", () => {
    expect(Object.keys(SSE_EVENT_NAMES)).toHaveLength(29);
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
    expect(data.chunk_index).toBe(0);
    expect(data.traceId).toBe("trace-1");
    expect(data.timestamp).toBeDefined();
  });

  it("formats input.request with snake_case correlation + tool context", () => {
    const event = createEvent("agent.input.request", {
      ...baseFields,
      correlationId: "call-9",
      kind: "approval",
      prompt: 'Approve "ratify_definition"?',
      toolName: "ratify_definition",
      toolCallId: "call-9",
      arguments: { id: "def-1" },
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name, data } = parseSSE(result!);
    expect(name).toBe("input.request");
    expect(data.correlation_id).toBe("call-9");
    expect(data.kind).toBe("approval");
    expect(data.prompt).toBe('Approve "ratify_definition"?');
    expect(data.tool_name).toBe("ratify_definition");
    expect(data.tool_call_id).toBe("call-9");
    expect(data.arguments).toEqual({ id: "def-1" });
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
    expect(data.input_tokens).toBe(100);
    expect(data.output_tokens).toBe(50);
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
  });

  it("formats reasoning with isComplete as thinking.complete", () => {
    const event = createEvent("agent.reasoning", {
      ...baseFields,
      content: "done thinking",
      isComplete: true,
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name, data } = parseSSE(result!);
    expect(name).toBe("thinking.complete");
    expect(data.content).toBe("done thinking");
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
    expect(data.tool_call_id).toBe("tc-1");
    expect(data.tool_name).toBe("search");
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
    expect(data.tool_call_id).toBe("tc-1");
    expect(data.tool_name).toBe("search");
    expect(data.result).toEqual({ items: [] });
    expect(data.duration_ms).toBe(150);
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
    expect(data.tool_name).toBe("rm");
    expect(data.reason).toBe("blocked by safety gate");
    expect(data.gate_name).toBe("safety");
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
    expect(data.error_type).toBe("RuntimeError");
    expect(data.message).toBe("something broke");
    expect(data.recoverable).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Events now mapped (previously returned null)
  // ---------------------------------------------------------------------------

  it("formats message.start", () => {
    const event = createEvent("agent.message.start", {
      ...baseFields,
      agentName: "test",
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name } = parseSSE(result!);
    expect(name).toBe("message.start");
  });

  it("formats iteration.start", () => {
    const event = createEvent("agent.iteration.start", {
      ...baseFields,
      iteration: 1,
      maxIterations: 10,
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name } = parseSSE(result!);
    expect(name).toBe("iteration.start");
  });

  it("formats iteration.end", () => {
    const event = createEvent("agent.iteration.end", {
      ...baseFields,
      iteration: 1,
      toolCallsCount: 0,
      hasMore: false,
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name } = parseSSE(result!);
    expect(name).toBe("iteration.end");
  });

  it("formats llm.start", () => {
    const event = createEvent("agent.llm.start", {
      ...baseFields,
      model: "gpt-4",
      messageCount: 5,
      hasTools: true,
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name } = parseSSE(result!);
    expect(name).toBe("llm.start");
  });

  it("formats llm.end", () => {
    const event = createEvent("agent.llm.end", {
      ...baseFields,
      model: "gpt-4",
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 1000,
      hasToolCalls: false,
      finishReason: "stop",
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name } = parseSSE(result!);
    expect(name).toBe("llm.end");
  });

  it("formats tool.intent", () => {
    const event = createEvent("agent.tool.intent", {
      ...baseFields,
      toolCallId: "tc-1",
      toolName: "search",
      arguments: {},
    });
    const result = formatSSE(event);
    expect(result).not.toBeNull();
    const { event: name } = parseSSE(result!);
    expect(name).toBe("tool.intent");
  });

  // ---------------------------------------------------------------------------
  // State-delta events (#226) — one wire-format pin per frame family. Payload
  // keys are snake_case (the step.start convention); optional fields are
  // OMITTED when absent, never serialized as null/undefined.
  // ---------------------------------------------------------------------------

  it("formats backpack.drop with receipt counts, sizes, previews, and optionals", () => {
    const event = createEvent("agent.backpack.drop", {
      ...baseFields,
      key: "backpack.observations",
      origin: "explicit",
      ordinal: 1,
      accepted: 2,
      merged: 1,
      skipped: 1,
      indexes: [10, 11, 3],
      sizeBefore: 9,
      sizeAfter: 12,
      previews: [{ index: 10, op: "added", preview: "obs-10" }],
      previewsOmitted: 2,
      toolCallId: "tc-1",
      tag: "search_deal_context",
      display: { caption: "Evidence" },
    });
    const { event: name, data } = parseSSE(formatSSE(event)!);
    expect(name).toBe("backpack.drop");
    expect(data.key).toBe("backpack.observations");
    expect(data.origin).toBe("explicit");
    expect(data.ordinal).toBe(1);
    expect(data.accepted).toBe(2);
    expect(data.merged).toBe(1);
    expect(data.skipped).toBe(1);
    expect(data.indexes).toEqual([10, 11, 3]);
    expect(data.size_before).toBe(9);
    expect(data.size_after).toBe(12);
    expect(data.previews).toEqual([{ index: 10, op: "added", preview: "obs-10" }]);
    expect(data.previews_omitted).toBe(2);
    expect(data.tool_call_id).toBe("tc-1");
    expect(data.tag).toBe("search_deal_context");
    expect(data.display).toEqual({ caption: "Evidence" });
  });

  it("omits backpack.drop optionals (tool_call_id/tag/display) when absent", () => {
    const event = createEvent("agent.backpack.drop", {
      ...baseFields,
      key: "backpack.observations",
      origin: "innate",
      ordinal: 2,
      accepted: 0,
      merged: 0,
      skipped: 0,
      indexes: [],
      sizeBefore: 0,
      sizeAfter: 0,
      previews: [],
      previewsOmitted: 0,
    });
    const { data } = parseSSE(formatSSE(event)!);
    expect("tool_call_id" in data).toBe(false);
    expect("tag" in data).toBe(false);
    expect("display" in data).toBe(false);
  });

  it("formats backpack.read with memo hit + size + preview", () => {
    const event = createEvent("agent.backpack.read", {
      ...baseFields,
      key: "backpack.observations",
      origin: "explicit",
      ordinal: 3,
      memoHit: true,
      size: 6,
      preview: "ranked list…",
      display: { caption: "Evidence", attribution: "added by tools" },
    });
    const { event: name, data } = parseSSE(formatSSE(event)!);
    expect(name).toBe("backpack.read");
    expect(data.key).toBe("backpack.observations");
    expect(data.memo_hit).toBe(true);
    expect(data.size).toBe(6);
    expect(data.preview).toBe("ranked list…");
    expect(data.display).toEqual({ caption: "Evidence", attribution: "added by tools" });
  });

  it("formats backpack.absorb with child size + appended indexes", () => {
    const event = createEvent("agent.backpack.absorb", {
      ...baseFields,
      key: "backpack.observations",
      origin: "innate",
      ordinal: 4,
      childSize: 3,
      accepted: 2,
      merged: 1,
      sizeBefore: 12,
      sizeAfter: 14,
      appendedIndexes: [13, 14],
    });
    const { event: name, data } = parseSSE(formatSSE(event)!);
    expect(name).toBe("backpack.absorb");
    expect(data.child_size).toBe(3);
    expect(data.accepted).toBe(2);
    expect(data.merged).toBe(1);
    expect(data.size_before).toBe(12);
    expect(data.size_after).toBe(14);
    expect(data.appended_indexes).toEqual([13, 14]);
  });

  it("formats scratchpad.write with op + before/after previews", () => {
    const event = createEvent("agent.scratchpad.write", {
      ...baseFields,
      key: "brief.highlights",
      origin: "explicit",
      ordinal: 5,
      op: "set",
      hadValue: true,
      before: "old value",
      after: "new value",
      toolCallId: "tc-2",
    });
    const { event: name, data } = parseSSE(formatSSE(event)!);
    expect(name).toBe("scratchpad.write");
    expect(data.key).toBe("brief.highlights");
    expect(data.op).toBe("set");
    expect(data.had_value).toBe(true);
    expect(data.before).toBe("old value");
    expect(data.after).toBe("new value");
    expect(data.tool_call_id).toBe("tc-2");
  });

  it("omits scratchpad.write's before preview on a first write (hadValue false)", () => {
    const event = createEvent("agent.scratchpad.write", {
      ...baseFields,
      key: "agents.retrieve",
      origin: "innate",
      ordinal: 6,
      op: "set",
      hadValue: false,
      after: "stage output",
    });
    const { data } = parseSSE(formatSSE(event)!);
    expect(data.had_value).toBe(false);
    expect("before" in data).toBe(false);
    expect("tool_call_id" in data).toBe(false);
  });

  it("formats scratchpad.read with the value preview", () => {
    const event = createEvent("agent.scratchpad.read", {
      ...baseFields,
      key: "agents.retrieve",
      origin: "innate",
      ordinal: 7,
      preview: "## Prior stage output…",
    });
    const { event: name, data } = parseSSE(formatSSE(event)!);
    expect(name).toBe("scratchpad.read");
    expect(data.key).toBe("agents.retrieve");
    expect(data.origin).toBe("innate");
    expect(data.preview).toBe("## Prior stage output…");
  });

  it("formats scratchpad.fork with shared keys", () => {
    const event = createEvent("agent.scratchpad.fork", {
      ...baseFields,
      origin: "innate",
      ordinal: 8,
      sharedKeys: ["backpack.observations", "agents.retrieve"],
    });
    const { event: name, data } = parseSSE(formatSSE(event)!);
    expect(name).toBe("scratchpad.fork");
    expect(data.shared_keys).toEqual(["backpack.observations", "agents.retrieve"]);
  });

  it("formats scratchpad.join with merged + discarded keys (the silent-loss trap, visible)", () => {
    const event = createEvent("agent.scratchpad.join", {
      ...baseFields,
      origin: "innate",
      ordinal: 9,
      mergedKeys: ["branch.results"],
      discardedKeys: ["branch.scratch"],
    });
    const { event: name, data } = parseSSE(formatSSE(event)!);
    expect(name).toBe("scratchpad.join");
    expect(data.merged_keys).toEqual(["branch.results"]);
    expect(data.discarded_keys).toEqual(["branch.scratch"]);
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

  // ---------------------------------------------------------------------------
  // SSEFormatter class
  // ---------------------------------------------------------------------------

  it("SSEFormatter.formatDone returns done event", () => {
    expect(SSEFormatter.formatDone()).toBe("event: done\ndata: {}\n\n");
  });
});
