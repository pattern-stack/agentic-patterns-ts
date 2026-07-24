/**
 * Tests for AgentRunner using MockLanguageModelV2.
 */

import { ToolSchema } from "@agentic-patterns/core";
import type { ToolExecutionContext } from "@agentic-patterns/core";
import type { LanguageModelV2Content } from "@ai-sdk/provider";
import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent } from "../../events/types.js";
import { buildScopeHost, readScope } from "../../workflows/scope-host.js";
import { AgentRunner, RunCancelledError, ToolCallBlocked } from "../agent-runner.js";
import type { AgentLike } from "../agent-runner.js";
import type { ToolExecutor } from "../types.js";

// ---------------------------------------------------------------------------
// v5 mock fixture helpers — build a doGenerate result from content parts.
// ---------------------------------------------------------------------------

type V2Result = Awaited<ReturnType<MockLanguageModelV2["doGenerate"]>>;

/** A text-only doGenerate result. */
function textResult(text: string, inputTokens: number, outputTokens: number): V2Result {
  return {
    content: [{ type: "text", text }],
    finishReason: "stop",
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    warnings: [],
  };
}

/** A single-tool-call doGenerate result (`input` is the parsed args object). */
function toolCallResult(
  call: { toolCallId: string; toolName: string; input: Record<string, unknown> },
  inputTokens: number,
  outputTokens: number,
): V2Result {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: JSON.stringify(call.input),
      },
    ],
    finishReason: "tool-calls",
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    warnings: [],
  };
}

/** A multi-tool-call doGenerate result. */
function toolCallsResult(
  calls: Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }>,
  inputTokens: number,
  outputTokens: number,
): V2Result {
  const content: LanguageModelV2Content[] = calls.map((c) => ({
    type: "tool-call",
    toolCallId: c.toolCallId,
    toolName: c.toolName,
    input: JSON.stringify(c.input),
  }));
  return {
    content,
    finishReason: "tool-calls",
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    role: { name: "test-agent" },
    getModel: () => "test-model",
    getTools: () => [],
    renderInitialPrompt: () => "You are a helpful assistant.",
    ...overrides,
  };
}

function makeToolExecutor(
  handler: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): ToolExecutor {
  return { execute: handler };
}

function collectEvents(bus: AgentEventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  bus.subscribe("agent.message.start", (e) => {
    events.push(e as AgentEvent);
  });
  bus.subscribe("agent.message.complete", (e) => {
    events.push(e as AgentEvent);
  });
  bus.subscribe("agent.iteration.start", (e) => {
    events.push(e as AgentEvent);
  });
  bus.subscribe("agent.iteration.end", (e) => {
    events.push(e as AgentEvent);
  });
  bus.subscribe("agent.llm.start", (e) => {
    events.push(e as AgentEvent);
  });
  bus.subscribe("agent.llm.end", (e) => {
    events.push(e as AgentEvent);
  });
  bus.subscribe("agent.tool.intent", (e) => {
    events.push(e as AgentEvent);
  });
  bus.subscribe("agent.tool.start", (e) => {
    events.push(e as AgentEvent);
  });
  bus.subscribe("agent.tool.end", (e) => {
    events.push(e as AgentEvent);
  });
  bus.subscribe("agent.error", (e) => {
    events.push(e as AgentEvent);
  });
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunner", () => {
  describe("single-turn no tools", () => {
    it("should return response directly when no tools are available", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () => textResult("Hello! How can I help?", 10, 5),
      });

      const runner = new AgentRunner(model);
      const agent = makeAgent();

      const result = await runner.run(agent, "Hi");

      expect(result.response).toBe("Hello! How can I help?");
      expect(result.finishReason).toBe("stop");
      expect(result.iterations).toBe(1);
      expect(result.toolCallsCount).toBe(0);
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
    });
  });

  describe("single-turn with tools", () => {
    it("should execute tool and return final response", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            // First call: return tool call
            return toolCallResult(
              { toolCallId: "tc-1", toolName: "get_weather", input: { city: "Seattle" } },
              20,
              10,
            );
          }
          // Second call: return final text
          return textResult("The weather in Seattle is rainy.", 30, 15);
        },
      });

      const weatherSchema = z.object({ city: z.string() });
      const tools = [ToolSchema.fromZod("get_weather", "Get weather info", weatherSchema)];
      const agent = makeAgent({ getTools: () => tools });

      const executor = makeToolExecutor(async (_name, args) => ({
        weather: "rainy",
        city: args.city,
      }));

      const runner = new AgentRunner(model);
      const result = await runner.run(agent, "What's the weather?", {
        toolExecutor: executor,
      });

      expect(result.response).toBe("The weather in Seattle is rainy.");
      expect(result.toolCallsCount).toBe(1);
      expect(result.iterations).toBe(2);
      expect(result.inputTokens).toBe(50); // 20 + 30
      expect(result.outputTokens).toBe(25); // 10 + 15
    });
  });

  describe("multi-iteration tool loop", () => {
    it("should handle tool -> response -> tool -> response chain", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              { toolCallId: "tc-1", toolName: "search", input: { query: "weather" } },
              10,
              5,
            );
          }
          if (callCount === 2) {
            return toolCallResult(
              { toolCallId: "tc-2", toolName: "format", input: { data: "raw-result" } },
              15,
              8,
            );
          }
          return textResult("Here is the formatted result.", 20, 12);
        },
      });

      const searchSchema = z.object({ query: z.string() });
      const formatSchema = z.object({ data: z.string() });
      const tools = [
        ToolSchema.fromZod("search", "Search for info", searchSchema),
        ToolSchema.fromZod("format", "Format data", formatSchema),
      ];
      const agent = makeAgent({ getTools: () => tools });

      const executor = makeToolExecutor(async (name) => ({ tool: name, result: "ok" }));
      const runner = new AgentRunner(model);

      const result = await runner.run(agent, "Search and format", {
        toolExecutor: executor,
      });

      expect(result.response).toBe("Here is the formatted result.");
      expect(result.toolCallsCount).toBe(2);
      expect(result.iterations).toBe(3);
    });
  });

  describe("max iterations", () => {
    it("should return gracefully with finishReason max_iterations", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () =>
          toolCallResult({ toolCallId: "tc-loop", toolName: "infinite_tool", input: {} }, 5, 3),
      });

      const toolSchema = z.object({});
      const tools = [ToolSchema.fromZod("infinite_tool", "Never stops", toolSchema)];
      const agent = makeAgent({ getTools: () => tools });

      const executor = makeToolExecutor(async () => "still going");
      const runner = new AgentRunner(model);

      const result = await runner.run(agent, "Go!", {
        toolExecutor: executor,
        maxIterations: 3,
      });

      expect(result.finishReason).toBe("max_iterations");
      expect(result.iterations).toBe(3);
      expect(result.toolCallsCount).toBe(3);
      expect(result.response).toBe("");
    });

    // #117: the max-iterations exit now emits a terminal message.complete
    // (previously silent) — a bus-finish hook has nothing to finalize on
    // otherwise and the run row would stay 'running' forever.
    it("should emit a terminal message.complete with finishReason max_iterations", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () =>
          toolCallResult({ toolCallId: "tc-loop", toolName: "infinite_tool", input: {} }, 5, 3),
      });

      const toolSchema = z.object({});
      const tools = [ToolSchema.fromZod("infinite_tool", "Never stops", toolSchema)];
      const agent = makeAgent({ getTools: () => tools });

      const executor = makeToolExecutor(async () => "still going");
      const bus = new AgentEventBus();
      const events = collectEvents(bus);
      const runner = new AgentRunner(model, bus);

      await runner.run(agent, "Go!", { toolExecutor: executor, maxIterations: 3 });

      const complete = events.find((e) => e.type === "agent.message.complete");
      expect(complete).toBeDefined();
      expect((complete as { content: string }).content).toBe("");
      expect((complete as { finishReason?: string }).finishReason).toBe("max_iterations");
      expect((complete as { inputTokens: number }).inputTokens).toBe(15); // 5 * 3
      expect((complete as { outputTokens: number }).outputTokens).toBe(9); // 3 * 3
    });
  });

  describe("parallel tool execution", () => {
    it("should execute multiple tools concurrently", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallsResult(
              [
                { toolCallId: "tc-a", toolName: "tool_a", input: {} },
                { toolCallId: "tc-b", toolName: "tool_b", input: {} },
              ],
              10,
              5,
            );
          }
          return textResult("Both tools completed.", 20, 10);
        },
      });

      const schema = z.object({});
      const tools = [
        ToolSchema.fromZod("tool_a", "Tool A", schema),
        ToolSchema.fromZod("tool_b", "Tool B", schema),
      ];
      const agent = makeAgent({ getTools: () => tools });

      const executionOrder: string[] = [];
      const executor = makeToolExecutor(async (name) => {
        executionOrder.push(`start:${name}`);
        // Both should start before either finishes in parallel execution
        executionOrder.push(`end:${name}`);
        return { tool: name };
      });

      const runner = new AgentRunner(model);
      const result = await runner.run(agent, "Run both", {
        toolExecutor: executor,
      });

      expect(result.toolCallsCount).toBe(2);
      expect(result.response).toBe("Both tools completed.");
    });
  });

  describe("event emission", () => {
    it("should emit events in correct order for simple run", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () => textResult("Done!", 10, 5),
      });

      const bus = new AgentEventBus();
      const events = collectEvents(bus);
      const agent = makeAgent();
      const runner = new AgentRunner(model, bus);

      await runner.run(agent, "Hello");

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toEqual([
        "agent.message.start",
        "agent.iteration.start",
        "agent.llm.start",
        "agent.llm.end",
        "agent.iteration.end",
        "agent.message.complete",
      ]);
    });

    // #117: message.start now carries the rendered system prompt (no other
    // event does), and message.complete carries the authoritative finishReason.
    it("should stamp systemPrompt on message.start and finishReason on message.complete", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () => textResult("Done!", 10, 5),
      });

      const bus = new AgentEventBus();
      const events = collectEvents(bus);
      const agent = makeAgent();
      const runner = new AgentRunner(model, bus);

      await runner.run(agent, "Hello");

      const start = events.find((e) => e.type === "agent.message.start");
      expect((start as { systemPrompt?: string }).systemPrompt).toBe(
        "You are a helpful assistant.",
      );

      const complete = events.find((e) => e.type === "agent.message.complete");
      expect((complete as { finishReason?: string }).finishReason).toBe("stop");
    });

    it("should emit tool events for tool calls", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              { toolCallId: "tc-1", toolName: "my_tool", input: { key: "val" } },
              10,
              5,
            );
          }
          return textResult("Done.", 15, 8);
        },
      });

      const bus = new AgentEventBus();
      const events = collectEvents(bus);
      const schema = z.object({ key: z.string() });
      const tools = [ToolSchema.fromZod("my_tool", "A tool", schema)];
      const agent = makeAgent({ getTools: () => tools });

      const executor = makeToolExecutor(async () => "result");
      const runner = new AgentRunner(model, bus);

      await runner.run(agent, "Use tool", { toolExecutor: executor });

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("agent.tool.intent");
      expect(eventTypes).toContain("agent.tool.start");
      expect(eventTypes).toContain("agent.tool.end");
    });

    it("stamps displayType on tool.start/end when the schema declares it, omits the key otherwise", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallsResult(
              [
                { toolCallId: "tc-1", toolName: "edit_file", input: { path: "a.ts" } },
                { toolCallId: "tc-2", toolName: "search", input: { q: "x" } },
              ],
              10,
              5,
            );
          }
          return textResult("Done.", 15, 8);
        },
      });

      const bus = new AgentEventBus();
      const events = collectEvents(bus);
      const tools = [
        ToolSchema.fromZod(
          "edit_file",
          "Edit a file",
          z.object({ path: z.string() }),
          undefined,
          undefined,
          "diff",
        ),
        ToolSchema.fromZod("search", "Search", z.object({ q: z.string() })),
      ];
      const agent = makeAgent({ getTools: () => tools });
      const executor = makeToolExecutor(async () => "result");
      const runner = new AgentRunner(model, bus);

      await runner.run(agent, "Use tools", { toolExecutor: executor });

      const starts = events.filter((e) => e.type === "agent.tool.start");
      const ends = events.filter((e) => e.type === "agent.tool.end");

      const editStart = starts.find((e) => (e as { toolCallId?: string }).toolCallId === "tc-1");
      const searchStart = starts.find((e) => (e as { toolCallId?: string }).toolCallId === "tc-2");
      const editEnd = ends.find((e) => (e as { toolCallId?: string }).toolCallId === "tc-1");
      const searchEnd = ends.find((e) => (e as { toolCallId?: string }).toolCallId === "tc-2");

      expect((editStart as { displayType?: string }).displayType).toBe("diff");
      expect((editEnd as { displayType?: string }).displayType).toBe("diff");
      expect(searchStart).not.toHaveProperty("displayType");
      expect(searchEnd).not.toHaveProperty("displayType");
    });
  });

  describe("token counting", () => {
    it("should accumulate tokens across iterations", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult({ toolCallId: "tc-1", toolName: "tool", input: {} }, 100, 50);
          }
          return textResult("Final.", 200, 75);
        },
      });

      const schema = z.object({});
      const tools = [ToolSchema.fromZod("tool", "Tool", schema)];
      const agent = makeAgent({ getTools: () => tools });

      const executor = makeToolExecutor(async () => "ok");
      const runner = new AgentRunner(model);

      const result = await runner.run(agent, "Go", { toolExecutor: executor });

      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(125);
    });
  });

  describe("tool executor error handling", () => {
    it("should handle tool execution errors gracefully", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              { toolCallId: "tc-1", toolName: "failing_tool", input: {} },
              10,
              5,
            );
          }
          return textResult("I see the tool failed.", 20, 10);
        },
      });

      const schema = z.object({});
      const tools = [ToolSchema.fromZod("failing_tool", "Tool that fails", schema)];
      const agent = makeAgent({ getTools: () => tools });

      const executor = makeToolExecutor(async () => {
        throw new Error("Tool execution failed!");
      });
      const runner = new AgentRunner(model);

      const result = await runner.run(agent, "Use tool", { toolExecutor: executor });

      // Runner should continue after tool error
      expect(result.response).toBe("I see the tool failed.");
      expect(result.toolCallsCount).toBe(1);
    });

    it("should handle missing tool executor", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult({ toolCallId: "tc-1", toolName: "my_tool", input: {} }, 10, 5);
          }
          return textResult("No executor available.", 20, 10);
        },
      });

      const schema = z.object({});
      const tools = [ToolSchema.fromZod("my_tool", "A tool", schema)];
      const agent = makeAgent({ getTools: () => tools });

      const runner = new AgentRunner(model);
      // No toolExecutor passed
      const result = await runner.run(agent, "Use tool");

      expect(result.response).toBe("No executor available.");
      expect(result.toolCallsCount).toBe(1);
    });
  });

  describe("gate integration", () => {
    it("should throw ToolCallBlocked when gate blocks", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () =>
          toolCallResult(
            { toolCallId: "tc-blocked", toolName: "dangerous_tool", input: {} },
            10,
            5,
          ),
      });

      const schema = z.object({});
      const tools = [ToolSchema.fromZod("dangerous_tool", "Dangerous", schema)];
      const agent = makeAgent({ getTools: () => tools });

      const bus = new AgentEventBus();
      // Add a gate that blocks everything
      bus.addGate({
        name: "BlockAll",
        category: 0,
        categoryName: "SAFETY",
        check: async () => ({ action: "block" as const, reason: "Not allowed" }),
        getBlockReason: () => "Not allowed",
      });

      const runner = new AgentRunner(model, bus);

      await expect(runner.run(agent, "Do something dangerous")).rejects.toThrow(ToolCallBlocked);
    });

    it("allows tool calls when a gate permits and nothing subscribes to agent.tool.intent (regression)", async () => {
      // Regression for the unsound `results.length > 0` gate-allow heuristic.
      // With a gate attached and NO subscriber on agent.tool.intent, an allowed
      // intent must execute — not be treated as blocked. Do NOT attach
      // collectEvents() here: it subscribes to agent.tool.intent and would mask
      // the bug by making publish() return a non-empty handler list.
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              { toolCallId: "tc-allowed", toolName: "safe_tool", input: {} },
              10,
              5,
            );
          }
          return textResult("Done.", 20, 10);
        },
      });

      const schema = z.object({});
      const tools = [ToolSchema.fromZod("safe_tool", "Safe", schema)];
      const agent = makeAgent({ getTools: () => tools });

      const bus = new AgentEventBus();
      // An allow gate: present (so gates.length > 0) but never blocks.
      bus.addGate({
        name: "AllowAll",
        category: 0,
        categoryName: "SAFETY",
        check: async () => ({ action: "allow" as const }),
        getBlockReason: () => "",
      });

      let toolRan = false;
      const executor = makeToolExecutor(async () => {
        toolRan = true;
        return { ok: true };
      });

      const runner = new AgentRunner(model, bus);
      const result = await runner.run(agent, "Use safe tool", { toolExecutor: executor });

      expect(toolRan).toBe(true);
      expect(result.toolCallsCount).toBe(1);
      expect(result.response).toBe("Done.");
    });
  });

  describe("ToolCallBlocked error", () => {
    it("should have correct properties", () => {
      const error = new ToolCallBlocked("my_tool", "Unsafe operation");
      expect(error.toolName).toBe("my_tool");
      expect(error.reason).toBe("Unsafe operation");
      expect(error.name).toBe("ToolCallBlocked");
      expect(error.message).toBe("Tool call 'my_tool' blocked: Unsafe operation");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("ToolExecutionContext threading (#102, m.a)", () => {
    it("builds a correlated ctx for each dispatched tool call", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              { toolCallId: "tc-correlated-1", toolName: "get_weather", input: { city: "NYC" } },
              10,
              5,
            );
          }
          return textResult("It's sunny.", 5, 5);
        },
      });

      const weatherSchema = z.object({ city: z.string() });
      const tools = [ToolSchema.fromZod("get_weather", "Get weather", weatherSchema)];
      const agent = makeAgent({ getTools: () => tools });

      const capturedCtx: ToolExecutionContext[] = [];
      const executor: ToolExecutor = {
        execute: async (_name, _args, ctx) => {
          if (ctx) capturedCtx.push(ctx);
          return { weather: "sunny" };
        },
      };

      const bus = new AgentEventBus();
      const progressEvents: AgentEvent[] = [];
      bus.subscribe("agent.tool.progress", (e) => progressEvents.push(e as AgentEvent));

      const runner = new AgentRunner(model, bus);
      await runner.run(agent, "weather?", { toolExecutor: executor, traceId: "trace-abc" });

      expect(capturedCtx).toHaveLength(1);
      expect(capturedCtx[0]?.traceId).toBe("trace-abc");
      expect(capturedCtx[0]?.runId).toBeTruthy();
      expect(capturedCtx[0]?.parentToolCallId).toBe("tc-correlated-1");

      // Channel B: ctx.emit publishes a real, correlated agent.tool.progress event.
      capturedCtx[0]?.emit?.({ type: "progress", data: { statusText: "halfway" } });
      await Promise.resolve(); // let the fire-and-forget publish settle
      expect(progressEvents).toHaveLength(1);
      const progress = progressEvents[0] as unknown as {
        toolCallId: string;
        statusText: string;
        traceId: string;
      };
      expect(progress.toolCallId).toBe("tc-correlated-1");
      expect(progress.statusText).toBe("halfway");
      expect(progress.traceId).toBe("trace-abc");
    });

    it("execute(name, args) with no toolExecutor ctx support still works (backward compat)", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              { toolCallId: "tc-legacy-1", toolName: "get_weather", input: { city: "LA" } },
              10,
              5,
            );
          }
          return textResult("It's cloudy.", 5, 5);
        },
      });
      const weatherSchema = z.object({ city: z.string() });
      const tools = [ToolSchema.fromZod("get_weather", "Get weather", weatherSchema)];
      const agent = makeAgent({ getTools: () => tools });

      // Legacy 2-arg-only executor — ignores the 3rd ctx arg entirely.
      const legacyExecutor: ToolExecutor = {
        execute: async (_name, args) => ({ weather: "cloudy", city: args.city }),
      };

      const runner = new AgentRunner(model);
      const result = await runner.run(agent, "weather?", { toolExecutor: legacyExecutor });

      expect(result.toolCallsCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // #124 — `RunOptions.host` relay onto every `ToolExecutionContext` a
  // dispatch site builds. `buildToolCtx` is the single copy site; each
  // dispatch path (run()'s manual loop, runStructured()'s SDK-driven
  // convertExecutableTools loop, stream() — covered in
  // agent-runner-stream.test.ts) only relays `options.host` unchanged.
  // ---------------------------------------------------------------------------
  describe("RunOptions.host relay (#124)", () => {
    it("run(): ctx.host === options.host on the dispatched tool call", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              { toolCallId: "tc-host-1", toolName: "get_weather", input: { city: "NYC" } },
              10,
              5,
            );
          }
          return textResult("sunny", 5, 5);
        },
      });
      const tools = [
        ToolSchema.fromZod("get_weather", "Get weather", z.object({ city: z.string() })),
      ];
      const agent = makeAgent({ getTools: () => tools });

      const sentinelHost = { scratchpad: "fake-scratchpad-marker" };
      const capturedCtx: ToolExecutionContext[] = [];
      const executor: ToolExecutor = {
        execute: async (_name, _args, ctx) => {
          if (ctx) capturedCtx.push(ctx);
          return { weather: "sunny" };
        },
      };

      const runner = new AgentRunner(model);
      await runner.run(agent, "weather?", { toolExecutor: executor, host: sentinelHost });

      expect(capturedCtx).toHaveLength(1);
      expect(capturedCtx[0]?.host).toBe(sentinelHost);
    });

    it("run(): omitting options.host yields ctx.host === undefined (no accidental default)", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              { toolCallId: "tc-host-2", toolName: "get_weather", input: { city: "NYC" } },
              10,
              5,
            );
          }
          return textResult("sunny", 5, 5);
        },
      });
      const tools = [
        ToolSchema.fromZod("get_weather", "Get weather", z.object({ city: z.string() })),
      ];
      const agent = makeAgent({ getTools: () => tools });

      const capturedCtx: ToolExecutionContext[] = [];
      const executor: ToolExecutor = {
        execute: async (_name, _args, ctx) => {
          if (ctx) capturedCtx.push(ctx);
          return { weather: "sunny" };
        },
      };

      const runner = new AgentRunner(model);
      await runner.run(agent, "weather?", { toolExecutor: executor });

      expect(capturedCtx).toHaveLength(1);
      expect(capturedCtx[0]?.host).toBeUndefined();
    });

    it("run(): readScope(ctx) reads a session scope value relayed via RunOptions.host.scope (#308)", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              { toolCallId: "tc-host-scope-1", toolName: "get_weather", input: { city: "NYC" } },
              10,
              5,
            );
          }
          return textResult("sunny", 5, 5);
        },
      });
      const tools = [
        ToolSchema.fromZod("get_weather", "Get weather", z.object({ city: z.string() })),
      ];
      const agent = makeAgent({ getTools: () => tools });

      const parsedScope = { workspace: "acme", user: "sam@acme.dev" };
      const capturedCtx: ToolExecutionContext[] = [];
      const executor: ToolExecutor = {
        execute: async (_name, _args, ctx) => {
          if (ctx) capturedCtx.push(ctx);
          return { weather: "sunny" };
        },
      };

      const runner = new AgentRunner(model);
      await runner.run(agent, "weather?", {
        toolExecutor: executor,
        host: buildScopeHost(parsedScope),
      });

      expect(capturedCtx).toHaveLength(1);
      expect(readScope(capturedCtx[0])).toEqual(parsedScope);
    });

    it("runStructured() (capable model → convertExecutableTools): ctx.host === options.host on the dispatched tool call", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        modelId: "gpt-4o",
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              {
                toolCallId: "tc-host-structured-1",
                toolName: "get_weather",
                input: { city: "NYC" },
              },
              10,
              5,
            );
          }
          return textResult(JSON.stringify({ weather: "sunny" }), 5, 5);
        },
      });
      const tools = [
        ToolSchema.fromZod("get_weather", "Get weather", z.object({ city: z.string() })),
      ];
      const agent = makeAgent({ getModel: () => "gpt-4o", getTools: () => tools });

      const sentinelHost = { scratchpad: "fake-scratchpad-marker" };
      const capturedCtx: ToolExecutionContext[] = [];
      const executor: ToolExecutor = {
        execute: async (_name, _args, ctx) => {
          if (ctx) capturedCtx.push(ctx);
          return { weather: "sunny" };
        },
      };

      const runner = new AgentRunner(model);
      const schema = z.object({ weather: z.string() });
      const result = await runner.runStructured(agent, "weather?", schema, {
        toolExecutor: executor,
        host: sentinelHost,
      });

      expect(result.object).toEqual({ weather: "sunny" });
      expect(capturedCtx).toHaveLength(1);
      expect(capturedCtx[0]?.host).toBe(sentinelHost);
    });
  });

  // #308 PR-3 — the render seam: the runner narrows RunOptions.host.scope
  // into a RenderContext and passes it to agent.renderInitialPrompt() at
  // every call site. Spy on the ctx argument directly (as opposed to the
  // #124 block above, which spies on ToolExecutionContext.host).
  describe("renderInitialPrompt render-ctx relay (#308)", () => {
    it("run(): delivers {scope} to renderInitialPrompt when RunOptions.host carries one", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () => textResult("hi there", 5, 5),
      });
      const parsedScope = { workspace: "acme", user: "sam@acme.dev" };
      const capturedCtx: Array<{ scope?: Record<string, unknown> } | undefined> = [];
      const agent = makeAgent({
        renderInitialPrompt: (ctx) => {
          capturedCtx.push(ctx);
          return "system prompt";
        },
      });

      const runner = new AgentRunner(model);
      await runner.run(agent, "hello", { host: buildScopeHost(parsedScope) });

      expect(capturedCtx).toEqual([{ scope: parsedScope }]);
    });

    it("run(): delivers undefined to renderInitialPrompt when RunOptions.host carries no scope", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () => textResult("hi there", 5, 5),
      });
      const capturedCtx: Array<{ scope?: Record<string, unknown> } | undefined> = [];
      const agent = makeAgent({
        renderInitialPrompt: (ctx) => {
          capturedCtx.push(ctx);
          return "system prompt";
        },
      });

      const runner = new AgentRunner(model);
      await runner.run(agent, "hello");

      expect(capturedCtx).toEqual([undefined]);
    });

    it("runStructured(): delivers {scope} to renderInitialPrompt when RunOptions.host carries one", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () => textResult(JSON.stringify({ ok: true }), 10, 5),
      });
      const parsedScope = { workspace: "acme", user: "sam@acme.dev" };
      const capturedCtx: Array<{ scope?: Record<string, unknown> } | undefined> = [];
      const agent = makeAgent({
        renderInitialPrompt: (ctx) => {
          capturedCtx.push(ctx);
          return "system prompt";
        },
      });
      const schema = z.object({ ok: z.boolean() });

      const runner = new AgentRunner(model);
      await runner.runStructured(agent, "hello", schema, { host: buildScopeHost(parsedScope) });

      expect(capturedCtx).toEqual([{ scope: parsedScope }]);
    });

    it("runStructured(): delivers undefined to renderInitialPrompt when RunOptions.host carries no scope", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () => textResult(JSON.stringify({ ok: true }), 10, 5),
      });
      const capturedCtx: Array<{ scope?: Record<string, unknown> } | undefined> = [];
      const agent = makeAgent({
        renderInitialPrompt: (ctx) => {
          capturedCtx.push(ctx);
          return "system prompt";
        },
      });
      const schema = z.object({ ok: z.boolean() });

      const runner = new AgentRunner(model);
      await runner.runStructured(agent, "hello", schema);

      expect(capturedCtx).toEqual([undefined]);
    });
  });

  // #117: message.start now carries systemPrompt (mirroring run()), and
  // message.complete carries the authoritative finishReason.
  describe("runStructured() event stamping (#117)", () => {
    it("stamps systemPrompt on message.start and finishReason on message.complete", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () => textResult(JSON.stringify({ ok: true }), 10, 5),
      });

      const bus = new AgentEventBus();
      const events = collectEvents(bus);
      const agent = makeAgent();
      const runner = new AgentRunner(model, bus);
      const schema = z.object({ ok: z.boolean() });

      await runner.runStructured(agent, "Hello", schema);

      const start = events.find((e) => e.type === "agent.message.start");
      expect((start as { systemPrompt?: string }).systemPrompt).toBe(
        "You are a helpful assistant.",
      );

      const complete = events.find((e) => e.type === "agent.message.complete");
      expect((complete as { finishReason?: string }).finishReason).toBe("stop");
    });

    it("stamps displayType on tool.start/end via convertExecutableTools (capable model), omits the key when undeclared", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV2({
        modelId: "gpt-4o",
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return toolCallResult(
              { toolCallId: "tc-structured-1", toolName: "edit_file", input: { path: "a.ts" } },
              10,
              5,
            );
          }
          return textResult(JSON.stringify({ ok: true }), 5, 5);
        },
      });
      const tools = [
        ToolSchema.fromZod(
          "edit_file",
          "Edit a file",
          z.object({ path: z.string() }),
          undefined,
          undefined,
          "diff",
        ),
      ];
      const agent = makeAgent({ getModel: () => "gpt-4o", getTools: () => tools });

      const bus = new AgentEventBus();
      const events = collectEvents(bus);
      const executor: ToolExecutor = { execute: async () => "diff --git a/a.ts b/a.ts" };
      const runner = new AgentRunner(model, bus);
      const schema = z.object({ ok: z.boolean() });

      await runner.runStructured(agent, "edit it", schema, { toolExecutor: executor });

      const start = events.find((e) => e.type === "agent.tool.start");
      const end = events.find((e) => e.type === "agent.tool.end");
      expect((start as { displayType?: string }).displayType).toBe("diff");
      expect((end as { displayType?: string }).displayType).toBe("diff");
    });
  });

  // Terminal tools (ToolDefinition.terminal): a successful call ends the raw
  // tool loop — the tool's result IS the run's final response. The explicit
  // exit for a bare tool-loop agent, vs the implicit "reply with no tool call".
  describe("terminal-tool exit", () => {
    const finishSchema = z.object({ summary: z.string() });
    const finishTool = ToolSchema.fromZod("finish", "Signal done", finishSchema, undefined, true);

    it("ends the loop on a successful terminal call — the tool result is the response", async () => {
      // The model tool-calls on EVERY iteration: without the terminal exit this
      // run would burn maxIterations and finish as "max_iterations".
      const model = new MockLanguageModelV2({
        doGenerate: async () =>
          toolCallResult(
            { toolCallId: "tc-1", toolName: "finish", input: { summary: "covered 3 facets" } },
            20,
            10,
          ),
      });
      const agent = makeAgent({ getTools: () => [finishTool] });
      const executor = makeToolExecutor(async (_name, args) => args.summary);

      const runner = new AgentRunner(model);
      const result = await runner.run(agent, "Gather", {
        toolExecutor: executor,
        maxIterations: 5,
      });

      expect(result.finishReason).toBe("terminal_tool");
      expect(result.response).toBe("covered 3 facets");
      expect(result.iterations).toBe(1);
      expect(result.toolCallsCount).toBe(1);
    });

    it("serializes a non-string terminal result as JSON", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () =>
          toolCallResult(
            { toolCallId: "tc-1", toolName: "finish", input: { summary: "done" } },
            20,
            10,
          ),
      });
      const agent = makeAgent({ getTools: () => [finishTool] });
      const executor = makeToolExecutor(async () => ({ facets: 3, gaps: 0 }));

      const runner = new AgentRunner(model);
      const result = await runner.run(agent, "Gather", { toolExecutor: executor });

      expect(result.finishReason).toBe("terminal_tool");
      expect(result.response).toBe(JSON.stringify({ facets: 3, gaps: 0 }));
    });

    it("T6 — runStructured uses a schema-valid terminal result without a tier-2 pass", async () => {
      const terminalResult = {
        summary: "covered 3 facets",
        citationKeys: ["observation:5"],
      };
      const outputSchema = z.object({
        summary: z.string(),
        citationKeys: z.array(z.string()),
      });
      let llmCalls = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          llmCalls++;
          return toolCallResult(
            { toolCallId: "tc-t6", toolName: "finish", input: { summary: "done" } },
            20,
            10,
          );
        },
      });
      const agent = makeAgent({ getTools: () => [finishTool] });
      const executor = makeToolExecutor(async () => terminalResult);

      const runner = new AgentRunner(model);
      const result = await runner.runStructured(agent, "Gather", outputSchema, {
        toolExecutor: executor,
      });

      expect(llmCalls).toBe(1);
      expect(result.object).toEqual(terminalResult);
      expect(result.finishReason).toBe("terminal_tool");
      expect(result.inputTokens).toBe(20);
      expect(result.outputTokens).toBe(10);
      expect(result.iterations).toBe(1);
    });

    it("T7 — runStructured falls back to tier 2 when the terminal result is invalid", async () => {
      const tier2Result = { summary: "normalized by tier 2" };
      const outputSchema = z.object({ summary: z.string() });
      let llmCalls = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          llmCalls++;
          if (llmCalls === 1) {
            return toolCallResult(
              { toolCallId: "tc-t7", toolName: "finish", input: { summary: "done" } },
              20,
              10,
            );
          }
          return textResult(JSON.stringify(tier2Result), 30, 15);
        },
      });
      const agent = makeAgent({ getTools: () => [finishTool] });
      const executor = makeToolExecutor(async () => ({ summary: 42 }));

      const runner = new AgentRunner(model);
      const result = await runner.runStructured(agent, "Gather", outputSchema, {
        toolExecutor: executor,
      });

      expect(llmCalls).toBe(2);
      expect(result.object).toEqual(tier2Result);
      expect(result.inputTokens).toBe(50);
      expect(result.outputTokens).toBe(25);
      expect(result.iterations).toBe(2);
    });

    it("T8a — accepts a JSON-looking terminal string as the raw candidate", async () => {
      let llmCalls = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          llmCalls++;
          return toolCallResult(
            { toolCallId: "tc-t8a", toolName: "finish", input: { summary: "done" } },
            20,
            10,
          );
        },
      });
      const agent = makeAgent({ getTools: () => [finishTool] });
      const executor = makeToolExecutor(async () => "42");

      const runner = new AgentRunner(model);
      const result = await runner.runStructured(agent, "Gather", z.string(), {
        toolExecutor: executor,
      });

      expect(llmCalls).toBe(1);
      expect(result.object).toBe("42");
      expect(result.finishReason).toBe("terminal_tool");
      expect(result.inputTokens).toBe(20);
      expect(result.outputTokens).toBe(10);
    });

    it("T8b — accepts a stringified object through the parsed candidate", async () => {
      const terminalResult = { summary: "done" };
      let llmCalls = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          llmCalls++;
          return toolCallResult(
            { toolCallId: "tc-t8b", toolName: "finish", input: { summary: "done" } },
            20,
            10,
          );
        },
      });
      const agent = makeAgent({ getTools: () => [finishTool] });
      const executor = makeToolExecutor(async () => JSON.stringify(terminalResult));

      const runner = new AgentRunner(model);
      const result = await runner.runStructured(agent, "Gather", finishSchema, {
        toolExecutor: executor,
      });

      expect(llmCalls).toBe(1);
      expect(result.object).toEqual(terminalResult);
      expect(result.finishReason).toBe("terminal_tool");
    });

    it("does NOT terminate on an errored terminal call — the model sees the error and corrects", async () => {
      let llmCalls = 0;
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          llmCalls++;
          if (llmCalls === 1) {
            return toolCallResult(
              { toolCallId: "tc-1", toolName: "finish", input: { summary: "too early" } },
              20,
              10,
            );
          }
          return textResult("recovered with a plain reply", 30, 15);
        },
      });
      const agent = makeAgent({ getTools: () => [finishTool] });
      const executor = makeToolExecutor(async () => {
        throw new Error("not done yet — facet 2 uncovered");
      });

      const runner = new AgentRunner(model);
      const result = await runner.run(agent, "Gather", {
        toolExecutor: executor,
        maxIterations: 5,
      });

      expect(result.finishReason).toBe("stop");
      expect(result.response).toBe("recovered with a plain reply");
      expect(result.iterations).toBe(2);
    });

    it("executes the whole batch before exiting when ordinary + terminal calls mix", async () => {
      const executed: string[] = [];
      const model = new MockLanguageModelV2({
        doGenerate: async () =>
          toolCallsResult(
            [
              { toolCallId: "tc-1", toolName: "search", input: { q: "risks" } },
              {
                toolCallId: "tc-2",
                toolName: "finish",
                input: { summary: "one search, then done" },
              },
            ],
            20,
            10,
          ),
      });
      const searchTool = ToolSchema.fromZod("search", "Search", z.object({ q: z.string() }));
      const agent = makeAgent({ getTools: () => [searchTool, finishTool] });
      const executor = makeToolExecutor(async (name, args) => {
        executed.push(name);
        return name === "finish" ? (args.summary as string) : { rows: 2 };
      });

      const runner = new AgentRunner(model);
      const result = await runner.run(agent, "Gather", { toolExecutor: executor });

      expect(executed.sort()).toEqual(["finish", "search"]);
      expect(result.finishReason).toBe("terminal_tool");
      expect(result.response).toBe("one search, then done");
      expect(result.toolCallsCount).toBe(2);
    });

    it("emits iteration.end (hasMore=false) and message.complete (terminal_tool)", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () =>
          toolCallResult(
            { toolCallId: "tc-1", toolName: "finish", input: { summary: "done" } },
            20,
            10,
          ),
      });
      const bus = new AgentEventBus();
      const events = collectEvents(bus);
      const agent = makeAgent({ getTools: () => [finishTool] });
      const executor = makeToolExecutor(async (_name, args) => args.summary);

      const runner = new AgentRunner(model, bus);
      await runner.run(agent, "Gather", { toolExecutor: executor });

      const iterEnd = events.find((e) => e.type === "agent.iteration.end");
      expect((iterEnd as { hasMore?: boolean }).hasMore).toBe(false);

      const complete = events.find((e) => e.type === "agent.message.complete");
      expect((complete as { finishReason?: string }).finishReason).toBe("terminal_tool");
      expect((complete as { content?: string }).content).toBe("done");
    });

    // BOUNDED COMPLETION: the first errored terminal call continues (test
    // above), but a terminal tool that KEEPS erroring must not burn every
    // remaining iteration and return an empty "max_iterations" response.
    it("ends as terminal_tool_error on the SECOND errored terminal call — does not burn to max_iterations", async () => {
      // The model tool-calls finish on every iteration; the tool always throws.
      const model = new MockLanguageModelV2({
        doGenerate: async () =>
          toolCallResult(
            { toolCallId: "tc-1", toolName: "finish", input: { summary: "done?" } },
            20,
            10,
          ),
      });
      const agent = makeAgent({ getTools: () => [finishTool] });
      const executor = makeToolExecutor(async () => {
        throw new Error("facet 2 still uncovered");
      });

      const runner = new AgentRunner(model);
      const result = await runner.run(agent, "Gather", {
        toolExecutor: executor,
        maxIterations: 20,
      });

      expect(result.finishReason).toBe("terminal_tool_error");
      // The response carries the error so a lost summary isn't silently dropped.
      expect(result.response).toContain("facet 2 still uncovered");
      expect(result.response).toContain("finish");
      // Bounded: it stops on the second attempt, nowhere near maxIterations.
      expect(result.iterations).toBe(2);
    });

    it("emits message.complete (terminal_tool_error) with the error text as content", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () =>
          toolCallResult(
            { toolCallId: "tc-1", toolName: "finish", input: { summary: "done?" } },
            20,
            10,
          ),
      });
      const bus = new AgentEventBus();
      const events = collectEvents(bus);
      const agent = makeAgent({ getTools: () => [finishTool] });
      const executor = makeToolExecutor(async () => {
        throw new Error("still uncovered");
      });

      const runner = new AgentRunner(model, bus);
      await runner.run(agent, "Gather", { toolExecutor: executor, maxIterations: 20 });

      const complete = events.find((e) => e.type === "agent.message.complete");
      expect((complete as { finishReason?: string }).finishReason).toBe("terminal_tool_error");
      expect((complete as { content?: string }).content).toBe("still uncovered");
      // No max_iterations completion was emitted.
      const maxIter = events.find(
        (e) =>
          e.type === "agent.message.complete" &&
          (e as { finishReason?: string }).finishReason === "max_iterations",
      );
      expect(maxIter).toBeUndefined();
    });

    it("terminal errors ONCE then succeeds — clean terminal_tool exit (correct-and-retry still works)", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: async () =>
          toolCallResult(
            { toolCallId: "tc-1", toolName: "finish", input: { summary: "done" } },
            20,
            10,
          ),
      });
      const agent = makeAgent({ getTools: () => [finishTool] });
      let calls = 0;
      const executor = makeToolExecutor(async (_name, args) => {
        calls++;
        if (calls === 1) throw new Error("too early");
        return args.summary as string;
      });

      const runner = new AgentRunner(model);
      const result = await runner.run(agent, "Gather", {
        toolExecutor: executor,
        maxIterations: 5,
      });

      expect(result.finishReason).toBe("terminal_tool");
      expect(result.response).toBe("done");
      expect(result.iterations).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // #341 amendment — the human gate's Q1 override: run() and runStructured()
  // ALSO honor RunOptions.abortSignal (cheap top-of-iteration checks), not
  // just stream(). abortSignal must never be silently ignored on any
  // RunOptions path.
  // ---------------------------------------------------------------------------
  describe("abortSignal (#341 amendment)", () => {
    describe("run()", () => {
      it("pre-aborted signal: returns (never throws) with finishReason 'cancelled' — no LLM call at all", async () => {
        const controller = new AbortController();
        controller.abort();

        const model = new MockLanguageModelV2({
          doGenerate: async () => {
            throw new Error("doGenerate must never be called for a pre-aborted signal");
          },
        });

        const runner = new AgentRunner(model);
        const agent = makeAgent();

        const result = await runner.run(agent, "Hi", { abortSignal: controller.signal });

        expect(result.finishReason).toBe("cancelled");
        expect(result.response).toBe("");
        expect(result.iterations).toBe(0);
      });

      it("aborts between iterations: the tool executor fires controller.abort() during iteration 0's execute — no second LLM call", async () => {
        const controller = new AbortController();
        let llmCalls = 0;

        const model = new MockLanguageModelV2({
          doGenerate: async () => {
            llmCalls++;
            return toolCallResult({ toolCallId: "tc-1", toolName: "loopy", input: {} }, 5, 3);
          },
        });

        const loopSchema = z.object({});
        const tools = [ToolSchema.fromZod("loopy", "Loop tool", loopSchema)];
        const agent = makeAgent({ getTools: () => tools });

        const executor = makeToolExecutor(async () => {
          controller.abort();
          return "ok";
        });

        const runner = new AgentRunner(model);
        const result = await runner.run(agent, "loop", {
          abortSignal: controller.signal,
          toolExecutor: executor,
          maxIterations: 10,
        });

        expect(llmCalls).toBe(1);
        expect(result.finishReason).toBe("cancelled");
        expect(result.iterations).toBe(1);
      });

      it("emits a message.complete with finishReason 'cancelled' — collectors/exporters still see a terminal event", async () => {
        const controller = new AbortController();
        controller.abort();

        const model = new MockLanguageModelV2({
          doGenerate: async () => {
            throw new Error("doGenerate must never be called for a pre-aborted signal");
          },
        });

        const bus = new AgentEventBus();
        const events = collectEvents(bus);
        const runner = new AgentRunner(model, bus);
        const agent = makeAgent();

        await runner.run(agent, "Hi", { abortSignal: controller.signal });

        const complete = events.find((e) => e.type === "agent.message.complete");
        expect(complete).toBeDefined();
        expect((complete as { finishReason?: string }).finishReason).toBe("cancelled");
        // No "cancelled" conversation-level event — run() has no
        // conversationId (that pairing is stream()'s / Conversation.stream's
        // concern); message.complete alone is the honest terminal signal here.
        expect(events.map((e) => e.type)).not.toContain("agent.conversation.end");
      });
    });

    describe("runStructured()", () => {
      it("pre-aborted signal: throws RunCancelledError before any LLM call (no schema-valid object to return)", async () => {
        const controller = new AbortController();
        controller.abort();

        const model = new MockLanguageModelV2({
          doGenerate: async () => {
            throw new Error("doGenerate must never be called for a pre-aborted signal");
          },
        });

        const runner = new AgentRunner(model);
        const agent = makeAgent();
        const schema = z.object({ answer: z.string() });

        await expect(
          runner.runStructured(agent, "Hi", schema, { abortSignal: controller.signal }),
        ).rejects.toThrow(RunCancelledError);
      });

      it("tier-1 delegate (tools + incapable model) cancelled mid-loop: throws RunCancelledError rather than feeding an empty tier-1 response into tier 2", async () => {
        const controller = new AbortController();
        let llmCalls = 0;

        const model = new MockLanguageModelV2({
          doGenerate: async () => {
            llmCalls++;
            return toolCallResult({ toolCallId: "tc-1", toolName: "loopy", input: {} }, 5, 3);
          },
        });

        const loopSchema = z.object({});
        const tools = [ToolSchema.fromZod("loopy", "Loop tool", loopSchema)];
        // "test-model" (makeAgent's default) is not in the capable-model
        // table (modelSupportsToolsWithStructuredOutput) — this always takes
        // the tools+incapable 2-tier fallback, whose tier 1 IS a run() call.
        const agent = makeAgent({ getTools: () => tools });

        const executor = makeToolExecutor(async () => {
          controller.abort();
          return "ok";
        });

        const runner = new AgentRunner(model);
        const schema = z.object({ answer: z.string() });

        await expect(
          runner.runStructured(agent, "loop", schema, {
            abortSignal: controller.signal,
            toolExecutor: executor,
          }),
        ).rejects.toThrow(RunCancelledError);

        // Only tier 1's single LLM call happened — tier 2 was never reached.
        expect(llmCalls).toBe(1);
      });
    });
  });
});
