import { describe, expect, it } from "vitest";

import type { Capability } from "../../molecules/capability.js";
import type {
  CapabilityResolutionContext,
  CapabilityResolver,
} from "../../organisms/capability-resolver.js";
import { AgentConfig, AgentConfigSchema, RoleTemplateConfigSchema } from "../agent-config.js";

const minimalRoleTemplate = {
  name: "Project Manager",
  persona: { identity: "a project manager", tone: "concise" },
};

describe("RoleTemplateConfigSchema", () => {
  it("applies defaults", () => {
    const parsed = RoleTemplateConfigSchema.parse(minimalRoleTemplate);
    expect(parsed.judgments).toEqual([]);
    expect(parsed.responsibilities).toEqual([]);
    // No framework default — an unspecified model is undefined (the runner decides).
    expect(parsed.defaultModel).toBeUndefined();
    expect(parsed.source).toBe("custom");
    expect(parsed.archetype).toBeNull();
  });

  it("rejects an unknown source", () => {
    expect(() =>
      RoleTemplateConfigSchema.parse({ ...minimalRoleTemplate, source: "vendor" }),
    ).toThrow();
  });
});

describe("AgentConfig", () => {
  it("constructs with minimal config and applies defaults", () => {
    const cfg = new AgentConfig({
      roleTemplate: minimalRoleTemplate,
      mission: { objective: "Keep the backlog healthy" },
    });
    expect(cfg.data.capabilities).toEqual([]);
    expect(cfg.data.model).toBeNull();
    // Neither an agent model nor a role default → effective model is undefined.
    expect(cfg.model).toBeUndefined();
    expect(cfg.data.background.teamContext).toEqual({});
    expect(cfg.data.awareness.domains).toEqual([]);
  });

  it("effective model falls back to the role template default", () => {
    const cfg = new AgentConfig({
      roleTemplate: { ...minimalRoleTemplate, defaultModel: "claude-haiku-4-5" },
      mission: { objective: "x" },
    });
    expect(cfg.model).toBe("claude-haiku-4-5");
  });

  it("effective model honors an explicit override", () => {
    const cfg = new AgentConfig({
      roleTemplate: { ...minimalRoleTemplate, defaultModel: "claude-haiku-4-5" },
      mission: { objective: "x" },
      model: "claude-opus-4-8",
    });
    expect(cfg.model).toBe("claude-opus-4-8");
  });

  it("preserves capability names", () => {
    const cfg = new AgentConfig({
      roleTemplate: minimalRoleTemplate,
      mission: { objective: "x" },
      capabilities: ["task-management", "documentation"],
    });
    expect(cfg.data.capabilities).toEqual(["task-management", "documentation"]);
  });

  it("toPrompt renders identity, model, capabilities, and mission", () => {
    const cfg = new AgentConfig({
      roleTemplate: minimalRoleTemplate,
      mission: { objective: "Keep the backlog healthy" },
      capabilities: ["task-management"],
    });
    const prompt = cfg.toPrompt();
    expect(prompt).toContain("Agent Config: Project Manager");
    expect(prompt).toContain("Model: (runner default)");
    expect(prompt).toContain("Capabilities: task-management");
    expect(prompt).toContain("a project manager");
    expect(prompt).toContain("Keep the backlog healthy");
  });

  it("toPrompt renders tone once, from the Tone slot, when both a persona tone and a Tone are set (#221)", () => {
    const cfg = new AgentConfig({
      roleTemplate: {
        ...minimalRoleTemplate,
        // persona.tone is a plain string ("concise"); the richer Tone slot supersedes it.
        tone: { name: "direct", prompt: "Be blunt and specific." },
      },
      mission: { objective: "x" },
    });
    const prompt = cfg.toPrompt();
    // The Tone slot wins — its prompt is rendered under a single `### Tone` heading…
    expect(prompt).toContain("Be blunt and specific.");
    expect(prompt.match(/### Tone/g)?.length ?? 0).toBe(1);
    // …and the persona's plain-string tone is no longer double-rendered alongside it.
    expect(prompt).not.toContain("concise");
  });

  it("requires a mission objective", () => {
    expect(() =>
      AgentConfigSchema.parse({ roleTemplate: minimalRoleTemplate, mission: {} }),
    ).toThrow();
  });
});

describe("CapabilityResolver port", () => {
  it("is implementable and surfaces unknown names by throwing", () => {
    class StubResolver implements CapabilityResolver {
      resolve(name: string, _ctx?: CapabilityResolutionContext): Capability {
        throw new Error(`unknown capability: ${name}`);
      }
    }
    const resolver: CapabilityResolver = new StubResolver();
    expect(() => resolver.resolve("task-management")).toThrow(
      "unknown capability: task-management",
    );
  });
});
