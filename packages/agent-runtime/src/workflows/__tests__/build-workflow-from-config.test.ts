/**
 * G4 — buildWorkflowFromConfig: hydrate a declarative WorkflowConfig into a
 * runnable Sequential/Parallel. Verifies agent-name resolution, per-step model
 * (shorthand + configOverride, with shorthand winning), {{key}} message
 * interpolation, mode selection, and validation/error surfacing.
 *
 * Uses MockRunner (records the dispatched agent.getModel() + message) and a
 * registry-backed AgentResolver. Agents declare no capabilities, so no
 * CapabilityResolver is needed (that path is covered by buildAgentFromConfig).
 */

import type { AgentResolver } from "@agentic-patterns/core";
import { describe, expect, it } from "vitest";

import { MockRunner } from "../../runner/mock-runner.js";
import type { RunnerProtocol } from "../../runner/types.js";
import { buildWorkflowFromConfig, compileMessageTemplate } from "../build-workflow-from-config.js";
import { Parallel } from "../parallel.js";

const AGENTS: Record<string, object> = {
  Extractor: {
    roleTemplate: {
      name: "Extractor",
      persona: { identity: "an extractor", tone: "concise" },
      defaultModel: "default-extract-model",
    },
    mission: { objective: "extract" },
  },
  Summarizer: {
    roleTemplate: {
      name: "Summarizer",
      persona: { identity: "a summarizer", tone: "concise" },
      defaultModel: "default-sum-model",
    },
    mission: { objective: "summarize" },
  },
};

function makeResolver(): AgentResolver {
  return {
    resolve(name: string) {
      const cfg = AGENTS[name];
      if (!cfg) throw new Error(`unknown agent: ${name}`);
      // biome-ignore lint/suspicious/noExplicitAny: registry holds plain AgentConfig inputs
      return cfg as any;
    },
  };
}

describe("buildWorkflowFromConfig", () => {
  it("builds a Sequential; each step runs its agent's declared model with the threaded message", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const wf = buildWorkflowFromConfig(
      {
        name: "deal",
        mode: "sequential",
        steps: [
          { agent: "Extractor", messageTemplate: "Extract it", outputKey: "ex" },
          { agent: "Summarizer", messageTemplate: "Summarize {{ex}}" },
        ],
      },
      { agentResolver: makeResolver() },
    );

    // Sequential mode builds a folded Node<PatternContext, string> (not a Parallel).
    expect(wf).not.toBeInstanceOf(Parallel);
    expect(typeof wf.run).toBe("function");
    await wf.run({}, { runner });

    expect(runner.callHistory.map((c) => c.model)).toEqual([
      "default-extract-model",
      "default-sum-model",
    ]);
    // {{ex}} interpolated from step 1's outputKey (its content "ok")
    expect(runner.callHistory[1]?.message).toBe("Summarize ok");
  });

  it("step.model overrides the agent's declared model", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const wf = buildWorkflowFromConfig(
      {
        name: "x",
        mode: "sequential",
        steps: [{ agent: "Extractor", messageTemplate: "go", model: "cheap-override" }],
      },
      { agentResolver: makeResolver() },
    );
    await wf.run({}, { runner });
    expect(runner.callHistory[0]?.model).toBe("cheap-override");
  });

  it("configOverride.model sets the step agent's model", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const wf = buildWorkflowFromConfig(
      {
        name: "x",
        mode: "sequential",
        steps: [
          {
            agent: "Summarizer",
            messageTemplate: "go",
            configOverride: { model: "strong-override" },
          },
        ],
      },
      { agentResolver: makeResolver() },
    );
    await wf.run({}, { runner });
    expect(runner.callHistory[0]?.model).toBe("strong-override");
  });

  it("step.model wins over configOverride.model", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const wf = buildWorkflowFromConfig(
      {
        name: "x",
        mode: "sequential",
        steps: [
          {
            agent: "Summarizer",
            messageTemplate: "go",
            model: "shorthand-wins",
            configOverride: { model: "loses" },
          },
        ],
      },
      { agentResolver: makeResolver() },
    );
    await wf.run({}, { runner });
    expect(runner.callHistory[0]?.model).toBe("shorthand-wins");
  });

  it("threads per-step maxIterations", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const wf = buildWorkflowFromConfig(
      {
        name: "x",
        mode: "sequential",
        steps: [{ agent: "Extractor", messageTemplate: "go", maxIterations: 7 }],
      },
      { agentResolver: makeResolver() },
    );
    await wf.run({}, { runner });
    expect(runner.callHistory[0]?.maxIterations).toBe(7);
  });

  it("configOverride.mission reaches the built agent's system prompt", async () => {
    // End-to-end: a per-step config patch actually changes what the agent IS,
    // not just its model. Capture the dispatched agent's prompt via a recording runner.
    const prompts: string[] = [];
    const runner: RunnerProtocol = {
      run: async (agent) => {
        prompts.push(agent.renderInitialPrompt());
        return {
          response: "ok",
          inputTokens: 0,
          outputTokens: 0,
          toolCallsCount: 0,
          iterations: 1,
          finishReason: "stop",
        };
      },
    };
    const wf = buildWorkflowFromConfig(
      {
        name: "x",
        mode: "sequential",
        steps: [
          {
            agent: "Summarizer",
            messageTemplate: "go",
            configOverride: { mission: { objective: "OVERRIDDEN-OBJECTIVE-9k2" } },
          },
        ],
      },
      { agentResolver: makeResolver() },
    );
    await wf.run({}, { runner });
    expect(prompts[0]).toContain("OVERRIDDEN-OBJECTIVE-9k2");
  });

  it("renders an inherited-prototype placeholder ({{toString}}) as empty, not its native value", () => {
    const t = compileMessageTemplate("[{{toString}}]");
    expect((t as (c: Record<string, unknown>) => string)({})).toBe("[]");
  });

  it("mode 'parallel' builds a Parallel", () => {
    const wf = buildWorkflowFromConfig(
      {
        name: "x",
        mode: "parallel",
        steps: [{ agent: "Extractor", messageTemplate: "go" }],
      },
      { agentResolver: makeResolver() },
    );
    expect(wf).toBeInstanceOf(Parallel);
  });

  it("surfaces an unknown agent name from the resolver as a build error", () => {
    expect(() =>
      buildWorkflowFromConfig(
        { name: "x", mode: "sequential", steps: [{ agent: "Nope", messageTemplate: "go" }] },
        { agentResolver: makeResolver() },
      ),
    ).toThrow(/unknown agent: Nope/);
  });

  it("rejects an invalid config (bad mode / no steps)", () => {
    expect(() =>
      buildWorkflowFromConfig(
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid
        { name: "x", mode: "diagonal", steps: [] } as any,
        { agentResolver: makeResolver() },
      ),
    ).toThrow();
  });
});

describe("compileMessageTemplate", () => {
  it("returns a static string unchanged (no placeholders)", () => {
    expect(compileMessageTemplate("just text")).toBe("just text");
  });

  it("interpolates {{key}} (with optional whitespace) against the context", () => {
    const t = compileMessageTemplate("Hi {{name}}, see {{ doc }}");
    expect(typeof t).toBe("function");
    expect((t as (c: Record<string, unknown>) => string)({ name: "Ada", doc: "draft-1" })).toBe(
      "Hi Ada, see draft-1",
    );
  });

  it("renders missing/null keys as an empty string", () => {
    const t = compileMessageTemplate("[{{missing}}]");
    expect((t as (c: Record<string, unknown>) => string)({})).toBe("[]");
  });
});
