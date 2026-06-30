import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { FunctionStep } from "../function-step.js";
import { NodeToolbox, delegateTo } from "../node-tool.js";

describe("NodeToolbox (agent-as-a-tool)", () => {
  it("runs a wrapped Node and returns its typed output inline", async () => {
    const runner = new MockRunner();
    const double = new FunctionStep<{ n: number }, { result: number }>({
      name: "double",
      fn: ({ n }) => ({ result: n * 2 }),
    });
    const tb = new NodeToolbox({
      name: "math",
      description: "math sub-workflows",
      runner,
      tools: {
        double: {
          description: "double a number",
          parameters: z.object({ n: z.number() }),
          node: double,
        },
      },
    });

    // tools are discoverable as schemas (so the coordinator's LLM sees them)
    expect(tb.getToolNames()).toEqual(["double"]);

    const out = await tb.execute("double", { n: 21 });
    expect(out).toEqual({ result: 42 });
  });

  it("returns { error } when the wrapped Node fails — call-and-return, never throws", async () => {
    const runner = new MockRunner();
    const boom = new FunctionStep<{ x: number }, { y: number }>({
      name: "boom",
      fn: () => {
        throw new Error("kaboom");
      },
    });
    const tb = new NodeToolbox({
      name: "math",
      description: "math",
      runner,
      tools: {
        boom: { description: "always fails", parameters: z.object({ x: z.number() }), node: boom },
      },
    });

    const out = (await tb.execute("boom", { x: 1 })) as { error: string };
    expect(out.error).toContain("kaboom");
  });
});

describe("delegateTo (just pass subagents)", () => {
  function agent(name: string): AgentLike {
    return {
      role: { name },
      getModel: () => "mock",
      getTools: () => [],
      getSystemPrompt: () => `you are ${name}`,
      renderInitialPrompt: () => `you are ${name}`,
    };
  }

  it("wraps subagents as call-and-return tools the coordinator routes to", async () => {
    const runner = new MockRunner().addResponse("*", { content: "drafted the section" });
    const team = delegateTo(runner, [
      { agent: agent("writer"), description: "writes grounded sections from evidence" },
      { agent: agent("planner"), description: "allocates sections to evidence" },
    ]);

    // one tool per subagent, named by the agent — the LLM routes by description
    expect(team.getToolNames().sort()).toEqual(["planner", "writer"]);

    const out = await team.execute("writer", { task: "write the intro" });
    expect(out).toBe("drafted the section");
  });
});
