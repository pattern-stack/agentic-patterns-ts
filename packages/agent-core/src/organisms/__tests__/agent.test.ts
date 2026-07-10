import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Awareness } from "../../atoms/awareness.js";
import { Background } from "../../atoms/background.js";
import { Judgment } from "../../atoms/judgment.js";
import { Methodology } from "../../atoms/methodology.js";
import { Mission } from "../../atoms/mission.js";
import { Persona } from "../../atoms/persona.js";
import { Recovery } from "../../atoms/recovery.js";
import { Responsibility } from "../../atoms/responsibility.js";
import { Phase, State } from "../../atoms/state.js";
import { Tone } from "../../atoms/tone.js";
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
    escalationTriggers: ["Security vulnerability found"],
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
    successCriteria: ["All issues flagged", "No false positives"],
    constraints: ["Complete within 30 minutes"],
  });
}

function makeBackground(): Background {
  return new Background({
    teamContext: { team: "Platform", sprint: "Q1-S3" },
    projectContext: { name: "agentic-patterns" },
  });
}

function makeAwareness(): Awareness {
  return new Awareness({
    domains: [{ name: "GitHub", description: "Repos and PRs", accessMethod: "API" }],
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

    it("falls back to the role default model when set", () => {
      const role = new RoleBuilder("Test Role")
        .withPersona(new Persona({ identity: "tester", tone: "neutral" }))
        .withDefaultModel("claude-haiku-4-5")
        .build();
      const agent = new Agent({ role, mission: makeMission() });
      expect(agent.getModel()).toBe("claude-haiku-4-5");
    });

    it("returns undefined when neither the agent nor its role pins a model", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
      });
      expect(agent.getModel()).toBeUndefined();
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

  describe("toPrompt (delegates to renderInitialPrompt)", () => {
    it("includes role, background, awareness, and mission", () => {
      const agent = new Agent({
        role: makeRole(),
        background: makeBackground(),
        awareness: makeAwareness(),
        mission: makeMission(),
      });

      const prompt = agent.toPrompt();
      expect(prompt).toContain("## Identity");
      expect(prompt).toContain("## Team Context");
      expect(prompt).toContain("## Available Information Sources");
      expect(prompt).toContain("## Mission");
    });

    it("toPrompt is alias for renderInitialPrompt", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
      });
      expect(agent.toPrompt()).toBe(agent.renderInitialPrompt());
    });

    it("getSystemPrompt is a deprecated alias for renderInitialPrompt", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
      });
      expect(agent.getSystemPrompt()).toBe(agent.renderInitialPrompt());
    });

    it("omits empty background", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: makeMission(),
      });
      const prompt = agent.toPrompt();
      // Background with no data produces empty string, should not add extra sections
      expect(prompt).not.toContain("## Team Context");
    });

    it("includes role tone/methodology/recovery", () => {
      const role = new RoleBuilder("Code Reviewer")
        .withPersona(
          new Persona({
            identity: "a code review specialist",
            tone: "professional",
          }),
        )
        .withTone(new Tone({ name: "direct", prompt: "Be blunt and specific." }))
        .withMethodology(
          new Methodology({
            name: "checklist-review",
            prompt: "Work through the review checklist in order.",
            checklist: ["Read the diff twice"],
          }),
        )
        .withRecovery(
          new Recovery({ name: "retry", prompt: "Retry the failing step once.", maxAttempts: 2 }),
        )
        .build();

      const prompt = new Agent({ role, mission: makeMission() }).toPrompt();
      expect(prompt).toContain("Be blunt and specific.");
      expect(prompt).toContain("Work through the review checklist in order.");
      expect(prompt).toContain("Retry the failing step once.");
    });

    it("injects the mission outputSchema when strictOutput is false", () => {
      const agent = new Agent({
        role: makeRole(),
        mission: new Mission({
          objective: "Extract data",
          outputSchema: { title: "Extraction", properties: { name: { type: "string" } } },
          strictOutput: false,
        }),
      });
      const prompt = agent.toPrompt();
      expect(prompt).toContain("**Required Output Format:**");
      expect(prompt).toContain("`Extraction`");
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

    it("passes role tone/methodology/recovery through to the sections", () => {
      const role = new RoleBuilder("Code Reviewer")
        .withPersona(
          new Persona({
            identity: "a code review specialist",
            tone: "professional",
          }),
        )
        .withTone(new Tone({ name: "direct", prompt: "Be blunt and specific." }))
        .withMethodology(
          new Methodology({
            name: "checklist-review",
            prompt: "Work through the review checklist in order.",
            checklist: ["Read the diff twice"],
          }),
        )
        .withRecovery(
          new Recovery({ name: "retry", prompt: "Retry the failing step once.", maxAttempts: 2 }),
        )
        .build();

      const prompt = new Agent({ role, mission: makeMission() }).renderInitialPrompt();
      expect(prompt).toContain("Be blunt and specific.");
      expect(prompt).toContain("Work through the review checklist in order.");
      expect(prompt).toContain("Retry the failing step once.");
    });
  });

  describe("renderSections (sections with provenance)", () => {
    it("joining section texts reproduces renderInitialPrompt exactly", () => {
      const agent = new Agent({
        role: makeRole(),
        background: makeBackground(),
        awareness: makeAwareness(),
        mission: makeMission(),
      });

      const joined = agent
        .renderSections()
        .map((s) => s.text)
        .join("\n\n");
      expect(joined).toBe(agent.renderInitialPrompt());
    });

    it("attributes each section to role or instance", () => {
      const agent = new Agent({
        role: makeRole(),
        background: makeBackground(),
        awareness: makeAwareness(),
        mission: makeMission(),
      });

      const sections = agent.renderSections();
      expect(sections.map((s) => [s.name, s.source])).toEqual([
        ["Identity", "role"],
        ["Boundaries", "role"],
        ["Capabilities", "role"],
        ["Context", "instance"],
        ["Mission", "instance"],
        ["Methodology", "role"],
      ]);
    });

    it("filters sections that render empty (mirrors renderInitial's filter)", () => {
      // Bare role: no judgments -> Methodology renders "" and is filtered out.
      const role = new RoleBuilder("Minimal")
        .withPersona(new Persona({ identity: "a minimal agent", tone: "neutral" }))
        .build();
      const agent = new Agent({ role, mission: makeMission() });

      const names = agent.renderSections().map((s) => s.name);
      expect(names).not.toContain("Methodology");
      // Invariant still holds with filtered sections.
      const joined = agent
        .renderSections()
        .map((s) => s.text)
        .join("\n\n");
      expect(joined).toBe(agent.renderInitialPrompt());
    });

    it("keeps the Context section for empty background/awareness (awareness fallback text)", () => {
      // Empty Awareness renders a fallback line, so ContextSection is non-empty
      // and renderInitial includes it — renderSections must mirror that.
      const agent = new Agent({ role: makeRole(), mission: makeMission() });

      const context = agent.renderSections().find((s) => s.name === "Context");
      expect(context).toBeDefined();
      expect(context?.source).toBe("instance");
      expect(context?.text).toContain("no external information sources");
    });

    it("every rendered section is non-empty", () => {
      const agent = new Agent({ role: makeRole(), mission: makeMission() });
      for (const section of agent.renderSections()) {
        expect(section.text).not.toBe("");
      }
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
        lastAction: "Reviewed utils.ts",
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
        lastAction: "Final review complete",
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
      escalationTriggers: ["Production outage"],
    });
    const responsibility = new Responsibility({
      key: "deploy",
      name: "Deployment",
      description: "Manage CI/CD pipelines",
    });
    const mission = new Mission({
      objective: "Set up staging environment",
      successCriteria: ["All services running", "Monitoring enabled"],
    });
    const background = new Background({
      projectContext: { cloud: "AWS", region: "us-east-1" },
    });
    const awareness = new Awareness({
      domains: [{ name: "AWS Console", description: "Cloud resources", accessMethod: "SDK" }],
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

    // Verify the unified prompt path
    const systemPrompt = agent.toPrompt();
    expect(systemPrompt).toContain("a DevOps engineer");
    expect(systemPrompt).toContain("## Mission");
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
