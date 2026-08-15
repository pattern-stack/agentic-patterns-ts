/**
 * `AgentRunner` — `RunOptions.timeout` (#521): per-run `modelMs`/`toolMs`/
 * `runMs` budgets.
 *
 * `modelMs` maps to the SDK's own `timeout: { stepMs }` (native, signal-based
 * delivery — no hand-rolled race); on 4 of 5 provider calls it is a true
 * per-model-call bound, but on `runStructured()`'s CAPABLE path (tools + a
 * model verified for single-call structured output) a "step" is one model
 * call PLUS every SDK-run tool execution it triggered, so there it bounds
 * model-call-plus-tools (documented semantics, pinned below). `toolMs` is a
 * hand-rolled race (`withToolTimeout`) around all three tool-dispatch sites —
 * REJECTS with a structured tool error on expiry, never resolves, so the
 * run's loop continues. `runMs` composes a derived `AbortSignal.timeout` into
 * the effective abort signal every provider call and guard observes;
 * expiry's `finishReason` is discriminated by SIGNAL IDENTITY (an explicit
 * caller cancel always wins over a `runMs` deadline when both have fired),
 * never by comparing clocks.
 *
 * The `modelMs`/`runMs` proving fixture is the #504 hang-until-abort
 * fixture (settles ONLY when the signal the provider call actually received
 * fires) — `timeout` is consumed by the SDK before `doGenerate`/`doStream`
 * ever see it (not observable at the mock at any level), so reaching
 * settlement at all is what proves delivery.
 */

import { ToolSchema } from "@pattern-stack/agentic-core";
import type { ToolExecutionContext } from "@pattern-stack/agentic-core";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent } from "../../events/types.js";
import { AgentRunner, RunCancelledError } from "../agent-runner.js";
import type { AgentLike } from "../agent-runner.js";

// ---------------------------------------------------------------------------
// Fixtures (mirror agent-runner-abort-forwarding.test.ts / -model-params.test.ts)
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

function toolCallResult(toolCallId: string, toolName: string, input = "{}"): V3Result {
  return {
    content: [{ type: "tool-call", toolCallId, toolName, input }],
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage: usageV3(10, 5),
    warnings: [],
  };
}

/**
 * The #504 proving fixture: settles ONLY when the signal the provider call
 * actually received fires. Reaching the assertion at all proves the runner
 * forwarded `timeout`/`abortSignal` — a dropped signal hangs to the vitest
 * timeout, not a failed assertion.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Collect every event the assertions below care about. */
function collect(bus: AgentEventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const t of [
    "agent.llm.end",
    "agent.error",
    "agent.message.complete",
    "agent.tool.end",
  ] as const) {
    bus.subscribe(t, (e) => {
      events.push(e as AgentEvent);
    });
  }
  return events;
}

async function collectStream(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function messageCompletes(events: AgentEvent[]): Array<{ finishReason?: string }> {
  return events.filter((e) => e.type === "agent.message.complete") as Array<{
    finishReason?: string;
  }>;
}

const schema = z.object({ answer: z.string() });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunner — RunOptions.timeout (#521)", () => {
  describe("modelMs — native SDK timeout, reaches every provider call", () => {
    it("run(): a hang-until-abort call under modelMs REJECTS via the error path — agent.error, no RunCancelledError-shaped cancel", async () => {
      const model = new MockLanguageModelV3({
        doGenerate: (options) => hangUntilAbort(options.abortSignal),
      });
      const bus = new AgentEventBus();
      const events = collect(bus);
      const runner = new AgentRunner(model, bus);

      await expect(runner.run(makeAgent(), "hi", { timeout: { modelMs: 50 } })).rejects.toThrow();

      expect(events.some((e) => e.type === "agent.error")).toBe(true);
      expect(messageCompletes(events).some((e) => e.finishReason === "cancelled")).toBe(false);
      expect(messageCompletes(events).some((e) => e.finishReason === "timeout")).toBe(false);
    });

    it("runStructured() no-tools: a hang-until-abort call under modelMs REJECTS via the error path, not RunCancelledError", async () => {
      const model = new MockLanguageModelV3({
        doGenerate: (options) => hangUntilAbort(options.abortSignal),
      });
      const bus = new AgentEventBus();
      const events = collect(bus);
      const runner = new AgentRunner(model, bus);

      const promise = runner.runStructured(makeAgent(), "hi", schema, {
        timeout: { modelMs: 50 },
      });

      await expect(promise).rejects.toThrow();
      await expect(promise).rejects.not.toBeInstanceOf(RunCancelledError);
      expect(events.some((e) => e.type === "agent.error")).toBe(true);
    });

    it("stream(): a hang-until-abort call under modelMs lands on the cancel path — conversation.end {reason:'cancelled'}, no agent.error (SDK's own 'abort' stream part, §2/B2)", async () => {
      const model = new MockLanguageModelV3({
        doStream: (options) => hangUntilAbort(options.abortSignal),
      });
      const bus = new AgentEventBus();
      const runner = new AgentRunner(model, bus);

      const events = await collectStream(
        runner.stream(makeAgent(), "hi", { timeout: { modelMs: 50 } }),
      );

      expect(events.some((e) => e.type === "agent.error")).toBe(false);
      expect(events.some((e) => e.type === "agent.message.cancel")).toBe(true);
      const convEnd = events.find((e) => e.type === "agent.conversation.end");
      expect((convEnd as { reason?: string } | undefined)?.reason).toBe("cancelled");
      expect(events.some((e) => e.type === "agent.message.complete")).toBe(false);
    });

    it("runStructured() capable path (gemini-3.5-flash): a fast model call + a slow SDK-run tool REJECTS the whole step under modelMs (documented step-scope semantics, §2/Spec Review B1)", async () => {
      // Our own `ToolExecutor` abstraction only ever sees the SDK's raw
      // per-step abort signal via `ctx.signal` when `toolMs` is ALSO set
      // (§5 — deliberate, `_toolDispatchSignal` returns `undefined`
      // otherwise), so under `modelMs` alone the tool is not preemptible —
      // it runs to completion, and ai@7 reports the step's own timeout
      // AFTER that (probed: no early interruption without a signal-aware
      // tool). This pins the "burns the step budget" consequence itself —
      // the whole `generateText` step rejects once its total duration
      // (fast model call + the tool) exceeds `modelMs`, not a shorter tool
      // budget.
      let calls = 0;
      let toolCompleted = false;
      const model = new MockLanguageModelV3({
        modelId: "gemini-3.5-flash",
        doGenerate: async () => {
          calls++;
          if (calls === 1) return toolCallResult("t1", "slow");
          return textResult(JSON.stringify({ answer: "42" }));
        },
      });
      const tools = [ToolSchema.fromZod("slow", "Slow", z.object({}))];
      const agent = makeAgent({ getModel: () => "gemini-3.5-flash", getTools: () => tools });
      const bus = new AgentEventBus();
      const events = collect(bus);
      const runner = new AgentRunner(model, bus);

      const promise = runner.runStructured(agent, "hi", schema, {
        timeout: { modelMs: 50 },
        toolExecutor: {
          execute: async () => {
            await sleep(90);
            toolCompleted = true;
            return "tool-result";
          },
        },
      });

      await expect(promise).rejects.toThrow();
      await expect(promise).rejects.not.toBeInstanceOf(RunCancelledError);
      expect(calls).toBe(1);
      expect(toolCompleted).toBe(true);
      expect(events.some((e) => e.type === "agent.error")).toBe(true);
    });
  });

  describe("toolMs — hand-rolled dispatch race", () => {
    it("run(): a never-resolving toolExecutor under toolMs rejects with a structured tool error — agent.tool.end carries it, the run completes normally", async () => {
      let calls = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          calls++;
          if (calls === 1) return toolCallResult("t1", "hangs");
          return textResult("ok despite the timed-out tool");
        },
      });
      const tools = [ToolSchema.fromZod("hangs", "Hangs", z.object({}))];
      const agent = makeAgent({ getTools: () => tools });
      const bus = new AgentEventBus();
      const events = collect(bus);
      const runner = new AgentRunner(model, bus);

      const result = await runner.run(agent, "hi", {
        toolExecutor: { execute: () => new Promise(() => {}) },
        timeout: { toolMs: 40 },
      });

      expect(result.finishReason).toBe("stop");
      expect(result.toolCallsCount).toBe(1);
      const toolEnd = events.find((e) => e.type === "agent.tool.end") as
        | { error?: string }
        | undefined;
      expect(toolEnd?.error).toMatch(/timed out/i);
    });
  });

  describe("ctx.signal — cooperative-only, present iff toolMs is set", () => {
    it("aborted once toolMs expires — an executor observing it via a captured reference sees aborted===true after the run settles", async () => {
      let capturedSignal: AbortSignal | undefined;
      let hasSignalKey: boolean | undefined;
      let calls = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          calls++;
          if (calls === 1) return toolCallResult("t1", "slow");
          return textResult("done");
        },
      });
      const tools = [ToolSchema.fromZod("slow", "Slow", z.object({}))];
      const agent = makeAgent({ getTools: () => tools });
      const runner = new AgentRunner(model);

      const result = await runner.run(agent, "hi", {
        toolExecutor: {
          execute: async (_name, _args, ctx: ToolExecutionContext) => {
            capturedSignal = ctx.signal;
            hasSignalKey = Object.hasOwn(ctx, "signal");
            return new Promise(() => {}); // abandoned — withToolTimeout wins
          },
        },
        timeout: { toolMs: 40 },
      });

      expect(hasSignalKey).toBe(true);
      expect(capturedSignal?.aborted).toBe(true);
      expect(result.finishReason).toBe("stop");
    });

    it("absent entirely (own-property check) when RunOptions.timeout is unset", async () => {
      let hasSignalKey: boolean | undefined;
      let calls = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          calls++;
          if (calls === 1) return toolCallResult("t1", "fast");
          return textResult("done");
        },
      });
      const tools = [ToolSchema.fromZod("fast", "Fast", z.object({}))];
      const agent = makeAgent({ getTools: () => tools });
      const runner = new AgentRunner(model);

      await runner.run(agent, "hi", {
        toolExecutor: {
          execute: async (_name, _args, ctx: ToolExecutionContext) => {
            hasSignalKey = Object.hasOwn(ctx, "signal");
            return "ok";
          },
        },
      });

      expect(hasSignalKey).toBe(false);
    });
  });

  describe("runMs — boundary + in-flight expiry, reason discrimination by signal identity", () => {
    it("run(): a per-iteration tool loop shorter than runMs boundary returns finishReason 'timeout'", async () => {
      const model = new MockLanguageModelV3({
        doGenerate: async () => toolCallResult(`t-${Date.now()}`, "slow"),
      });
      const tools = [ToolSchema.fromZod("slow", "Slow", z.object({}))];
      const agent = makeAgent({ getTools: () => tools });
      const bus = new AgentEventBus();
      const events = collect(bus);
      const runner = new AgentRunner(model, bus);

      const result = await runner.run(agent, "hi", {
        maxIterations: 10,
        toolExecutor: { execute: async () => sleep(40).then(() => "ok") },
        timeout: { runMs: 60 },
      });

      expect(result.finishReason).toBe("timeout");
      expect(result.iterations).toBeLessThan(10);
      const complete = messageCompletes(events).find((e) => e.finishReason !== undefined);
      expect(complete?.finishReason).toBe("timeout");
      const llmEnds = events.filter((e) => e.type === "agent.llm.end");
      // §4: agent.llm.end stays the literal "cancelled" (no new vocabulary
      // there) whenever the boundary guard — not an in-flight rejection —
      // is what ended the run.
      for (const e of llmEnds) {
        expect((e as { finishReason?: string }).finishReason).not.toBe("timeout");
      }
    });

    it("stream(): the same boundary expiry still maps to 'cancelled' — message.cancel + conversation.end {reason:'cancelled'}, no message.complete", async () => {
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "tool-call",
                toolCallId: `t-${Date.now()}`,
                toolName: "slow",
                input: "{}",
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: usageV3(5, 2),
              });
              controller.close();
            },
          }),
        }),
      });
      const tools = [ToolSchema.fromZod("slow", "Slow", z.object({}))];
      const agent = makeAgent({ getTools: () => tools });
      const runner = new AgentRunner(model);

      const events = await collectStream(
        runner.stream(agent, "hi", {
          maxIterations: 10,
          toolExecutor: { execute: async () => sleep(40).then(() => "ok") },
          timeout: { runMs: 60 },
        }),
      );

      expect(events.some((e) => e.type === "agent.message.cancel")).toBe(true);
      const convEnd = events.find((e) => e.type === "agent.conversation.end");
      expect((convEnd as { reason?: string } | undefined)?.reason).toBe("cancelled");
      expect(events.some((e) => e.type === "agent.message.complete")).toBe(false);
    });

    it("run(): an in-flight hang-until-abort call under runMs resolves finishReason 'timeout' (not 'cancelled'), llm.end still says 'cancelled', no agent.error", async () => {
      const model = new MockLanguageModelV3({
        doGenerate: (options) => hangUntilAbort(options.abortSignal),
      });
      const bus = new AgentEventBus();
      const events = collect(bus);
      const runner = new AgentRunner(model, bus);

      const result = await runner.run(makeAgent(), "hi", { timeout: { runMs: 50 } });

      expect(result.finishReason).toBe("timeout");
      const complete = messageCompletes(events).find((e) => e.finishReason !== undefined);
      expect(complete?.finishReason).toBe("timeout");
      const llmEnds = events.filter((e) => e.type === "agent.llm.end");
      expect(llmEnds).toHaveLength(1);
      expect((llmEnds[0] as { finishReason?: string }).finishReason).toBe("cancelled");
      expect(events.some((e) => e.type === "agent.error")).toBe(false);
    });

    it("runStructured() 2-tier: a tier-1 tool loop that times out throws RunCancelledError, not the empty-tier-1 Error (Spec Review B2, re-run 1)", async () => {
      const model = new MockLanguageModelV3({
        doGenerate: (options) => hangUntilAbort(options.abortSignal),
      });
      const tools = [ToolSchema.fromZod("noop", "Noop", z.object({}))];
      // "test-model" (via makeAgent's default getModel) is unknown to the
      // capability table → 2-tier by construction (mirrors
      // agent-runner-abort-forwarding.test.ts's tier-2 fixture).
      const agent = makeAgent({ getTools: () => tools });
      const bus = new AgentEventBus();
      const events = collect(bus);
      const runner = new AgentRunner(model, bus);

      await expect(
        runner.runStructured(agent, "hi", schema, { timeout: { runMs: 50 } }),
      ).rejects.toThrow(RunCancelledError);

      // emitCancelledTerminal()'s own message.complete carries the LITERAL
      // "cancelled" (unchanged — harmless per the Spec Review note:
      // RunStoreExporter is first-terminal-wins, so a shared runId prefers
      // tier-1's own discriminated "timeout" terminal over this one).
      expect(messageCompletes(events).some((e) => e.finishReason === "cancelled")).toBe(true);
      expect(events.some((e) => e.type === "agent.error")).toBe(false);
    });

    it("caller abort still wins as 'cancelled' even when runMs would also expire", async () => {
      const model = new MockLanguageModelV3({
        doGenerate: (options) => hangUntilAbort(options.abortSignal),
      });
      const runner = new AgentRunner(model);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);

      const result = await runner.run(makeAgent(), "hi", {
        abortSignal: controller.signal,
        timeout: { runMs: 200 },
      });

      expect(result.finishReason).toBe("cancelled");
    });
  });

  describe("omission — behavioral proof (B6: timeout is consumed by the SDK before doGenerate, not observable at the mock)", () => {
    it("no RunOptions.timeout: a hang-until-abort call stays pending with nothing configured to end it", async () => {
      const model = new MockLanguageModelV3({
        doGenerate: (options) => hangUntilAbort(options.abortSignal),
      });
      const runner = new AgentRunner(model);
      // Test-owned controller: NOT aborted during the pending-window
      // assertion below — its only job is letting the floating promise
      // settle afterward so the test process exits cleanly.
      const controller = new AbortController();

      let settled = false;
      const promise = runner
        .run(makeAgent(), "hi", { abortSignal: controller.signal })
        .catch(() => undefined)
        .finally(() => {
          settled = true;
        });

      await sleep(120);
      expect(settled).toBe(false);

      controller.abort();
      await promise;
    });
  });
});
