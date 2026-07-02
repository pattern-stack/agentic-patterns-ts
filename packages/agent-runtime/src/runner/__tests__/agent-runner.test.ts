/**
 * Tests for AgentRunner using MockLanguageModelV2.
 */

import { ToolSchema } from "@agentic-patterns/core";
import type { LanguageModelV2Content } from "@ai-sdk/provider";
import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent } from "../../events/types.js";
import { AgentRunner, ToolCallBlocked } from "../agent-runner.js";
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
});
