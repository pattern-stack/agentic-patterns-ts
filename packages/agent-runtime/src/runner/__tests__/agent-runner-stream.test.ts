/**
 * Tests for AgentRunner.stream() using MockLanguageModelV1.
 */

import { ToolSchema } from "@agentic-patterns/core";
import { MockLanguageModelV1 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent } from "../../events/types.js";
import { AgentRunner } from "../agent-runner.js";
import type { AgentLike } from "../agent-runner.js";

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

async function collectStream(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function eventTypes(events: AgentEvent[]): string[] {
  return events.map((e) => e.type);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunner.stream()", () => {
  it("streams a simple response with no tools", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Hello " });
            controller.enqueue({ type: "text-delta", textDelta: "world!" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 10, completionTokens: 5 },
            });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent();

    const events = await collectStream(runner.stream(agent, "Hi"));
    const types = eventTypes(events);

    // Check lifecycle order
    expect(types[0]).toBe("agent.conversation.start");
    expect(types[1]).toBe("agent.message.start");
    expect(types[2]).toBe("agent.iteration.start");
    expect(types[3]).toBe("agent.llm.start");

    // Check we got message chunks
    const chunks = events.filter((e) => e.type === "agent.message.chunk");
    expect(chunks.length).toBe(2);

    // Check we got llm.end
    expect(types).toContain("agent.llm.end");
    expect(types).toContain("agent.iteration.end");
    expect(types).toContain("agent.message.complete");
    expect(types).toContain("agent.conversation.end");

    // Check message.complete has content
    const complete = events.find((e) => e.type === "agent.message.complete");
    expect((complete as { content: string }).content).toBe("Hello world!");

    // Check conversation.end has reason
    const convEnd = events.find((e) => e.type === "agent.conversation.end");
    expect((convEnd as { reason: string }).reason).toBe("completed");
  });

  it("handles tool calls and continues iteration", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallType: "function",
                  toolCallId: "tc-1",
                  toolName: "calculator",
                  args: '{"value": 42}',
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { promptTokens: 10, completionTokens: 5 },
                });
                controller.close();
              },
            }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-delta", textDelta: "Result is 42" });
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { promptTokens: 20, completionTokens: 10 },
              });
              controller.close();
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });

    const calcSchema = z.object({ value: z.number() });
    const tools = [ToolSchema.fromZod("calculator", "Calculate", calcSchema)];
    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent({ getTools: () => tools });

    const events = await collectStream(
      runner.stream(agent, "What is 42?", {
        toolExecutor: { execute: async (_name, _args) => 42 },
      }),
    );

    const types = eventTypes(events);

    // Should have tool lifecycle events
    expect(types).toContain("agent.tool.intent");
    expect(types).toContain("agent.tool.start");
    expect(types).toContain("agent.tool.end");

    // Should have two iterations
    const iterStarts = events.filter((e) => e.type === "agent.iteration.start");
    expect(iterStarts.length).toBe(2);

    // Should end with complete + conversation.end
    expect(types).toContain("agent.message.complete");
    expect(types).toContain("agent.conversation.end");
  });

  it("handles LLM error during streaming", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => {
        throw new Error("LLM connection failed");
      },
    });

    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent();

    const events = await collectStream(runner.stream(agent, "Hi"));
    const types = eventTypes(events);

    // Should have error and conversation.end with error reason
    expect(types).toContain("agent.error");
    expect(types).toContain("agent.conversation.end");

    const convEnd = events.find((e) => e.type === "agent.conversation.end");
    expect((convEnd as { reason: string }).reason).toBe("error");
  });

  it("emits events to the event bus as well as yielding them", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Hi" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 2 },
            });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const bus = new AgentEventBus();
    const busEvents: string[] = [];
    bus.subscribe("agent.message.start", () => {
      busEvents.push("agent.message.start");
    });
    bus.subscribe("agent.message.complete", () => {
      busEvents.push("agent.message.complete");
    });

    const runner = new AgentRunner(model, bus);
    const agent = makeAgent();

    await collectStream(runner.stream(agent, "Hi"));

    expect(busEvents).toContain("agent.message.start");
    expect(busEvents).toContain("agent.message.complete");
  });

  it("emits thinking.start + reasoning deltas + reasoning complete around text", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "reasoning", textDelta: "Let me think" });
            controller.enqueue({ type: "reasoning", textDelta: " about this" });
            controller.enqueue({ type: "text-delta", textDelta: "The answer" });
            controller.enqueue({ type: "text-delta", textDelta: " is 42" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 10, completionTokens: 5 },
            });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent();

    const events = await collectStream(runner.stream(agent, "Hi"));

    // Exactly one thinking.start
    const thinkingStarts = events.filter((e) => e.type === "agent.thinking.start");
    expect(thinkingStarts.length).toBe(1);

    // Reasoning events: 2 deltas + 1 complete
    const reasoningEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: "agent.reasoning" }> => e.type === "agent.reasoning",
    );
    expect(reasoningEvents.length).toBe(3);
    expect(reasoningEvents[0]?.isComplete).toBe(false);
    expect(reasoningEvents[0]?.content).toBe("Let me think");
    expect(reasoningEvents[1]?.isComplete).toBe(false);
    expect(reasoningEvents[1]?.content).toBe(" about this");
    expect(reasoningEvents[2]?.isComplete).toBe(true);
    expect(reasoningEvents[2]?.content).toBe("Let me think about this");

    // Text chunks still flow
    const chunks = events.filter((e) => e.type === "agent.message.chunk");
    expect(chunks.length).toBe(2);

    // Ordering: thinking.start -> first reasoning delta ->
    //           reasoning (isComplete=true) -> first message.chunk -> message.complete
    const thinkingStartIdx = events.findIndex((e) => e.type === "agent.thinking.start");
    const firstReasoningDeltaIdx = events.findIndex(
      (e) => e.type === "agent.reasoning" && !e.isComplete,
    );
    const reasoningCompleteIdx = events.findIndex(
      (e) => e.type === "agent.reasoning" && e.isComplete,
    );
    const firstChunkIdx = events.findIndex((e) => e.type === "agent.message.chunk");
    const messageCompleteIdx = events.findIndex((e) => e.type === "agent.message.complete");
    expect(thinkingStartIdx).toBeGreaterThan(-1);
    expect(firstReasoningDeltaIdx).toBeGreaterThan(thinkingStartIdx);
    expect(reasoningCompleteIdx).toBeGreaterThan(firstReasoningDeltaIdx);
    expect(firstChunkIdx).toBeGreaterThan(reasoningCompleteIdx);
    expect(messageCompleteIdx).toBeGreaterThan(firstChunkIdx);

    // message.complete content is just the text, not the reasoning
    const complete = events.find((e) => e.type === "agent.message.complete");
    expect((complete as { content: string }).content).toBe("The answer is 42");
  });

  it("closes reasoning block before tool call, then opens a new block after", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "reasoning", textDelta: "First I need" });
                controller.enqueue({ type: "reasoning", textDelta: " the weather" });
                controller.enqueue({
                  type: "tool-call",
                  toolCallType: "function",
                  toolCallId: "tc-1",
                  toolName: "weather",
                  args: '{"city": "SF"}',
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { promptTokens: 10, completionTokens: 5 },
                });
                controller.close();
              },
            }),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "reasoning", textDelta: "Now I can answer" });
              controller.enqueue({ type: "text-delta", textDelta: "Sunny" });
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { promptTokens: 20, completionTokens: 10 },
              });
              controller.close();
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });

    const weatherSchema = z.object({ city: z.string() });
    const tools = [ToolSchema.fromZod("weather", "Get weather", weatherSchema)];
    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent({ getTools: () => tools });

    const events = await collectStream(
      runner.stream(agent, "weather?", {
        toolExecutor: { execute: async () => ({ forecast: "sunny" }) },
      }),
    );

    // Two distinct thinking.start events — one per reasoning block.
    const thinkingStarts = events.filter((e) => e.type === "agent.thinking.start");
    expect(thinkingStarts.length).toBe(2);

    // The first reasoning-complete must come before the first tool.intent.
    const firstReasoningCompleteIdx = events.findIndex(
      (e) => e.type === "agent.reasoning" && e.isComplete,
    );
    const firstToolIntentIdx = events.findIndex((e) => e.type === "agent.tool.intent");
    expect(firstReasoningCompleteIdx).toBeGreaterThan(-1);
    expect(firstToolIntentIdx).toBeGreaterThan(firstReasoningCompleteIdx);

    // Both reasoning blocks close — 2 completed reasoning events with the
    // correct accumulated content per block.
    const completedReasoning = events.filter(
      (e): e is Extract<AgentEvent, { type: "agent.reasoning" }> =>
        e.type === "agent.reasoning" && e.isComplete,
    );
    expect(completedReasoning.length).toBe(2);
    expect(completedReasoning[0]?.content).toBe("First I need the weather");
    expect(completedReasoning[1]?.content).toBe("Now I can answer");
  });

  it("respects max iterations", async () => {
    const calcSchema = z.object({ x: z.number() });
    const tools = [ToolSchema.fromZod("loopy", "Loop tool", calcSchema)];

    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: "tool-call",
              toolCallType: "function",
              toolCallId: `tc-${Date.now()}`,
              toolName: "loopy",
              args: '{"x": 1}',
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { promptTokens: 5, completionTokens: 2 },
            });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent({ getTools: () => tools });

    const events = await collectStream(
      runner.stream(agent, "loop", {
        maxIterations: 2,
        toolExecutor: { execute: async () => "ok" },
      }),
    );

    const iterStarts = events.filter((e) => e.type === "agent.iteration.start");
    expect(iterStarts.length).toBe(2);

    const convEnd = events.find((e) => e.type === "agent.conversation.end");
    expect(convEnd).toBeDefined();
  });
});
