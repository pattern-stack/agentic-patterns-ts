import { describe, expect, it } from "vitest";
import type { RunResult, RunnerProtocol } from "../../runner/types.js";
import {
  type AgentLike,
  type PatternEvent,
  type Step,
  createStepResult,
  executeStep,
  makeStepName,
  resolveMessage,
} from "../base.js";

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

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    response: "Hello from mock",
    inputTokens: 10,
    outputTokens: 20,
    toolCallsCount: 0,
    iterations: 1,
    finishReason: "stop",
    ...overrides,
  };
}

function makeRunner(result: RunResult): RunnerProtocol {
  return {
    async run() {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// resolveMessage
// ---------------------------------------------------------------------------

describe("resolveMessage", () => {
  it("returns a static string unchanged", () => {
    expect(resolveMessage("hello", {})).toBe("hello");
  });

  it("calls a function template with context", () => {
    const template = (ctx: Record<string, unknown>) => `Hello ${ctx.name as string}`;
    expect(resolveMessage(template, { name: "World" })).toBe("Hello World");
  });
});

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
// createStepResult
// ---------------------------------------------------------------------------

describe("createStepResult", () => {
  it("creates a frozen StepResult with correct content", () => {
    const runResult = makeRunResult({ response: "Test output" });
    const result = createStepResult("my-step", runResult);

    expect(result.stepName).toBe("my-step");
    expect(result.content).toBe("Test output");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(20);
    expect(result.runResult).toBe(runResult);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeStep
// ---------------------------------------------------------------------------

describe("executeStep", () => {
  it("resolves message, runs agent, and returns StepResult", async () => {
    const runResult = makeRunResult({ response: "Agent response" });
    const runner = makeRunner(runResult);
    const step: Step = {
      agent: makeAgent(),
      messageTemplate: "Do something",
      name: "action-step",
    };

    const result = await executeStep(step, {}, runner);

    expect(result.stepName).toBe("action-step");
    expect(result.content).toBe("Agent response");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(20);
  });

  it("resolves dynamic message template with context", async () => {
    let capturedMessage = "";
    const runner: RunnerProtocol = {
      async run(_agent, message) {
        capturedMessage = message;
        return makeRunResult();
      },
    };
    const step: Step = {
      agent: makeAgent(),
      messageTemplate: (ctx) => `Analyze ${ctx.topic as string}`,
    };

    await executeStep(step, { topic: "TypeScript" }, runner);

    expect(capturedMessage).toBe("Analyze TypeScript");
  });

  it("passes toolExecutor to runner", async () => {
    let receivedOptions: Record<string, unknown> = {};
    const runner: RunnerProtocol = {
      async run(_agent, _message, options) {
        receivedOptions = options as Record<string, unknown>;
        return makeRunResult();
      },
    };
    const executor = { execute: async () => null };
    const step: Step = {
      agent: makeAgent(),
      messageTemplate: "test",
    };

    await executeStep(step, {}, runner, executor);

    expect(receivedOptions.toolExecutor).toBe(executor);
  });

  it("falls back to step_0 when step has no name", async () => {
    const runner = makeRunner(makeRunResult());
    const step: Step = {
      agent: makeAgent(),
      messageTemplate: "test",
    };

    const result = await executeStep(step, {}, runner);

    expect(result.stepName).toBe("step_0");
  });
});

// ---------------------------------------------------------------------------
// PatternEvent type discrimination
// ---------------------------------------------------------------------------

describe("PatternEvent", () => {
  it("discriminates event types", () => {
    const events: PatternEvent[] = [
      { type: "pattern.start", patternName: "test", timestamp: new Date() },
      {
        type: "pattern.step.start",
        stepName: "s1",
        stepIndex: 0,
        timestamp: new Date(),
      },
      {
        type: "pattern.step.complete",
        stepName: "s1",
        stepIndex: 0,
        result: createStepResult("s1", makeRunResult()),
        timestamp: new Date(),
      },
      {
        type: "pattern.step.error",
        stepName: "s1",
        stepIndex: 0,
        error: new Error("fail"),
        timestamp: new Date(),
      },
      {
        type: "pattern.iteration.start",
        iteration: 1,
        timestamp: new Date(),
      },
      {
        type: "pattern.iteration.complete",
        iteration: 1,
        timestamp: new Date(),
      },
      {
        type: "pattern.complete",
        patternName: "test",
        result: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          succeeded: true,
          finalContent: "",
        },
        timestamp: new Date(),
      },
    ];

    expect(events).toHaveLength(7);
    expect(events[0]?.type).toBe("pattern.start");
    expect(events[6]?.type).toBe("pattern.complete");
  });
});
