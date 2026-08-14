/**
 * `AgentRunner` — `abortSignal` forwarding to every provider call (#504).
 *
 * Three of five provider calls never received `options.abortSignal`:
 * `run()`'s `generateText`, `runStructured()`'s no-tools path, and its
 * tier-2 fallback. The proving fixture is a `doGenerate` that HANGS until
 * the signal it actually received fires — forwarding is proven by the run
 * settling at all (a dropped signal fails by test timeout, not by assertion
 * gymnastics). The abort rejection is normalized: `run()` resolves with
 * `finishReason: "cancelled"` and no `agent.error` (D1 non-throw posture);
 * `runStructured()` throws `RunCancelledError`, never a raw `AbortError`.
 */

import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolSchema } from "@pattern-stack/agentic-core";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent } from "../../events/types.js";
import { AgentRunner, RunCancelledError } from "../agent-runner.js";
import type { AgentLike } from "../agent-runner.js";

// ---------------------------------------------------------------------------
// Fixtures
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

/**
 * The #504 proving fixture: settles ONLY when the signal the provider call
 * actually received fires. If the runner drops the signal, this never
 * settles and the test times out — reaching the assertion at all proves the
 * forwarding. Rejects with the signal's own `reason`, which is what `fetch`
 * rejects an in-flight request with (a `DOMException("AbortError")` for a
 * plain `abort()`, a `TimeoutError` for `AbortSignal.timeout`, the caller's
 * value for `abort(customReason)`).
 */
function hangUntilAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
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

/** Collect the event types the normalization assertions care about. */
function collect(bus: AgentEventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const t of ["agent.llm.end", "agent.error", "agent.message.complete"] as const) {
    bus.subscribe(t, (e) => {
      events.push(e as AgentEvent);
    });
  }
  return events;
}

/** The cancelled-terminal finalizer (#504 Gate 2.5 B2) a run-store exporter needs. */
function cancelledComplete(events: AgentEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === "agent.message.complete" &&
      (e as { finishReason?: string }).finishReason === "cancelled",
  );
}

/** Abort `controller` once the event loop has let the run get in-flight. */
function abortSoon(controller: AbortController, ms = 30): void {
  setTimeout(() => controller.abort(), ms);
}

const schema = z.object({ answer: z.string() });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunner — abortSignal forwarding (#504)", () => {
  it("run(): a mid-call abort resolves finishReason 'cancelled' — llm.end says 'cancelled', no agent.error", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: (options) => hangUntilAbort(options.abortSignal),
    });
    const bus = new AgentEventBus();
    const events = collect(bus);
    const runner = new AgentRunner(model, bus);
    const controller = new AbortController();

    abortSoon(controller);
    const result = await runner.run(makeAgent(), "hi", { abortSignal: controller.signal });

    expect(result.finishReason).toBe("cancelled");
    expect(result.iterations).toBe(0);
    const llmEnds = events.filter((e) => e.type === "agent.llm.end");
    expect(llmEnds).toHaveLength(1);
    expect((llmEnds[0] as { finishReason?: string } | undefined)?.finishReason).toBe("cancelled");
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
  });

  it("runStructured() no-tools: a mid-call abort throws RunCancelledError, no agent.error", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: (options) => hangUntilAbort(options.abortSignal),
    });
    const bus = new AgentEventBus();
    const events = collect(bus);
    const runner = new AgentRunner(model, bus);
    const controller = new AbortController();

    abortSoon(controller);
    await expect(
      runner.runStructured(makeAgent(), "hi", schema, { abortSignal: controller.signal }),
    ).rejects.toThrow(RunCancelledError);
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
    // Gate 2.5 B2: the run still FINALIZES — a terminal message.complete with
    // finishReason "cancelled" precedes the throw, so run-store exporters
    // never leave the row stuck 'running'.
    expect(cancelledComplete(events)).toBe(true);
  });

  it("runStructured() tier-2 fallback: a mid-call abort in the structured finish throws RunCancelledError", async () => {
    // Tools + unknown model → 2-tier. Tier-1 (the run() delegate) completes
    // instantly with plain text; the tier-2 structured finish — keyed by its
    // distinctive prompt preamble — hangs until the signal fires.
    let tier2Called = false;
    const model = new MockLanguageModelV3({
      doGenerate: (options) => {
        if (JSON.stringify(options.prompt).includes("produce the structured object")) {
          tier2Called = true;
          return hangUntilAbort(options.abortSignal);
        }
        return Promise.resolve(textResult('{"answer":"draft"}'));
      },
    });
    const tools = [ToolSchema.fromZod("noop", "Noop", z.object({}))];
    const agent = makeAgent({ getTools: () => tools });
    const runner = new AgentRunner(model);
    const controller = new AbortController();

    abortSoon(controller, 60);
    await expect(
      runner.runStructured(agent, "hi", schema, { abortSignal: controller.signal }),
    ).rejects.toThrow(RunCancelledError);
    expect(tier2Called).toBe(true);
  });

  it("runStructured() capable path: the already-forwarded signal now normalizes to RunCancelledError (not a raw AbortError)", async () => {
    const model = new MockLanguageModelV3({
      modelId: "gemini-3.5-flash",
      doGenerate: (options) => hangUntilAbort(options.abortSignal),
    });
    const tools = [ToolSchema.fromZod("noop", "Noop", z.object({}))];
    const agent = makeAgent({ getModel: () => "gemini-3.5-flash", getTools: () => tools });
    const bus = new AgentEventBus();
    const events = collect(bus);
    const runner = new AgentRunner(model, bus);
    const controller = new AbortController();

    abortSoon(controller);
    await expect(
      runner.runStructured(agent, "hi", schema, { abortSignal: controller.signal }),
    ).rejects.toThrow(RunCancelledError);
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
    expect(cancelledComplete(events)).toBe(true);
  });

  it("run(): AbortSignal.timeout — the reason is a TimeoutError, still a cancel, not an error (Gate 2.5 B1)", async () => {
    // fetch rejects an in-flight request with the SIGNAL'S REASON, and
    // AbortSignal.timeout's reason is a DOMException named "TimeoutError" —
    // the most common way a caller hands a signal to an LLM call.
    const model = new MockLanguageModelV3({
      doGenerate: (options) => hangUntilAbort(options.abortSignal),
    });
    const bus = new AgentEventBus();
    const events = collect(bus);
    const runner = new AgentRunner(model, bus);

    const result = await runner.run(makeAgent(), "hi", {
      abortSignal: AbortSignal.timeout(30),
    });

    expect(result.finishReason).toBe("cancelled");
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
  });

  it("runStructured(): controller.abort(customReason) — reason identity proves causality, still RunCancelledError (Gate 2.5 B1)", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: (options) => hangUntilAbort(options.abortSignal),
    });
    const bus = new AgentEventBus();
    const events = collect(bus);
    const runner = new AgentRunner(model, bus);
    const controller = new AbortController();

    setTimeout(() => controller.abort(new Error("user clicked stop")), 30);
    await expect(
      runner.runStructured(makeAgent(), "hi", schema, { abortSignal: controller.signal }),
    ).rejects.toThrow(RunCancelledError);
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
    expect(cancelledComplete(events)).toBe(true);
  });

  it("a provider AbortError WITHOUT our signal having fired stays a genuine error (the AND in the detector)", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: () => Promise.reject(new DOMException("provider hiccup", "AbortError")),
    });
    const bus = new AgentEventBus();
    const events = collect(bus);
    const runner = new AgentRunner(model, bus);
    const controller = new AbortController(); // never aborted

    await expect(
      runner.run(makeAgent(), "hi", { abortSignal: controller.signal }),
    ).rejects.toThrow();
    // Normal error path: agent.error emitted, llm.end says "error".
    expect(events.some((e) => e.type === "agent.error")).toBe(true);
    const llmEnds = events.filter((e) => e.type === "agent.llm.end");
    expect((llmEnds[0] as { finishReason?: string } | undefined)?.finishReason).toBe("error");
  });
});
