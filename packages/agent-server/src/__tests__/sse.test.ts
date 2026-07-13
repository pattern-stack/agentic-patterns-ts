import { describe, expect, it } from "vitest";
import { agentEventToSSE } from "../sse.js";

const base = {
  traceId: "t1",
  runId: "r1",
  spanId: "s1",
  timestamp: new Date(),
} as const;

describe("agentEventToSSE — client-facing canonical vocabulary", () => {
  // ---------------------------------------------------------------------------
  // Conversation lifecycle
  // ---------------------------------------------------------------------------

  it("maps conversation.start", () => {
    const result = agentEventToSSE({
      type: "agent.conversation.start",
      conversationId: "c-1",
      agentName: "agent-1",
      ...base,
    });
    expect(result?.event).toBe("conversation.start");
    const parsed = JSON.parse(result!.data);
    expect(parsed.conversation_id).toBe("c-1");
    expect(parsed.agent_name).toBe("agent-1");
  });

  it("maps conversation.end", () => {
    const result = agentEventToSSE({
      type: "agent.conversation.end",
      conversationId: "c-1",
      reason: "completed",
      ...base,
    });
    expect(result?.event).toBe("conversation.end");
    const parsed = JSON.parse(result!.data);
    expect(parsed.reason).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // Message lifecycle
  // ---------------------------------------------------------------------------

  it("maps message.start", () => {
    const result = agentEventToSSE({
      type: "agent.message.start",
      agentName: "agent-1",
      ...base,
    });
    expect(result?.event).toBe("message.start");
    const parsed = JSON.parse(result!.data);
    expect(parsed.agent_name).toBe("agent-1");
  });

  it("maps message.chunk to message.delta with chunk_index", () => {
    const result = agentEventToSSE({
      type: "agent.message.chunk",
      delta: "Hello ",
      chunkIndex: 0,
      ...base,
    });
    expect(result?.event).toBe("message.delta");
    const parsed = JSON.parse(result!.data);
    expect(parsed.delta).toBe("Hello ");
    expect(parsed.chunk_index).toBe(0);
  });

  it("maps message.complete with token counts and model", () => {
    const result = agentEventToSSE({
      type: "agent.message.complete",
      content: "Hello world!",
      inputTokens: 10,
      outputTokens: 5,
      model: "test-model",
      ...base,
    });
    expect(result?.event).toBe("message.complete");
    const parsed = JSON.parse(result!.data);
    expect(parsed.content).toBe("Hello world!");
    expect(parsed.input_tokens).toBe(10);
    expect(parsed.output_tokens).toBe(5);
    expect(parsed.model).toBe("test-model");
  });

  it("maps message.cancel", () => {
    const result = agentEventToSSE({
      type: "agent.message.cancel",
      reason: "user_aborted",
      ...base,
    });
    expect(result?.event).toBe("message.cancel");
    const parsed = JSON.parse(result!.data);
    expect(parsed.reason).toBe("user_aborted");
  });

  // ---------------------------------------------------------------------------
  // Thinking / reasoning
  // ---------------------------------------------------------------------------

  it("maps thinking.start", () => {
    const result = agentEventToSSE({ type: "agent.thinking.start", ...base });
    expect(result?.event).toBe("thinking.start");
  });

  it("maps reasoning (isComplete=false) to thinking", () => {
    const result = agentEventToSSE({
      type: "agent.reasoning",
      content: "Let me think...",
      isComplete: false,
      ...base,
    });
    expect(result?.event).toBe("thinking");
    const parsed = JSON.parse(result!.data);
    expect(parsed.content).toBe("Let me think...");
  });

  it("maps reasoning (isComplete=true) to thinking.complete", () => {
    const result = agentEventToSSE({
      type: "agent.reasoning",
      content: "Done thinking.",
      isComplete: true,
      ...base,
    });
    expect(result?.event).toBe("thinking.complete");
    const parsed = JSON.parse(result!.data);
    expect(parsed.content).toBe("Done thinking.");
  });

  // ---------------------------------------------------------------------------
  // Tool lifecycle
  // ---------------------------------------------------------------------------

  it("maps tool.intent", () => {
    const result = agentEventToSSE({
      type: "agent.tool.intent",
      toolCallId: "tc-1",
      toolName: "read_file",
      arguments: { path: "/foo" },
      ...base,
    });
    expect(result?.event).toBe("tool.intent");
    const parsed = JSON.parse(result!.data);
    expect(parsed.tool_call_id).toBe("tc-1");
    expect(parsed.tool_name).toBe("read_file");
  });

  it("maps tool.start", () => {
    const result = agentEventToSSE({
      type: "agent.tool.start",
      toolCallId: "tc-1",
      toolName: "read_file",
      arguments: { path: "/src/main.ts" },
      ...base,
    });
    expect(result?.event).toBe("tool.start");
    const parsed = JSON.parse(result!.data);
    expect(parsed.tool_call_id).toBe("tc-1");
    expect(parsed.tool_name).toBe("read_file");
  });

  it("maps tool.progress", () => {
    const result = agentEventToSSE({
      type: "agent.tool.progress",
      toolCallId: "tc-1",
      progress: 0.5,
      statusText: "Reading...",
      ...base,
    });
    expect(result?.event).toBe("tool.progress");
    const parsed = JSON.parse(result!.data);
    expect(parsed.progress).toBe(0.5);
    expect(parsed.status_text).toBe("Reading...");
  });

  it("maps tool.end with error", () => {
    const result = agentEventToSSE({
      type: "agent.tool.end",
      toolCallId: "tc-1",
      toolName: "read_file",
      arguments: {},
      result: null,
      error: "File not found",
      durationMs: 12,
      resultTokens: 0,
      ...base,
    });
    expect(result?.event).toBe("tool.end");
    const parsed = JSON.parse(result!.data);
    expect(parsed.error).toBe("File not found");
    expect(parsed.duration_ms).toBe(12);
  });

  it("maps tool.rejected", () => {
    const result = agentEventToSSE({
      type: "agent.tool.rejected",
      toolName: "execute_command",
      reason: "Not in allowlist",
      gateName: "safety",
      gateCategory: "SAFETY",
      originalIntent: {} as unknown as import("@agentic-patterns/runtime").ToolCallIntent,
      ...base,
    });
    expect(result?.event).toBe("tool.rejected");
    const parsed = JSON.parse(result!.data);
    expect(parsed.tool_name).toBe("execute_command");
    expect(parsed.reason).toBe("Not in allowlist");
  });

  // ---------------------------------------------------------------------------
  // Error
  // ---------------------------------------------------------------------------

  it("maps error with recoverable flag", () => {
    const result = agentEventToSSE({
      type: "agent.error",
      errorType: "rate_limit",
      message: "Too many requests",
      recoverable: false,
      context: {},
      ...base,
    });
    expect(result?.event).toBe("error");
    const parsed = JSON.parse(result!.data);
    expect(parsed.error_type).toBe("rate_limit");
    expect(parsed.message).toBe("Too many requests");
    expect(parsed.recoverable).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // State-delta events (#226) — pass through with ZERO server changes. The
  // delegation to the runtime's `toSSEMapping` carries them automatically;
  // only iteration.*/llm.* are filtered here. These pins make that verified
  // claim executable.
  // ---------------------------------------------------------------------------

  it("maps backpack.drop with the snake_case receipt payload (no server-side allowlist)", () => {
    const result = agentEventToSSE({
      type: "agent.backpack.drop",
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
      previewsOmitted: 0,
      toolCallId: "tc-1",
      ...base,
    });
    expect(result?.event).toBe("backpack.drop");
    const parsed = JSON.parse(result!.data);
    expect(parsed.key).toBe("backpack.observations");
    expect(parsed.accepted).toBe(2);
    expect(parsed.size_before).toBe(9);
    expect(parsed.size_after).toBe(12);
    expect(parsed.tool_call_id).toBe("tc-1");
  });

  it("maps scratchpad.write with origin + ordinal + before/after previews", () => {
    const result = agentEventToSSE({
      type: "agent.scratchpad.write",
      key: "brief.highlights",
      origin: "innate",
      ordinal: 5,
      op: "set",
      hadValue: false,
      after: "stage output",
      ...base,
    });
    expect(result?.event).toBe("scratchpad.write");
    const parsed = JSON.parse(result!.data);
    expect(parsed.key).toBe("brief.highlights");
    expect(parsed.origin).toBe("innate");
    expect(parsed.ordinal).toBe(5);
    expect(parsed.had_value).toBe(false);
    expect(parsed.after).toBe("stage output");
  });

  it("maps scratchpad.join — the silent-discard trap reaches the client", () => {
    const result = agentEventToSSE({
      type: "agent.scratchpad.join",
      origin: "innate",
      ordinal: 9,
      mergedKeys: ["branch.results"],
      discardedKeys: ["branch.scratch"],
      ...base,
    });
    expect(result?.event).toBe("scratchpad.join");
    const parsed = JSON.parse(result!.data);
    expect(parsed.merged_keys).toEqual(["branch.results"]);
    expect(parsed.discarded_keys).toEqual(["branch.scratch"]);
  });

  // ---------------------------------------------------------------------------
  // Internal events are filtered from the client protocol
  // ---------------------------------------------------------------------------

  it("returns null for iteration.start", () => {
    const result = agentEventToSSE({
      type: "agent.iteration.start",
      iteration: 1,
      maxIterations: 10,
      ...base,
    });
    expect(result).toBeNull();
  });

  it("returns null for iteration.end", () => {
    const result = agentEventToSSE({
      type: "agent.iteration.end",
      iteration: 1,
      toolCallsCount: 0,
      hasMore: false,
      ...base,
    });
    expect(result).toBeNull();
  });

  it("returns null for llm.start", () => {
    const result = agentEventToSSE({
      type: "agent.llm.start",
      model: "test",
      messageCount: 1,
      hasTools: false,
      ...base,
    });
    expect(result).toBeNull();
  });

  it("returns null for llm.end", () => {
    const result = agentEventToSSE({
      type: "agent.llm.end",
      model: "test",
      inputTokens: 5,
      outputTokens: 3,
      durationMs: 100,
      finishReason: "stop",
      hasToolCalls: false,
      ...base,
    });
    expect(result).toBeNull();
  });
});
