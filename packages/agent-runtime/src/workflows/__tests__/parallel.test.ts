import { describe, expect, it } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { Step } from "../base.js";
import { Parallel, collectByName, collectContents } from "../parallel.js";

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
// Parallel
// ---------------------------------------------------------------------------

describe("Parallel", () => {
  it("runs 3 parallel steps", async () => {
    const runner = new MockRunner()
      .addResponse("task-A", { content: "result-A", inputTokens: 1, outputTokens: 2 })
      .addResponse("task-B", { content: "result-B", inputTokens: 3, outputTokens: 4 })
      .addResponse("task-C", { content: "result-C", inputTokens: 5, outputTokens: 6 });

    const steps: Step[] = [
      { agent: makeAgent("a"), messageTemplate: "task-A", name: "step-a" },
      { agent: makeAgent("b"), messageTemplate: "task-B", name: "step-b" },
      { agent: makeAgent("c"), messageTemplate: "task-C", name: "step-c" },
    ];

    const par = new Parallel(steps);
    const result = await par.run({}, { runner });

    expect(result.allSucceeded).toBe(true);
    expect(result.succeeded).toBe(true);
    expect(result.successful).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.totalInputTokens).toBe(9);
    expect(result.totalOutputTokens).toBe(12);
  });

  it("maxConcurrency=1 runs serially", async () => {
    const order: string[] = [];
    const runner = new MockRunner();

    // Use a custom runner that tracks order
    const trackingRunner = {
      async run(agent: AgentLike, message: string) {
        order.push(message);
        return runner.run(agent, message);
      },
    };

    const steps: Step[] = [
      { agent: makeAgent(), messageTemplate: "first", name: "s1" },
      { agent: makeAgent(), messageTemplate: "second", name: "s2" },
      { agent: makeAgent(), messageTemplate: "third", name: "s3" },
    ];

    const par = new Parallel(steps, { maxConcurrency: 1 });
    await par.run({}, { runner: trackingRunner });

    // With maxConcurrency=1, order should be preserved
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("handles mixed success/failure", async () => {
    const runner = new MockRunner()
      .addResponse("ok", { content: "success", inputTokens: 1, outputTokens: 1 })
      .addResponse("fail", { content: "", error: new Error("boom") });

    const steps: Step[] = [
      { agent: makeAgent(), messageTemplate: "ok", name: "good" },
      { agent: makeAgent(), messageTemplate: "fail", name: "bad" },
      { agent: makeAgent(), messageTemplate: "ok", name: "good2" },
    ];

    const par = new Parallel(steps, { returnExceptions: true });
    const result = await par.run({}, { runner });

    expect(result.allSucceeded).toBe(false);
    expect(result.successful).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.[0]).toBe(1); // index of failed step
    expect(result.failed[0]?.[1].message).toBe("boom");
  });

  it("applies custom consolidator", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "data",
      inputTokens: 1,
      outputTokens: 1,
    });

    const steps: Step[] = [
      { agent: makeAgent(), messageTemplate: "a", name: "s1" },
      { agent: makeAgent(), messageTemplate: "b", name: "s2" },
    ];

    const par = new Parallel(steps, {
      consolidator: collectContents,
      outputKey: "all",
    });
    const result = await par.run({}, { runner });

    expect(result.consolidatedOutput.all).toEqual(["data", "data"]);
  });

  it("collectByName consolidator works", async () => {
    const runner = new MockRunner()
      .addResponse("q1", { content: "answer-1" })
      .addResponse("q2", { content: "answer-2" });

    const steps: Step[] = [
      { agent: makeAgent(), messageTemplate: "q1", name: "question-1" },
      { agent: makeAgent(), messageTemplate: "q2", name: "question-2" },
    ];

    const par = new Parallel(steps, {
      consolidator: collectByName,
      outputKey: "answers",
    });
    const result = await par.run({}, { runner });

    const answers = result.consolidatedOutput.answers as Record<string, string>;
    expect(answers["question-1"]).toBe("answer-1");
    expect(answers["question-2"]).toBe("answer-2");
  });

  it("fires hook callbacks", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const events: string[] = [];

    const hooks = {
      onPatternStart: () => {
        events.push("start");
      },
      onStepStart: () => {
        events.push("step-start");
      },
      onStepComplete: () => {
        events.push("step-complete");
      },
      onPatternComplete: () => {
        events.push("complete");
      },
    };

    const par = new Parallel([{ agent: makeAgent(), messageTemplate: "test", name: "s1" }]);
    await par.run({}, { runner, hooks });

    expect(events).toContain("start");
    expect(events).toContain("step-start");
    expect(events).toContain("step-complete");
    expect(events).toContain("complete");
  });

  it("returns frozen result", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const par = new Parallel([{ agent: makeAgent(), messageTemplate: "test" }]);
    const result = await par.run({}, { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
