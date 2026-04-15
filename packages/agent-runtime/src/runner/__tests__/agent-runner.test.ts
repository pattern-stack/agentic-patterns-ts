/**
 * Tests for AgentRunner using MockLanguageModelV1.
 */

import { ToolSchema } from "@pattern-stack/agent-core";
import { MockLanguageModelV1 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent } from "../../events/types.js";
import { AgentRunner, ToolCallBlocked } from "../agent-runner.js";
import type { AgentLike } from "../agent-runner.js";
import type { ToolExecutor } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    role: { name: "test-agent" },
    getModel: () => "test-model",
    getTools: () => [],
    getSystemPrompt: () => "You are a helpful assistant.",
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          text: "Hello! How can I help?",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            // First call: return tool call
            return {
              toolCalls: [
                {
                  toolCallType: "function" as const,
                  toolCallId: "tc-1",
                  toolName: "get_weather",
                  args: JSON.stringify({ city: "Seattle" }),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: { promptTokens: 20, completionTokens: 10 },
              rawCall: { rawPrompt: null, rawSettings: {} },
            };
          }
          // Second call: return final text
          return {
            text: "The weather in Seattle is rainy.",
            finishReason: "stop" as const,
            usage: { promptTokens: 30, completionTokens: 15 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              toolCalls: [
                {
                  toolCallType: "function" as const,
                  toolCallId: "tc-1",
                  toolName: "search",
                  args: JSON.stringify({ query: "weather" }),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: { promptTokens: 10, completionTokens: 5 },
              rawCall: { rawPrompt: null, rawSettings: {} },
            };
          }
          if (callCount === 2) {
            return {
              toolCalls: [
                {
                  toolCallType: "function" as const,
                  toolCallId: "tc-2",
                  toolName: "format",
                  args: JSON.stringify({ data: "raw-result" }),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: { promptTokens: 15, completionTokens: 8 },
              rawCall: { rawPrompt: null, rawSettings: {} },
            };
          }
          return {
            text: "Here is the formatted result.",
            finishReason: "stop" as const,
            usage: { promptTokens: 20, completionTokens: 12 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          toolCalls: [
            {
              toolCallType: "function" as const,
              toolCallId: "tc-loop",
              toolName: "infinite_tool",
              args: JSON.stringify({}),
            },
          ],
          finishReason: "tool-calls" as const,
          usage: { promptTokens: 5, completionTokens: 3 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              toolCalls: [
                {
                  toolCallType: "function" as const,
                  toolCallId: "tc-a",
                  toolName: "tool_a",
                  args: JSON.stringify({}),
                },
                {
                  toolCallType: "function" as const,
                  toolCallId: "tc-b",
                  toolName: "tool_b",
                  args: JSON.stringify({}),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: { promptTokens: 10, completionTokens: 5 },
              rawCall: { rawPrompt: null, rawSettings: {} },
            };
          }
          return {
            text: "Both tools completed.",
            finishReason: "stop" as const,
            usage: { promptTokens: 20, completionTokens: 10 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          text: "Done!",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              toolCalls: [
                {
                  toolCallType: "function" as const,
                  toolCallId: "tc-1",
                  toolName: "my_tool",
                  args: JSON.stringify({ key: "val" }),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: { promptTokens: 10, completionTokens: 5 },
              rawCall: { rawPrompt: null, rawSettings: {} },
            };
          }
          return {
            text: "Done.",
            finishReason: "stop" as const,
            usage: { promptTokens: 15, completionTokens: 8 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              toolCalls: [
                {
                  toolCallType: "function" as const,
                  toolCallId: "tc-1",
                  toolName: "tool",
                  args: JSON.stringify({}),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: { promptTokens: 100, completionTokens: 50 },
              rawCall: { rawPrompt: null, rawSettings: {} },
            };
          }
          return {
            text: "Final.",
            finishReason: "stop" as const,
            usage: { promptTokens: 200, completionTokens: 75 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              toolCalls: [
                {
                  toolCallType: "function" as const,
                  toolCallId: "tc-1",
                  toolName: "failing_tool",
                  args: JSON.stringify({}),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: { promptTokens: 10, completionTokens: 5 },
              rawCall: { rawPrompt: null, rawSettings: {} },
            };
          }
          return {
            text: "I see the tool failed.",
            finishReason: "stop" as const,
            usage: { promptTokens: 20, completionTokens: 10 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              toolCalls: [
                {
                  toolCallType: "function" as const,
                  toolCallId: "tc-1",
                  toolName: "my_tool",
                  args: JSON.stringify({}),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: { promptTokens: 10, completionTokens: 5 },
              rawCall: { rawPrompt: null, rawSettings: {} },
            };
          }
          return {
            text: "No executor available.",
            finishReason: "stop" as const,
            usage: { promptTokens: 20, completionTokens: 10 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
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
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          toolCalls: [
            {
              toolCallType: "function" as const,
              toolCallId: "tc-blocked",
              toolName: "dangerous_tool",
              args: JSON.stringify({}),
            },
          ],
          finishReason: "tool-calls" as const,
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
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
