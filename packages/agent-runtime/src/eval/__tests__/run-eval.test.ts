import { describe, expect, it } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { asAgent } from "../../workflows/as-agent.js";
import { FunctionStep } from "../../workflows/function-step.js";
import type { Node, NodeResult, NodeRunContext } from "../../workflows/node.js";
import { Sequential } from "../../workflows/sequential.js";
import { runEval } from "../run-eval.js";
import { exactMatch, predicateScorer } from "../scorer.js";
import { EvalResultSchema, ScoreSchema } from "../types.js";

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

/** A Node that always fails — for the "node failure is scored, not thrown" test. */
class FailingNode implements Node<string, string> {
  readonly name = "failing";
  async run(_input: string, _ctx: NodeRunContext): Promise<NodeResult<string>> {
    return {
      output: undefined as unknown as string,
      succeeded: false,
      error: new Error("boom"),
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// 1. Bare Node target
// ---------------------------------------------------------------------------

describe("runEval — bare Node target", () => {
  it("runs 3 cases through a FunctionStep and scores with exactMatch", async () => {
    const upper = new FunctionStep<string, string>({
      name: "upper",
      fn: (input) => input.toUpperCase(),
    });

    const report = await runEval(
      {
        target: upper,
        cases: [
          { id: "1", input: "a", expected: "A" },
          { id: "2", input: "b", expected: "B" },
          { id: "3", input: "c", expected: "nope" },
        ],
        scorers: [exactMatch<string>()],
      },
      { runner: new MockRunner() },
    );

    expect(report.target).toBe("node");
    expect(report.results).toHaveLength(3);
    expect(report.results[0]?.output).toBe("A");
    expect(report.results[0]?.scores[0]?.value).toBe(1);
    expect(report.results[2]?.scores[0]?.value).toBe(0);
    expect(report.summary.cases).toBe(3);
    expect(report.summary.succeeded).toBe(3);
    expect(report.summary.errored).toBe(0);
    expect(report.summary.scoreMeans["exact-match"]).toBeCloseTo(2 / 3);
    expect(report.summary.passRate["exact-match"]).toBeCloseTo(2 / 3);
  });
});

// ---------------------------------------------------------------------------
// 2. Bare Agent target
// ---------------------------------------------------------------------------

describe("runEval — bare Agent target", () => {
  it("wraps the agent in AgentStep and runs it via the injected MockRunner", async () => {
    const agent = makeAgent("bare-agent");
    const runner = new MockRunner().addResponse("*", { content: "canned response" });

    const report = await runEval(
      {
        target: agent,
        cases: [{ id: "1", input: "hello" }],
        scorers: [],
      },
      { runner },
    );

    expect(report.target).toBe("agent");
    expect(report.results[0]?.output).toBe("canned response");
    expect(report.results[0]?.succeeded).toBe(true);
    expect(runner.callHistory).toHaveLength(1);
    expect(runner.callHistory[0]?.agentName).toBe("bare-agent");
  });
});

// ---------------------------------------------------------------------------
// 3. Promoted pipeline target — the "same API" acceptance criterion
// ---------------------------------------------------------------------------

describe("runEval — asAgent-promoted pipeline target", () => {
  it("unwraps __promotedNode and feeds typed TIn directly, bypassing coerceIn", async () => {
    const a = new FunctionStep<{ n: number }, { n: number }>({
      name: "double",
      fn: (input) => ({ n: input.n * 2 }),
    });
    const b = new FunctionStep<{ n: number }, { n: number }>({
      name: "increment",
      fn: (input) => ({ n: input.n + 1 }),
    });
    const pipeline = Sequential.start(a).then(b).build("double-then-increment");
    const promoted = asAgent(pipeline, {
      role: { name: "Pipe" },
      coerceIn: (message: string) => ({ n: Number(message) }),
    });

    const report = await runEval(
      {
        target: promoted,
        cases: [
          { id: "1", input: { n: 1 }, expected: { n: 3 } },
          { id: "2", input: { n: 2 }, expected: { n: 5 } },
        ],
        scorers: [exactMatch<{ n: number }>()],
      },
      { runner: new MockRunner() },
    );

    expect(report.target).toBe("promoted");
    expect(report.results[0]?.output).toEqual({ n: 3 });
    expect(report.results[1]?.output).toEqual({ n: 5 });
    expect(report.results.every((r) => r.scores[0]?.value === 1)).toBe(true);
  });

  it("exposes the same runEval() call shape across Node, Agent, and promoted targets", async () => {
    // Node target
    const nodeReport = await runEval(
      {
        target: new FunctionStep<string, string>({ fn: (i) => i }),
        cases: [{ id: "1", input: "x" }],
        scorers: [],
      },
      { runner: new MockRunner() },
    );

    // Agent target
    const agentReport = await runEval(
      {
        target: makeAgent(),
        cases: [{ id: "1", input: "x" }],
        scorers: [],
      },
      { runner: new MockRunner() },
    );

    // Promoted target
    const promotedReport = await runEval(
      {
        target: asAgent(new FunctionStep<string, string>({ fn: (i) => i }), {
          role: { name: "P" },
        }),
        cases: [{ id: "1", input: "x" }],
        scorers: [],
      },
      { runner: new MockRunner() },
    );

    for (const report of [nodeReport, agentReport, promotedReport]) {
      expect(report.results).toHaveLength(1);
      expect(report.summary.cases).toBe(1);
    }
    expect(nodeReport.target).toBe("node");
    expect(agentReport.target).toBe("agent");
    expect(promotedReport.target).toBe("promoted");
  });
});

// ---------------------------------------------------------------------------
// 4. predicateScorer + multiple scorers per case
// ---------------------------------------------------------------------------

describe("runEval — multiple scorers per case", () => {
  it("runs all scorers and aggregates each independently", async () => {
    const node = new FunctionStep<number, number>({ fn: (n) => n * 2 });
    const isEven = predicateScorer<number, number, undefined>(
      "is-even",
      (output) => output % 2 === 0,
    );
    const gtTen = predicateScorer<number, number, undefined>("gt-ten", (output) => output > 10);

    const report = await runEval(
      {
        target: node,
        cases: [
          { id: "1", input: 3 }, // -> 6
          { id: "2", input: 6 }, // -> 12
        ],
        scorers: [isEven, gtTen],
      },
      { runner: new MockRunner() },
    );

    expect(report.results[0]?.scores).toHaveLength(2);
    expect(report.summary.scoreMeans["is-even"]).toBe(1);
    expect(report.summary.scoreMeans["gt-ten"]).toBeCloseTo(0.5);
    expect(report.summary.passRate["gt-ten"]).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// 5. Node failure is scored, not thrown
// ---------------------------------------------------------------------------

describe("runEval — node failure semantics", () => {
  it("records succeeded:false + error, empty scores, and increments summary.errored — never rejects", async () => {
    const report = await runEval(
      {
        target: new FailingNode(),
        cases: [{ id: "1", input: "x" }],
        scorers: [exactMatch<string>()],
      },
      { runner: new MockRunner() },
    );

    expect(report.results[0]?.succeeded).toBe(false);
    expect(report.results[0]?.error).toBe("boom");
    expect(report.results[0]?.scores).toEqual([]);
    expect(report.summary.errored).toBe(1);
    expect(report.summary.succeeded).toBe(0);
  });

  it("records a throwing scorer as ERRORED (value:null + error), excluded from aggregate math", async () => {
    const throwingScorer = () => {
      throw new Error("scorer exploded");
    };

    const report = await runEval(
      {
        target: new FunctionStep<string, string>({ fn: (i) => i }),
        cases: [
          { id: "1", input: "a" },
          { id: "2", input: "b" },
        ],
        scorers: [exactMatch<string>(), throwingScorer],
      },
      { runner: new MockRunner() },
    );

    for (const result of report.results) {
      const errored = result.scores.find((s) => s.value === null);
      expect(errored).toBeDefined();
      expect(errored?.error).toBe("scorer exploded");
    }
    // Excluded from aggregate math: only exact-match (both null, no expected -> 0) contributes.
    expect(Object.keys(report.summary.scoreMeans)).not.toContain("throwingScorer");
    expect(report.summary.scoreErrors).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. onResult seam
// ---------------------------------------------------------------------------

describe("runEval — onResult seam", () => {
  it("fires once per case with the built EvalResult", async () => {
    const seen: string[] = [];
    await runEval(
      {
        target: new FunctionStep<string, string>({ fn: (i) => i }),
        cases: [
          { id: "1", input: "a" },
          { id: "2", input: "b" },
        ],
        scorers: [],
        onResult: (r) => {
          seen.push(r.case.id);
        },
      },
      { runner: new MockRunner() },
    );

    expect(seen).toEqual(["1", "2"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Zod schema round-trip
// ---------------------------------------------------------------------------

describe("runEval — Zod schema round-trip", () => {
  it("ScoreSchema and EvalResultSchema parse a built result", async () => {
    const report = await runEval(
      {
        target: new FunctionStep<string, string>({ fn: (i) => i.toUpperCase() }),
        cases: [{ id: "1", input: "a", expected: "A" }],
        scorers: [exactMatch<string>()],
      },
      { runner: new MockRunner() },
    );

    const result = report.results[0];
    expect(ScoreSchema.parse(result?.scores[0])).toBeDefined();
    expect(EvalResultSchema.parse(result)).toBeDefined();
  });
});
