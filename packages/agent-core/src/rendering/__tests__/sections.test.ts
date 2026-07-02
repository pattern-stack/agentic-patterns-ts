import { describe, expect, it } from "vitest";

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
import {
  BoundariesSection,
  ContextSection,
  IdentitySection,
  MethodologySection,
  MissionSection,
  StateSection,
} from "../sections/index.js";

describe("IdentitySection", () => {
  it("renders persona identity", () => {
    const persona = new Persona({
      identity: "a senior code reviewer",
      tone: "professional and direct",
    });
    const section = new IdentitySection(persona);
    const result = section.render();
    expect(result).toContain("## Identity");
    expect(result).toContain("You are a senior code reviewer.");
    expect(result).toContain("### Tone");
    expect(result).toContain("professional and direct");
  });

  it("renders Tone object over persona.tone string", () => {
    const persona = new Persona({
      identity: "a helpful assistant",
      tone: "basic tone",
    });
    const tone = new Tone({
      name: "Professional",
      prompt: "Be formal and precise.",
      examples: [["Good", "I recommend..."]],
      antiPatterns: ["Hey there!"],
    });
    const section = new IdentitySection(persona, [], tone);
    const result = section.render();
    expect(result).toContain("Be formal and precise.");
    expect(result).not.toContain("basic tone");
  });

  it("renders priorities and principles", () => {
    const persona = new Persona({
      identity: "a task manager",
      tone: "",
      priorities: ["Accuracy", "Speed"],
      principles: ["Be honest", "Be thorough"],
    });
    const section = new IdentitySection(persona);
    const result = section.render();
    expect(result).toContain("### Priorities");
    expect(result).toContain("- Accuracy");
    expect(result).toContain("- Speed");
    expect(result).toContain("### Principles");
    expect(result).toContain("- Be honest");
  });

  it("renders responsibilities", () => {
    const resp = new Responsibility({
      key: "review",
      name: "Code Review",
      description: "Review pull requests",
    });
    const section = new IdentitySection(undefined, [resp]);
    const result = section.render();
    expect(result).toContain("### Responsibilities");
    expect(result).toContain("**Code Review**: Review pull requests");
  });

  it("renders just heading when no inputs", () => {
    const section = new IdentitySection();
    expect(section.render()).toBe("## Identity");
  });

  it("snapshot: full identity section", () => {
    const persona = new Persona({
      identity: "a senior code reviewer specializing in TypeScript",
      tone: "professional and constructive",
      priorities: ["Code quality", "Maintainability"],
      principles: ["Be specific in feedback", "Suggest alternatives"],
    });
    const resp = new Responsibility({
      key: "review",
      name: "Code Review",
      description: "Review pull requests for quality",
      examples: ["PR review", "Code audit"],
    });
    const section = new IdentitySection(persona, [resp]);
    expect(section.render()).toMatchSnapshot();
  });
});

describe("BoundariesSection", () => {
  it("renders constraints and escalation triggers", () => {
    const judgment = new Judgment({
      domain: "security",
      constraints: ["Never expose secrets", "No SQL injection"],
      escalationTriggers: ["Unknown vulnerability type"],
    });
    const section = new BoundariesSection([judgment]);
    const result = section.render();
    expect(result).toContain("## Boundaries");
    expect(result).toContain("### Constraints");
    expect(result).toContain("- Never expose secrets");
    expect(result).toContain("### Escalate When");
    expect(result).toContain("- Unknown vulnerability type");
  });

  it("aggregates from multiple judgments", () => {
    const j1 = new Judgment({
      domain: "security",
      constraints: ["No secrets"],
    });
    const j2 = new Judgment({
      domain: "compliance",
      escalationTriggers: ["Legal review needed"],
    });
    const section = new BoundariesSection([j1, j2]);
    const result = section.render();
    expect(result).toContain("- No secrets");
    expect(result).toContain("- Legal review needed");
  });

  it("renders empty with empty judgments", () => {
    const section = new BoundariesSection([]);
    expect(section.render()).toBe("");
  });

  it("renders empty with judgments that have no constraints or triggers", () => {
    const j = new Judgment({ domain: "testing", heuristics: ["Test first"] });
    const section = new BoundariesSection([j]);
    expect(section.render()).toBe("");
  });

  it("renders a Recovery subsection after the escalation block", () => {
    const judgment = new Judgment({
      domain: "security",
      escalationTriggers: ["Data breach"],
    });
    const recovery = new Recovery({ name: "retry", prompt: "Try again.", maxAttempts: 2 });
    const section = new BoundariesSection([judgment], recovery);
    const result = section.render();
    expect(result.indexOf("### Escalate When")).toBeLessThan(result.indexOf("### Recovery"));
    expect(result).toContain("Try again.\nMax attempts before escalating: 2");
  });

  it("renders recovery even when judgments contribute nothing", () => {
    const recovery = new Recovery({ name: "retry", prompt: "Try again." });
    const section = new BoundariesSection([], recovery);
    const result = section.render();
    expect(result).toContain("## Boundaries");
    expect(result).toContain("### Recovery");
    expect(result).toContain("Try again.");
  });

  it("snapshot: boundaries section", () => {
    const judgment = new Judgment({
      domain: "security",
      constraints: ["Never expose API keys", "No direct DB access"],
      escalationTriggers: ["Potential data breach", "Compliance violation"],
    });
    const section = new BoundariesSection([judgment]);
    expect(section.render()).toMatchSnapshot();
  });
});

describe("ContextSection", () => {
  it("renders background", () => {
    const bg = new Background({
      teamContext: { team: "Platform" },
    });
    const section = new ContextSection(bg);
    const result = section.render();
    expect(result).toContain("## Context");
    expect(result).toContain("Team Context");
  });

  it("renders awareness", () => {
    const awareness = new Awareness({
      domains: [{ name: "GitHub", description: "Code repos", accessMethod: "API" }],
    });
    const section = new ContextSection(undefined, awareness);
    const result = section.render();
    expect(result).toContain("## Context");
    expect(result).toContain("GitHub");
  });

  it("returns empty when no background or awareness", () => {
    const section = new ContextSection();
    expect(section.render()).toBe("");
  });

  it("returns empty when background is all empty", () => {
    const bg = new Background({});
    const section = new ContextSection(bg);
    expect(section.render()).toBe("");
  });
});

describe("MissionSection", () => {
  it("renders mission objective", () => {
    const mission = new Mission({
      objective: "Review the pull request",
    });
    const section = new MissionSection(mission);
    const result = section.render();
    expect(result).toContain("## Mission");
    expect(result).toContain("### Objective");
    expect(result).toContain("Review the pull request");
  });

  it("renders success criteria and constraints", () => {
    const mission = new Mission({
      objective: "Build feature X",
      successCriteria: ["All tests pass", "No regressions"],
      constraints: ["Use existing APIs only"],
    });
    const section = new MissionSection(mission);
    const result = section.render();
    expect(result).toContain("### Success Criteria");
    expect(result).toContain("- All tests pass");
    expect(result).toContain("### Constraints");
    expect(result).toContain("- Use existing APIs only");
  });

  it("renders rationale", () => {
    const mission = new Mission({
      objective: "Migrate to v2",
      rationale: "v1 is deprecated",
    });
    const section = new MissionSection(mission);
    const result = section.render();
    expect(result).toContain("### Rationale");
    expect(result).toContain("v1 is deprecated");
  });

  it("returns empty when no mission", () => {
    const section = new MissionSection();
    expect(section.render()).toBe("");
  });

  it("renders the outputSchema when strictOutput is false (single prompt path)", () => {
    const mission = new Mission({
      objective: "Extract data",
      outputSchema: { title: "Extraction", properties: { name: { type: "string" } } },
      strictOutput: false,
    });
    const section = new MissionSection(mission);
    expect(section.render()).toContain("**Required Output Format:**");
    expect(section.render()).toContain("`Extraction`");
  });

  it("snapshot: full mission section", () => {
    const mission = new Mission({
      objective: "Implement the rendering layer for TypeScript port",
      successCriteria: ["All sections render correctly", "Snapshot tests pass"],
      constraints: ["Match Python output exactly"],
      rationale: "Required for agent prompt composition",
    });
    const section = new MissionSection(mission);
    expect(section.render()).toMatchSnapshot();
  });
});

describe("MethodologySection", () => {
  it("renders heuristics", () => {
    const judgment = new Judgment({
      domain: "code_review",
      heuristics: ["Check for edge cases", "Verify error handling"],
    });
    const section = new MethodologySection([judgment]);
    const result = section.render();
    expect(result).toContain("## Methodology");
    expect(result).toContain("### Code Review");
    expect(result).toContain("- Check for edge cases");
  });

  it("formats domain names from snake_case to Title Case", () => {
    const judgment = new Judgment({
      domain: "pull_request_review",
      heuristics: ["Be thorough"],
    });
    const section = new MethodologySection([judgment]);
    expect(section.render()).toContain("### Pull Request Review");
  });

  it("renders examples", () => {
    const judgment = new Judgment({
      domain: "testing",
      examples: [
        {
          scenario: "Unit test needed",
          good: "Write focused test",
          bad: "Skip testing",
          reasoning: "Tests prevent regressions",
        },
      ],
    });
    const section = new MethodologySection([judgment]);
    const result = section.render();
    expect(result).toContain("**Examples:**");
    expect(result).toContain("- **Scenario:** Unit test needed");
    expect(result).toContain("  - \u2713 Write focused test");
    expect(result).toContain("  - \u2717 Skip testing");
    expect(result).toContain("  - *Why:* Tests prevent regressions");
  });

  it("returns empty when no judgments", () => {
    const section = new MethodologySection([]);
    expect(section.render()).toBe("");
  });

  it("returns empty when judgments have only constraints", () => {
    const j = new Judgment({
      domain: "security",
      constraints: ["No secrets"],
    });
    const section = new MethodologySection([j]);
    expect(section.render()).toBe("");
  });

  it("renders a Methodology as the first block under the heading", () => {
    const methodology = new Methodology({
      name: "thorough",
      prompt: "Be systematic.",
      checklist: ["step 1"],
    });
    const judgment = new Judgment({
      domain: "code_review",
      heuristics: ["Check edge cases"],
    });
    const section = new MethodologySection([judgment], methodology);
    const result = section.render();
    expect(result.indexOf("Be systematic.")).toBeLessThan(result.indexOf("### Code Review"));
    expect(result.startsWith("## Methodology\n\nBe systematic.")).toBe(true);
  });

  it("renders heading + methodology with empty judgments", () => {
    const methodology = new Methodology({ name: "quick", prompt: "Move fast." });
    const section = new MethodologySection([], methodology);
    expect(section.render()).toBe("## Methodology\n\nMove fast.");
  });

  it("snapshot: methodology section", () => {
    const judgment = new Judgment({
      domain: "code_quality",
      heuristics: ["Prefer composition over inheritance", "Keep functions small"],
      examples: [
        {
          scenario: "Large function detected",
          good: "Extract helper functions",
          bad: "Leave as is",
          reasoning: "Smaller functions are easier to test and maintain",
        },
      ],
    });
    const section = new MethodologySection([judgment]);
    expect(section.render()).toMatchSnapshot();
  });
});

describe("StateSection", () => {
  it("renders state", () => {
    const state = new State({
      iteration: 3,
      phase: Phase.EXECUTING,
      lastAction: "Reviewed file.ts",
    });
    const section = new StateSection(state);
    const result = section.render();
    expect(result).toContain("## Current State");
    expect(result).toContain("Iteration: 3");
    expect(result).toContain("Phase: executing");
    expect(result).toContain("Last action: Reviewed file.ts");
  });

  it("returns empty when no state", () => {
    const section = new StateSection();
    expect(section.render()).toBe("");
  });
});
