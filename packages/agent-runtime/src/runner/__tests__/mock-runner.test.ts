import type { ToolExecutionContext } from "@pattern-stack/agentic-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ToolCallEndEvent, ToolCallStartEvent } from "../../events/types.js";
import { MockRunner } from "../mock-runner.js";
import type { ToolExecutor } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAgent(name = "TestAgent") {
  return {
    getModel: () => "test-model",
    getTools: () => [],
    renderInitialPrompt: () => "initial prompt",
    role: { name },
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MockRunner", () => {
  it("should start with empty state", () => {
    const runner = new MockRunner();
    expect(runner.callHistory).toEqual([]);
  });

  it("should support fluent chaining on addResponse", () => {
    const runner = new MockRunner();
    const result = runner.addResponse("hello", { content: "hi" });
    expect(result).toBe(runner);
  });

  it("should support fluent chaining on clear", () => {
    const runner = new MockRunner().addResponse("x", { content: "y" });
    const result = runner.clear();
    expect(result).toBe(runner);
    expect(runner.callHistory).toEqual([]);
  });

  it("should match responses by substring", async () => {
    const runner = new MockRunner()
      .addResponse("hello", { content: "Hi there!" })
      .addResponse("bye", { content: "Goodbye!" });

    const result = await runner.run(makeAgent(), "say hello world");
    expect(result.response).toBe("Hi there!");
  });

  it("should match wildcard * as default", async () => {
    const runner = new MockRunner()
      .addResponse("specific", { content: "matched" })
      .addResponse("*", { content: "default response" });

    const result = await runner.run(makeAgent(), "something else");
    expect(result.response).toBe("default response");
  });

  it("should prefer substring match over wildcard", async () => {
    const runner = new MockRunner()
      .addResponse("*", { content: "default" })
      .addResponse("hello", { content: "specific" });

    const result = await runner.run(makeAgent(), "hello");
    expect(result.response).toBe("specific");
  });

  it("should auto-generate fallback when no match", async () => {
    const runner = new MockRunner();
    const result = await runner.run(makeAgent(), "test message");
    expect(result.response).toBe("Mock response to: test message");
  });

  it("should record call history", async () => {
    const runner = new MockRunner();
    const agent = makeAgent("MyAgent");

    await runner.run(agent, "first");
    await runner.run(agent, "second");

    expect(runner.callHistory).toHaveLength(2);
    expect(runner.callHistory[0]!.message).toBe("first");
    expect(runner.callHistory[0]!.agentName).toBe("MyAgent");
    expect(runner.callHistory[0]!.model).toBe("test-model");
    expect(runner.callHistory[0]!.timestamp).toBeInstanceOf(Date);
    expect(runner.callHistory[1]!.message).toBe("second");
  });

  it("should return token counts from response", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "ok",
      inputTokens: 100,
      outputTokens: 50,
    });

    const result = await runner.run(makeAgent(), "test");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it("should default token counts to 0", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const result = await runner.run(makeAgent(), "test");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("should throw configured error", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "ignored",
      error: new Error("Boom!"),
    });

    await expect(runner.run(makeAgent(), "test")).rejects.toThrow("Boom!");
  });

  it("should simulate delay", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "delayed",
      delayMs: 10,
    });

    const start = Date.now();
    await runner.run(makeAgent(), "test");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(5);
  });

  it("should execute tool calls with toolExecutor", async () => {
    const executor: ToolExecutor = {
      execute: vi.fn().mockResolvedValue("tool result"),
    };

    const runner = new MockRunner().addResponse("*", {
      content: "done",
      toolCalls: [
        { name: "search", arguments: { query: "test" } },
        { name: "save", arguments: { data: "x" } },
      ],
    });

    const result = await runner.run(makeAgent(), "test", {
      toolExecutor: executor,
    });

    expect(result.toolCallsCount).toBe(2);
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(executor.execute).toHaveBeenCalledWith("search", { query: "test" }, expect.anything());
    expect(executor.execute).toHaveBeenCalledWith("save", { data: "x" }, expect.anything());
  });

  it("should count tool calls without toolExecutor", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "done",
      toolCalls: [
        { name: "a", arguments: {} },
        { name: "b", arguments: {} },
      ],
    });

    const result = await runner.run(makeAgent(), "test");
    expect(result.toolCallsCount).toBe(2);
  });

  it("should return iterations=1 and finishReason=stop", async () => {
    const runner = new MockRunner();
    const result = await runner.run(makeAgent(), "test");
    expect(result.iterations).toBe(1);
    expect(result.finishReason).toBe("stop");
  });

  describe("ToolExecutionContext threading (#269)", () => {
    it("run() relays host and traceId while sharing runId across distinct tool-call parents", async () => {
      const contexts: ToolExecutionContext[] = [];
      const executor: ToolExecutor = {
        execute: vi.fn(async (_name, _args, ctx) => {
          contexts.push(ctx!);
          return "ok";
        }),
      };
      const host = { marker: "host" };
      const runner = new MockRunner().addResponse("*", {
        content: "done",
        toolCalls: [
          { name: "first", arguments: {} },
          { name: "second", arguments: {} },
        ],
      });

      await runner.run(makeAgent(), "test", {
        toolExecutor: executor,
        host,
        traceId: "caller-trace",
      });

      expect(contexts).toHaveLength(2);
      const first = contexts[0]!;
      const second = contexts[1]!;
      expect(first.host).toBe(host);
      expect(second.host).toBe(host);
      expect(first.traceId).toBe("caller-trace");
      expect(second.traceId).toBe("caller-trace");
      expect(first.runId).toEqual(expect.stringMatching(/.+/));
      expect(second.runId).toBe(first.runId);
      expect(first.parentToolCallId).toEqual(expect.stringMatching(/.+/));
      expect(second.parentToolCallId).toEqual(expect.stringMatching(/.+/));
      expect(second.parentToolCallId).not.toBe(first.parentToolCallId);
    });

    it("run() passes a context with an undefined host when no host was supplied", async () => {
      let captured: ToolExecutionContext | undefined;
      const executor: ToolExecutor = {
        execute: vi.fn(async (_name, _args, ctx) => {
          captured = ctx;
          return "ok";
        }),
      };
      const runner = new MockRunner().addResponse("*", {
        content: "done",
        toolCalls: [{ name: "probe", arguments: {} }],
      });

      await runner.run(makeAgent(), "test", { toolExecutor: executor });

      expect(captured).toBeDefined();
      expect(captured?.host).toBeUndefined();
      expect(captured?.runId).toEqual(expect.stringMatching(/.+/));
      expect(captured?.traceId).toEqual(expect.stringMatching(/.+/));
      expect(captured?.parentToolCallId).toEqual(expect.stringMatching(/.+/));
    });

    it("stream() uses the yielded toolCallId as parentToolCallId and relays host", async () => {
      let captured: ToolExecutionContext | undefined;
      const executor: ToolExecutor = {
        execute: vi.fn(async (_name, _args, ctx) => {
          captured = ctx;
          return "ok";
        }),
      };
      const host = { marker: "stream-host" };
      const runner = new MockRunner().addResponse("*", {
        content: "done",
        toolCalls: [{ name: "probe", arguments: {} }],
      });

      const events = await collectEvents(
        runner.stream(makeAgent(), "test", { toolExecutor: executor, host }),
      );
      const start = events.find((event) => event.type === "agent.tool.start") as
        | ToolCallStartEvent
        | undefined;

      expect(start).toBeDefined();
      expect(captured?.parentToolCallId).toBe(start?.toolCallId);
      expect(captured?.host).toBe(host);
    });

    it("keeps the no-executor run path unchanged", async () => {
      const runner = new MockRunner().addResponse("*", {
        content: "done",
        toolCalls: [
          { name: "first", arguments: {} },
          { name: "second", arguments: {} },
        ],
      });

      const result = await runner.run(makeAgent(), "test");

      expect(result.toolCallsCount).toBe(2);
    });

    it("keeps stream() executor errors captured on the tool-end event", async () => {
      const executor: ToolExecutor = {
        execute: vi.fn().mockRejectedValue(new Error("tool failed")),
      };
      const runner = new MockRunner().addResponse("*", {
        content: "done",
        toolCalls: [{ name: "probe", arguments: {} }],
      });

      const events = await collectEvents(
        runner.stream(makeAgent(), "test", { toolExecutor: executor }),
      );
      const end = events.find((event) => event.type === "agent.tool.end") as
        | ToolCallEndEvent
        | undefined;

      expect(end?.error).toBe("tool failed");
      expect(events.some((event) => event.type === "agent.message.complete")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  describe("stream", () => {
    it("should yield message lifecycle events", async () => {
      const runner = new MockRunner().addResponse("*", {
        content: "streamed response",
        inputTokens: 10,
        outputTokens: 5,
      });

      const events = await collectEvents(runner.stream(makeAgent("StreamAgent"), "test"));

      const types = events.map((e) => e.type);
      expect(types).toContain("agent.message.start");
      expect(types).toContain("agent.message.chunk");
      expect(types).toContain("agent.message.complete");

      const start = events.find((e) => e.type === "agent.message.start");
      expect((start as { agentName: string }).agentName).toBe("StreamAgent");

      const chunk = events.find((e) => e.type === "agent.message.chunk");
      expect((chunk as { delta: string }).delta).toBe("streamed response");

      const complete = events.find((e) => e.type === "agent.message.complete");
      expect((complete as { content: string }).content).toBe("streamed response");
      expect((complete as { inputTokens: number }).inputTokens).toBe(10);
      expect((complete as { outputTokens: number }).outputTokens).toBe(5);
      expect((complete as { model: string }).model).toBe("test-model");
    });

    it("should yield tool events when tool calls configured", async () => {
      const runner = new MockRunner().addResponse("*", {
        content: "done",
        toolCalls: [{ name: "search", arguments: { q: "test" }, result: "found" }],
      });

      const events = await collectEvents(runner.stream(makeAgent(), "test"));

      const types = events.map((e) => e.type);
      expect(types).toContain("agent.tool.start");
      expect(types).toContain("agent.tool.end");

      const toolStart = events.find((e) => e.type === "agent.tool.start");
      expect((toolStart as { toolName: string }).toolName).toBe("search");

      const toolEnd = events.find((e) => e.type === "agent.tool.end");
      expect((toolEnd as { toolName: string }).toolName).toBe("search");
      expect((toolEnd as { result: unknown }).result).toBe("found");
    });

    it("should yield error event on configured error", async () => {
      const runner = new MockRunner().addResponse("*", {
        content: "ignored",
        error: new Error("Stream failure"),
      });

      const events = await collectEvents(runner.stream(makeAgent(), "test"));

      const types = events.map((e) => e.type);
      expect(types).toContain("agent.message.start");
      expect(types).toContain("agent.error");
      expect(types).not.toContain("agent.message.complete");

      const errorEvent = events.find((e) => e.type === "agent.error");
      expect((errorEvent as { message: string }).message).toBe("Stream failure");
    });

    it("should record call history in stream mode", async () => {
      const runner = new MockRunner();
      await collectEvents(runner.stream(makeAgent("S"), "hello"));
      expect(runner.callHistory).toHaveLength(1);
      expect(runner.callHistory[0]!.agentName).toBe("S");
    });
  });
});
