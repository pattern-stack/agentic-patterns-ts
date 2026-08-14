/**
 * Tests for AgentRunner.stream() using MockLanguageModelV3.
 */

import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { ToolSchema } from "@pattern-stack/agentic-core";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent } from "../../events/types.js";
import { buildScopeHost } from "../../workflows/scope-host.js";
import { AgentRunner } from "../agent-runner.js";
import type { AgentLike } from "../agent-runner.js";

// ---------------------------------------------------------------------------
// Mock stream helpers — emit PROVIDER-level LanguageModelV3 stream parts. The
// AI SDK transforms these into the higher-level `.stream` parts the runner
// consumes (e.g. provider `text-delta {delta}` -> SDK `text-delta {text}`).
// ---------------------------------------------------------------------------

const TXT = "txt-0";
const RSN = "rsn-0";

/** Wrap a list of provider stream parts in a doStream return (with stream-start). */
function streamFrom(parts: LanguageModelV3StreamPart[]) {
  return async () => ({
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    }),
  });
}

/**
 * V3 provider usage — nested input/output token detail (unlike v5's flat
 * shape). `details` (#388) optionally overrides cache/reasoning members;
 * omitted members default to the flat totals (defined, not absent) —
 * matching this fixture's pre-#388 shape exactly when `details` is omitted.
 */
function usageV3(
  inputTokens: number,
  outputTokens: number,
  details?: { cacheRead?: number; cacheWrite?: number; reasoning?: number },
): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: details?.cacheRead,
      cacheWrite: details?.cacheWrite,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: details?.reasoning,
    },
  };
}

/** V3 provider finish reason — `{ unified, raw }` (unlike v5's bare string). */
function finishReasonV3(
  unified: LanguageModelV3FinishReason["unified"],
): LanguageModelV3FinishReason {
  return { unified, raw: unified };
}

/** A provider `finish` part with V3 usage + finishReason shape. */
function finishPart(
  finishReason: LanguageModelV3FinishReason["unified"],
  inputTokens: number,
  outputTokens: number,
  details?: { cacheRead?: number; cacheWrite?: number; reasoning?: number },
): LanguageModelV3StreamPart {
  return {
    type: "finish",
    finishReason: finishReasonV3(finishReason),
    usage: usageV3(inputTokens, outputTokens, details),
  };
}

/** Text deltas grouped by a stable id (text-start/delta…/text-end). */
function textParts(...deltas: string[]): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: TXT },
    ...deltas.map((delta): LanguageModelV3StreamPart => ({ type: "text-delta", id: TXT, delta })),
    { type: "text-end", id: TXT },
  ];
}

/** Reasoning deltas grouped by a stable id (reasoning-start/delta…/end). */
function reasoningParts(...deltas: string[]): LanguageModelV3StreamPart[] {
  return [
    { type: "reasoning-start", id: RSN },
    ...deltas.map(
      (delta): LanguageModelV3StreamPart => ({ type: "reasoning-delta", id: RSN, delta }),
    ),
    { type: "reasoning-end", id: RSN },
  ];
}

/** A single tool-call provider part (`input` is a stringified JSON object). */
function toolCallPart(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3StreamPart {
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
    const model = new MockLanguageModelV3({
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
    const model = new MockLanguageModelV3({
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

  it("stamps displayType on tool.start/end when the schema declares it, omits the key otherwise", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        callCount++;
        if (callCount === 1) {
          return streamFrom([
            toolCallPart("tc-1", "edit_file", { path: "a.ts" }),
            toolCallPart("tc-2", "search", { q: "x" }),
            finishPart("tool-calls", 10, 5),
          ])();
        }
        return streamFrom([...textParts("Done."), finishPart("stop", 20, 10)])();
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
      ToolSchema.fromZod("search", "Search", z.object({ q: z.string() })),
    ];
    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent({ getTools: () => tools });

    const events = await collectStream(
      runner.stream(agent, "Use tools", {
        toolExecutor: { execute: async () => "result" },
      }),
    );

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

  it("handles LLM error during streaming", async () => {
    const model = new MockLanguageModelV3({
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
    const model = new MockLanguageModelV3({
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
    const model = new MockLanguageModelV3({
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
    const model = new MockLanguageModelV3({
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

    const model = new MockLanguageModelV3({
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

    // #117: max-iterations now yields a terminal message.complete before
    // conversation.end (previously silent on this path).
    const types = eventTypes(events);
    const completeIdx = types.indexOf("agent.message.complete");
    const convEndIdx = types.indexOf("agent.conversation.end");
    expect(completeIdx).toBeGreaterThan(-1);
    expect(convEndIdx).toBeGreaterThan(completeIdx);

    const complete = events.find((e) => e.type === "agent.message.complete");
    expect((complete as { finishReason?: string }).finishReason).toBe("max_iterations");
  });

  // #117: message.start now carries systemPrompt + agentConfig on stream(),
  // for parity with run()/runStructured() (previously agentName only).
  it("stamps systemPrompt + agentConfig on message.start", async () => {
    const model = new MockLanguageModelV3({
      doStream: streamFrom([...textParts("Hi"), finishPart("stop", 5, 2)]),
    });

    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent();

    const events = await collectStream(runner.stream(agent, "Hi"));
    const start = events.find((e) => e.type === "agent.message.start");

    expect((start as { systemPrompt?: string }).systemPrompt).toBe("You are a helpful assistant.");
    expect((start as { agentConfig?: { role: string } }).agentConfig?.role).toBe("test-agent");
  });

  // ---------------------------------------------------------------------------
  // #124 — `RunOptions.host` relay onto the `ToolExecutionContext` stream()'s
  // dispatch site builds (the 3rd of 3 `buildToolCtx` dispatch sites).
  // ---------------------------------------------------------------------------
  it("relays RunOptions.host onto the dispatched tool call's ToolExecutionContext (#124)", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        callCount++;
        if (callCount === 1) {
          return streamFrom([
            toolCallPart("tc-host-stream-1", "weather", { city: "SF" }),
            finishPart("tool-calls", 10, 5),
          ])();
        }
        return streamFrom([...textParts("Sunny"), finishPart("stop", 20, 10)])();
      },
    });

    const weatherSchema = z.object({ city: z.string() });
    const tools = [ToolSchema.fromZod("weather", "Get weather", weatherSchema)];
    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent({ getTools: () => tools });

    const sentinelHost = { scratchpad: "fake-scratchpad-marker" };
    const capturedCtx: Array<{ host?: unknown } | undefined> = [];

    await collectStream(
      runner.stream(agent, "weather?", {
        toolExecutor: {
          execute: async (_name, _args, ctx) => {
            capturedCtx.push(ctx);
            return { forecast: "sunny" };
          },
        },
        host: sentinelHost,
      }),
    );

    expect(capturedCtx).toHaveLength(1);
    expect(capturedCtx[0]?.host).toBe(sentinelHost);
  });

  // ---------------------------------------------------------------------------
  // #308 PR-3 — the render seam: stream() narrows RunOptions.host.scope into a
  // RenderContext for renderInitialPrompt(), the 3rd of 3 call sites.
  // ---------------------------------------------------------------------------
  it("delivers {scope} to renderInitialPrompt when RunOptions.host carries one (#308)", async () => {
    const model = new MockLanguageModelV3({
      doStream: streamFrom([...textParts("Hello"), finishPart("stop", 10, 5)]),
    });
    const parsedScope = { workspace: "acme", user: "sam@acme.dev" };
    const capturedCtx: Array<{ scope?: Record<string, unknown> } | undefined> = [];
    const runner = new AgentRunner(model);
    const agent = makeAgent({
      renderInitialPrompt: (ctx) => {
        capturedCtx.push(ctx);
        return "system prompt";
      },
    });

    await collectStream(runner.stream(agent, "Hi", { host: buildScopeHost(parsedScope) }));

    expect(capturedCtx).toEqual([{ scope: parsedScope }]);
  });

  it("delivers undefined to renderInitialPrompt when RunOptions.host carries no scope (#308)", async () => {
    const model = new MockLanguageModelV3({
      doStream: streamFrom([...textParts("Hello"), finishPart("stop", 10, 5)]),
    });
    const capturedCtx: Array<{ scope?: Record<string, unknown> } | undefined> = [];
    const runner = new AgentRunner(model);
    const agent = makeAgent({
      renderInitialPrompt: (ctx) => {
        capturedCtx.push(ctx);
        return "system prompt";
      },
    });

    await collectStream(runner.stream(agent, "Hi"));

    expect(capturedCtx).toEqual([undefined]);
  });

  // Terminal-tool exit — parity with run(): a successful terminal call ends
  // the stream; the tool's result is the final message content.
  it("ends the stream after a successful terminal call with finishReason terminal_tool", async () => {
    // The model tool-calls on EVERY iteration: without the terminal exit this
    // stream would burn maxIterations.
    const model = new MockLanguageModelV3({
      doStream: async () =>
        streamFrom([
          toolCallPart("tc-1", "finish", { summary: "all facets covered" }),
          finishPart("tool-calls", 10, 5),
        ])(),
    });

    const finishSchema = z.object({ summary: z.string() });
    const tools = [ToolSchema.fromZod("finish", "Signal done", finishSchema, undefined, true)];
    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent({ getTools: () => tools });

    const events = await collectStream(
      runner.stream(agent, "Gather", {
        toolExecutor: { execute: async (_name, args) => args.summary },
        maxIterations: 3,
      }),
    );

    const iterStarts = events.filter((e) => e.type === "agent.iteration.start");
    expect(iterStarts.length).toBe(1);

    const iterEnd = events.find((e) => e.type === "agent.iteration.end");
    expect((iterEnd as { hasMore?: boolean }).hasMore).toBe(false);

    const complete = events.find((e) => e.type === "agent.message.complete");
    expect((complete as { finishReason?: string }).finishReason).toBe("terminal_tool");
    expect((complete as { content?: string }).content).toBe("all facets covered");

    const convEnd = events.find((e) => e.type === "agent.conversation.end");
    expect((convEnd as { reason?: string }).reason).toBe("completed");
  });

  // BOUNDED COMPLETION (parity with run()): a terminal tool that keeps erroring
  // ends the stream as terminal_tool_error on the SECOND failure rather than
  // burning to max_iterations.
  it("ends the stream as terminal_tool_error on the SECOND errored terminal call", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () =>
        streamFrom([
          toolCallPart("tc-1", "finish", { summary: "done?" }),
          finishPart("tool-calls", 10, 5),
        ])(),
    });

    const finishSchema = z.object({ summary: z.string() });
    const tools = [ToolSchema.fromZod("finish", "Signal done", finishSchema, undefined, true)];
    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent({ getTools: () => tools });

    const events = await collectStream(
      runner.stream(agent, "Gather", {
        toolExecutor: {
          execute: async () => {
            throw new Error("facet 2 still uncovered");
          },
        },
        maxIterations: 20,
      }),
    );

    // Bounded: exactly two iterations (first continues, second ends).
    const iterStarts = events.filter((e) => e.type === "agent.iteration.start");
    expect(iterStarts.length).toBe(2);

    const iterEnd = events.filter((e) => e.type === "agent.iteration.end").at(-1);
    expect((iterEnd as { hasMore?: boolean }).hasMore).toBe(false);

    const complete = events.find((e) => e.type === "agent.message.complete");
    expect((complete as { finishReason?: string }).finishReason).toBe("terminal_tool_error");
    expect((complete as { content?: string }).content).toBe("facet 2 still uncovered");

    const convEnd = events.find((e) => e.type === "agent.conversation.end");
    expect((convEnd as { reason?: string }).reason).toBe("completed");
  });

  it("stream: terminal errors ONCE then succeeds — clean terminal_tool exit", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () =>
        streamFrom([
          toolCallPart("tc-1", "finish", { summary: "done" }),
          finishPart("tool-calls", 10, 5),
        ])(),
    });

    const finishSchema = z.object({ summary: z.string() });
    const tools = [ToolSchema.fromZod("finish", "Signal done", finishSchema, undefined, true)];
    const bus = new AgentEventBus();
    const runner = new AgentRunner(model, bus);
    const agent = makeAgent({ getTools: () => tools });

    let calls = 0;
    const events = await collectStream(
      runner.stream(agent, "Gather", {
        toolExecutor: {
          execute: async (_name, args) => {
            calls++;
            if (calls === 1) throw new Error("too early");
            return args.summary;
          },
        },
        maxIterations: 5,
      }),
    );

    const iterStarts = events.filter((e) => e.type === "agent.iteration.start");
    expect(iterStarts.length).toBe(2);

    const complete = events.find((e) => e.type === "agent.message.complete");
    expect((complete as { finishReason?: string }).finishReason).toBe("terminal_tool");
    expect((complete as { content?: string }).content).toBe("done");
  });

  // ---------------------------------------------------------------------------
  // #341 — RunOptions.abortSignal: stream() wiring. Runner owns cancel
  // emission (locked D1) — `agent.message.cancel` + `agent.conversation.end
  // {reason:"cancelled"}` — and RETURNS, never throws.
  // ---------------------------------------------------------------------------
  describe("abortSignal (#341)", () => {
    it("pre-aborted signal: conversation.start, message.start, then the cancel pair — no llm.start, generator returns (never throws)", async () => {
      const controller = new AbortController();
      controller.abort();

      const model = new MockLanguageModelV3({
        doStream: async () => {
          throw new Error("doStream must never be called for a pre-aborted signal");
        },
      });

      const bus = new AgentEventBus();
      const runner = new AgentRunner(model, bus);
      const agent = makeAgent();

      const events = await collectStream(
        runner.stream(agent, "Hi", { abortSignal: controller.signal }),
      );
      const types = eventTypes(events);

      expect(types).toEqual([
        "agent.conversation.start",
        "agent.message.start",
        "agent.message.cancel",
        "agent.conversation.end",
      ]);
      expect(types).not.toContain("agent.llm.start");

      const cancelEv = events.find((e) => e.type === "agent.message.cancel");
      expect((cancelEv as { reason?: string }).reason).toBe("cancelled by client");

      const convEnd = events.find((e) => e.type === "agent.conversation.end");
      expect((convEnd as { reason?: string }).reason).toBe("cancelled");
    });

    it("aborts between iterations: the tool executor fires controller.abort() during iteration 0's execute — no second llm.start, cancel pair emitted", async () => {
      const controller = new AbortController();
      let doStreamCalls = 0;

      const model = new MockLanguageModelV3({
        doStream: async () => {
          doStreamCalls++;
          return streamFrom([
            toolCallPart("tc-1", "loopy", { x: 1 }),
            finishPart("tool-calls", 5, 2),
          ])();
        },
      });

      const loopSchema = z.object({ x: z.number() });
      const tools = [ToolSchema.fromZod("loopy", "Loop tool", loopSchema)];
      const bus = new AgentEventBus();
      const runner = new AgentRunner(model, bus);
      const agent = makeAgent({ getTools: () => tools });

      const events = await collectStream(
        runner.stream(agent, "loop", {
          abortSignal: controller.signal,
          toolExecutor: {
            execute: async () => {
              // Fires mid tool-dispatch — the abort lands strictly between
              // iteration 0's tool call and iteration 1's llm.start.
              controller.abort();
              return "ok";
            },
          },
        }),
      );
      const types = eventTypes(events);

      // Exactly one llm.start (iteration 0's) — the top-of-iteration guard
      // stops a second one from ever firing.
      expect(types.filter((t) => t === "agent.llm.start")).toHaveLength(1);
      expect(doStreamCalls).toBe(1);

      expect(types).toContain("agent.message.cancel");
      expect(types).toContain("agent.conversation.end");
      const convEnd = events.find((e) => e.type === "agent.conversation.end");
      expect((convEnd as { reason?: string }).reason).toBe("cancelled");

      // Iteration 0 completed normally (its one tool call already ran before
      // abort fired) — iteration.end for it is expected. What matters is
      // that iteration 1 never starts at all: no message.complete (only the
      // cancel pair ends the turn), and exactly one llm.start (asserted
      // above).
      expect(types).not.toContain("agent.message.complete");
    });

    it("aborts mid-provider-stream via ai@5's fullStream 'abort' part (provider forwards abortSignal into its own stream, matching real-provider behavior)", async () => {
      const controller = new AbortController();

      const model = new MockLanguageModelV3({
        doStream: async (options: { abortSignal?: AbortSignal }) => ({
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "stream-start", warnings: [] });
              c.enqueue({ type: "text-start", id: TXT });
              c.enqueue({ type: "text-delta", id: TXT, delta: "Hel" });
              // Never closes on its own — a real provider forwards
              // abortSignal into its own fetch()/HTTP client, so aborting
              // ends the underlying stream. ai@5's own `pull()` wrapper then
              // converts the resulting AbortError into a clean
              // `{type:"abort"}` fullStream part (empirically verified
              // against ai@5.0.216 — see spec's dossier).
              options.abortSignal?.addEventListener("abort", () => {
                c.error(new DOMException("The user aborted a request.", "AbortError"));
              });
            },
          }),
        }),
      });

      const bus = new AgentEventBus();
      const runner = new AgentRunner(model, bus);
      const agent = makeAgent();

      const events: AgentEvent[] = [];
      const gen = runner.stream(agent, "Hi", { abortSignal: controller.signal });

      // Drain through the first chunk, then abort mid-stream.
      for (let i = 0; i < 5; i++) {
        const { value, done } = await gen.next();
        if (done) break;
        events.push(value);
        if (value.type === "agent.message.chunk") {
          controller.abort();
        }
      }
      for await (const event of gen) {
        events.push(event);
      }

      const types = eventTypes(events);
      expect(types).toContain("agent.message.cancel");
      expect(types).toContain("agent.conversation.end");
      const convEnd = events.find((e) => e.type === "agent.conversation.end");
      expect((convEnd as { reason?: string }).reason).toBe("cancelled");
      expect(types).not.toContain("agent.message.complete");
    });

    it("belt-and-braces: a provider that throws a raw AbortError (not the SDK's synthesized 'abort' part) still routes to the cancel pair, never the error path", async () => {
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "stream-start", warnings: [] });
              c.enqueue({ type: "text-start", id: TXT });
              c.enqueue({ type: "text-delta", id: TXT, delta: "Hel" });
              // Errors immediately with an AbortError-shaped exception,
              // independent of any RunOptions.abortSignal correlation (ai@5
              // only synthesizes its own clean 'abort' part when its OWN
              // abortSignal is already `.aborted` at the moment the error
              // surfaces — otherwise the raw AbortError propagates to the
              // consumer, per ai@5.0.216's `pull()` — pinned here).
              c.error(new DOMException("The user aborted a request.", "AbortError"));
            },
          }),
        }),
      });

      const bus = new AgentEventBus();
      const runner = new AgentRunner(model, bus);
      const agent = makeAgent();

      // No `abortSignal` at all — proves the guard is keyed on the error's
      // shape (`err.name === "AbortError"`), not solely on our own signal.
      const events = await collectStream(runner.stream(agent, "Hi"));
      const types = eventTypes(events);

      expect(types).toContain("agent.message.cancel");
      expect(types).toContain("agent.conversation.end");
      const convEnd = events.find((e) => e.type === "agent.conversation.end");
      expect((convEnd as { reason?: string }).reason).toBe("cancelled");
      expect(types).not.toContain("agent.error");
    });

    it("pre-tool-dispatch guard: aborting before a SECOND pending tool call in the same batch skips its dispatch and cancels", async () => {
      const controller = new AbortController();
      const dispatched: string[] = [];

      const model = new MockLanguageModelV3({
        doStream: async () =>
          streamFrom([
            toolCallPart("tc-1", "alpha", { x: 1 }),
            toolCallPart("tc-2", "beta", { x: 2 }),
            finishPart("tool-calls", 5, 2),
          ])(),
      });

      const schema = z.object({ x: z.number() });
      const tools = [
        ToolSchema.fromZod("alpha", "Tool A", schema),
        ToolSchema.fromZod("beta", "Tool B", schema),
      ];
      const bus = new AgentEventBus();
      const runner = new AgentRunner(model, bus);
      const agent = makeAgent({ getTools: () => tools });

      const events = await collectStream(
        runner.stream(agent, "go", {
          abortSignal: controller.signal,
          toolExecutor: {
            execute: async (name) => {
              dispatched.push(name);
              if (name === "alpha") {
                // Abort right after the FIRST call in the batch dispatches;
                // the guard must stop the second from ever running.
                controller.abort();
              }
              return "ok";
            },
          },
        }),
      );
      const types = eventTypes(events);

      expect(dispatched).toEqual(["alpha"]);
      expect(types).toContain("agent.message.cancel");
      expect(types).toContain("agent.conversation.end");
      const convEnd = events.find((e) => e.type === "agent.conversation.end");
      expect((convEnd as { reason?: string }).reason).toBe("cancelled");
    });
  });

  // ---------------------------------------------------------------------------
  // ADR-0006 — render-artifact publication + preserved structured terminal
  // output, parity with run()'s dispatch site (the 3rd of 3 `buildToolCtx`
  // call sites).
  // ---------------------------------------------------------------------------
  describe("render artifacts (ADR-0006)", () => {
    it("publishArtifacts: true — published artifacts land on that call's tool.end", async () => {
      const model = new MockLanguageModelV3({
        doStream: async () =>
          streamFrom([
            toolCallPart("tc-1", "weather", { city: "SF" }),
            finishPart("tool-calls", 10, 5),
          ])(),
      });
      const weatherSchema = z.object({ city: z.string() });
      const tools = [ToolSchema.fromZod("weather", "Get weather", weatherSchema)];
      const bus = new AgentEventBus();
      const runner = new AgentRunner(model, bus);
      const agent = makeAgent({ getTools: () => tools });

      const events = await collectStream(
        runner.stream(agent, "weather?", {
          toolExecutor: {
            execute: async (_name, _args, ctx) => {
              ctx?.publishArtifact?.({
                id: "wx:sf",
                displayType: "table",
                data: { columns: ["day"], rows: [["tue"]] },
              });
              return { forecast: "foggy" };
            },
          },
          publishArtifacts: true,
        }),
      );

      const toolEnd = events.find((e) => e.type === "agent.tool.end") as unknown as {
        artifacts?: Array<{ id: string }>;
      };
      expect(toolEnd.artifacts).toEqual([
        { id: "wx:sf", displayType: "table", data: { columns: ["day"], rows: [["tue"]] } },
      ]);
    });

    it("publishArtifacts: false (default) — ctx.publishArtifact is undefined, tool.end carries no artifacts key", async () => {
      const model = new MockLanguageModelV3({
        doStream: async () =>
          streamFrom([
            toolCallPart("tc-1", "weather", { city: "SF" }),
            finishPart("tool-calls", 10, 5),
          ])(),
      });
      const weatherSchema = z.object({ city: z.string() });
      const tools = [ToolSchema.fromZod("weather", "Get weather", weatherSchema)];
      const bus = new AgentEventBus();
      const runner = new AgentRunner(model, bus);
      const agent = makeAgent({ getTools: () => tools });

      const capturedCtx: Array<{ publishArtifact?: unknown } | undefined> = [];
      const events = await collectStream(
        runner.stream(agent, "weather?", {
          toolExecutor: {
            execute: async (_name, _args, ctx) => {
              capturedCtx.push(ctx);
              return { forecast: "foggy" };
            },
          },
        }),
      );

      expect(capturedCtx[0]?.publishArtifact).toBeUndefined();
      const toolEnd = events.find((e) => e.type === "agent.tool.end");
      expect(toolEnd).not.toHaveProperty("artifacts");
    });

    describe("preserved structured terminal output (ADR §9, parity with run())", () => {
      it("attaches structuredContent to message.complete for a structured terminal result, content stays JSON-stringified", async () => {
        const structured = { facets: 3, gaps: 0 };
        const model = new MockLanguageModelV3({
          doStream: async () =>
            streamFrom([
              toolCallPart("tc-1", "finish", { summary: "done" }),
              finishPart("tool-calls", 10, 5),
            ])(),
        });
        const finishSchema = z.object({ summary: z.string() });
        const tools = [ToolSchema.fromZod("finish", "Signal done", finishSchema, undefined, true)];
        const bus = new AgentEventBus();
        const runner = new AgentRunner(model, bus);
        const agent = makeAgent({ getTools: () => tools });

        const events = await collectStream(
          runner.stream(agent, "Gather", {
            toolExecutor: { execute: async () => structured },
          }),
        );

        const complete = events.find((e) => e.type === "agent.message.complete") as unknown as {
          content: string;
          structuredContent?: unknown;
        };
        expect(complete.content).toBe(JSON.stringify(structured));
        expect(complete.structuredContent).toEqual(structured);
      });

      it("omits structuredContent entirely for a string terminal result — byte-identical content", async () => {
        const model = new MockLanguageModelV3({
          doStream: async () =>
            streamFrom([
              toolCallPart("tc-1", "finish", { summary: "all facets covered" }),
              finishPart("tool-calls", 10, 5),
            ])(),
        });
        const finishSchema = z.object({ summary: z.string() });
        const tools = [ToolSchema.fromZod("finish", "Signal done", finishSchema, undefined, true)];
        const bus = new AgentEventBus();
        const runner = new AgentRunner(model, bus);
        const agent = makeAgent({ getTools: () => tools });

        const events = await collectStream(
          runner.stream(agent, "Gather", {
            toolExecutor: { execute: async (_name, args) => args.summary },
          }),
        );

        const complete = events.find((e) => e.type === "agent.message.complete");
        expect((complete as { content?: string }).content).toBe("all facets covered");
        expect(complete).not.toHaveProperty("structuredContent");
      });
    });
  });

  describe("usageDetails (#388) — absent ≠ zero", () => {
    it("a finish part carrying cache/reasoning detail surfaces usageDetails on llm.end and message.complete", async () => {
      const model = new MockLanguageModelV3({
        doStream: streamFrom([
          ...textParts("Hello ", "world!"),
          finishPart("stop", 12000, 320, { cacheRead: 11900, cacheWrite: 0, reasoning: 140 }),
        ]),
      });

      const runner = new AgentRunner(model);
      const agent = makeAgent();

      const events = await collectStream(runner.stream(agent, "Hi"));

      const llmEnd = events.find((e) => e.type === "agent.llm.end") as unknown as {
        usageDetails?: unknown;
      };
      expect(llmEnd.usageDetails).toEqual({
        noCacheTokens: 12000,
        cacheReadTokens: 11900,
        cacheWriteTokens: 0,
        textTokens: 320,
        reasoningTokens: 140,
      });

      const complete = events.find((e) => e.type === "agent.message.complete") as unknown as {
        usageDetails?: unknown;
      };
      expect(complete.usageDetails).toEqual(llmEnd.usageDetails);
    });

    it("a finish part with no detail members (only totals) omits usageDetails entirely on both events", async () => {
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: TXT });
              controller.enqueue({ type: "text-delta", id: TXT, delta: "hi" });
              controller.enqueue({ type: "text-end", id: TXT });
              controller.enqueue({
                type: "finish",
                finishReason: finishReasonV3("stop"),
                usage: {
                  inputTokens: {
                    total: 10,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 5, text: undefined, reasoning: undefined },
                },
              });
              controller.close();
            },
          }),
        }),
      });

      const runner = new AgentRunner(model);
      const agent = makeAgent();

      const events = await collectStream(runner.stream(agent, "Hi"));

      const llmEnd = events.find((e) => e.type === "agent.llm.end");
      expect(llmEnd && "usageDetails" in llmEnd).toBe(false);

      const complete = events.find((e) => e.type === "agent.message.complete");
      expect(complete && "usageDetails" in complete).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Per-call request headers (#406) — stream() path parity with run()/runStructured()
// ---------------------------------------------------------------------------

describe("AgentRunner.stream() — requestHeaders (#406)", () => {
  it("forwards factory + per-run headers into streamText's doStream call", async () => {
    let captured: Record<string, string | undefined> | undefined;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        captured = options.headers;
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: TXT });
              controller.enqueue({ type: "text-delta", id: TXT, delta: "hi" });
              controller.enqueue({ type: "text-end", id: TXT });
              controller.enqueue({
                type: "finish",
                finishReason: finishReasonV3("stop"),
                usage: usageV3(1, 1),
              });
              controller.close();
            },
          }),
        };
      },
    });
    const runner = new AgentRunner(model, undefined, {
      requestHeaders: (ctx) => ({ "x-request-id": ctx.runId }),
    });
    const agent = makeAgent();

    await collectStream(
      runner.stream(agent, "Hi", { requestHeaders: { "x-bf-guardrail-ids": "pii-strict" } }),
    );

    expect(captured?.["x-bf-guardrail-ids"]).toBe("pii-strict");
    expect(captured?.["x-request-id"]).toBeTruthy();
  });
});
