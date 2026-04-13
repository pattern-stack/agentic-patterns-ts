/**
 * Tests for runner types — RunResult, ToolExecutor, RunOptions, RunnerProtocol.
 */

import { describe, expect, it } from "vitest";
import type { RunOptions, RunResult, RunnerProtocol, ToolExecutor } from "../types.js";

describe("RunResult", () => {
  it("should accept a fully-formed result", () => {
    const result: RunResult = {
      response: "Hello, world!",
      inputTokens: 100,
      outputTokens: 50,
      toolCallsCount: 2,
      iterations: 3,
      finishReason: "stop",
    };

    expect(result.response).toBe("Hello, world!");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.toolCallsCount).toBe(2);
    expect(result.iterations).toBe(3);
    expect(result.finishReason).toBe("stop");
  });
});

describe("ToolExecutor", () => {
  it("should accept an object implementing execute()", async () => {
    const executor: ToolExecutor = {
      execute: async (name, args) => ({ name, args, result: "ok" }),
    };

    const result = await executor.execute("test_tool", { key: "value" });
    expect(result).toEqual({ name: "test_tool", args: { key: "value" }, result: "ok" });
  });
});

describe("RunOptions", () => {
  it("should accept all optional fields", () => {
    const opts: RunOptions = {
      maxIterations: 5,
      traceId: "trace-123",
      parentSpanId: "span-456",
    };

    expect(opts.maxIterations).toBe(5);
    expect(opts.traceId).toBe("trace-123");
  });

  it("should accept empty options", () => {
    const opts: RunOptions = {};
    expect(opts.maxIterations).toBeUndefined();
    expect(opts.toolExecutor).toBeUndefined();
  });
});

describe("RunnerProtocol", () => {
  it("should accept an object implementing run()", async () => {
    const runner: RunnerProtocol = {
      run: async (_agent, _message, _options) => ({
        response: "done",
        inputTokens: 10,
        outputTokens: 5,
        toolCallsCount: 0,
        iterations: 1,
        finishReason: "stop",
      }),
    };

    const fakeAgent = {
      getModel: () => "test-model",
      getTools: () => [],
      getSystemPrompt: () => "system",
      renderInitialPrompt: () => "initial",
      role: { name: "test" },
    };

    const result = await runner.run(fakeAgent, "hello");
    expect(result.response).toBe("done");
    expect(result.finishReason).toBe("stop");
  });
});
