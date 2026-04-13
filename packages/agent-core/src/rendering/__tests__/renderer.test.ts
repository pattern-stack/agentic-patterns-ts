import { describe, expect, it } from "vitest";

import { Awareness } from "../../atoms/awareness.js";
import { Background } from "../../atoms/background.js";
import { Judgment } from "../../atoms/judgment.js";
import { Mission } from "../../atoms/mission.js";
import { Persona } from "../../atoms/persona.js";
import { Responsibility } from "../../atoms/responsibility.js";
import { Phase, State } from "../../atoms/state.js";
import { PromptRenderer } from "../renderer.js";
import {
  BoundariesSection,
  CapabilitiesSection,
  ContextSection,
  IdentitySection,
  MethodologySection,
  MissionSection,
} from "../sections/index.js";

function makeRenderer() {
  const persona = new Persona({
    identity: "a code review specialist",
    tone: "professional",
    priorities: ["Quality"],
  });
  const resp = new Responsibility({
    key: "review",
    name: "Code Review",
    description: "Review PRs",
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
  const bg = new Background({
    team_context: { team: "Platform" },
  });
  const awareness = new Awareness({
    domains: [{ name: "GitHub", description: "Repos", access_method: "API" }],
  });
  const mission = new Mission({
    objective: "Review PR #42",
    success_criteria: ["All issues flagged"],
    constraints: ["Complete within 30 minutes"],
  });

  return new PromptRenderer(
    new IdentitySection(persona, [resp]),
    new BoundariesSection([judgment]),
    new CapabilitiesSection([]),
    new ContextSection(bg, awareness),
    new MissionSection(mission),
    new MethodologySection([judgment]),
  );
}

describe("PromptRenderer", () => {
  it("renderInitial includes all non-empty sections", () => {
    const renderer = makeRenderer();
    const result = renderer.renderInitial();

    // Should include identity, boundaries, context, mission, methodology
    expect(result).toContain("## Identity");
    expect(result).toContain("## Boundaries");
    expect(result).toContain("## Context");
    expect(result).toContain("## Mission");
    expect(result).toContain("## Methodology");
  });

  it("renderInitial filters empty sections", () => {
    const renderer = makeRenderer();
    const result = renderer.renderInitial();

    // Capabilities section is empty (no capabilities provided), should not appear
    expect(result).not.toContain("## Capabilities");
  });

  it("renderInitial has no double blank lines from filtering", () => {
    const renderer = makeRenderer();
    const result = renderer.renderInitial();

    // Sections are joined by \n\n; no triple+ newlines should appear
    expect(result).not.toContain("\n\n\n");
  });

  it("renderContinuation includes only state, mission, methodology", () => {
    const renderer = makeRenderer();
    const state = new State({
      iteration: 2,
      phase: Phase.EXECUTING,
      last_action: "Reviewed main.ts",
    });
    const result = renderer.renderContinuation(state);

    expect(result).toContain("## Current State");
    expect(result).toContain("Iteration: 2");
    expect(result).toContain("## Mission");
    expect(result).toContain("## Methodology");

    // Should NOT include identity or boundaries
    expect(result).not.toContain("## Identity");
    expect(result).not.toContain("## Boundaries");
    expect(result).not.toContain("## Context");
  });

  it("renderInitial sections appear in fixed order", () => {
    const renderer = makeRenderer();
    const result = renderer.renderInitial();

    const identityIdx = result.indexOf("## Identity");
    const boundariesIdx = result.indexOf("## Boundaries");
    const contextIdx = result.indexOf("## Context");
    const missionIdx = result.indexOf("## Mission");
    const methodologyIdx = result.indexOf("## Methodology");

    expect(identityIdx).toBeLessThan(boundariesIdx);
    expect(boundariesIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(missionIdx);
    expect(missionIdx).toBeLessThan(methodologyIdx);
  });

  it("snapshot: full initial prompt", () => {
    const renderer = makeRenderer();
    expect(renderer.renderInitial()).toMatchSnapshot();
  });

  it("snapshot: continuation prompt", () => {
    const renderer = makeRenderer();
    const state = new State({
      iteration: 5,
      phase: Phase.FINISHING,
      last_action: "Final review complete",
    });
    expect(renderer.renderContinuation(state)).toMatchSnapshot();
  });
});
