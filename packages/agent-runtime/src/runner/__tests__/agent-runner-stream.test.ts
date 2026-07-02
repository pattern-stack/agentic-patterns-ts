/**
 * Tests for AgentRunner.stream() using MockLanguageModelV2.
 */

import { ToolSchema } from "@agentic-patterns/core";
import type { LanguageModelV2FinishReason, LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent } from "../../events/types.js";
import { AgentRunner } from "../agent-runner.js";
import type { AgentLike } from "../agent-runner.js";

// ---------------------------------------------------------------------------
// v5 mock stream helpers — emit PROVIDER-level LanguageModelV2 stream parts.
// The AI SDK transforms these into the higher-level fullStream parts the
// runner consumes (e.g. provider `text-delta {delta}` -> SDK `text-delta {text}`).
// ---------------------------------------------------------------------------

const TXT = "txt-0";
const RSN = "rsn-0";

/** Wrap a list of provider stream parts in a doStream return (with stream-start). */
function streamFrom(parts: LanguageModelV2StreamPart[]) {
  return async () => ({
    stream: new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    }),
  });
}

/** A provider `finish` part with v5 usage shape. */
function finishPart(
  finishReason: LanguageModelV2FinishReason,
  inputTokens: number,
  outputTokens: number,
): LanguageModelV2StreamPart {
  return {
    type: "finish",
    finishReason,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}

/** Text deltas grouped by a stable id (text-start/delta…/text-end). */
function textParts(...deltas: string[]): LanguageModelV2StreamPart[] {
  return [
    { type: "text-start", id: TXT },
    ...deltas.map((delta): LanguageModelV2StreamPart => ({ type: "text-delta", id: TXT, delta })),
    { type: "text-end", id: TXT },
  ];
}

/** Reasoning deltas grouped by a stable id (reasoning-start/delta…/end). */
function reasoningParts(...deltas: string[]): LanguageModelV2StreamPart[] {
  return [
    { type: "reasoning-start", id: RSN },
    ...deltas.map(
      (delta): LanguageModelV2StreamPart => ({ type: "reasoning-delta", id: RSN, delta }),
    ),
    { type: "reasoning-end", id: RSN },
  ];
}

/** A single tool-call provider part (`input` is a stringified JSON object). */
function toolCallPart(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV2StreamPart {
  return { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) };
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
    const model = new MockLanguageModelV2({
      doStream: streamFrom([...textParts("Hello ", "world!"), finishPart("stop", 10, 5)]),
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
    const model = new MockLanguageModelV2({
      doStream: async () => {
        callCount++;
        if (callCount === 1) {
          return streamFrom([
            toolCallPart("tc-1", "calculator", { value: 42 }),
            finishPart("tool-calls", 10, 5),
          ])();
        }
        return streamFrom([...textParts("Result is 42"), finishPart("stop", 20, 10)])();
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
    const model = new MockLanguageModelV2({
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
    const model = new MockLanguageModelV2({
      doStream: streamFrom([...textParts("Hi"), finishPart("stop", 5, 2)]),
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
    const model = new MockLanguageModelV2({
      doStream: streamFrom([
        ...reasoningParts("Let me think", " about this"),
        ...textParts("The answer", " is 42"),
        finishPart("stop", 10, 5),
      ]),
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
    const model = new MockLanguageModelV2({
      doStream: async () => {
        callCount++;
        if (callCount === 1) {
          return streamFrom([
            ...reasoningParts("First I need", " the weather"),
            toolCallPart("tc-1", "weather", { city: "SF" }),
            finishPart("tool-calls", 10, 5),
          ])();
        }
        return streamFrom([
          ...reasoningParts("Now I can answer"),
          ...textParts("Sunny"),
          finishPart("stop", 20, 10),
        ])();
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

    const model = new MockLanguageModelV2({
      doStream: async () =>
        streamFrom([
          toolCallPart(`tc-${Date.now()}`, "loopy", { x: 1 }),
          finishPart("tool-calls", 5, 2),
        ])(),
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
