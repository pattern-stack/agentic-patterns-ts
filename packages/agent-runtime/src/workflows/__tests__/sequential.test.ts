import { describe, expect, it } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { AgentStep } from "../agent-step.js";
import { FunctionStep } from "../function-step.js";
import { Sequential } from "../sequential.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(name = "test-agent"): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    renderInitialPrompt: () => "Initial prompt",
  };
}

// ---------------------------------------------------------------------------
// Sequential
// ---------------------------------------------------------------------------

describe("Sequential", () => {
  it("threads typed output node→node and rolls up tokens (AgentStep chain)", async () => {
    const runner = new MockRunner()
      .addResponse("Step 1", { content: "result-1", inputTokens: 5, outputTokens: 10 })
      .addResponse("Step 2", { content: "result-2", inputTokens: 6, outputTokens: 11 })
      .addResponse("Step 3", { content: "result-3", inputTokens: 7, outputTokens: 12 });

    const seq = Sequential.start(
      new AgentStep<{ topic: string }, string>({
        name: "first",
        agent: makeAgent("agent-1"),
        prompt: (input) => `Step 1: ${input.topic}`,
      }),
    )
      .then(
        new AgentStep<string, string>({
          name: "second",
          agent: makeAgent("agent-2"),
          prompt: (prev) => `Step 2: ${prev}`,
        }),
      )
      .then(
        new AgentStep<string, string>({
          name: "third",
          agent: makeAgent("agent-3"),
          prompt: (prev) => `Step 3: ${prev}`,
        }),
      )
      .build();

    const result = await seq.run({ topic: "go" }, { runner });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("result-3");
    expect(result.totalInputTokens).toBe(18);
    expect(result.totalOutputTokens).toBe(33);

    // Threading: each step's typed output is the next step's input.
    expect(runner.callHistory[1]?.message).toBe("Step 2: result-1");
    expect(runner.callHistory[2]?.message).toBe("Step 3: result-2");
  });

  it("threads typed objects through FunctionStep nodes", async () => {
    const runner = new MockRunner();
    const seq = Sequential.start(
      new FunctionStep<number, { n: number }>({ name: "wrap", fn: (n) => ({ n: n + 1 }) }),
    )
      .then(new FunctionStep<{ n: number }, number>({ name: "double", fn: (x) => x.n * 2 }))
      .build();

    const result = await seq.run(10, { runner });
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe(22);
  });

  it("supports a nested Sequential as a child node", async () => {
    const runner = new MockRunner();
    const inner = Sequential.start(
      new FunctionStep<number, number>({ name: "inc", fn: (n) => n + 1 }),
    )
      .then(new FunctionStep<number, number>({ name: "inc2", fn: (n) => n + 1 }))
      .build("inner");

    const outer = Sequential.start(inner)
      .then(new FunctionStep<number, number>({ name: "times10", fn: (n) => n * 10 }))
      .build("outer");

    const result = await outer.run(0, { runner });
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe(20);
  });

  it("stops on the first failed child by default", async () => {
    const runner = new MockRunner();
    const reached: string[] = [];
    const seq = Sequential.start(new FunctionStep<number, number>({ name: "ok", fn: (n) => n + 1 }))
      .then(
        new FunctionStep<number, number>({
          name: "boom",
          fn: () => {
            throw new Error("boom");
          },
        }),
      )
      .then(
        new FunctionStep<number, number>({
          name: "never",
          fn: (n) => {
            reached.push("never");
            return n;
          },
        }),
      )
      .build();

    const result = await seq.run(0, { runner });
    expect(result.succeeded).toBe(false);
    expect(result.error?.message).toBe("boom");
    expect(reached).toEqual([]); // third step never ran
  });

  it("continues past a failed child when continueOnError is true", async () => {
    const runner = new MockRunner();
    const reached: string[] = [];
    const seq = Sequential.start(
      new FunctionStep<number, number>({
        name: "boom",
        fn: () => {
          throw new Error("boom");
        },
      }),
      { continueOnError: true },
    )
      .then(
        new FunctionStep<number, number>({
          name: "after",
          fn: (n) => {
            reached.push("after");
            return n;
          },
        }),
      )
      .build();

    const result = await seq.run(7, { runner });
    expect(result.succeeded).toBe(false); // a child failed
    expect(reached).toEqual(["after"]); // but we continued
  });

  it("fires hook callbacks in order", async () => {
    const runner = new MockRunner();
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

    const seq = Sequential.start(
      new FunctionStep<number, number>({ name: "s1", fn: (n) => n }),
    ).build();
    await seq.run(1, { runner, hooks });

    expect(events).toEqual(["pattern-start", "step-start", "step-complete", "pattern-complete"]);
  });

  it("returns a frozen result", async () => {
    const runner = new MockRunner();
    const seq = Sequential.start(
      new FunctionStep<number, number>({ name: "s1", fn: (n) => n }),
    ).build();
    const result = await seq.run(1, { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
