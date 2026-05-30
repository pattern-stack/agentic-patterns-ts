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
    expect(parsed.defaultModel).toBe("claude-sonnet-4-20250514");
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
    expect(cfg.data.background.team_context).toEqual({});
    expect(cfg.data.awareness.domains).toEqual([]);
  });

  it("effective model falls back to the role template default", () => {
    const cfg = new AgentConfig({
      roleTemplate: minimalRoleTemplate,
      mission: { objective: "x" },
    });
    expect(cfg.model).toBe("claude-sonnet-4-20250514");
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
    expect(prompt).toContain("Model: claude-sonnet-4-20250514");
    expect(prompt).toContain("Capabilities: task-management");
    expect(prompt).toContain("a project manager");
    expect(prompt).toContain("Keep the backlog healthy");
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
