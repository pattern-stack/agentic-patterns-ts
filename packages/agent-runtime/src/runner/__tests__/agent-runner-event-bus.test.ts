/**
 * `AgentRunner` — per-call event-bus resolution (#496).
 *
 * `run({eventBus})` used to REBIND the runner: `this._eventBus =
 * options.eventBus`, permanently. With a singleton runner (the NestJS
 * default scope; `createRunner()`), two concurrent calls with different
 * buses interleaved — and because intent evaluation routed through the same
 * mutable field, a gate registered for one bus could adjudicate the other
 * call's tool intents. The bus now resolves ONCE per public call
 * (`options.eventBus ?? constructor bus ?? global singleton`) and is closed
 * over for that call's lifetime; the field is never assigned outside the
 * constructor.
 *
 * The last test DELIBERATELY pins the accompanying behaviour change: a call
 * that omits `eventBus` no longer inherits the bus a previous call passed.
 */

import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolSchema } from "@pattern-stack/agentic-core";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent, ToolCallIntent } from "../../events/types.js";
import { AgentRunner, ToolCallBlocked } from "../agent-runner.js";
import type { AgentLike } from "../agent-runner.js";
import type { ToolExecutor } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures (mirror agent-runner.test.ts's V3 helpers, trimmed to what these
// tests need).
// ---------------------------------------------------------------------------

type V3Result = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

function usageV3(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function textResult(text: string): V3Result {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: usageV3(10, 5),
    warnings: [],
  };
}

function toolCallResult(call: { toolCallId: string; toolName: string }): V3Result {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: JSON.stringify({}),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage: usageV3(10, 5),
    warnings: [],
  };
}

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

/** Subscribe to every event type these runs can produce, into one array. */
function collect(bus: AgentEventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  const types = [
    "agent.message.start",
    "agent.message.complete",
    "agent.iteration.start",
    "agent.iteration.end",
    "agent.llm.start",
    "agent.llm.end",
    "agent.tool.intent",
    "agent.tool.start",
    "agent.tool.end",
    "agent.error",
  ] as const;
  for (const t of types) {
    bus.subscribe(t, (e) => {
      events.push(e as AgentEvent);
    });
  }
  return events;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunner — per-call event bus (#496)", () => {
  it("two concurrent runs on ONE runner with different buses each receive only their own run's events", async () => {
    // Script by prompt content, not call order: RUN-A's (only) response is
    // slow, so RUN-B starts, runs, and completes while A is still mid-call —
    // the exact interleave that used to rebind A's remaining events onto B's
    // bus.
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        if (JSON.stringify(options.prompt).includes("RUN-A")) {
          await sleep(150);
          return textResult("a-done");
        }
        return textResult("b-done");
      },
    });
    const runner = new AgentRunner(model);
    const agent = makeAgent();

    const busA = new AgentEventBus();
    const busB = new AgentEventBus();
    const eventsA = collect(busA);
    const eventsB = collect(busB);

    const [resultA, resultB] = await Promise.all([
      runner.run(agent, "RUN-A", { runId: "run-a", eventBus: busA }),
      (async () => {
        await sleep(25);
        return runner.run(agent, "RUN-B", { runId: "run-b", eventBus: busB });
      })(),
    ]);

    expect(resultA.response).toBe("a-done");
    expect(resultB.response).toBe("b-done");

    // Each bus saw a full run — including the terminal event, which lands
    // AFTER the other run touched the runner.
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
    expect(eventsA.some((e) => e.type === "agent.message.complete")).toBe(true);
    expect(eventsB.some((e) => e.type === "agent.message.complete")).toBe(true);

    // ...and NOTHING from the other run.
    expect(eventsA.every((e) => e.runId === "run-a")).toBe(true);
    expect(eventsB.every((e) => e.runId === "run-b")).toBe(true);
  });

  it("a gate registered on bus A never evaluates bus B's tool intents", async () => {
    const gateSawRunIds: string[] = [];
    const busA = new AgentEventBus();
    busA.addGate({
      name: "BlockAll",
      category: 0,
      categoryName: "SAFETY",
      check: async (event) => {
        gateSawRunIds.push((event as ToolCallIntent).runId);
        return { action: "block" as const, reason: "Not allowed" };
      },
      getBlockReason: () => "Not allowed",
    });
    const busB = new AgentEventBus();

    // RUN-A: slow tool call (evaluated against busA's gate well after RUN-B
    // touched the runner). RUN-B: tool call, then — once its transcript
    // carries tc-b's result — a final text turn.
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const prompt = JSON.stringify(options.prompt);
        if (prompt.includes("RUN-A")) {
          await sleep(150);
          return toolCallResult({ toolCallId: "tc-a", toolName: "the_tool" });
        }
        if (prompt.includes("tc-b")) {
          return textResult("b-done");
        }
        return toolCallResult({ toolCallId: "tc-b", toolName: "the_tool" });
      },
    });

    const tools = [ToolSchema.fromZod("the_tool", "A tool", z.object({}))];
    const agent = makeAgent({ getTools: () => tools });
    let toolRan = false;
    const executor = makeToolExecutor(async () => {
      toolRan = true;
      return { ok: true };
    });
    const runner = new AgentRunner(model);

    const runA = runner.run(agent, "RUN-A", {
      runId: "run-a",
      eventBus: busA,
      toolExecutor: executor,
    });
    await sleep(25);
    const resultB = await runner.run(agent, "RUN-B", {
      runId: "run-b",
      eventBus: busB,
      toolExecutor: executor,
    });

    // B's tool call was adjudicated on busB (no gates) — it ran.
    expect(toolRan).toBe(true);
    expect(resultB.toolCallsCount).toBe(1);
    expect(resultB.response).toBe("b-done");

    // A's tool call was adjudicated on busA — blocked, even though B used
    // the runner (with a different bus) in between.
    await expect(runA).rejects.toThrow(ToolCallBlocked);

    // The bus-A gate saw run-a's intent and NOTHING of run-b's.
    expect(gateSawRunIds).toEqual(["run-a"]);
  });

  it("PINS the #496 behaviour change: a per-call bus does not stick — the next bus-less call falls back to the constructor bus, not the previous call's", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => textResult("ok"),
    });
    const constructorBus = new AgentEventBus();
    const busX = new AgentEventBus();
    const constructorEvents = collect(constructorBus);
    const xEvents = collect(busX);

    const runner = new AgentRunner(model, constructorBus);
    const agent = makeAgent();

    await runner.run(agent, "first", { runId: "run-1", eventBus: busX });
    await runner.run(agent, "second", { runId: "run-2" });

    // Call 1 published to X, and ONLY call 1 did — the old sticky rebind
    // would have routed call 2's events to X as well.
    expect(xEvents.length).toBeGreaterThan(0);
    expect(xEvents.every((e) => e.runId === "run-1")).toBe(true);

    // Call 2 fell back to the constructor bus.
    expect(constructorEvents.length).toBeGreaterThan(0);
    expect(constructorEvents.every((e) => e.runId === "run-2")).toBe(true);
    expect(constructorEvents.some((e) => e.type === "agent.message.complete")).toBe(true);
  });
});
