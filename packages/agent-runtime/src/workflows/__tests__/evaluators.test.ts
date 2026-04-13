import { describe, expect, it } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import {
  EvaluatorChain,
  LLMGoalEvaluator,
  SelfEvalGoalEvaluator,
  SimpleGoalEvaluator,
} from "../evaluators.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(name = "evaluator"): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    getSystemPrompt: () => "You evaluate goals.",
    renderInitialPrompt: () => "",
  };
}

// ---------------------------------------------------------------------------
// SimpleGoalEvaluator
// ---------------------------------------------------------------------------

describe("SimpleGoalEvaluator", () => {
  it("matches success pattern", async () => {
    const evaluator = new SimpleGoalEvaluator();
    const [achieved, reason, confident] = await evaluator.evaluate(
      "complete task",
      "The task is TASK_COMPLETE and done.",
    );
    expect(achieved).toBe(true);
    expect(confident).toBe(true);
    expect(reason).toContain("TASK_COMPLETE");
  });

  it("matches failure pattern", async () => {
    const evaluator = new SimpleGoalEvaluator();
    const [achieved, , confident] = await evaluator.evaluate(
      "complete task",
      "CANNOT_PROCEED due to missing data.",
    );
    expect(achieved).toBe(false);
    expect(confident).toBe(true);
  });

  it("returns not-confident when no patterns match", async () => {
    const evaluator = new SimpleGoalEvaluator();
    const [achieved, , confident] = await evaluator.evaluate(
      "complete task",
      "I made some progress on the analysis.",
    );
    expect(achieved).toBe(false);
    expect(confident).toBe(false);
  });

  it("accepts custom patterns", async () => {
    const evaluator = new SimpleGoalEvaluator({
      successPatterns: ["DONE"],
      failurePatterns: ["STUCK"],
    });
    const [achieved, , confident] = await evaluator.evaluate("test", "All DONE here.");
    expect(achieved).toBe(true);
    expect(confident).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SelfEvalGoalEvaluator
// ---------------------------------------------------------------------------

describe("SelfEvalGoalEvaluator", () => {
  it("parses GOAL_STATUS: ACHIEVED", async () => {
    const evaluator = new SelfEvalGoalEvaluator();
    const [achieved, reason, confident] = await evaluator.evaluate(
      "write code",
      "GOAL_STATUS: ACHIEVED\nPROGRESS: Code written and tested.",
    );
    expect(achieved).toBe(true);
    expect(reason).toBe("Code written and tested.");
    expect(confident).toBe(true);
  });

  it("parses GOAL_STATUS: NOT_ACHIEVED", async () => {
    const evaluator = new SelfEvalGoalEvaluator();
    const [achieved, reason, confident] = await evaluator.evaluate(
      "write code",
      "GOAL_STATUS: NOT_ACHIEVED\nPROGRESS: Still working on it.",
    );
    expect(achieved).toBe(false);
    expect(reason).toBe("Still working on it.");
    expect(confident).toBe(true);
  });

  it("returns not-confident with only PROGRESS marker", async () => {
    const evaluator = new SelfEvalGoalEvaluator();
    const [achieved, reason, confident] = await evaluator.evaluate(
      "write code",
      "PROGRESS: Making headway.",
    );
    expect(achieved).toBe(false);
    expect(reason).toBe("Making headway.");
    expect(confident).toBe(false);
  });

  it("returns not-confident with no markers", async () => {
    const evaluator = new SelfEvalGoalEvaluator();
    const [, , confident] = await evaluator.evaluate("write code", "Just some random output.");
    expect(confident).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LLMGoalEvaluator
// ---------------------------------------------------------------------------

describe("LLMGoalEvaluator", () => {
  it("uses MockRunner to evaluate", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "GOAL_STATUS: ACHIEVED\nPROGRESS: Looks good.",
    });

    const evaluator = new LLMGoalEvaluator({
      agent: makeAgent(),
      runner,
    });

    const [achieved, reason, confident] = await evaluator.evaluate(
      "write a poem",
      "Roses are red...",
    );
    expect(achieved).toBe(true);
    expect(reason).toBe("Looks good.");
    expect(confident).toBe(true);
    expect(runner.callHistory).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// EvaluatorChain
// ---------------------------------------------------------------------------

describe("EvaluatorChain", () => {
  it("stops on first confident result", async () => {
    const notConfident = {
      async evaluate(): Promise<readonly [boolean, string, boolean]> {
        return [false, "Not sure", false] as const;
      },
    };
    const confident = {
      async evaluate(): Promise<readonly [boolean, string, boolean]> {
        return [true, "Yes!", true] as const;
      },
    };
    const shouldNotRun = {
      async evaluate(): Promise<readonly [boolean, string, boolean]> {
        throw new Error("Should not be called");
      },
    };

    const chain = new EvaluatorChain([notConfident, confident, shouldNotRun]);
    const [achieved, reason, isConfident] = await chain.evaluate("goal", "output");

    expect(achieved).toBe(true);
    expect(reason).toBe("Yes!");
    expect(isConfident).toBe(true);
  });

  it("returns last result if none are confident", async () => {
    const eval1 = {
      async evaluate(): Promise<readonly [boolean, string, boolean]> {
        return [false, "Unsure 1", false] as const;
      },
    };
    const eval2 = {
      async evaluate(): Promise<readonly [boolean, string, boolean]> {
        return [false, "Unsure 2", false] as const;
      },
    };

    const chain = new EvaluatorChain([eval1, eval2]);
    const [, reason, confident] = await chain.evaluate("goal", "output");

    expect(reason).toBe("Unsure 2");
    expect(confident).toBe(false);
  });
});
