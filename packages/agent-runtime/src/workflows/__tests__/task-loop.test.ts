import { describe, expect, it } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { GoalEvaluatorProtocol } from "../base.js";
import { TaskLoop } from "../task-loop.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(name = "task-agent"): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    getSystemPrompt: () => "You are a task agent.",
    renderInitialPrompt: () => "Initial prompt",
  };
}

/** Evaluator that achieves goal on the Nth call. */
function achieveOnCall(n: number): GoalEvaluatorProtocol {
  let callCount = 0;
  return {
    async evaluate() {
      callCount++;
      const achieved = callCount >= n;
      return [achieved, achieved ? "done" : "not yet", true];
    },
  };
}

/** Evaluator that never achieves the goal. */
function neverAchieved(): GoalEvaluatorProtocol {
  return {
    async evaluate() {
      return [false, "not achieved", true];
    },
  };
}

// ---------------------------------------------------------------------------
// TaskLoop
// ---------------------------------------------------------------------------

describe("TaskLoop", () => {
  it("achieves goal in 2 iterations", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "working on it",
      inputTokens: 5,
      outputTokens: 10,
    });

    const loop = new TaskLoop(makeAgent(), achieveOnCall(2), {
      maxIterations: 5,
    });
    const result = await loop.run("Complete the task", {}, { runner });

    expect(result.succeeded).toBe(true);
    expect(result.exitReason).toBe("goal_achieved");
    expect(result.iterations).toBe(2);
    expect(result.totalInputTokens).toBe(10);
    expect(result.totalOutputTokens).toBe(20);
  });

  it("exits on max iterations", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "still working",
      inputTokens: 1,
      outputTokens: 2,
    });

    const loop = new TaskLoop(makeAgent(), neverAchieved(), {
      maxIterations: 3,
    });
    const result = await loop.run("Impossible goal", {}, { runner });

    expect(result.succeeded).toBe(false);
    expect(result.exitReason).toBe("max_iterations");
    expect(result.iterations).toBe(3);
    expect(result.totalInputTokens).toBe(3);
    expect(result.totalOutputTokens).toBe(6);
  });

  it("detects stop phrase", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "I am done. TASK_COMPLETE",
      inputTokens: 1,
      outputTokens: 1,
    });

    const loop = new TaskLoop(makeAgent(), neverAchieved(), {
      maxIterations: 10,
    });
    const result = await loop.run("Do something", {}, { runner });

    expect(result.succeeded).toBe(false);
    expect(result.exitReason).toBe("explicit_stop");
    expect(result.iterations).toBe(1);
  });

  it("detects custom stop phrase", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "ALL_FINISHED",
      inputTokens: 1,
      outputTokens: 1,
    });

    const loop = new TaskLoop(makeAgent(), neverAchieved(), {
      maxIterations: 10,
      stopPhrases: ["ALL_FINISHED"],
    });
    const result = await loop.run("Do something", {}, { runner });

    expect(result.exitReason).toBe("explicit_stop");
  });

  it("includes history in prompt", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "response-1",
    });

    const loop = new TaskLoop(makeAgent(), achieveOnCall(2), {
      maxIterations: 5,
      includeHistory: true,
    });
    await loop.run("Complete it", {}, { runner });

    // Second call should contain the first response in the prompt
    const secondPrompt = runner.callHistory[1]?.message ?? "";
    expect(secondPrompt).toContain("response-1");
    expect(secondPrompt).toContain("PREVIOUS RESPONSES");
    expect(secondPrompt).toContain("[Iteration 1]");
  });

  it("excludes history when includeHistory is false", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "response-1",
    });

    const loop = new TaskLoop(makeAgent(), achieveOnCall(2), {
      maxIterations: 5,
      includeHistory: false,
    });
    await loop.run("Complete it", {}, { runner });

    const secondPrompt = runner.callHistory[1]?.message ?? "";
    expect(secondPrompt).not.toContain("PREVIOUS RESPONSES");
  });

  it("fires hook callbacks", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const events: string[] = [];

    const hooks = {
      onPatternStart: () => {
        events.push("start");
      },
      onIterationStart: () => {
        events.push("iter-start");
      },
      onIterationComplete: () => {
        events.push("iter-complete");
      },
      onPatternComplete: () => {
        events.push("complete");
      },
    };

    const loop = new TaskLoop(makeAgent(), achieveOnCall(1), {
      maxIterations: 5,
    });
    await loop.run("Goal", {}, { runner, hooks });

    expect(events).toEqual(["start", "iter-start", "iter-complete", "complete"]);
  });

  it("provides state with history summary", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "step-output",
    });

    const loop = new TaskLoop(makeAgent(), achieveOnCall(3), {
      maxIterations: 5,
    });
    const result = await loop.run("Goal", {}, { runner });

    expect(result.state.iteration).toBe(3);
    expect(result.state.history).toHaveLength(3);
    expect(result.state.getHistorySummary()).toContain("step-output");
  });

  it("returns frozen result", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const loop = new TaskLoop(makeAgent(), achieveOnCall(1));
    const result = await loop.run("Goal", {}, { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
