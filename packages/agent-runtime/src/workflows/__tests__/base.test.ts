import { describe, expect, it } from "vitest";
import type { PatternEvent } from "../base.js";
import { type AgentLike, applyStepModel, makeStepName } from "../base.js";
import type { NodeOutcome, NodeResult } from "../node.js";

// ---------------------------------------------------------------------------
// makeStepName
// ---------------------------------------------------------------------------

describe("makeStepName", () => {
  it("returns the provided name", () => {
    expect(makeStepName("my-step", 0)).toBe("my-step");
  });

  it("generates a name from index when undefined", () => {
    expect(makeStepName(undefined, 3)).toBe("step_3");
  });

  it("generates a name from index when empty string", () => {
    expect(makeStepName("", 5)).toBe("step_5");
  });
});

// ---------------------------------------------------------------------------
// applyStepModel
// ---------------------------------------------------------------------------

describe("applyStepModel", () => {
  it("returns the agent unchanged when no override is given", () => {
    const a: AgentLike = {
      role: { name: "a" },
      getModel: () => "base",
      getTools: () => [],
      renderInitialPrompt: () => "init",
    };
    expect(applyStepModel(a, undefined)).toBe(a);
  });

  it("overrides getModel and delegates every other member to the original agent", () => {
    const tools = [{ marker: 1 }];
    const a: AgentLike = {
      role: { name: "a" },
      getModel: () => "base",
      getTools: () => tools,
      renderInitialPrompt: () => "init",
    };
    const view = applyStepModel(a, "override-model");
    expect(view.getModel()).toBe("override-model");
    expect(view.getTools()).toBe(tools);
    expect(view.renderInitialPrompt()).toBe("init");
    expect(view.role.name).toBe("a");
    expect(a.getModel()).toBe("base");
  });

  it("forwards the render ctx argument to the wrapped agent (#308 — no silent ctx-drop)", () => {
    const capturedCtx: Array<{ scope?: Record<string, unknown> } | undefined> = [];
    const a: AgentLike = {
      role: { name: "a" },
      getModel: () => "base",
      getTools: () => [],
      renderInitialPrompt: (ctx) => {
        capturedCtx.push(ctx);
        return "init";
      },
    };
    const view = applyStepModel(a, "override-model");

    const scope = { workspace: "acme" };
    expect(view.renderInitialPrompt({ scope })).toBe("init");
    expect(view.renderInitialPrompt()).toBe("init");

    expect(capturedCtx).toEqual([{ scope }, undefined]);
  });
});

// ---------------------------------------------------------------------------
// PatternEvent type discrimination
// ---------------------------------------------------------------------------

describe("PatternEvent", () => {
  it("discriminates event types over the typed Node records", () => {
    const outcome: NodeOutcome<string> = {
      nodeName: "s1",
      output: "out",
      succeeded: true,
      inputTokens: 1,
      outputTokens: 2,
    };
    const result: NodeResult<string> = {
      output: "final",
      succeeded: true,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };

    const events: PatternEvent[] = [
      { type: "pattern.start", patternName: "test", timestamp: new Date() },
      { type: "pattern.step.start", stepName: "s1", stepIndex: 0, timestamp: new Date() },
      {
        type: "pattern.step.complete",
        stepName: "s1",
        stepIndex: 0,
        result: outcome,
        timestamp: new Date(),
      },
      {
        type: "pattern.step.error",
        stepName: "s1",
        stepIndex: 0,
        error: new Error("fail"),
        timestamp: new Date(),
      },
      { type: "pattern.iteration.start", iteration: 1, timestamp: new Date() },
      { type: "pattern.iteration.complete", iteration: 1, timestamp: new Date() },
      { type: "pattern.complete", patternName: "test", result, timestamp: new Date() },
    ];

    expect(events).toHaveLength(7);
    expect(events[0]?.type).toBe("pattern.start");
    expect(events[6]?.type).toBe("pattern.complete");
  });
});
