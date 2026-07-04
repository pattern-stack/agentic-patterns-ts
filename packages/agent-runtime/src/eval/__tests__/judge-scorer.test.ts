/**
 * Tests for `judgeScorer` (spec `.ai-docs/stacks/eval-surface/specs/141.md` § Test plan).
 *
 * All judge calls run through `MockRunner` (substring-trigger canned responses;
 * `callHistory` records `agentName`/`model` per call) — no live LLM.
 */

import { describe, expect, it } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { runEval } from "../run-eval.js";
import { exactMatch } from "../scorer.js";
import { judgeScorer } from "../scorers/judge.js";
import type { EvalCase, Score } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function verdictJson(
  overrides: {
    pass?: boolean;
    axes?: Partial<{
      accuracy: number;
      completeness: number;
      grounding: number;
      hazardAvoidance: number;
      calibration: number;
    }>;
    notes?: string;
  } = {},
): string {
  return JSON.stringify({
    pass: overrides.pass ?? true,
    axes: {
      accuracy: 4,
      completeness: 4,
      grounding: 4,
      hazardAvoidance: 5,
      calibration: 3,
      ...overrides.axes,
    },
    notes: overrides.notes ?? "Solid, well-grounded answer.",
  });
}

async function scoreOnce(
  scorer: ReturnType<typeof judgeScorer>,
  args: { input?: unknown; output: unknown; expected?: unknown },
): Promise<Score[]> {
  const evalCase: EvalCase<unknown, unknown> = {
    id: "c1",
    input: args.input ?? "q",
    expected: args.expected,
  };
  const result = await scorer({
    input: args.input ?? "q",
    output: args.output,
    expected: args.expected,
    case: evalCase,
  });
  return Array.isArray(result) ? result : [result];
}

function makeAgentLikeTarget(): AgentLike {
  return {
    role: { name: "target" },
    getModel: () => "target-model",
    getTools: () => [],
    getSystemPrompt: () => "system",
    renderInitialPrompt: () => "",
  };
}

// ---------------------------------------------------------------------------
// T-J1 — happy path
// ---------------------------------------------------------------------------

describe("judgeScorer — T-J1 (happy path)", () => {
  it("MockRunner canned valid verdict → 6 scores with the pinned shape", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: verdictJson(),
      inputTokens: 120,
      outputTokens: 40,
    });
    const scorer = judgeScorer({ runner });

    const scores = await scoreOnce(scorer, {
      output: "Paris is the capital of France.",
      expected: "Paris",
    });

    expect(scores).toHaveLength(6);
    expect(scores.map((s) => s.name)).toEqual([
      "judge",
      "judge:accuracy",
      "judge:completeness",
      "judge:grounding",
      "judge:hazard-avoidance",
      "judge:calibration",
    ]);

    const overall = scores[0] as Score;
    const mean = (4 + 4 + 4 + 5 + 3) / 5;
    expect(overall.value).toBeCloseTo(mean / 5);
    expect(overall.passed).toBe(true);
    expect(overall.detail?.axes).toEqual({
      accuracy: 4,
      completeness: 4,
      grounding: 4,
      hazardAvoidance: 5,
      calibration: 3,
    });
    expect(overall.detail?.judgeInputTokens).toBe(120);
    expect(overall.detail?.judgeOutputTokens).toBe(40);

    // Unconfigured axes stay informational — `passed` absent (no thresholds).
    for (const axisScore of scores.slice(1)) {
      expect(axisScore.passed).toBeUndefined();
    }

    const accuracyScore = scores[1] as Score;
    expect(accuracyScore.value).toBeCloseTo(4 / 5);
    expect(accuracyScore.detail).toEqual({ raw: 4 });
  });
});

// ---------------------------------------------------------------------------
// T-J2 — thresholds
// ---------------------------------------------------------------------------

describe("judgeScorer — T-J2 (thresholds)", () => {
  it("axis threshold + mean threshold gate independently of verdict.pass", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: verdictJson({
        pass: true,
        axes: { grounding: 2, accuracy: 3, completeness: 3, hazardAvoidance: 3, calibration: 3 },
      }),
    });
    const scorer = judgeScorer({ runner, thresholds: { grounding: 3, mean: 3.5 } });

    const scores = await scoreOnce(scorer, { output: "some answer", expected: "answer" });
    const overall = scores[0] as Score;
    const grounding = scores.find((s) => s.name === "judge:grounding") as Score;

    expect(grounding.passed).toBe(false); // raw 2 < threshold 3
    expect(overall.passed).toBe(false); // mean 2.8 < 3.5, even though verdict.pass was true
  });
});

// ---------------------------------------------------------------------------
// T-J3 — garbage output
// ---------------------------------------------------------------------------

describe("judgeScorer — T-J3 (garbage output)", () => {
  it("unparseable text → exactly one ERRORED Score, never throws", async () => {
    const runner = new MockRunner().addResponse("*", { content: "Looks fine to me!" });
    const scorer = judgeScorer({ runner });

    const scores = await scoreOnce(scorer, { output: "some answer", expected: "answer" });

    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ name: "judge", value: null });
    expect(scores[0]?.error).toMatch(/unparseable/);
    expect(scores[0]?.passed).toBeUndefined();
  });

  it("through runEval: scoreErrors counted, judge absent from scoreMeans, no throw", async () => {
    const judgeRunner = new MockRunner().addResponse("*", { content: "Looks fine to me!" });
    const targetRunner = new MockRunner().addResponse("*", { content: "answer text" });
    const target = makeAgentLikeTarget();

    const report = await runEval(
      {
        target,
        cases: [{ id: "c1", input: "q", expected: "answer" }],
        scorers: [judgeScorer({ runner: judgeRunner })],
      },
      { runner: targetRunner },
    );

    expect(report.summary.scoreErrors).toBe(1);
    expect(report.summary.scoreMeans.judge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-J4 — schema-invalid JSON + fenced/prose-wrapped JSON
// ---------------------------------------------------------------------------

describe("judgeScorer — T-J4 (schema-invalid + fenced/prose JSON)", () => {
  it("valid JSON missing required fields → ERRORED with a schema reason", async () => {
    const runner = new MockRunner().addResponse("*", { content: '{"pass": true}' });
    const scorer = judgeScorer({ runner });

    const scores = await scoreOnce(scorer, { output: "answer", expected: "answer" });

    expect(scores).toHaveLength(1);
    expect(scores[0]?.value).toBeNull();
    expect(scores[0]?.error).toMatch(/unparseable/);
  });

  it("fenced JSON (```json … ```) parses", async () => {
    const fenced = `\`\`\`json\n${verdictJson()}\n\`\`\``;
    const runner = new MockRunner().addResponse("*", { content: fenced });
    const scorer = judgeScorer({ runner });

    const scores = await scoreOnce(scorer, { output: "answer", expected: "answer" });
    expect(scores).toHaveLength(6);
    expect(scores[0]?.value).not.toBeNull();
  });

  it("JSON wrapped in prose parses via the balanced-brace scan", async () => {
    const prose = `Sure, here is my verdict:\n${verdictJson()}\nHope that helps!`;
    const runner = new MockRunner().addResponse("*", { content: prose });
    const scorer = judgeScorer({ runner });

    const scores = await scoreOnce(scorer, { output: "answer", expected: "answer" });
    expect(scores).toHaveLength(6);
    expect(scores[0]?.value).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-J5 — runner throws
// ---------------------------------------------------------------------------

describe("judgeScorer — T-J5 (runner throws)", () => {
  it("a throwing runner call → ERRORED Score, scorer does not throw", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "unused",
      error: new Error("connection reset"),
    });
    const scorer = judgeScorer({ runner });

    const scores = await scoreOnce(scorer, { output: "some answer", expected: "answer" });

    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ name: "judge", value: null });
    expect(scores[0]?.error).toMatch(/unparseable/);
    expect(scores[0]?.error).toContain("connection reset");
  });
});

// ---------------------------------------------------------------------------
// T-J6 — expected-gating + empty-answer short-circuit
// ---------------------------------------------------------------------------

describe("judgeScorer — T-J6 (expected-gating + empty-answer short-circuit)", () => {
  it("expected undefined → [] by default (requireExpected: true)", async () => {
    const runner = new MockRunner().addResponse("*", { content: verdictJson() });
    const scorer = judgeScorer({ runner });

    const scores = await scoreOnce(scorer, { output: "some answer", expected: undefined });
    expect(scores).toEqual([]);
    expect(runner.callHistory).toHaveLength(0);
  });

  it("requireExpected: false → judge runs even without expected", async () => {
    const runner = new MockRunner().addResponse("*", { content: verdictJson() });
    const scorer = judgeScorer({ runner, requireExpected: false });

    const scores = await scoreOnce(scorer, { output: "some answer", expected: undefined });
    expect(scores).toHaveLength(6);
    expect(runner.callHistory).toHaveLength(1);
  });

  it("empty output → no runner call, all-zero axes, pass false", async () => {
    const runner = new MockRunner().addResponse("*", { content: verdictJson() });
    const scorer = judgeScorer({ runner });

    const scores = await scoreOnce(scorer, { output: "   ", expected: "answer" });

    expect(runner.callHistory).toHaveLength(0);
    const overall = scores[0] as Score;
    expect(overall.passed).toBe(false);
    expect(overall.detail?.axes).toEqual({
      accuracy: 0,
      completeness: 0,
      grounding: 0,
      hazardAvoidance: 0,
      calibration: 0,
    });
    expect(overall.detail?.notes).toMatch(/no answer produced/);
  });
});

// ---------------------------------------------------------------------------
// T-J7 — injection seam
// ---------------------------------------------------------------------------

describe("judgeScorer — T-J7 (injection seam)", () => {
  it("default agent: agentName eval-judge, model = opts.model", async () => {
    const runner = new MockRunner().addResponse("*", { content: verdictJson() });
    const scorer = judgeScorer({ runner, model: "opus" });

    await scoreOnce(scorer, { output: "answer", expected: "answer" });

    expect(runner.callHistory[0]?.agentName).toBe("eval-judge");
    expect(runner.callHistory[0]?.model).toBe("opus");
  });

  it("custom agent override wins over model/system", async () => {
    const runner = new MockRunner().addResponse("*", { content: verdictJson() });
    const customAgent: AgentLike = {
      role: { name: "custom-judge" },
      getModel: () => "custom-model",
      getTools: () => [],
      getSystemPrompt: () => "custom system",
      renderInitialPrompt: () => "",
    };
    const scorer = judgeScorer({ runner, model: "opus", agent: customAgent });

    await scoreOnce(scorer, { output: "answer", expected: "answer" });

    expect(runner.callHistory[0]?.agentName).toBe("custom-judge");
    expect(runner.callHistory[0]?.model).toBe("custom-model");
  });
});

// ---------------------------------------------------------------------------
// T-J8 — runEval integration / scores_json shape
// ---------------------------------------------------------------------------

describe("judgeScorer — T-J8 (runEval integration)", () => {
  it("judge + exactMatch on one case — EvalResult.scores holds both families", async () => {
    const judgeRunner = new MockRunner().addResponse("*", { content: verdictJson() });
    const targetRunner = new MockRunner().addResponse("*", { content: "Paris" });
    const target = makeAgentLikeTarget();

    const results: Score[][] = [];

    const report = await runEval(
      {
        target,
        cases: [{ id: "c1", input: "capital of France?", expected: "Paris" }],
        scorers: [exactMatch<unknown>(), judgeScorer({ runner: judgeRunner })],
        onResult: (r) => {
          results.push([...r.scores]);
        },
      },
      { runner: targetRunner },
    );

    const names = report.results[0]?.scores.map((s) => s.name) ?? [];
    expect(names).toContain("exact-match");
    expect(names).toContain("judge");
    expect(names).toContain("judge:accuracy");
    expect(results[0]?.map((s) => s.name)).toEqual(names);
  });
});
