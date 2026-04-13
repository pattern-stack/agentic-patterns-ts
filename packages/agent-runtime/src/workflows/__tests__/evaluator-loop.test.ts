import { describe, expect, it } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import {
  CompositeRefinementEvaluator,
  EvaluatorLoop,
  type RefinementEvaluator,
  RubricEvaluator,
} from "../evaluator-loop.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(name = "producer"): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    getSystemPrompt: () => "You are a producer.",
    renderInitialPrompt: () => "Initial prompt",
  };
}

/** Evaluator that gives increasing scores and meets quality on Nth call. */
function improvingEvaluator(meetQualityOnCall: number): RefinementEvaluator {
  let callCount = 0;
  return {
    async evaluate() {
      callCount++;
      const score = callCount * 0.3;
      return {
        score: Math.min(score, 1),
        feedback: `Iteration ${callCount} feedback`,
        qualityMet: callCount >= meetQualityOnCall,
      };
    },
  };
}

/** Evaluator that always returns the same score. */
function flatEvaluator(score: number): RefinementEvaluator {
  return {
    async evaluate() {
      return {
        score,
        feedback: "No changes needed",
        qualityMet: false,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// EvaluatorLoop
// ---------------------------------------------------------------------------

describe("EvaluatorLoop", () => {
  it("achieves quality in 2 refinements", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "draft output",
      inputTokens: 5,
      outputTokens: 10,
    });

    const loop = new EvaluatorLoop(makeAgent(), improvingEvaluator(2), {
      maxRefinements: 5,
    });
    const result = await loop.run("Write something good", { runner });

    expect(result.succeeded).toBe(true);
    expect(result.exitReason).toBe("quality_met");
    expect(result.iterations).toBe(2);
    expect(result.refinements).toHaveLength(2);
    expect(result.totalInputTokens).toBe(10);
    expect(result.totalOutputTokens).toBe(20);
  });

  it("exits on max refinements", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "draft",
      inputTokens: 1,
      outputTokens: 2,
    });

    const loop = new EvaluatorLoop(makeAgent(), improvingEvaluator(100), {
      maxRefinements: 3,
    });
    const result = await loop.run("Write something", { runner });

    expect(result.succeeded).toBe(false);
    expect(result.exitReason).toBe("max_refinements");
    expect(result.iterations).toBe(3);
  });

  it("exits on no improvement (score plateau)", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "draft",
    });

    const loop = new EvaluatorLoop(makeAgent(), flatEvaluator(0.5), {
      maxRefinements: 10,
      minImprovement: 0.01,
    });
    const result = await loop.run("Write something", { runner });

    expect(result.succeeded).toBe(false);
    expect(result.exitReason).toBe("no_improvement");
    // First iteration sets baseline, second detects plateau
    expect(result.iterations).toBe(2);
  });

  it("tracks best output by score", async () => {
    let callCount = 0;
    const evaluator: RefinementEvaluator = {
      async evaluate() {
        callCount++;
        // Scores: 0.8, 0.3, 0.5 — best is first (0.8)
        const scores = [0.8, 0.3, 0.5];
        const score = scores[(callCount - 1) % scores.length] ?? 0;
        return { score, feedback: "feedback", qualityMet: false };
      },
    };

    // Need runner to return different content per call to distinguish
    // MockRunner returns same content for *, so track via refinements
    const runner = new MockRunner().addResponse("*", { content: "draft" });

    const loop = new EvaluatorLoop(makeAgent(), evaluator, {
      maxRefinements: 3,
    });
    const result = await loop.run("Write", { runner });

    expect(result.bestScore).toBe(0.8);
  });

  it("passes feedback to producer on subsequent iterations", async () => {
    const runner = new MockRunner().addResponse("*", { content: "draft" });

    const loop = new EvaluatorLoop(makeAgent(), improvingEvaluator(2), {
      maxRefinements: 5,
    });
    await loop.run("Write a haiku", { runner });

    // Second call should contain feedback from first evaluation
    const secondPrompt = runner.callHistory[1]?.message ?? "";
    expect(secondPrompt).toContain("FEEDBACK FROM EVALUATOR");
    expect(secondPrompt).toContain("Iteration 1 feedback");
  });

  it("fires hook callbacks", async () => {
    const runner = new MockRunner().addResponse("*", { content: "draft" });
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

    const loop = new EvaluatorLoop(makeAgent(), improvingEvaluator(1), {
      maxRefinements: 5,
    });
    await loop.run("Write", { runner, hooks });

    expect(events).toEqual(["start", "iter-start", "iter-complete", "complete"]);
  });

  it("returns frozen result", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const loop = new EvaluatorLoop(makeAgent(), improvingEvaluator(1));
    const result = await loop.run("Write", { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RubricEvaluator
// ---------------------------------------------------------------------------

describe("RubricEvaluator", () => {
  it("scores against weighted criteria", async () => {
    const evaluator = new RubricEvaluator(
      [
        { name: "length", weight: 2, score: (_input, output) => (output.length > 5 ? 1 : 0.5) },
        {
          name: "keywords",
          weight: 1,
          score: (_input, output) => (output.includes("good") ? 1 : 0),
        },
      ],
      0.8,
    );

    const result = await evaluator.evaluate("test", "this is good content");
    // length: 1 * 2 = 2, keywords: 1 * 1 = 1, total = 3/3 = 1.0
    expect(result.score).toBe(1);
    expect(result.qualityMet).toBe(true);
    expect(result.feedback).toContain("length");
    expect(result.feedback).toContain("keywords");
  });

  it("clamps scores to [0, 1]", async () => {
    const evaluator = new RubricEvaluator([
      { name: "over", weight: 1, score: () => 2.0 },
      { name: "under", weight: 1, score: () => -0.5 },
    ]);

    const result = await evaluator.evaluate("test", "output");
    // clamped: 1.0 * 1 + 0.0 * 1 = 1/2 = 0.5
    expect(result.score).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// CompositeRefinementEvaluator
// ---------------------------------------------------------------------------

describe("CompositeRefinementEvaluator", () => {
  it("computes weighted average of sub-evaluators", async () => {
    const high: RefinementEvaluator = {
      async evaluate() {
        return { score: 0.9, feedback: "high quality", qualityMet: true };
      },
    };
    const low: RefinementEvaluator = {
      async evaluate() {
        return { score: 0.3, feedback: "needs work", qualityMet: false };
      },
    };

    const composite = new CompositeRefinementEvaluator(
      [
        { evaluator: high, weight: 3 },
        { evaluator: low, weight: 1 },
      ],
      0.7,
    );

    const result = await composite.evaluate("test", "output");
    // (0.9 * 3 + 0.3 * 1) / 4 = 3.0 / 4 = 0.75
    expect(result.score).toBe(0.75);
    expect(result.qualityMet).toBe(true);
    expect(result.feedback).toContain("high quality");
    expect(result.feedback).toContain("needs work");
  });

  it("fails quality when below threshold", async () => {
    const low: RefinementEvaluator = {
      async evaluate() {
        return { score: 0.4, feedback: "poor", qualityMet: false };
      },
    };

    const composite = new CompositeRefinementEvaluator([{ evaluator: low, weight: 1 }], 0.8);

    const result = await composite.evaluate("test", "output");
    expect(result.score).toBe(0.4);
    expect(result.qualityMet).toBe(false);
  });
});
