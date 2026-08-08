import { describe, expect, expectTypeOf, it } from "vitest";

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

  it("toPrompt() renders the persona block", () => {
    const p = new Persona({
      identity: "a senior code reviewer",
      tone: "direct and constructive",
      priorities: ["code quality", "maintainability"],
      principles: ["be specific", "suggest alternatives"],
    });
    expect(p.toPrompt()).toMatchInlineSnapshot(`
      "You are a senior code reviewer.

      ### Tone

      direct and constructive

      ### Priorities

      - code quality
      - maintainability

      ### Principles

      - be specific
      - suggest alternatives"
    `);
  });

  it("toPrompt() without optional fields", () => {
    const p = new Persona({
      identity: "an assistant",
      tone: "friendly",
    });
    expect(p.toPrompt()).toBe("You are an assistant.\n\n### Tone\n\nfriendly");
  });

  it("toPrompt() renders a Tone object over the persona tone string", () => {
    const p = new Persona({ identity: "an assistant", tone: "basic tone" });
    const t = new Tone({ name: "formal", prompt: "Be formal and precise." });
    const result = p.toPrompt({ tone: t });
    expect(result).toContain("### Tone");
    expect(result).toContain("Be formal and precise.");
    expect(result).not.toContain("basic tone");
  });

  it("withPriorities() and withPrinciples() append", () => {
    const p = new Persona({ identity: "reviewer", tone: "direct", priorities: ["p1"] })
      .withPriorities(["p2"])
      .withPrinciples(["always verify"]);
    expect(p.data.priorities).toEqual(["p1", "p2"]);
    expect(p.data.principles).toEqual(["always verify"]);
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
      "- **Scenario:** PR has SQL injection
        - \u2713 Block for SQL injection
        - \u2717 Comment on both
        - *Why:* Security first"
    `);
  });

  it("renders without optional fields", () => {
    const e = new Example({
      scenario: "Simple case",
      good: "Do the right thing",
    });
    expect(e.toPrompt()).toBe("- **Scenario:** Simple case\n  - \u2713 Do the right thing");
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
    expect(j.data.escalationTriggers).toEqual(["security vulnerability found"]);
  });

  it("toPrompt() matches Python output", () => {
    const j = new Judgment({
      domain: "code review",
      heuristics: ["check security", "check readability"],
      constraints: ["never approve without tests"],
      escalationTriggers: ["security vulnerability"],
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
      "## Mission

      ### Objective

      Ship the feature"
    `);
  });

  it("renders full mission with criteria, constraints, rationale", () => {
    const m = new Mission({
      objective: "Ship the feature",
      successCriteria: ["all tests pass", "no regressions"],
      constraints: ["do not modify public API"],
      rationale: "Customer deadline",
    });
    const prompt = m.toPrompt();
    expect(prompt).toContain("### Success Criteria");
    expect(prompt).toContain("- all tests pass");
    expect(prompt).toContain("### Constraints");
    expect(prompt).toContain("### Rationale");
    expect(prompt).toContain("Customer deadline");
  });

  it("withCriteria() and withConstraints() fluent methods", () => {
    const m = new Mission({ objective: "test" }).withCriteria(["c1"]).withConstraints(["x1"]);
    expect(m.data.successCriteria).toEqual(["c1"]);
    expect(m.data.constraints).toEqual(["x1"]);
  });

  it("renders output schema when strictOutput is false", () => {
    const schema = { title: "TestOutput", properties: { name: { type: "string" } } };
    const m = new Mission({
      objective: "produce output",
      outputSchema: schema,
      strictOutput: false,
    });
    const prompt = m.toPrompt();
    expect(prompt).toContain("**Required Output Format:**");
    expect(prompt).toContain("TestOutput");
  });

  it("does not render schema when strictOutput is true", () => {
    const schema = { title: "TestOutput", properties: { name: { type: "string" } } };
    const m = new Mission({
      objective: "produce output",
      outputSchema: schema,
      strictOutput: true,
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
      teamContext: { lead: "Alice" },
      projectContext: { name: "MyProject" },
      conventions: { style: "functional" },
      currentState: { sprint: "14" },
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
      teamContext: { members: { alice: "lead", bob: "dev" } },
    });
    const prompt = b.toPrompt();
    expect(prompt).toContain("- **members**:");
    expect(prompt).toContain("  - **alice**: lead");
  });

  it("handles arrays in dicts", () => {
    const b = new Background({
      teamContext: { skills: ["ts", "python"] },
    });
    expect(b.toPrompt()).toContain("- **skills**: ts, python");
  });
});

// A minimal SessionScope-shaped stand-in: `{ parse(input): T }`. Awareness
// (atoms, layer 0) can never import the real SessionScope (molecules, layer
// 2) — this mirrors what a real SessionScope instance looks like structurally,
// per R2's "typing anchor only" contract.
const workspaceScopeSchema = z.object({
  userId: z.string(),
  workspace: z.string(),
  region: z.string().default("us-east-1"),
});
const workspaceScope = {
  parse: (input: unknown) => workspaceScopeSchema.parse(input),
};

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
          accessMethod: "search",
        },
      ],
      explorationCapabilities: ["grep", "find"],
    });
    const prompt = a.toPrompt();
    expect(prompt).toContain("## Available Information Sources");
    expect(prompt).toContain("- **codebase**: Source code (via search)");
    expect(prompt).toContain("Methods: grep, find");
  });

  it("domainNames returns names", () => {
    const a = new Awareness({
      domains: [
        { name: "code", description: "d", accessMethod: "m" },
        { name: "docs", description: "d", accessMethod: "m" },
      ],
    });
    expect(a.domainNames).toEqual(["code", "docs"]);
  });

  it("canAccess() and getDomain()", () => {
    const a = new Awareness({
      domains: [{ name: "code", description: "source", accessMethod: "search" }],
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
        accessMethod: "m",
      })
      .withDomains([{ name: "docs", description: "d2", accessMethod: "m2" }])
      .withCapabilities(["search"]);
    expect(a.data.domains).toHaveLength(2);
    expect(a.data.explorationCapabilities).toEqual(["search"]);
  });
});

describe("Awareness.fromScope", () => {
  it("builds an Awareness with no domains by default", () => {
    const awareness = Awareness.fromScope(workspaceScope, (s) => `Workspace: ${s.workspace}`);
    expect(awareness.data.domains).toEqual([]);
  });

  it("layers scope-derived text onto a base awareness's domains", () => {
    const awareness = Awareness.fromScope(workspaceScope, (s) => `Workspace: ${s.workspace}`, {
      domains: [{ name: "GitHub", description: "Repos", accessMethod: "API" }],
    });
    expect(awareness.domainNames).toEqual(["GitHub"]);
  });

  it("types fn's scope param from scopeLike.parse's return type", () => {
    const awareness = Awareness.fromScope(workspaceScope, (s) => {
      expectTypeOf(s).toEqualTypeOf<z.infer<typeof workspaceScopeSchema>>();
      return `Workspace: ${s.workspace}`;
    });
    // Actually invoke the hook (via toPrompt) so the assertion above runs.
    const prompt = awareness.toPrompt({
      scope: { userId: "u1", workspace: "acme", region: "us-east-1" },
    });
    expect(prompt).toContain("Workspace: acme");
  });

  it("never calls scopeLike.parse — a typing anchor only, not re-validated at render time", () => {
    let parseCalls = 0;
    const spyScope = {
      parse: (input: unknown) => {
        parseCalls++;
        return workspaceScopeSchema.parse(input);
      },
    };
    const awareness = Awareness.fromScope(spyScope, (s) => s.workspace);
    awareness.toPrompt({ scope: { userId: "u1", workspace: "acme", region: "us-east-1" } });
    expect(parseCalls).toBe(0);
  });
});

describe("Awareness.fromRecall", () => {
  const FALLBACK = "You have no external information sources available.";

  it("appends the host-assembled block verbatim (identity default) after the base content", () => {
    const awareness = Awareness.fromRecall();
    expect(awareness.toPrompt({ recall: "block" })).toBe(`${FALLBACK}\n\nblock`);
  });

  it("renders through a custom fn when one is supplied", () => {
    const awareness = Awareness.fromRecall((r) => `wrapped: ${r}`);
    expect(awareness.toPrompt({ recall: "block" })).toBe(`${FALLBACK}\n\nwrapped: block`);
  });

  it("renders base domains first, recall appended last", () => {
    const awareness = Awareness.fromRecall(undefined, {
      domains: [{ name: "GitHub", description: "Repos", accessMethod: "API" }],
    });
    const nullary = awareness.toPrompt();
    expect(nullary).toContain("GitHub");
    expect(awareness.toPrompt({ recall: "block" })).toBe(`${nullary}\n\nblock`);
  });

  it("is byte-identical to a plain Awareness when ctx is omitted", () => {
    expect(Awareness.fromRecall().toPrompt()).toBe(new Awareness({}).toPrompt());
  });

  it("is byte-identical to nullary rendering when ctx.recall is undefined", () => {
    const awareness = Awareness.fromRecall();
    expect(awareness.toPrompt({ scope: { workspace: "acme" } })).toBe(awareness.toPrompt());
  });

  it("a hook-less instance ignores ctx.recall entirely", () => {
    const awareness = new Awareness({});
    expect(awareness.toPrompt({ recall: "block" })).toBe(awareness.toPrompt());
  });

  it("skips the append for an empty-string ctx.recall (hosts may pass block unconditionally)", () => {
    const awareness = Awareness.fromRecall();
    expect(awareness.toPrompt({ recall: "" })).toBe(awareness.toPrompt());
  });

  it("recallRender AND scopeRender survive withDomain/withDomains/withCapabilities", () => {
    const awareness = new Awareness(
      {},
      (s) => `Workspace: ${String(s.workspace)}`,
      (r) => r,
    );
    const chained = awareness
      .withDomain({ name: "GitHub", description: "Repos", accessMethod: "API" })
      .withDomains([{ name: "Docs", description: "d", accessMethod: "m" }])
      .withCapabilities(["search"]);
    expect(chained.recallRender).toBe(awareness.recallRender);
    expect(chained.scopeRender).toBe(awareness.scopeRender);
    const prompt = chained.toPrompt({ scope: { workspace: "acme" }, recall: "remembered" });
    expect(prompt).toContain("Workspace: acme");
    expect(prompt).toContain("remembered");
  });

  it("renders base, scope text, recall text in that order when both hooks fire", () => {
    const awareness = new Awareness(
      {},
      (s) => `Workspace: ${String(s.workspace)}`,
      (r) => r,
    );
    expect(awareness.toPrompt({ scope: { workspace: "acme" }, recall: "remembered" })).toBe(
      `${FALLBACK}\n\nWorkspace: acme\n\nremembered`,
    );
  });
});

describe("Awareness.toPrompt(ctx) append semantics", () => {
  it("is byte-identical to a scopeRender-less Awareness when ctx is omitted", () => {
    const withHook = Awareness.fromScope(workspaceScope, (s) => `Workspace: ${s.workspace}`);
    const without = new Awareness({});
    expect(withHook.toPrompt()).toBe(without.toPrompt());
  });

  it("is byte-identical to nullary rendering when ctx.scope is undefined", () => {
    const withHook = Awareness.fromScope(workspaceScope, (s) => `Workspace: ${s.workspace}`);
    expect(withHook.toPrompt({})).toBe(withHook.toPrompt());
  });

  it("appends after the no-domains fallback line, never replacing it", () => {
    const awareness = Awareness.fromScope(
      workspaceScope,
      (s) => `Acting on behalf of ${s.userId} in workspace ${s.workspace}.`,
    );
    const prompt = awareness.toPrompt({
      scope: { userId: "u1", workspace: "acme", region: "us-east-1" },
    });
    expect(prompt).toBe(
      "You have no external information sources available.\n\n" +
        "Acting on behalf of u1 in workspace acme.",
    );
  });

  it("appends after a populated info-sources block, never reordering it", () => {
    const awareness = Awareness.fromScope(workspaceScope, (s) => `Workspace: ${s.workspace}`, {
      domains: [{ name: "GitHub", description: "Repos", accessMethod: "API" }],
    });
    const nullary = awareness.toPrompt();
    const scoped = awareness.toPrompt({
      scope: { userId: "u1", workspace: "acme", region: "us-east-1" },
    });
    expect(scoped.startsWith(nullary)).toBe(true);
    expect(scoped).toBe(`${nullary}\n\nWorkspace: acme`);
  });

  it("skips appending when scopeRender returns an empty string", () => {
    const awareness = Awareness.fromScope(workspaceScope, () => "");
    const scoped = awareness.toPrompt({
      scope: { userId: "u1", workspace: "acme", region: "us-east-1" },
    });
    expect(scoped).toBe(awareness.toPrompt());
  });

  it("ignores ctx.scope entirely when the instance has no scopeRender", () => {
    const awareness = new Awareness({});
    const scoped = awareness.toPrompt({ scope: { anything: "goes" } });
    expect(scoped).toBe("You have no external information sources available.");
  });
});

describe("Awareness.replace() scopeRender survival (R3)", () => {
  it("survives a direct replace() call", () => {
    const awareness = Awareness.fromScope(workspaceScope, (s) => `Workspace: ${s.workspace}`);
    const replaced = awareness.replace({ explorationCapabilities: ["search"] });
    expect(replaced.scopeRender).toBe(awareness.scopeRender);
    expect(
      replaced.toPrompt({ scope: { userId: "u1", workspace: "acme", region: "x" } }),
    ).toContain("Workspace: acme");
  });

  it("survives withDomain()", () => {
    const awareness = Awareness.fromScope(workspaceScope, (s) => `Workspace: ${s.workspace}`);
    const next = awareness.withDomain({
      name: "GitHub",
      description: "Repos",
      accessMethod: "API",
    });
    expect(next.scopeRender).toBe(awareness.scopeRender);
    expect(next.toPrompt({ scope: { userId: "u1", workspace: "acme", region: "x" } })).toContain(
      "Workspace: acme",
    );
  });

  it("survives withDomains()", () => {
    const awareness = Awareness.fromScope(workspaceScope, (s) => `Workspace: ${s.workspace}`);
    const next = awareness.withDomains([
      { name: "GitHub", description: "Repos", accessMethod: "API" },
    ]);
    expect(next.scopeRender).toBe(awareness.scopeRender);
  });

  it("survives withCapabilities()", () => {
    const awareness = Awareness.fromScope(workspaceScope, (s) => `Workspace: ${s.workspace}`);
    const next = awareness.withCapabilities(["grep"]);
    expect(next.scopeRender).toBe(awareness.scopeRender);
  });

  it("a plain (non-fromScope) Awareness still has no scopeRender after replace()", () => {
    const awareness = new Awareness({});
    const replaced = awareness.replace({ explorationCapabilities: ["search"] });
    expect(replaced.scopeRender).toBeUndefined();
  });
});

describe("AwarenessDomain", () => {
  it("renders correctly", () => {
    const d = new AwarenessDomain({
      name: "codebase",
      description: "Source code",
      accessMethod: "search",
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
    expect(s.data.accumulatedContext).toEqual({});
    expect(s.data.lastAction).toBeNull();
  });

  it("toPrompt() matches Python", () => {
    const s = new State({
      iteration: 3,
      phase: Phase.EXECUTING,
      lastAction: "ran tests",
    });
    expect(s.toPrompt()).toMatchInlineSnapshot(`
      "## Current State
      Iteration: 3
      Phase: executing
      Last action: ran tests"
    `);
  });

  it("toPrompt() without lastAction", () => {
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
    expect(s2.data.lastAction).toBe("deployed");
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
      antiPatterns: ["I think maybe", "Perhaps we could"],
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
  it("renders with default maxAttempts", () => {
    const r = new Recovery({ name: "retry", prompt: "Try again." });
    expect(r.toPrompt()).toBe("Try again.\nMax attempts before escalating: 3");
  });

  it("renders with custom maxAttempts", () => {
    const r = new Recovery({
      name: "retry",
      prompt: "Try again.",
      maxAttempts: 5,
    });
    expect(r.toPrompt()).toBe("Try again.\nMax attempts before escalating: 5");
  });

  it("rejects maxAttempts < 1", () => {
    expect(() => new Recovery({ name: "retry", prompt: "Try.", maxAttempts: 0 })).toThrow();
  });
});
