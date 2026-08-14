/**
 * #116 — per-node runner override + `withRunner` subtree combinator.
 *
 * Resolution: `spec.runner ?? ctx.runner` (leaf) / nearest enclosing
 * `withRunner` (ctx override) / root `ctx.runner` — falls straight out of the
 * `??` chain since `withRunner` rewrites `ctx.runner` for its subtree.
 */

import { Agent, Mission, Persona, RoleBuilder } from "@pattern-stack/agentic-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { RunOptions, RunResult, RunnerProtocol } from "../../runner/types.js";
import { AgentStep, StructuredOutputUnsupported } from "../agent-step.js";
import { CoordinatorStep } from "../coordinator-step.js";
import { delegateTo } from "../node-tool.js";
import type { Node } from "../node.js";
import { Sequential } from "../sequential.js";
import { withRunner } from "../with-runner.js";

function makeAgent(name: string, model = "mock"): AgentLike {
  return {
    role: { name },
    getModel: () => model,
    getTools: () => [],
    renderInitialPrompt: () => `init:${name}`,
  };
}

/** A runner stub that only implements `run` — no `runStructured` at all. */
function textOnlyRunner(): RunnerProtocol {
  return {
    async run(_agent: AgentLike, _message: string, _options?: RunOptions): Promise<RunResult> {
      return {
        response: "text-only",
        inputTokens: 0,
        outputTokens: 0,
        toolCallsCount: 0,
        iterations: 1,
        finishReason: "stop",
      };
    },
  };
}

const Template = z.object({ title: z.string() });

describe("AgentStep.spec.runner — per-node override (#116)", () => {
  it("dispatches the text path on the override; the ambient runner records zero calls", async () => {
    const ambient = new MockRunner().addResponse("*", { content: "ambient" });
    const override = new MockRunner().addResponse("*", { content: "override" });
    const agent = makeAgent("a");

    const step = new AgentStep<unknown, string>({
      agent,
      prompt: () => "go",
      runner: override,
    });

    const result = await step.run({}, { runner: ambient });

    expect(result.output).toBe("override");
    expect(override.callHistory).toHaveLength(1);
    expect(ambient.callHistory).toHaveLength(0);
  });

  it("dispatches the structured path on the override; the ambient runner records zero calls", async () => {
    const ambient = new MockRunner().addResponse("*", { content: "{}", object: { title: "amb" } });
    const override = new MockRunner().addResponse("*", { content: "{}", object: { title: "ovr" } });
    const agent = makeAgent("a");

    const step = new AgentStep<unknown, z.infer<typeof Template>>({
      agent,
      prompt: () => "go",
      output: Template,
      runner: override,
    });

    const result = await step.run({}, { runner: ambient });

    expect(result.output).toEqual({ title: "ovr" });
    expect(override.callHistory).toHaveLength(1);
    expect(ambient.callHistory).toHaveLength(0);
  });

  it("uses the ambient runner when no override is declared", async () => {
    const ambient = new MockRunner().addResponse("*", { content: "ambient" });
    const step = new AgentStep<unknown, string>({ agent: makeAgent("a"), prompt: () => "go" });

    const result = await step.run({}, { runner: ambient });

    expect(result.output).toBe("ambient");
    expect(ambient.callHistory).toHaveLength(1);
  });

  it("guards the RESOLVED runner: an override without runStructured fails loud even though ctx.runner supports it", async () => {
    const ambient = new MockRunner().addResponse("*", { content: "{}", object: { title: "x" } });
    const step = new AgentStep<unknown, z.infer<typeof Template>>({
      agent: makeAgent("a"),
      prompt: () => "go",
      output: Template,
      runner: textOnlyRunner(),
    });

    const result = await step.run({}, { runner: ambient });

    expect(result.succeeded).toBe(false);
    expect(result.error).toBeInstanceOf(StructuredOutputUnsupported);
    expect(ambient.callHistory).toHaveLength(0);
  });
});

describe("withRunner — subtree combinator (#116)", () => {
  it("routes every leaf in the subtree onto the given runner; the ambient runner is untouched", async () => {
    const ambient = new MockRunner().addResponse("*", { content: "ambient" });
    const runnerB = new MockRunner()
      .addResponse("a", { content: "A" })
      .addResponse("b", { content: "B" });
    const agent = makeAgent("shared");

    const pipeline = Sequential.start(new AgentStep<unknown, string>({ agent, prompt: () => "a" }))
      .then(new AgentStep<string, string>({ agent, prompt: () => "b" }))
      .build();

    const wrapped = withRunner(pipeline, runnerB);
    const result = await wrapped.run({}, { runner: ambient });

    expect(result.output).toBe("B");
    expect(runnerB.callHistory).toHaveLength(2);
    expect(ambient.callHistory).toHaveLength(0);
  });

  it("is transparent by default — exposes the inner node's name", () => {
    const inner = new AgentStep<unknown, string>({
      name: "inner-name",
      agent: makeAgent("a"),
      prompt: () => "go",
    });
    const wrapped = withRunner(inner, new MockRunner());
    expect(wrapped.name).toBe("inner-name");
  });

  it("exposes an opt-in label instead of the inner node's name when { name } is given", () => {
    const inner = new AgentStep<unknown, string>({
      name: "inner-name",
      agent: makeAgent("a"),
      prompt: () => "go",
    });
    const wrapped = withRunner(inner, new MockRunner(), { name: "wrapper-label" });
    expect(wrapped.name).toBe("wrapper-label");
  });

  it("precedence: a leaf's own spec.runner wins over an enclosing withRunner, whose sibling falls back to it", async () => {
    const ambient = new MockRunner().addResponse("*", { content: "ambient" });
    const runnerB = new MockRunner().addResponse("*", { content: "B" });
    const runnerC = new MockRunner().addResponse("*", { content: "C" });
    const agent = makeAgent("shared");

    const overridden = new AgentStep<unknown, string>({
      agent,
      prompt: () => "c",
      runner: runnerC,
    });
    const plain = new AgentStep<unknown, string>({ agent, prompt: () => "b" });

    const pair: Node<unknown, string> = {
      name: "pair",
      async run(input, ctx) {
        const a = await overridden.run(input, ctx);
        const b = await plain.run(input, ctx);
        return {
          output: `${a.output}/${b.output}`,
          succeeded: a.succeeded && b.succeeded,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        };
      },
    };
    const subtree = withRunner(pair, runnerB);

    const result = await subtree.run({}, { runner: ambient });

    expect(result.output).toBe("C/B");
    expect(runnerC.callHistory).toHaveLength(1);
    expect(runnerB.callHistory).toHaveLength(1);
    expect(ambient.callHistory).toHaveLength(0);
  });
});

describe("CoordinatorStep.spec.runner — per-node override (#116)", () => {
  function coordinatorAgent(): Agent {
    const role = new RoleBuilder("CanvasAuthor")
      .withPersona(
        new Persona({
          identity: "routes work to the right specialist",
          tone: "direct",
          priorities: ["route correctly"],
          principles: ["delegate, never do the work directly"],
        }),
      )
      .withDefaultModel("mock")
      .build();
    return new Agent({
      role,
      mission: new Mission({
        objective: "author a canvas template",
        successCriteria: ["valid template"],
        constraints: [],
      }),
    });
  }

  it("the routing turn dispatches on the override, not the ambient runner", async () => {
    const ambient = new MockRunner().addResponse("*", { content: "{}", object: { title: "amb" } });
    const override = new MockRunner().addResponse("*", { content: "{}", object: { title: "ovr" } });
    const team = delegateTo(override, [{ agent: makeAgent("writer"), description: "drafts" }]);

    const author = new CoordinatorStep<{ instruction: string }, z.infer<typeof Template>>({
      agent: coordinatorAgent(),
      team,
      output: Template,
      prompt: (input) => input.instruction,
      runner: override,
    });

    const result = await author.run({ instruction: "go" }, { runner: ambient });

    expect(result.output).toEqual({ title: "ovr" });
    expect(override.callHistory.length).toBeGreaterThan(0);
    expect(ambient.callHistory).toHaveLength(0);
  });
});
