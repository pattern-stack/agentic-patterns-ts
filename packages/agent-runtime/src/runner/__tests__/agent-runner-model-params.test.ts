/**
 * `AgentRunner` — `RunOptions.modelParams` passthrough (#514).
 *
 * Five provider calls (`run()`'s `generateText`, `runStructured()`'s
 * no-tools / capable / tier-2 paths, `stream()`'s `streamText`) previously
 * passed only `{model, instructions, messages, tools?, output?,
 * abortSignal?, headers}` — no generation control reached any of them. The
 * proving fixture captures the `LanguageModelV3CallOptions` a
 * `MockLanguageModelV3` actually receives, per site.
 *
 * `_resolveCallParams` mirrors `_callHeaders`'s no-config posture: spreading
 * `undefined` adds no keys at the `generateText` argument level, but the SDK
 * still materializes every `CallSettings` member as an own property valued
 * `undefined` at `doGenerate` regardless of config (the #406 headers
 * precedent, `agent-runner.test.ts:2652-2671`) — so the no-config assertion
 * here is value-level, not key-absence.
 */

import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { ToolSchema } from "@pattern-stack/agentic-core";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { resetAdvisoryWarningsForTests } from "../../providers/capabilities.js";
import { AgentRunner } from "../agent-runner.js";
import type { AgentLike } from "../agent-runner.js";
import type { ModelParams } from "../types.js";

/**
 * `LanguageModelV3CallOptions` (the type `MockLanguageModelV3.doGenerate`/
 * `.doStream` are typed against) predates the SDK's `reasoning` call
 * setting, but `ai@7`'s `asLanguageModelV4` shim forwards it to a V3 model's
 * options verbatim at runtime anyway (Spec Review, re-run 1) — widen the
 * captured type by this one field rather than casting at every read site.
 */
type V3CapturedOptions = LanguageModelV3CallOptions & { reasoning?: string };

// ---------------------------------------------------------------------------
// Fixtures (mirror agent-runner-abort-forwarding.test.ts / -event-bus.test.ts)
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

function makeAgent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    role: { name: "test-agent" },
    getModel: () => "test-model",
    getTools: () => [],
    renderInitialPrompt: () => "You are a helpful assistant.",
    ...overrides,
  };
}

const schema = z.object({ answer: z.string() });

/** The full `modelParams` bag exercised by the "reaches all five sites" test. */
const fullParams: ModelParams = {
  temperature: 0.3,
  maxOutputTokens: 55,
  topP: 0.9,
  topK: 7,
  seed: 42,
  stopSequences: ["STOP"],
  providerOptions: { acme: { flag: true } },
};

/** Assert the scalar/array members of `fullParams` arrived verbatim. */
function expectFullParamsArrived(captured: V3CapturedOptions | undefined): void {
  expect(captured?.temperature).toBe(fullParams.temperature);
  expect(captured?.maxOutputTokens).toBe(fullParams.maxOutputTokens);
  expect(captured?.topP).toBe(fullParams.topP);
  expect(captured?.topK).toBe(fullParams.topK);
  expect(captured?.seed).toBe(fullParams.seed);
  expect(captured?.stopSequences).toEqual(fullParams.stopSequences);
  expect(captured?.providerOptions).toEqual(fullParams.providerOptions);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunner — RunOptions.modelParams passthrough (#514)", () => {
  beforeEach(() => {
    resetAdvisoryWarningsForTests();
  });

  describe("reaches all five call sites", () => {
    it("run(): generateText receives modelParams", async () => {
      let captured: V3CapturedOptions | undefined;
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          captured = options;
          return textResult("ok");
        },
      });
      const runner = new AgentRunner(model);

      await runner.run(makeAgent(), "hi", { modelParams: fullParams });

      expectFullParamsArrived(captured);
    });

    it("runStructured() no-tools: the single Output.object call receives modelParams", async () => {
      let captured: V3CapturedOptions | undefined;
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          captured = options;
          return textResult(JSON.stringify({ answer: "42" }));
        },
      });
      const runner = new AgentRunner(model);

      await runner.runStructured(makeAgent(), "hi", schema, { modelParams: fullParams });

      expectFullParamsArrived(captured);
    });

    it("runStructured() capable path (gemini-3.5-flash): the tools+structured call receives modelParams", async () => {
      let captured: V3CapturedOptions | undefined;
      const model = new MockLanguageModelV3({
        modelId: "gemini-3.5-flash",
        doGenerate: async (options) => {
          captured = options;
          return textResult(JSON.stringify({ answer: "42" }));
        },
      });
      const tools = [ToolSchema.fromZod("noop", "Noop", z.object({}))];
      const agent = makeAgent({ getModel: () => "gemini-3.5-flash", getTools: () => tools });
      const runner = new AgentRunner(model);

      await runner.runStructured(agent, "hi", schema, {
        modelParams: fullParams,
        toolExecutor: { execute: async () => ({}) },
      });

      expectFullParamsArrived(captured);
    });

    it("runStructured() 2-tier fallback (unknown model): the tier-2 structured finish receives modelParams", async () => {
      let captured: V3CapturedOptions | undefined;
      let tier2Called = false;
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          if (JSON.stringify(options.prompt).includes("produce the structured object")) {
            tier2Called = true;
            captured = options;
            return textResult(JSON.stringify({ answer: "42" }));
          }
          return textResult("draft answer, not schema-valid");
        },
      });
      const tools = [ToolSchema.fromZod("noop", "Noop", z.object({}))];
      const agent = makeAgent({ getTools: () => tools });
      const runner = new AgentRunner(model);

      await runner.runStructured(agent, "hi", schema, { modelParams: fullParams });

      expect(tier2Called).toBe(true);
      expectFullParamsArrived(captured);
    });

    it("stream(): streamText receives modelParams", async () => {
      let captured: V3CapturedOptions | undefined;
      const model = new MockLanguageModelV3({
        doStream: async (options) => {
          captured = options;
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "t0" });
                controller.enqueue({ type: "text-delta", id: "t0", delta: "ok" });
                controller.enqueue({ type: "text-end", id: "t0" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: usageV3(10, 5),
                });
                controller.close();
              },
            }),
          };
        },
      });
      const runner = new AgentRunner(model);

      for await (const _event of runner.stream(makeAgent(), "hi", { modelParams: fullParams })) {
        // Drain the generator — the assertion is on `captured`, not the events.
      }

      expectFullParamsArrived(captured);
    });
  });

  it("no modelParams: every new member is undefined at the provider call (value-level, not key-absence)", async () => {
    let captured: V3CapturedOptions | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        captured = options;
        return textResult("ok");
      },
    });
    const runner = new AgentRunner(model);

    await runner.run(makeAgent(), "hi");

    // SDK materializes every CallSettings member as an own property, valued
    // undefined, regardless of configuration (#406 precedent) — value-level,
    // not key-absence.
    expect(captured?.temperature).toBeUndefined();
    expect(captured?.topP).toBeUndefined();
    expect(captured?.topK).toBeUndefined();
    expect(captured?.seed).toBeUndefined();
    expect(captured?.stopSequences).toBeUndefined();
    expect(captured?.maxOutputTokens).toBeUndefined();
    expect(captured?.reasoning).toBeUndefined();
    expect(captured?.providerOptions).toBeUndefined();
  });

  it('reasoningEffort: "high" arrives as reasoning: "high"', async () => {
    let captured: V3CapturedOptions | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        captured = options;
        return textResult("ok");
      },
    });
    const runner = new AgentRunner(model);

    await runner.run(makeAgent(), "hi", { modelParams: { reasoningEffort: "high" } });

    expect(captured?.reasoning).toBe("high");
  });

  describe("adviseReasoningEffort advisory", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("warns exactly once for two runs with reasoningEffort on the same unverified model; never throws; the call is unaffected", async () => {
      let captured: V3CapturedOptions | undefined;
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          captured = options;
          return textResult("ok");
        },
      });
      const runner = new AgentRunner(model);
      const agent = makeAgent({ getModel: () => "test-model" });

      await expect(
        runner.run(agent, "hi", { modelParams: { reasoningEffort: "high" } }),
      ).resolves.toBeDefined();
      expect(captured?.reasoning).toBe("high");

      await expect(
        runner.run(agent, "hi again", { modelParams: { reasoningEffort: "high" } }),
      ).resolves.toBeDefined();
      expect(captured?.reasoning).toBe("high");

      const reasoningWarnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes("reasoningEffort"),
      );
      expect(reasoningWarnings).toHaveLength(1);
    });

    it("no warning when reasoningEffort is not set", async () => {
      const model = new MockLanguageModelV3({
        doGenerate: async () => textResult("ok"),
      });
      const runner = new AgentRunner(model);

      await runner.run(makeAgent(), "hi");

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
