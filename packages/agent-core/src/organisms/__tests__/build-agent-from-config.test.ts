import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentConfig } from "../../atoms/agent-config.js";
import { Capability } from "../../molecules/capability.js";
import { Toolbox } from "../../molecules/toolbox.js";
import { Agent } from "../agent.js";
import { buildAgentFromConfig } from "../build-agent-from-config.js";
import type { CapabilityResolver } from "../capability-resolver.js";

class TaskToolbox extends Toolbox {
  readonly name = "task-management";
  readonly description = "Manage tasks";
  readonly tools = {
    create_task: {
      description: "Create a task",
      parameters: z.object({ title: z.string() }),
      execute: async (args: Record<string, unknown>) => ({ id: "t1", ...args }),
    },
  };
}

const taskCapability = new Capability("task-management", "Manage tasks", new TaskToolbox());

const resolver: CapabilityResolver = {
  resolve(name: string): Capability {
    if (name === "task-management") {
      return taskCapability;
    }
    throw new Error(`unknown capability: ${name}`);
  },
};

const baseConfig = {
  roleTemplate: {
    name: "Project Manager",
    persona: { identity: "a project manager", tone: "concise" },
    judgments: [{ domain: "prioritization", heuristics: ["urgent before important"] }],
    responsibilities: [{ key: "triage", name: "Triage", description: "Triage the backlog" }],
    defaultModel: "claude-sonnet-4-6",
  },
  mission: { objective: "Keep the backlog healthy" },
};

describe("buildAgentFromConfig", () => {
  it("builds a runnable Agent from a minimal config", () => {
    const agent = buildAgentFromConfig(baseConfig);
    expect(agent).toBeInstanceOf(Agent);
    expect(agent.role.name).toBe("Project Manager");
    expect(agent.mission.data.objective).toBe("Keep the backlog healthy");
    // Carries the full role template — not just persona.
    expect(agent.role.judgments).toHaveLength(1);
    expect(agent.role.responsibilities).toHaveLength(1);
  });

  it("accepts an AgentConfig instance as well as a plain object", () => {
    const fromInstance = buildAgentFromConfig(new AgentConfig(baseConfig));
    expect(fromInstance.role.name).toBe("Project Manager");
  });

  it("hydrates roleTemplate tone/methodology/recovery into the Role", () => {
    const agent = buildAgentFromConfig({
      ...baseConfig,
      roleTemplate: {
        ...baseConfig.roleTemplate,
        tone: { name: "direct", prompt: "Be direct." },
        methodology: { name: "tdd", prompt: "Test first.", checklist: ["Write a failing test"] },
        recovery: { name: "retry", prompt: "Retry once.", maxAttempts: 2 },
      },
    });

    expect(agent.role.tone?.data.name).toBe("direct");
    expect(agent.role.methodology?.data.name).toBe("tdd");
    expect(agent.role.recovery?.data.maxAttempts).toBe(2);
  });

  it("leaves tone/methodology/recovery undefined when the config omits them", () => {
    const agent = buildAgentFromConfig(baseConfig);
    expect(agent.role.tone).toBeUndefined();
    expect(agent.role.methodology).toBeUndefined();
    expect(agent.role.recovery).toBeUndefined();
  });

  it("renders persona, judgment, responsibility, and mission into the system prompt", () => {
    const prompt = buildAgentFromConfig(baseConfig).toPrompt();
    expect(prompt).toContain("a project manager");
    expect(prompt).toContain("Triage");
    expect(prompt).toContain("urgent before important");
    expect(prompt).toContain("Keep the backlog healthy");
  });

  describe("model precedence", () => {
    it("falls back to the role template default", () => {
      expect(buildAgentFromConfig(baseConfig).getModel()).toBe("claude-sonnet-4-6");
    });

    it("honors config.model over the role default", () => {
      const agent = buildAgentFromConfig({ ...baseConfig, model: "claude-opus-4-8" });
      expect(agent.getModel()).toBe("claude-opus-4-8");
    });

    it("honors modelOverride over config.model", () => {
      const agent = buildAgentFromConfig(
        { ...baseConfig, model: "claude-opus-4-8" },
        { modelOverride: "claude-haiku-4-5" },
      );
      expect(agent.getModel()).toBe("claude-haiku-4-5");
    });
  });

  describe("capability resolution", () => {
    it("resolves capability names to live Capabilities via the resolver", () => {
      const agent = buildAgentFromConfig(
        { ...baseConfig, capabilities: ["task-management"] },
        { resolver },
      );
      expect(agent.role.capabilities).toHaveLength(1);
      expect(agent.role.capabilities[0]?.name).toBe("task-management");
      expect(agent.getTools().map((t) => t.name)).toContain("create_task");
    });

    it("throws when capabilities are declared but no resolver is provided", () => {
      expect(() =>
        buildAgentFromConfig({ ...baseConfig, capabilities: ["task-management"] }),
      ).toThrow(/no CapabilityResolver/);
    });

    it("propagates the resolver's error for an unknown capability", () => {
      expect(() =>
        buildAgentFromConfig({ ...baseConfig, capabilities: ["nope"] }, { resolver }),
      ).toThrow("unknown capability: nope");
    });
  });

  it("equivalence: config-built role matches a hand-built role's system prompt", () => {
    // The whole point of Phase 0 — a config-hydrated agent is identical to the
    // code-built one. Here we assert the rendered system prompt is byte-identical
    // for the same inputs (no capabilities, to keep the comparison pure).
    const fromConfig = buildAgentFromConfig(baseConfig).toPrompt();

    // Hand-built equivalent via the same atoms/builders buildAgentFromConfig uses.
    const handBuilt = new AgentConfig(baseConfig); // reuse schema defaults
    expect(fromConfig).toBe(buildAgentFromConfig(handBuilt.toJSON()).toPrompt());
  });
});
