import { describe, expect, it } from "vitest";

import { z } from "zod";
import { Awareness, AwarenessDomain } from "../awareness.js";
import { Background } from "../background.js";
import { Example } from "../example.js";
import { Judgment } from "../judgment.js";
import { Methodology } from "../methodology.js";
import { Mission, renderSchemaForPrompt } from "../mission.js";
import { Persona } from "../persona.js";
import { Recovery } from "../recovery.js";
import { Responsibility } from "../responsibility.js";
import { Phase, State } from "../state.js";
import { Tone } from "../tone.js";

describe("Persona", () => {
  it("constructs with required fields", () => {
    const p = new Persona({ identity: "a code reviewer", tone: "direct" });
    expect(p.data.identity).toBe("a code reviewer");
    expect(p.data.tone).toBe("direct");
    expect(p.data.priorities).toEqual([]);
    expect(p.data.principles).toEqual([]);
  });

  it("rejects empty identity", () => {
    expect(() => new Persona({ identity: "", tone: "direct" })).toThrow();
  });

  it("toPrompt() matches Python output", () => {
    const p = new Persona({
      identity: "a senior code reviewer",
      tone: "direct and constructive",
      priorities: ["code quality", "maintainability"],
      principles: ["be specific", "suggest alternatives"],
    });
    expect(p.toPrompt()).toMatchInlineSnapshot(`
      "You are a senior code reviewer.
      Communication style: direct and constructive

      Priorities:
      - code quality
      - maintainability

      Principles:
      - be specific
      - suggest alternatives"
    `);
  });

  it("toPrompt() without optional fields", () => {
    const p = new Persona({
      identity: "an assistant",
      tone: "friendly",
    });
    expect(p.toPrompt()).toBe("You are an assistant.\nCommunication style: friendly");
  });

  it("replace() returns new instance", () => {
    const p = new Persona({ identity: "reviewer", tone: "direct" });
    const p2 = p.replace({ tone: "gentle" });
    expect(p2.data.tone).toBe("gentle");
    expect(p.data.tone).toBe("direct");
  });
});

describe("Example", () => {
  it("constructs and renders", () => {
    const e = new Example({
      scenario: "PR has SQL injection",
      good: "Block for SQL injection",
      bad: "Comment on both",
      reasoning: "Security first",
    });
    expect(e.toPrompt()).toMatchInlineSnapshot(`
      "**Scenario:** PR has SQL injection
        \u2713 Good: Block for SQL injection
        \u2717 Bad: Comment on both
        Why: Security first"
    `);
  });

  it("renders without optional fields", () => {
    const e = new Example({
      scenario: "Simple case",
      good: "Do the right thing",
    });
    expect(e.toPrompt()).toBe("**Scenario:** Simple case\n  \u2713 Good: Do the right thing");
  });
});

describe("Judgment", () => {
  it("constructs with fluent methods", () => {
    const j = new Judgment({ domain: "code review" })
      .withHeuristics(["check security"])
      .withConstraints(["never approve without tests"])
      .withEscalation(["security vulnerability found"]);
    expect(j.data.heuristics).toEqual(["check security"]);
    expect(j.data.constraints).toEqual(["never approve without tests"]);
    expect(j.data.escalation_triggers).toEqual(["security vulnerability found"]);
  });

  it("toPrompt() matches Python output", () => {
    const j = new Judgment({
      domain: "code review",
      heuristics: ["check security", "check readability"],
      constraints: ["never approve without tests"],
      escalation_triggers: ["security vulnerability"],
      examples: [
        {
          scenario: "PR has SQL injection",
          good: "Block it",
          bad: "Ignore it",
          reasoning: "Security first",
        },
      ],
    });
    const prompt = j.toPrompt();
    expect(prompt).toContain("## Judgment: code review");
    expect(prompt).toContain("**Heuristics:**");
    expect(prompt).toContain("- check security");
    expect(prompt).toContain("**Constraints (never violate):**");
    expect(prompt).toContain("**Escalate to human when:**");
    expect(prompt).toContain("**Examples:**");
    expect(prompt).toContain("**Scenario:** PR has SQL injection");
  });

  it("withExamples() adds examples", () => {
    const j = new Judgment({ domain: "test" }).withExamples([
      { scenario: "s1", good: "g1", bad: "", reasoning: "" },
    ]);
    expect(j.data.examples).toHaveLength(1);
  });
});

describe("Mission", () => {
  it("constructs and renders basic mission", () => {
    const m = new Mission({ objective: "Ship the feature" });
    expect(m.toPrompt()).toMatchInlineSnapshot(`
      "## Current Mission

      Ship the feature"
    `);
  });

  it("renders full mission with criteria, constraints, rationale", () => {
    const m = new Mission({
      objective: "Ship the feature",
      success_criteria: ["all tests pass", "no regressions"],
      constraints: ["do not modify public API"],
      rationale: "Customer deadline",
    });
    const prompt = m.toPrompt();
    expect(prompt).toContain("**Success criteria:**");
    expect(prompt).toContain("- all tests pass");
    expect(prompt).toContain("**Constraints:**");
    expect(prompt).toContain("**Rationale:** Customer deadline");
  });

  it("withCriteria() and withConstraints() fluent methods", () => {
    const m = new Mission({ objective: "test" }).withCriteria(["c1"]).withConstraints(["x1"]);
    expect(m.data.success_criteria).toEqual(["c1"]);
    expect(m.data.constraints).toEqual(["x1"]);
  });

  it("renders output schema when strict_output is false", () => {
    const schema = { title: "TestOutput", properties: { name: { type: "string" } } };
    const m = new Mission({
      objective: "produce output",
      output_schema: schema,
      strict_output: false,
    });
    const prompt = m.toPrompt();
    expect(prompt).toContain("**Required Output Format:**");
    expect(prompt).toContain("TestOutput");
  });

  it("does not render schema when strict_output is true", () => {
    const schema = { title: "TestOutput", properties: { name: { type: "string" } } };
    const m = new Mission({
      objective: "produce output",
      output_schema: schema,
      strict_output: true,
    });
    expect(m.toPrompt()).not.toContain("Required Output Format");
  });
});

describe("renderSchemaForPrompt", () => {
  it("renders a raw JSON schema", () => {
    const schema = {
      title: "MyOutput",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
      },
    };
    const result = renderSchemaForPrompt(schema);
    expect(result).toContain("**Required Output Format:**");
    expect(result).toContain("`MyOutput`");
    expect(result).toContain('"<name>"');
    expect(result).toContain("0");
  });

  it("renders a Zod schema", () => {
    const zSchema = z.object({
      title: z.string(),
      done: z.boolean(),
    });
    const result = renderSchemaForPrompt(zSchema);
    expect(result).toContain("**Required Output Format:**");
    expect(result).toContain("Schema:");
  });
});

describe("Background", () => {
  it("renders empty when no context", () => {
    const b = new Background({});
    expect(b.toPrompt()).toBe("");
  });

  it("renders sections", () => {
    const b = new Background({
      team_context: { lead: "Alice" },
      project_context: { name: "MyProject" },
      conventions: { style: "functional" },
      current_state: { sprint: "14" },
    });
    const prompt = b.toPrompt();
    expect(prompt).toContain("## Team Context");
    expect(prompt).toContain("- **lead**: Alice");
    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("## Conventions");
    expect(prompt).toContain("## Current State");
  });

  it("handles nested dicts", () => {
    const b = new Background({
      team_context: { members: { alice: "lead", bob: "dev" } },
    });
    const prompt = b.toPrompt();
    expect(prompt).toContain("- **members**:");
    expect(prompt).toContain("  - **alice**: lead");
  });

  it("handles arrays in dicts", () => {
    const b = new Background({
      team_context: { skills: ["ts", "python"] },
    });
    expect(b.toPrompt()).toContain("- **skills**: ts, python");
  });
});

describe("Awareness", () => {
  it("renders empty awareness", () => {
    const a = new Awareness({});
    expect(a.toPrompt()).toBe("You have no external information sources available.");
  });

  it("renders with domains and capabilities", () => {
    const a = new Awareness({
      domains: [
        {
          name: "codebase",
          description: "Source code",
          access_method: "search",
        },
      ],
      exploration_capabilities: ["grep", "find"],
    });
    const prompt = a.toPrompt();
    expect(prompt).toContain("## Available Information Sources");
    expect(prompt).toContain("- **codebase**: Source code (via search)");
    expect(prompt).toContain("Methods: grep, find");
  });

  it("domainNames returns names", () => {
    const a = new Awareness({
      domains: [
        { name: "code", description: "d", access_method: "m" },
        { name: "docs", description: "d", access_method: "m" },
      ],
    });
    expect(a.domainNames).toEqual(["code", "docs"]);
  });

  it("canAccess() and getDomain()", () => {
    const a = new Awareness({
      domains: [{ name: "code", description: "source", access_method: "search" }],
    });
    expect(a.canAccess("code")).toBe(true);
    expect(a.canAccess("unknown")).toBe(false);
    expect(a.getDomain("code")?.description).toBe("source");
    expect(a.getDomain("unknown")).toBeUndefined();
  });

  it("fluent with*() methods", () => {
    const a = new Awareness({})
      .withDomain({
        name: "code",
        description: "d",
        access_method: "m",
      })
      .withDomains([{ name: "docs", description: "d2", access_method: "m2" }])
      .withCapabilities(["search"]);
    expect(a.data.domains).toHaveLength(2);
    expect(a.data.exploration_capabilities).toEqual(["search"]);
  });
});

describe("AwarenessDomain", () => {
  it("renders correctly", () => {
    const d = new AwarenessDomain({
      name: "codebase",
      description: "Source code",
      access_method: "search",
    });
    expect(d.toPrompt()).toBe("- **codebase**: Source code (via search)");
  });
});

describe("Responsibility", () => {
  it("renders with examples", () => {
    const r = new Responsibility({
      key: "code_review",
      name: "Code Review",
      description: "Review pull requests",
      examples: ["PR #123", "PR #456"],
    });
    expect(r.toPrompt()).toMatchInlineSnapshot(`
      "**Code Review**: Review pull requests
        Examples:
        - PR #123
        - PR #456"
    `);
  });

  it("renders without examples", () => {
    const r = new Responsibility({
      key: "deploy",
      name: "Deploy",
      description: "Deploy to production",
    });
    expect(r.toPrompt()).toBe("**Deploy**: Deploy to production");
  });
});

describe("State", () => {
  it("constructs with defaults", () => {
    const s = new State({});
    expect(s.data.iteration).toBe(0);
    expect(s.data.phase).toBe(Phase.PLANNING);
    expect(s.data.accumulated_context).toEqual({});
    expect(s.data.last_action).toBeNull();
  });

  it("toPrompt() matches Python", () => {
    const s = new State({
      iteration: 3,
      phase: Phase.EXECUTING,
      last_action: "ran tests",
    });
    expect(s.toPrompt()).toMatchInlineSnapshot(`
      "## Current State
      Iteration: 3
      Phase: executing
      Last action: ran tests"
    `);
  });

  it("toPrompt() without last_action", () => {
    const s = new State({ iteration: 0, phase: Phase.PLANNING });
    expect(s.toPrompt()).toBe("## Current State\nIteration: 0\nPhase: planning");
  });

  it("withPhase() returns new instance", () => {
    const s = new State({});
    const s2 = s.withPhase(Phase.EXECUTING);
    expect(s2.data.phase).toBe(Phase.EXECUTING);
    expect(s.data.phase).toBe(Phase.PLANNING);
  });

  it("withIteration() returns new instance", () => {
    const s = new State({});
    const s2 = s.withIteration(5);
    expect(s2.data.iteration).toBe(5);
  });

  it("withAction() returns new instance", () => {
    const s = new State({});
    const s2 = s.withAction("deployed");
    expect(s2.data.last_action).toBe("deployed");
  });
});

describe("Tone", () => {
  it("renders with examples and anti-patterns", () => {
    const t = new Tone({
      name: "direct",
      prompt: "Be concise and clear.",
      examples: [
        ["Good", "Fix the bug."],
        ["Bad", "Maybe consider fixing..."],
      ],
      anti_patterns: ["I think maybe", "Perhaps we could"],
    });
    const prompt = t.toPrompt();
    expect(prompt).toContain("Be concise and clear.");
    expect(prompt).toContain("\nExamples:");
    expect(prompt).toContain("  Good: Fix the bug.");
    expect(prompt).toContain("\nAvoid phrases like:");
    expect(prompt).toContain('  - "I think maybe"');
  });

  it("renders minimal tone", () => {
    const t = new Tone({ name: "friendly", prompt: "Be warm." });
    expect(t.toPrompt()).toBe("Be warm.");
  });
});

describe("Methodology", () => {
  it("renders with checklist", () => {
    const m = new Methodology({
      name: "thorough",
      prompt: "Be systematic.",
      checklist: ["step 1", "step 2"],
    });
    expect(m.toPrompt()).toMatchInlineSnapshot(`
      "Be systematic.

      Approach:
        - step 1
        - step 2"
    `);
  });

  it("renders without checklist", () => {
    const m = new Methodology({ name: "quick", prompt: "Move fast." });
    expect(m.toPrompt()).toBe("Move fast.");
  });
});

describe("Recovery", () => {
  it("renders with default max_attempts", () => {
    const r = new Recovery({ name: "retry", prompt: "Try again." });
    expect(r.toPrompt()).toBe("Try again.\nMax attempts before escalating: 3");
  });

  it("renders with custom max_attempts", () => {
    const r = new Recovery({
      name: "retry",
      prompt: "Try again.",
      max_attempts: 5,
    });
    expect(r.toPrompt()).toBe("Try again.\nMax attempts before escalating: 5");
  });

  it("rejects max_attempts < 1", () => {
    expect(() => new Recovery({ name: "retry", prompt: "Try.", max_attempts: 0 })).toThrow();
  });
});
