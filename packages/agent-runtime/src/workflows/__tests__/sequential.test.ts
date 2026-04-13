import { describe, expect, it } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { PatternResult, PatternRunOptions, Step } from "../base.js";
import { Sequential } from "../sequential.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(name = "test-agent"): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    getSystemPrompt: () => "You are a test agent.",
    renderInitialPrompt: () => "Initial prompt",
  };
}

// ---------------------------------------------------------------------------
// Sequential
// ---------------------------------------------------------------------------

describe("Sequential", () => {
  it("chains 3 steps with context threading", async () => {
    const runner = new MockRunner()
      .addResponse("Step 1", { content: "result-1", inputTokens: 5, outputTokens: 10 })
      .addResponse("Step 2", { content: "result-2", inputTokens: 6, outputTokens: 11 })
      .addResponse("Step 3", { content: "result-3", inputTokens: 7, outputTokens: 12 });

    const steps: Step[] = [
      {
        agent: makeAgent("agent-1"),
        messageTemplate: "Step 1",
        name: "first",
        outputKey: "step1",
      },
      {
        agent: makeAgent("agent-2"),
        messageTemplate: (ctx) => `Step 2: ${ctx.step1 as string}`,
        name: "second",
        outputKey: "step2",
      },
      {
        agent: makeAgent("agent-3"),
        messageTemplate: (ctx) => `Step 3: ${ctx.step2 as string}`,
        name: "third",
      },
    ];

    const seq = new Sequential(steps);
    const result = await seq.run({}, { runner });

    expect(result.succeeded).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.totalInputTokens).toBe(18);
    expect(result.totalOutputTokens).toBe(33);
    expect(result.finalContent).toBe("result-3");
    expect(result.finalContext.step1).toBe("result-1");
    expect(result.finalContext.step2).toBe("result-2");

    // Verify context threading via runner call history
    expect(runner.callHistory[1]?.message).toBe("Step 2: result-1");
    expect(runner.callHistory[2]?.message).toBe("Step 3: result-2");
  });

  it("supports nested parallel within sequential", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "nested-result",
      inputTokens: 1,
      outputTokens: 2,
    });

    const nestedPattern = {
      async run(
        _context?: Record<string, unknown>,
        _options?: PatternRunOptions,
      ): Promise<PatternResult> {
        return {
          totalInputTokens: 100,
          totalOutputTokens: 200,
          succeeded: true,
          finalContent: "nested-output",
        };
      },
    };

    const steps: Array<Step | { run: typeof nestedPattern.run }> = [
      {
        agent: makeAgent(),
        messageTemplate: "First step",
        name: "step-1",
        outputKey: "s1",
      },
      nestedPattern,
    ];

    const seq = new Sequential(steps);
    const result = await seq.run({}, { runner });

    expect(result.succeeded).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.totalInputTokens).toBe(101);
    expect(result.totalOutputTokens).toBe(202);
    expect(result.finalContent).toBe("nested-output");
  });

  it("stops on error by default", async () => {
    const runner = new MockRunner()
      .addResponse("step-1", { content: "ok" })
      .addResponse("step-2", { content: "ok", error: new Error("boom") })
      .addResponse("step-3", { content: "ok" });

    const steps: Step[] = [
      { agent: makeAgent(), messageTemplate: "step-1", name: "s1" },
      { agent: makeAgent(), messageTemplate: "step-2", name: "s2" },
      { agent: makeAgent(), messageTemplate: "step-3", name: "s3" },
    ];

    const seq = new Sequential(steps);
    const result = await seq.run({}, { runner });

    expect(result.succeeded).toBe(false);
    expect(result.steps).toHaveLength(1); // Only first step completed
  });

  it("continues on error when continueOnError is true", async () => {
    const runner = new MockRunner()
      .addResponse("step-1", { content: "ok-1", inputTokens: 1, outputTokens: 1 })
      .addResponse("step-2", { content: "ok", error: new Error("boom") })
      .addResponse("step-3", { content: "ok-3", inputTokens: 2, outputTokens: 2 });

    const steps: Step[] = [
      { agent: makeAgent(), messageTemplate: "step-1", name: "s1" },
      { agent: makeAgent(), messageTemplate: "step-2", name: "s2" },
      { agent: makeAgent(), messageTemplate: "step-3", name: "s3" },
    ];

    const seq = new Sequential(steps, { continueOnError: true });
    const result = await seq.run({}, { runner });

    expect(result.succeeded).toBe(false);
    expect(result.steps).toHaveLength(2); // step-1 and step-3 succeeded
    expect(result.finalContent).toBe("ok-3");
  });

  it("fires hook callbacks in order", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const events: string[] = [];

    const hooks = {
      onPatternStart: () => {
        events.push("pattern-start");
      },
      onStepStart: () => {
        events.push("step-start");
      },
      onStepComplete: () => {
        events.push("step-complete");
      },
      onPatternComplete: () => {
        events.push("pattern-complete");
      },
    };

    const seq = new Sequential([{ agent: makeAgent(), messageTemplate: "do it", name: "s1" }]);
    await seq.run({}, { runner, hooks });

    expect(events).toEqual(["pattern-start", "step-start", "step-complete", "pattern-complete"]);
  });

  it("uses contextExtractor to update context", async () => {
    const runner = new MockRunner()
      .addResponse("extract", { content: "raw data" })
      .addResponse("*", { content: "final" });

    const steps: Step[] = [
      {
        agent: makeAgent(),
        messageTemplate: "extract",
        name: "extractor",
        contextExtractor: (_result, _ctx) => ({
          extracted: "custom-value",
        }),
      },
      {
        agent: makeAgent(),
        messageTemplate: (ctx) => `Use ${ctx.extracted as string}`,
        name: "user",
      },
    ];

    const seq = new Sequential(steps);
    const result = await seq.run({}, { runner });

    expect(result.succeeded).toBe(true);
    expect(runner.callHistory[1]?.message).toBe("Use custom-value");
  });

  it("returns frozen result", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const seq = new Sequential([{ agent: makeAgent(), messageTemplate: "test" }]);
    const result = await seq.run({}, { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
