/**
 * G1 — per-step model & maxIterations on workflow steps.
 *
 * Under the "model belongs to the agent" architecture there is NO per-step
 * runner: a step optionally overrides the model, which the pattern applies as an
 * agent *view* (applyStepModel) whose getModel() returns the override. One
 * (resolver-backed) runner then dispatches each step's model. These tests use
 * MockRunner, whose callHistory records the dispatched agent.getModel() and the
 * RunOptions.maxIterations.
 */

import { describe, expect, it } from "vitest";

import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { Step } from "../base.js";
import { applyStepModel } from "../base.js";
import { Parallel } from "../parallel.js";
import { Sequential } from "../sequential.js";

function makeAgent(name: string, model = "agent-default"): AgentLike {
  return {
    role: { name },
    getModel: () => model,
    getTools: () => [],
    getSystemPrompt: () => `sys:${name}`,
    renderInitialPrompt: () => `init:${name}`,
  };
}

describe("applyStepModel", () => {
  it("returns the agent unchanged when no override is given", () => {
    const a = makeAgent("a");
    expect(applyStepModel(a, undefined)).toBe(a);
  });

  it("overrides getModel and delegates every other member to the original agent", () => {
    const tools = [{ marker: 1 }];
    const a: AgentLike = {
      role: { name: "a" },
      getModel: () => "base",
      getTools: () => tools,
      getSystemPrompt: () => "sys",
      renderInitialPrompt: () => "init",
    };
    const view = applyStepModel(a, "override-model");
    expect(view.getModel()).toBe("override-model");
    expect(view.getTools()).toBe(tools); // delegated (same reference)
    expect(view.getSystemPrompt()).toBe("sys");
    expect(view.renderInitialPrompt()).toBe("init");
    expect(view.role.name).toBe("a");
    expect(a.getModel()).toBe("base"); // original is untouched
  });
});

describe("Sequential — per-step model & maxIterations", () => {
  it("dispatches each step's model override — one runner, per-step models", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const agent = makeAgent("shared", "agent-default");
    const steps: Step[] = [
      { agent, messageTemplate: "gather", model: "cheap-model" },
      { agent, messageTemplate: "synthesize", model: "strong-model" },
      { agent, messageTemplate: "no-override" }, // falls through to agent.getModel()
    ];

    await new Sequential(steps).run({}, { runner });

    expect(runner.callHistory.map((c) => c.model)).toEqual([
      "cheap-model",
      "strong-model",
      "agent-default",
    ]);
  });

  it("threads per-step maxIterations into RunOptions (default when unset)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const agent = makeAgent("a");
    const steps: Step[] = [
      { agent, messageTemplate: "m1", maxIterations: 3 },
      { agent, messageTemplate: "m2" },
    ];

    await new Sequential(steps).run({}, { runner });

    expect(runner.callHistory[0]?.maxIterations).toBe(3);
    expect(runner.callHistory[1]?.maxIterations).toBeUndefined();
  });
});

describe("Parallel — per-step model", () => {
  it("dispatches each step's model override", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const agent = makeAgent("shared", "agent-default");
    const steps: Step[] = [
      { agent, messageTemplate: "a", name: "a", model: "model-a" },
      { agent, messageTemplate: "b", name: "b", model: "model-b" },
    ];

    await new Parallel(steps).run({}, { runner });

    // Parallel may complete in any order — assert as a set.
    expect(new Set(runner.callHistory.map((c) => c.model))).toEqual(
      new Set(["model-a", "model-b"]),
    );
  });
});
