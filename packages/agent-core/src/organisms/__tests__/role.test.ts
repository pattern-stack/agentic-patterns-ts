import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Judgment } from "../../atoms/judgment.js";
import { Persona } from "../../atoms/persona.js";
import { Responsibility } from "../../atoms/responsibility.js";
import { Capability } from "../../molecules/capability.js";
import { TextManual } from "../../molecules/manual.js";
import { type ToolDefinition, Toolbox } from "../../molecules/toolbox.js";
import { Role, RoleBuilder } from "../role.js";

// --- Fixtures ---

function makePersona(): Persona {
  return new Persona({
    identity: "a project manager",
    tone: "professional and clear",
    priorities: ["Deliver on time", "Maintain quality"],
    principles: ["Transparency", "Accountability"],
  });
}

function makeJudgment(): Judgment {
  return new Judgment({
    domain: "prioritization",
    heuristics: ["High impact first", "Unblock others"],
    constraints: ["Never skip testing"],
    escalation_triggers: ["Budget exceeded"],
    examples: [
      {
        scenario: "Two tasks compete for resources",
        good: "Prioritize the one blocking others",
        bad: "Pick randomly",
        reasoning: "Blocking tasks have multiplicative impact",
      },
    ],
  });
}

function makeResponsibility(): Responsibility {
  return new Responsibility({
    key: "sprint_planning",
    name: "Sprint Planning",
    description: "Plan and manage sprints",
    examples: ["Create sprint board", "Assign tasks"],
  });
}

class TestToolbox extends Toolbox {
  readonly name = "task_management";
  readonly description = "Manage tasks";
  readonly tools: Record<string, ToolDefinition> = {
    create_task: {
      description: "Create a new task",
      parameters: z.object({ title: z.string() }),
      execute: async (args) => ({ id: 1, title: args.title }),
    },
    list_tasks: {
      description: "List all tasks",
      parameters: z.object({}),
      execute: async () => [],
    },
  };
}

function makeCapability(): Capability {
  const toolbox = new TestToolbox();
  const manual = new TextManual("Task Guide", "Always create tasks with clear titles.");
  return new Capability("Task Management", "Manage project tasks", toolbox, manual);
}

// --- Tests ---

describe("Role", () => {
  it("constructs with all fields", () => {
    const persona = makePersona();
    const judgment = makeJudgment();
    const responsibility = makeResponsibility();
    const capability = makeCapability();

    const role = new Role({
      name: "Project Manager",
      persona,
      judgments: [judgment],
      capabilities: [capability],
      responsibilities: [responsibility],
      defaultModel: "claude-opus-4-20250514",
    });

    expect(role.name).toBe("Project Manager");
    expect(role.defaultModel).toBe("claude-opus-4-20250514");
    expect(role.persona).toBe(persona);
    expect(role.judgments).toHaveLength(1);
    expect(role.capabilities).toHaveLength(1);
    expect(role.responsibilities).toHaveLength(1);
  });

  it("has no default model when not specified", () => {
    const role = new Role({
      name: "Test Role",
      persona: makePersona(),
    });
    // No framework default — the model is chosen by the agent, role, or runner.
    expect(role.defaultModel).toBeUndefined();
  });

  it("requires non-empty name", () => {
    expect(() => new Role({ name: "", persona: makePersona() })).toThrow();
  });

  it("getTools aggregates from all capabilities", () => {
    const capability = makeCapability();
    const role = new Role({
      name: "Test",
      persona: makePersona(),
      capabilities: [capability],
    });

    const tools = role.getTools();
    expect(tools).toHaveLength(2);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("create_task");
    expect(toolNames).toContain("list_tasks");
  });

  it("getTools returns empty array without capabilities", () => {
    const role = new Role({ name: "Test", persona: makePersona() });
    expect(role.getTools()).toEqual([]);
  });

  it("getGuidance combines all capability manuals", () => {
    const capability = makeCapability();
    const role = new Role({
      name: "Test",
      persona: makePersona(),
      capabilities: [capability],
    });

    const guidance = role.getGuidance();
    expect(guidance).toContain("### Task Management");
    expect(guidance).toContain("Always create tasks with clear titles.");
  });

  describe("renderSystemPrompt", () => {
    it("includes all sections", () => {
      const role = new Role({
        name: "Project Manager",
        persona: makePersona(),
        judgments: [makeJudgment()],
        capabilities: [makeCapability()],
        responsibilities: [makeResponsibility()],
      });

      const prompt = role.renderSystemPrompt();
      expect(prompt).toContain("# Project Manager");
      expect(prompt).toContain("## Identity");
      expect(prompt).toContain("## Responsibilities");
      expect(prompt).toContain("## Decision Guidelines");
      expect(prompt).toContain("## Guidance");
      expect(prompt).toContain("## Available Tools");
    });

    it("omits empty sections", () => {
      const role = new Role({
        name: "Simple Role",
        persona: makePersona(),
      });

      const prompt = role.renderSystemPrompt();
      expect(prompt).toContain("# Simple Role");
      expect(prompt).toContain("## Identity");
      expect(prompt).not.toContain("## Responsibilities");
      expect(prompt).not.toContain("## Decision Guidelines");
      expect(prompt).not.toContain("## Guidance");
      expect(prompt).not.toContain("## Available Tools");
    });

    it("toPrompt is alias for renderSystemPrompt", () => {
      const role = new Role({
        name: "Test",
        persona: makePersona(),
      });
      expect(role.toPrompt()).toBe(role.renderSystemPrompt());
    });

    it("snapshot: full role prompt", () => {
      const role = new Role({
        name: "Project Manager",
        persona: makePersona(),
        judgments: [makeJudgment()],
        capabilities: [makeCapability()],
        responsibilities: [makeResponsibility()],
      });
      expect(role.renderSystemPrompt()).toMatchSnapshot();
    });
  });
});

describe("RoleBuilder", () => {
  it("builds a complete role via fluent API", () => {
    const persona = makePersona();
    const judgment = makeJudgment();
    const responsibility = makeResponsibility();
    const capability = makeCapability();

    const role = new RoleBuilder("Project Manager")
      .withPersona(persona)
      .withJudgment(judgment)
      .withCapability(capability)
      .withResponsibility(responsibility)
      .withDefaultModel("claude-opus-4-20250514")
      .build();

    expect(role.name).toBe("Project Manager");
    expect(role.persona).toBe(persona);
    expect(role.judgments).toHaveLength(1);
    expect(role.capabilities).toHaveLength(1);
    expect(role.responsibilities).toHaveLength(1);
    expect(role.defaultModel).toBe("claude-opus-4-20250514");
  });

  it("throws without persona", () => {
    expect(() => new RoleBuilder("Test").build()).toThrow("Persona is required");
  });

  it("withJudgments adds multiple", () => {
    const j1 = makeJudgment();
    const j2 = new Judgment({ domain: "quality" });
    const role = new RoleBuilder("Test").withPersona(makePersona()).withJudgments([j1, j2]).build();

    expect(role.judgments).toHaveLength(2);
  });

  it("withCapabilities adds multiple", () => {
    const c1 = makeCapability();
    const c2 = makeCapability();
    const role = new RoleBuilder("Test")
      .withPersona(makePersona())
      .withCapabilities([c1, c2])
      .build();

    expect(role.capabilities).toHaveLength(2);
  });

  it("withResponsibilities adds multiple", () => {
    const r1 = makeResponsibility();
    const r2 = new Responsibility({
      key: "review",
      name: "Review",
      description: "Code review",
    });
    const role = new RoleBuilder("Test")
      .withPersona(makePersona())
      .withResponsibilities([r1, r2])
      .build();

    expect(role.responsibilities).toHaveLength(2);
  });

  it("chains fluently", () => {
    const builder = new RoleBuilder("Test");
    const result = builder
      .withPersona(makePersona())
      .withJudgment(makeJudgment())
      .withCapability(makeCapability())
      .withResponsibility(makeResponsibility())
      .withDefaultModel("test-model");

    // Should return same builder instance
    expect(result).toBe(builder);
  });
});
