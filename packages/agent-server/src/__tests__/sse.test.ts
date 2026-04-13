import { describe, expect, it } from "vitest";
import { agentEventToSSE } from "../sse.js";

describe("agentEventToSSE", () => {
  it("maps message.chunk to message.delta", () => {
    const event = {
      type: "agent.message.chunk" as const,
      delta: "Hello ",
      chunkIndex: 0,
      traceId: "t1",
      runId: "r1",
      spanId: "s1",
      timestamp: new Date(),
    };
    const result = agentEventToSSE(event);
    expect(result).toEqual({
      event: "message.delta",
      data: JSON.stringify({ delta: "Hello " }),
    });
  });

  it("maps message.complete with token counts", () => {
    const event = {
      type: "agent.message.complete" as const,
      content: "Hello world!",
      inputTokens: 10,
      outputTokens: 5,
      model: "test-model",
      traceId: "t1",
      runId: "r1",
      spanId: "s1",
      timestamp: new Date(),
    };
    const result = agentEventToSSE(event);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.data);
    expect(parsed.content).toBe("Hello world!");
    expect(parsed.input_tokens).toBe(10);
    expect(parsed.output_tokens).toBe(5);
  });

  it("maps reasoning to thinking", () => {
    const event = {
      type: "agent.reasoning" as const,
      content: "Let me think...",
      isComplete: false,
      traceId: "t1",
      runId: "r1",
      spanId: "s1",
      timestamp: new Date(),
    };
    const result = agentEventToSSE(event);
    expect(result).toEqual({
      event: "thinking",
      data: JSON.stringify({ content: "Let me think..." }),
    });
  });

  it("maps tool.start", () => {
    const event = {
      type: "agent.tool.start" as const,
      toolCallId: "tc-1",
      toolName: "read_file",
      arguments: { path: "/src/main.ts" },
      traceId: "t1",
      runId: "r1",
      spanId: "s1",
      timestamp: new Date(),
    };
    const result = agentEventToSSE(event);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.data);
    expect(parsed.tool_call_id).toBe("tc-1");
    expect(parsed.tool_name).toBe("read_file");
  });

  it("maps tool.end with error", () => {
    const event = {
      type: "agent.tool.end" as const,
      toolCallId: "tc-1",
      toolName: "read_file",
      arguments: {},
      result: null,
      error: "File not found",
      durationMs: 12,
      resultTokens: 0,
      traceId: "t1",
      runId: "r1",
      spanId: "s1",
      timestamp: new Date(),
    };
    const result = agentEventToSSE(event);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.data);
    expect(parsed.error).toBe("File not found");
    expect(parsed.duration_ms).toBe(12);
  });

  it("maps tool.rejected", () => {
    const event = {
      type: "agent.tool.rejected" as const,
      toolName: "execute_command",
      reason: "Not in allowlist",
      gateName: "safety",
      gateCategory: "SAFETY",
      originalIntent: {} as unknown as import("@agentic-patterns/runtime").ToolCallIntent,
      traceId: "t1",
      runId: "r1",
      spanId: "s1",
      timestamp: new Date(),
    };
    const result = agentEventToSSE(event);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.data);
    expect(parsed.tool_name).toBe("execute_command");
    expect(parsed.reason).toBe("Not in allowlist");
  });

  it("maps error event", () => {
    const event = {
      type: "agent.error" as const,
      errorType: "rate_limit",
      message: "Too many requests",
      recoverable: false,
      context: {},
      traceId: "t1",
      runId: "r1",
      spanId: "s1",
      timestamp: new Date(),
    };
    const result = agentEventToSSE(event);
    expect(result).toEqual({
      event: "error",
      data: JSON.stringify({ error_type: "rate_limit", message: "Too many requests" }),
    });
  });

  it("returns null for internal events", () => {
    const event = {
      type: "agent.iteration.start" as const,
      iteration: 1,
      maxIterations: 10,
      traceId: "t1",
      runId: "r1",
      spanId: "s1",
      timestamp: new Date(),
    };
    const result = agentEventToSSE(event);
    expect(result).toBeNull();
  });

  it("returns null for llm events", () => {
    const event = {
      type: "agent.llm.start" as const,
      model: "test",
      messageCount: 1,
      hasTools: false,
      traceId: "t1",
      runId: "r1",
      spanId: "s1",
      timestamp: new Date(),
    };
    const result = agentEventToSSE(event);
    expect(result).toBeNull();
  });
});
