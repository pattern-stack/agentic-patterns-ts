import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Awareness } from "../../atoms/awareness.js";
import { Background } from "../../atoms/background.js";
import { Judgment } from "../../atoms/judgment.js";
import { Mission } from "../../atoms/mission.js";
import { Persona } from "../../atoms/persona.js";
import { Responsibility } from "../../atoms/responsibility.js";
import { Phase, State } from "../../atoms/state.js";
import { Capability } from "../../molecules/capability.js";
import { TextManual } from "../../molecules/manual.js";
import { type ToolDefinition, Toolbox } from "../../molecules/toolbox.js";
import { Agent, AgentBuilder } from "../agent.js";
import { type Role, RoleBuilder } from "../role.js";

// --- Fixtures ---

class TestToolbox extends Toolbox {
  readonly name = "task_management";
  readonly description = "Manage tasks";
  readonly tools: Record<string, ToolDefinition> = {
    create_task: {
      description: "Create a new task",
      parameters: z.object({ title: z.string() }),
      execute: async (args) => ({ id: 1, title: args.title }),
    },
  };
}

function makeRole(): Role {
  const persona = new Persona({
    identity: "a code review specialist",
    tone: "professional",
    priorities: ["Quality"],
    principles: ["Thoroughness"],
  });
  const judgment = new Judgment({
    domain: "code_quality",
    constraints: ["No direct DB access"],
    escalation_triggers: ["Security vulnerability found"],
    heuristics: ["Check edge cases"],
    examples: [
      {
        scenario: "Missing error handling",
        good: "Add try-catch",
        bad: "Ignore errors",
        reasoning: "Unhandled errors crash the app",
      },
    ],
  });
  const responsibility = new Responsibility({
    key: "review",
    name: "Code Review",
    description: "Review pull requests",
  });
  const toolbox = new TestToolbox();
  const manual = new TextManual("Review Guide", "Review all changed files.");
  const capability = new Capability("Code Review Tools", "Review code", toolbox, manual);

  return new RoleBuilder("Code Reviewer")
    .withPersona(persona)
    .withJudgment(judgment)
    .withResponsibility(responsibility)
    .withCapability(capability)
    .build();
}

function makeMission(): Mission {
  return new Mission({
    objective: "Review PR #42",
    success_criteria: ["All issues flagged", "No false positives"],
    constraints: ["Complete within 30 minutes"],
  });
}

function makeBackground(): Background {
  return new Background({
    team_context: { team: "Platform", sprint: "Q1-S3" },
    project_context: { name: "agentic-patterns" },
  });
}

function makeAwareness(): Awareness {
  return new Awareness({
    domains: [{ name: "GitHub", description: "Repos and PRs", access_method: "API" }],
  });
}

// --- Tests ---

describe("Agent", () => {
  it("constructs with all fields", () => {
    const role = makeRole();
    const mission = makeMission();
    const background = makeBackground();
    const awareness = makeAwareness();

    const agent = new Agent({
      role,
      background,
      awareness,
      mission,
      model: "claude-opus-4-20250514",
    });

    expect(agent.role).toBe(role);
    expect(agent.background).toBe(background);
    expect(agent.awareness).toBe(awareness);
    expect(agent.mission).toBe(mission);
  });

  it("defaults background and awareness when not provided", () => {
    const agent = new Agent({
      role: makeRole(),
      mission: makeMission(),
    });

    expect(agent.background).toBeInstanceOf(Background);
    expect(agent.awareness).toBeInstanceOf(Awareness);
  });

  describe("getModel", () => {
    it("returns agent model override when set", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
        model: "claude-opus-4-20250514",
      });
      expect(agent.getModel()).toBe("claude-opus-4-20250514");
    });

    it("falls back to role default model", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
      });
      expect(agent.getModel()).toBe("claude-sonnet-4-20250514");
    });
  });

  describe("getTools", () => {
    it("delegates to role.getTools()", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
      });
      const tools = agent.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("create_task");
    });
  });

  describe("getAwarenessHints", () => {
    it("returns formatted domain hints", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
        awareness: makeAwareness(),
      });
      const hints = agent.getAwarenessHints();
      expect(hints).toEqual(["GitHub: Repos and PRs"]);
    });

    it("returns empty array when no domains", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
      });
      expect(agent.getAwarenessHints()).toEqual([]);
    });
  });

  describe("getSystemPrompt (inline rendering)", () => {
    it("includes role, background, awareness, and mission", () => {
      const agent = new Agent({
        role: makeRole(),
        background: makeBackground(),
        awareness: makeAwareness(),
        mission: makeMission(),
      });

      const prompt = agent.getSystemPrompt();
      expect(prompt).toContain("# Code Reviewer");
      expect(prompt).toContain("## Team Context");
      expect(prompt).toContain("## Available Information Sources");
      expect(prompt).toContain("## Current Mission");
    });

    it("toPrompt is alias for getSystemPrompt", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
      });
      expect(agent.toPrompt()).toBe(agent.getSystemPrompt());
    });

    it("omits empty background", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
      });
      const prompt = agent.getSystemPrompt();
      // Background with no data produces empty string, should not add extra sections
      expect(prompt).not.toContain("## Team Context");
    });
  });

  describe("renderInitialPrompt (structured rendering)", () => {
    it("includes all 6 sections via PromptRenderer", () => {
      const agent = new Agent({
        role: makeRole(),
        background: makeBackground(),
        awareness: makeAwareness(),
        mission: makeMission(),
      });

      const prompt = agent.renderInitialPrompt();
      expect(prompt).toContain("## Identity");
      expect(prompt).toContain("## Boundaries");
      expect(prompt).toContain("## Capabilities");
      expect(prompt).toContain("## Context");
      expect(prompt).toContain("## Mission");
      expect(prompt).toContain("## Methodology");
    });

    it("snapshot: full initial prompt", () => {
      const agent = new Agent({
        role: makeRole(),
        background: makeBackground(),
        awareness: makeAwareness(),
        mission: makeMission(),
      });
      expect(agent.renderInitialPrompt()).toMatchSnapshot();
    });
  });

  describe("renderContinuationPrompt (delta rendering)", () => {
    it("includes only state, mission, methodology", () => {
      const agent = new Agent({
        role: makeRole(),
        background: makeBackground(),
        awareness: makeAwareness(),
        mission: makeMission(),
      });

      const state = new State({
        iteration: 3,
        phase: Phase.EXECUTING,
        last_action: "Reviewed utils.ts",
      });

      const prompt = agent.renderContinuationPrompt(state);
      expect(prompt).toContain("## Current State");
      expect(prompt).toContain("Iteration: 3");
      expect(prompt).toContain("## Mission");
      expect(prompt).toContain("## Methodology");

      // Should NOT include identity, boundaries, context
      expect(prompt).not.toContain("## Identity");
      expect(prompt).not.toContain("## Boundaries");
      expect(prompt).not.toContain("## Context");
      expect(prompt).not.toContain("## Capabilities");
    });

    it("snapshot: continuation prompt", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
      });
      const state = new State({
        iteration: 5,
        phase: Phase.FINISHING,
        last_action: "Final review complete",
      });
      expect(agent.renderContinuationPrompt(state)).toMatchSnapshot();
    });
  });
});

describe("AgentBuilder", () => {
  it("builds a complete agent via fluent API", () => {
    const role = makeRole();
    const mission = makeMission();
    const background = makeBackground();
    const awareness = makeAwareness();

    const agent = new AgentBuilder(role)
      .withBackground(background)
      .withAwareness(awareness)
      .withMission(mission)
      .withModel("claude-opus-4-20250514")
      .build();

    expect(agent.role).toBe(role);
    expect(agent.background).toBe(background);
    expect(agent.awareness).toBe(awareness);
    expect(agent.mission).toBe(mission);
    expect(agent.getModel()).toBe("claude-opus-4-20250514");
  });

  it("throws without mission", () => {
    expect(() => new AgentBuilder(makeRole()).build()).toThrow("Mission is required");
  });

  it("defaults background and awareness", () => {
    const agent = new AgentBuilder(makeRole()).withMission(makeMission()).build();

    expect(agent.background).toBeInstanceOf(Background);
    expect(agent.awareness).toBeInstanceOf(Awareness);
  });

  it("chains fluently", () => {
    const builder = new AgentBuilder(makeRole());
    const result = builder
      .withBackground(makeBackground())
      .withAwareness(makeAwareness())
      .withMission(makeMission())
      .withModel("test-model");

    expect(result).toBe(builder);
  });
});

describe("Integration: atoms -> molecules -> organisms", () => {
  it("builds a complete agent from primitives and renders full prompt", () => {
    // Atoms
    const persona = new Persona({
      identity: "a DevOps engineer",
      tone: "concise and technical",
      priorities: ["Reliability", "Automation"],
    });
    const judgment = new Judgment({
      domain: "infrastructure",
      heuristics: ["Prefer managed services", "Automate everything"],
      constraints: ["Never store secrets in code"],
      escalation_triggers: ["Production outage"],
    });
    const responsibility = new Responsibility({
      key: "deploy",
      name: "Deployment",
      description: "Manage CI/CD pipelines",
    });
    const mission = new Mission({
      objective: "Set up staging environment",
      success_criteria: ["All services running", "Monitoring enabled"],
    });
    const background = new Background({
      project_context: { cloud: "AWS", region: "us-east-1" },
    });
    const awareness = new Awareness({
      domains: [{ name: "AWS Console", description: "Cloud resources", access_method: "SDK" }],
    });

    // Molecules
    const toolbox = new TestToolbox();
    const manual = new TextManual("Runbook", "Follow runbook for deployments.");
    const capability = new Capability("Infrastructure", "Cloud ops", toolbox, manual);

    // Organisms
    const role = new RoleBuilder("DevOps Engineer")
      .withPersona(persona)
      .withJudgment(judgment)
      .withResponsibility(responsibility)
      .withCapability(capability)
      .build();

    const agent = new AgentBuilder(role)
      .withBackground(background)
      .withAwareness(awareness)
      .withMission(mission)
      .build();

    // Verify inline rendering
    const systemPrompt = agent.getSystemPrompt();
    expect(systemPrompt).toContain("# DevOps Engineer");
    expect(systemPrompt).toContain("a DevOps engineer");
    expect(systemPrompt).toContain("## Current Mission");
    expect(systemPrompt).toContain("Set up staging environment");

    // Verify structured rendering
    const initialPrompt = agent.renderInitialPrompt();
    expect(initialPrompt).toContain("## Identity");
    expect(initialPrompt).toContain("## Boundaries");
    expect(initialPrompt).toContain("## Capabilities");
    expect(initialPrompt).toContain("## Mission");
    expect(initialPrompt).toContain("## Methodology");

    // Verify continuation rendering
    const state = new State({ iteration: 1, phase: Phase.EXECUTING });
    const continuationPrompt = agent.renderContinuationPrompt(state);
    expect(continuationPrompt).toContain("## Current State");
    expect(continuationPrompt).toContain("## Mission");
    expect(continuationPrompt).not.toContain("## Identity");
  });
});
