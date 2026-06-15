/**
 * mergeAgentConfig — applies an AgentConfigOverride onto a base AgentConfigData.
 * Top-level fields replace when present; roleTemplate is shallow-merged one level
 * deep; the base is never mutated.
 */

import { describe, expect, it } from "vitest";

import { AgentConfig, AgentConfigOverrideSchema } from "../../atoms/agent-config.js";
import { mergeAgentConfig } from "../build-agent-from-config.js";

const base = new AgentConfig({
  roleTemplate: {
    name: "R",
    persona: { identity: "the base identity", tone: "concise" },
    defaultModel: "base-default-model",
  },
  mission: { objective: "base objective" },
  model: "base-model",
  capabilities: ["alpha"],
}).data;

describe("mergeAgentConfig", () => {
  it("replaces top-level fields present in the override", () => {
    const merged = mergeAgentConfig(
      base,
      AgentConfigOverrideSchema.parse({ model: "new-model", capabilities: ["beta", "gamma"] }),
    );
    expect(merged.model).toBe("new-model");
    expect(merged.capabilities).toEqual(["beta", "gamma"]);
    expect(merged.mission).toEqual(base.mission); // untouched
  });

  it("shallow-merges roleTemplate one level deep — patch defaultModel, keep persona/name", () => {
    const merged = mergeAgentConfig(
      base,
      AgentConfigOverrideSchema.parse({ roleTemplate: { defaultModel: "rt-new" } }),
    );
    expect(merged.roleTemplate.defaultModel).toBe("rt-new");
    expect(merged.roleTemplate.persona).toEqual(base.roleTemplate.persona);
    expect(merged.roleTemplate.name).toBe("R");
  });

  it("replaces the mission when present", () => {
    const merged = mergeAgentConfig(
      base,
      AgentConfigOverrideSchema.parse({ mission: { objective: "new objective" } }),
    );
    expect(merged.mission.objective).toBe("new objective");
  });

  it("returns the base roleTemplate untouched when no roleTemplate override", () => {
    const merged = mergeAgentConfig(base, AgentConfigOverrideSchema.parse({ model: "x" }));
    expect(merged.roleTemplate).toEqual(base.roleTemplate);
  });

  it("rejects a typo'd nested roleTemplate key (strict), but accepts a valid partial patch", () => {
    expect(() =>
      AgentConfigOverrideSchema.parse({ roleTemplate: { defualtModel: "x" } }),
    ).toThrow();
    expect(() =>
      AgentConfigOverrideSchema.parse({ roleTemplate: { defaultModel: "x" } }),
    ).not.toThrow();
  });

  it("does not mutate the base", () => {
    const before = JSON.stringify(base);
    mergeAgentConfig(
      base,
      AgentConfigOverrideSchema.parse({ model: "x", roleTemplate: { name: "Y" } }),
    );
    expect(JSON.stringify(base)).toBe(before);
  });
});
