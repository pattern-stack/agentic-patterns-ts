/**
 * buildAgentFromConfig — hydrate a runnable Agent from a declarative AgentConfig.
 *
 * The pure-data counterpart to hand-building via RoleBuilder/AgentBuilder: both
 * produce the same Agent. Faithful port of the Python reference AgentAssembler —
 * role template (persona + judgments + responsibilities) → Role, then
 * mission / background / awareness / model → Agent.
 *
 * Capability *names* in the config are resolved to live Capabilities via the supplied
 * CapabilityResolver — the seam where the hosting application injects auth-wired
 * toolboxes. The library never constructs toolboxes or touches credentials.
 *
 * Model precedence (highest first): `options.modelOverride` → `config.model` →
 * `roleTemplate.defaultModel`.
 */

import type { z } from "zod";

import {
  AgentConfig,
  type AgentConfigData,
  type AgentConfigOverride,
  type AgentConfigSchema,
} from "../atoms/agent-config.js";
import { Awareness } from "../atoms/awareness.js";
import { Background } from "../atoms/background.js";
import { Judgment } from "../atoms/judgment.js";
import { Methodology } from "../atoms/methodology.js";
import { Mission } from "../atoms/mission.js";
import { Persona } from "../atoms/persona.js";
import { Recovery } from "../atoms/recovery.js";
import { Responsibility } from "../atoms/responsibility.js";
import { Tone } from "../atoms/tone.js";
import type { Capability } from "../molecules/capability.js";
import { type Agent, AgentBuilder } from "./agent.js";
import type { CapabilityResolutionContext, CapabilityResolver } from "./capability-resolver.js";
import { RoleBuilder } from "./role.js";

/** Plain-object form of an AgentConfig accepted by the factory. */
export type AgentConfigInput = z.input<typeof AgentConfigSchema>;

/** Options for {@link buildAgentFromConfig}. */
export interface BuildAgentOptions {
  /** Resolves capability names to live Capabilities. Required if the config declares any. */
  resolver?: CapabilityResolver;
  /** Opaque, app-defined resolution context (e.g. tenant / auth scope). */
  ctx?: CapabilityResolutionContext;
  /** Runtime model override — takes precedence over `config.model` and the role default. */
  modelOverride?: string;
}

/**
 * Build a runnable {@link Agent} from a declarative {@link AgentConfig}.
 *
 * @param config - an AgentConfig instance or its plain-object form (validated on the way in)
 * @param options - capability resolver + context + optional model override
 * @throws if the config declares capabilities but no resolver is supplied
 * @throws (from the resolver) if a declared capability name is unknown
 */
export function buildAgentFromConfig(
  config: AgentConfig | AgentConfigInput,
  options: BuildAgentOptions = {},
): Agent {
  const cfg = config instanceof AgentConfig ? config : new AgentConfig(config);
  const { roleTemplate: rt } = cfg.data;

  // Resolve capability names → live Capabilities via the app-provided resolver.
  const capabilities: Capability[] = cfg.data.capabilities.map((name) => {
    if (!options.resolver) {
      throw new Error(
        `AgentConfig "${rt.name}" declares capability "${name}" but no CapabilityResolver was provided to buildAgentFromConfig.`,
      );
    }
    return options.resolver.resolve(name, options.ctx);
  });

  const roleBuilder = new RoleBuilder(rt.name)
    .withPersona(new Persona(rt.persona))
    .withJudgments(rt.judgments.map((j) => new Judgment(j)))
    .withResponsibilities(rt.responsibilities.map((r) => new Responsibility(r)))
    .withCapabilities(capabilities)
    .withDefaultModel(rt.defaultModel);

  if (rt.tone) {
    roleBuilder.withTone(new Tone(rt.tone));
  }
  if (rt.methodology) {
    roleBuilder.withMethodology(new Methodology(rt.methodology));
  }
  if (rt.recovery) {
    roleBuilder.withRecovery(new Recovery(rt.recovery));
  }

  const role = roleBuilder.build();

  const builder = new AgentBuilder(role)
    .withBackground(new Background(cfg.data.background))
    .withAwareness(new Awareness(cfg.data.awareness))
    .withMission(new Mission(cfg.data.mission));

  // Only set an explicit model when one exists; otherwise Agent falls back to the
  // role's defaultModel.
  const explicitModel = options.modelOverride ?? cfg.data.model ?? undefined;
  if (explicitModel) {
    builder.withModel(explicitModel);
  }

  return builder.build();
}

/**
 * Apply an {@link AgentConfigOverride} onto a base {@link AgentConfigData},
 * returning new merged data (the base is not mutated).
 *
 * Semantics: top-level fields (mission / background / awareness / model /
 * capabilities) replace the base when present; `roleTemplate` is shallow-merged
 * one level deep, so a patch can tweak just its judgments without restating
 * persona / responsibilities. Used by `buildWorkflowFromConfig` to override an
 * already-defined agent's config per workflow step.
 */
export function mergeAgentConfig(
  base: AgentConfigData,
  override: AgentConfigOverride,
): AgentConfigData {
  return {
    roleTemplate: override.roleTemplate
      ? { ...base.roleTemplate, ...override.roleTemplate }
      : base.roleTemplate,
    mission: override.mission ?? base.mission,
    background: override.background ?? base.background,
    awareness: override.awareness ?? base.awareness,
    model: override.model !== undefined ? override.model : base.model,
    capabilities: override.capabilities ?? base.capabilities,
  };
}
