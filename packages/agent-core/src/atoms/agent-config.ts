/**
 * AgentConfig — declarative, serializable agent definition.
 *
 * The data shape that `buildAgentFromConfig` (organisms) hydrates into a runnable
 * Agent, and that a persistence layer / Agent Composer authors. It is the pure-data
 * counterpart to the code-defined `RoleBuilder`/`AgentBuilder` path — both produce
 * the same Agent.
 *
 * Mirrors the three-layer split proven in the Python reference (RoleTemplate +
 * AgentDefinition):
 *   - `roleTemplate` — the reusable role (persona + judgments + responsibilities).
 *   - top-level mission / background / awareness / model — the per-agent definition.
 *   - `capabilities` — capability *names*, NOT embedded Capabilities: a live
 *     Capability wraps a Toolbox holding vendor clients and secrets, which are the
 *     hosting app's concern. Names are resolved to live Capabilities at build time
 *     via a CapabilityResolver (see `organisms/capability-resolver`).
 */

import { z } from "zod";

import { AwarenessSchema } from "./awareness.js";
import { BackgroundSchema } from "./background.js";
import { AgenticModel } from "./base.js";
import { Judgment, JudgmentSchema } from "./judgment.js";
import { Methodology, MethodologySchema } from "./methodology.js";
import { Mission, MissionSchema } from "./mission.js";
import { Persona, PersonaSchema } from "./persona.js";
import { Recovery, RecoverySchema } from "./recovery.js";
import { Responsibility, ResponsibilitySchema } from "./responsibility.js";
import { Tone, ToneSchema } from "./tone.js";

/**
 * The reusable, capability-free part of a role.
 *
 * Maps to a persisted `role_template` row app-side. Capabilities are deliberately
 * absent — they are runtime-injected by name, never stored on the role.
 */
export const RoleTemplateConfigSchema = z.object({
  name: z.string().min(1),
  persona: PersonaSchema,
  judgments: z.array(JudgmentSchema).default([]),
  responsibilities: z.array(ResponsibilitySchema).default([]),
  tone: ToneSchema.nullable().default(null),
  methodology: MethodologySchema.nullable().default(null),
  recovery: RecoverySchema.nullable().default(null),
  // No framework default — unset means "the runner decides" (see role.ts).
  defaultModel: z.string().optional(),
  source: z.enum(["library", "custom"]).default("custom"),
  archetype: z.string().nullable().default(null),
});

export type RoleTemplateConfigData = z.infer<typeof RoleTemplateConfigSchema>;

/**
 * A complete, serializable agent definition.
 *
 * Maps to a persisted `agent_definition` row (+ its referenced role template)
 * app-side. `model` overrides `roleTemplate.defaultModel` when set.
 */
export const AgentConfigSchema = z.object({
  roleTemplate: RoleTemplateConfigSchema,
  mission: MissionSchema,
  background: BackgroundSchema.default({}),
  awareness: AwarenessSchema.default({}),
  /** Per-agent model override. Falls back to `roleTemplate.defaultModel` when null. */
  model: z.string().nullable().default(null),
  /** Capability names, resolved to live Capabilities at build time. */
  capabilities: z.array(z.string()).default([]),
});

export type AgentConfigData = z.infer<typeof AgentConfigSchema>;

/**
 * Frozen, validated agent definition.
 *
 * Sibling to `AgentSpec` (single agent within an Agency); `AgentConfig` is the
 * standalone, persistence-oriented form consumed by `buildAgentFromConfig`.
 */
export class AgentConfig extends AgenticModel<typeof AgentConfigSchema.shape> {
  constructor(data: z.input<typeof AgentConfigSchema>) {
    super(AgentConfigSchema, data);
  }

  /** Effective model: explicit override, else the role template's default,
   *  else `undefined` (the runner supplies it). */
  get model(): string | undefined {
    return this.data.model ?? this.data.roleTemplate.defaultModel;
  }

  toPrompt(): string {
    const rt = this.data.roleTemplate;
    const lines: string[] = [
      `### Agent Config: ${rt.name}`,
      `Model: ${this.model ?? "(runner default)"}`,
    ];
    if (this.data.capabilities.length > 0) {
      lines.push(`Capabilities: ${this.data.capabilities.join(", ")}`);
    }
    lines.push("", new Persona(rt.persona).toPrompt());
    if (rt.tone) {
      lines.push("", new Tone(rt.tone).toPrompt());
    }
    if (rt.methodology) {
      lines.push("", new Methodology(rt.methodology).toPrompt());
    }
    if (rt.recovery) {
      lines.push("", new Recovery(rt.recovery).toPrompt());
    }
    for (const j of rt.judgments) {
      lines.push("", new Judgment(j).toPrompt());
    }
    for (const r of rt.responsibilities) {
      lines.push("", new Responsibility(r).toPrompt());
    }
    lines.push("", new Mission(this.data.mission).toPrompt());
    return lines.join("\n");
  }
}

/**
 * A partial patch over an {@link AgentConfig} — used to override an
 * already-defined agent's config for one workflow's use (e.g. a different model,
 * judgments, or mission per step). `roleTemplate` is itself partial so a patch
 * can tweak just its judgments without restating persona/responsibilities.
 *
 * Applied by `mergeAgentConfig` (organisms): top-level fields replace the base
 * when present; `roleTemplate` is shallow-merged one level deep.
 */
export const AgentConfigOverrideSchema = z
  .object({
    roleTemplate: RoleTemplateConfigSchema.partial().strict().optional(),
    mission: MissionSchema.optional(),
    background: BackgroundSchema.optional(),
    awareness: AwarenessSchema.optional(),
    model: z.string().nullable().optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .strict();

export type AgentConfigOverride = z.infer<typeof AgentConfigOverrideSchema>;
