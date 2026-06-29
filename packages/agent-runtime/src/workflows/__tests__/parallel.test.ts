import { describe, expect, it } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { AgentStep } from "../agent-step.js";
import { FunctionStep } from "../function-step.js";
import type { Node } from "../node.js";
import { Parallel } from "../parallel.js";

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
  it("converts a throwing branch into a failed branch — siblings proceed", async () => {
    const runner = new MockRunner();
    const ok: Node<string, string> = {
      name: "ok",
      run: async () => ({
        output: "ok",
        succeeded: true,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
    };
    const boom: Node<string, string> = {
      name: "boom",
      run: async () => {
        throw new Error("kaboom");
      },
    };
    const par = new Parallel<string, string>([
      { name: "a", node: ok },
      { name: "b", node: boom },
    ]);

    const result = await par.run("in", { runner });
    expect(result.succeeded).toBe(false);
    expect(result.error?.message).toBe("kaboom");
    expect((result.output as string[])[0]).toBe("ok"); // sibling completed despite the throw
  });

  it("runs N branches over the shared input, collecting outputs in branch order", async () => {
    const runner = new MockRunner()
      .addResponse("task-A", { content: "result-A", inputTokens: 1, outputTokens: 2 })
      .addResponse("task-B", { content: "result-B", inputTokens: 3, outputTokens: 4 })
      .addResponse("task-C", { content: "result-C", inputTokens: 5, outputTokens: 6 });

    const par = new Parallel<unknown, string>([
      {
        name: "a",
        node: new AgentStep({ name: "a", agent: makeAgent("a"), prompt: () => "task-A" }),
      },
      {
        name: "b",
        node: new AgentStep({ name: "b", agent: makeAgent("b"), prompt: () => "task-B" }),
      },
      {
        name: "c",
        node: new AgentStep({ name: "c", agent: makeAgent("c"), prompt: () => "task-C" }),
      },
    ]);

    const result = await par.run({}, { runner });

    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual(["result-A", "result-B", "result-C"]);
    expect(result.totalInputTokens).toBe(9);
    expect(result.totalOutputTokens).toBe(12);
  });

  it("passes the same input to every branch", async () => {
    const runner = new MockRunner();
    const par = new Parallel<{ x: number }, number>([
      { name: "p1", node: new FunctionStep({ name: "p1", fn: (i) => i.x + 1 }) },
      { name: "p2", node: new FunctionStep({ name: "p2", fn: (i) => i.x * 10 }) },
    ]);

    const result = await par.run({ x: 5 }, { runner });
    expect(result.output).toEqual([6, 50]);
  });

  it("maxConcurrency=1 runs branches serially in order", async () => {
    const runner = new MockRunner();
    const order: string[] = [];
    const branch = (name: string) => ({
      name,
      node: new FunctionStep<unknown, string>({
        name,
        fn: () => {
          order.push(name);
          return name;
        },
      }),
    });

    const par = new Parallel<unknown, string>(
      [branch("first"), branch("second"), branch("third")],
      {
        maxConcurrency: 1,
      },
    );
    await par.run({}, { runner });

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("collects failures and proceeds", async () => {
    const runner = new MockRunner();
    const par = new Parallel<unknown, string>([
      { name: "good", node: new FunctionStep({ name: "good", fn: () => "ok" }) },
      {
        name: "bad",
        node: new FunctionStep({
          name: "bad",
          fn: () => {
            throw new Error("boom");
          },
        }),
      },
      { name: "good2", node: new FunctionStep({ name: "good2", fn: () => "ok2" }) },
    ]);

    const result = await par.run({}, { runner });

    expect(result.succeeded).toBe(false);
    expect(result.error?.message).toBe("boom");
    // Siblings still produced their outputs (failed branch slot is undefined).
    expect(result.output[0]).toBe("ok");
    expect(result.output[1]).toBeUndefined();
    expect(result.output[2]).toBe("ok2");
  });

  it("applies a consolidate reducer whose result becomes the node output", async () => {
    const runner = new MockRunner();
    const par = new Parallel<unknown, number, number>(
      [
        { name: "p1", node: new FunctionStep({ name: "p1", fn: () => 2 }) },
        { name: "p2", node: new FunctionStep({ name: "p2", fn: () => 3 }) },
        { name: "p3", node: new FunctionStep({ name: "p3", fn: () => 4 }) },
      ],
      { consolidate: (outs) => outs.reduce((a, b) => a + b, 0) },
    );

    const result = await par.run({}, { runner });
    expect(result.output).toBe(9);
  });

  it("fires hook callbacks", async () => {
    const runner = new MockRunner();
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

    const par = new Parallel<unknown, string>([
      { name: "s1", node: new FunctionStep({ name: "s1", fn: () => "ok" }) },
    ]);
    await par.run({}, { runner, hooks });

    expect(events).toContain("start");
    expect(events).toContain("step-start");
    expect(events).toContain("step-complete");
    expect(events).toContain("complete");
  });

  it("returns a frozen result", async () => {
    const runner = new MockRunner();
    const par = new Parallel<unknown, string>([
      { name: "s1", node: new FunctionStep({ name: "s1", fn: () => "ok" }) },
    ]);
    const result = await par.run({}, { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
