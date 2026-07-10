/**
 * Role datatype and RoleBuilder - reusable agent template.
 *
 * Role = Persona + Judgments + Capabilities + Responsibilities
 *
 * A Role is a reusable template that defines who an agent is, how they decide,
 * what they can do, and what they're responsible for.
 */

import { z } from "zod";

import { AgenticModel } from "../atoms/base.js";
import { type Judgment, JudgmentSchema } from "../atoms/judgment.js";
import { type Methodology, MethodologySchema } from "../atoms/methodology.js";
import { type Persona, PersonaSchema } from "../atoms/persona.js";
import { type Recovery, RecoverySchema } from "../atoms/recovery.js";
import { type Responsibility, ResponsibilitySchema } from "../atoms/responsibility.js";
import { type Tone, ToneSchema } from "../atoms/tone.js";
import type { Capability } from "../molecules/capability.js";
import type { ToolSchema } from "../molecules/tool-schema.js";
import {
  BoundariesSection,
  CapabilitiesSection,
  IdentitySection,
  MethodologySection,
} from "../rendering/index.js";

/**
 * Zod schema for Role data.
 *
 * Note: capabilities uses z.array(z.unknown()) because Capability is a class,
 * not a Zod-parseable value. The Role constructor handles validation.
 */
export const RoleSchema = z.object({
  name: z.string().min(1),
  persona: PersonaSchema,
  judgments: z.array(JudgmentSchema).default([]),
  capabilities: z.array(z.unknown()).default([]),
  responsibilities: z.array(ResponsibilitySchema).default([]),
  tone: ToneSchema.nullable().default(null),
  methodology: MethodologySchema.nullable().default(null),
  recovery: RecoverySchema.nullable().default(null),
  // No framework default: an unset model is `undefined`. The model is chosen by
  // the agent (`.withModel()`), the role (`.withDefaultModel()`), or — when both
  // are unset — the RUNNER (createRunner tier/env/gateway). The framework does
  // not silently pin a vendor's model onto every agent.
  defaultModel: z.string().optional(),
});

export type RoleData = z.infer<typeof RoleSchema>;

/**
 * Reusable agent template.
 *
 * Role = Persona + Judgments + Capabilities + Responsibilities
 */
export class Role extends AgenticModel<typeof RoleSchema.shape> {
  /** The Persona instance (not just raw data). */
  readonly persona: Persona;
  /** The Judgment instances. */
  readonly judgments: readonly Judgment[];
  /** The Capability instances. */
  readonly capabilities: readonly Capability[];
  /** The Responsibility instances. */
  readonly responsibilities: readonly Responsibility[];
  /** Optional Tone instance — controls HOW the agent communicates. */
  readonly tone?: Tone;
  /** Optional Methodology instance — controls HOW the agent works. */
  readonly methodology?: Methodology;
  /** Optional Recovery instance — controls how the agent handles failure. */
  readonly recovery?: Recovery;

  constructor(data: {
    name: string;
    persona: Persona;
    judgments?: Judgment[];
    capabilities?: Capability[];
    responsibilities?: Responsibility[];
    tone?: Tone;
    methodology?: Methodology;
    recovery?: Recovery;
    defaultModel?: string;
  }) {
    // Pass raw data through Zod for name/defaultModel validation.
    // Capabilities are class instances so we pass them as unknown[].
    super(RoleSchema, {
      name: data.name,
      persona: data.persona.data,
      judgments: (data.judgments ?? []).map((j) => j.data),
      capabilities: data.capabilities ?? [],
      responsibilities: (data.responsibilities ?? []).map((r) => r.data),
      tone: data.tone?.data ?? null,
      methodology: data.methodology?.data ?? null,
      recovery: data.recovery?.data ?? null,
      defaultModel: data.defaultModel,
    });

    // Store the actual class instances for method access.
    this.persona = data.persona;
    this.judgments = Object.freeze([...(data.judgments ?? [])]);
    this.capabilities = Object.freeze([...(data.capabilities ?? [])]);
    this.responsibilities = Object.freeze([...(data.responsibilities ?? [])]);
    this.tone = data.tone;
    this.methodology = data.methodology;
    this.recovery = data.recovery;
  }

  /** Get the role name. */
  get name(): string {
    return this._data.name;
  }

  /** Get the default model, or `undefined` when the role pins none. */
  get defaultModel(): string | undefined {
    return this._data.defaultModel;
  }

  /** Aggregate tools from all capabilities. */
  getTools(): ToolSchema[] {
    const tools: ToolSchema[] = [];
    for (const cap of this.capabilities) {
      tools.push(...cap.getTools());
    }
    return tools;
  }

  /** Aggregate guidance from all capabilities. */
  getGuidance(): string {
    const sections: string[] = [];
    for (const cap of this.capabilities) {
      sections.push(`### ${cap.name}\n\n${cap.getGuidance()}`);
    }
    return sections.join("\n\n");
  }

  /**
   * Render the role as a standalone preview (no runtime context).
   *
   * Composes the same rendering sections the PromptRenderer uses —
   * Identity, Boundaries, Capabilities, Methodology — so role previews and
   * runner prompts share a single formatting system. Mission, background,
   * awareness, and state belong to the Agent and are absent here.
   */
  toPrompt(): string {
    const sections = [
      new IdentitySection(this.persona, [...this.responsibilities], this.tone),
      new BoundariesSection([...this.judgments], this.recovery),
      new CapabilitiesSection([...this.capabilities]),
      new MethodologySection([...this.judgments], this.methodology),
    ];
    const rendered = sections.map((s) => s.render()).filter((s) => s.length > 0);
    return [`# ${this.name}`, ...rendered].join("\n\n");
  }

  /**
   * Legacy alias for the section-composed prompt.
   *
   * @deprecated Use {@link toPrompt}. Retained through one release so the
   * runner contract migrates in its own slice; scheduled for removal.
   */
  renderSystemPrompt(): string {
    return this.toPrompt();
  }
}

/**
 * Fluent builder for constructing Roles.
 *
 * Example:
 *   const role = new RoleBuilder("Project Manager")
 *     .withPersona(pmPersona)
 *     .withJudgment(prioritization)
 *     .withCapability(taskMgmt)
 *     .withResponsibility(sprintPlanning)
 *     .build();
 */
export class RoleBuilder {
  private _name: string;
  private _persona: Persona | undefined;
  private _judgments: Judgment[] = [];
  private _capabilities: Capability[] = [];
  private _responsibilities: Responsibility[] = [];
  private _tone: Tone | undefined;
  private _methodology: Methodology | undefined;
  private _recovery: Recovery | undefined;
  private _defaultModel: string | undefined;

  constructor(name: string) {
    this._name = name;
  }

  withPersona(persona: Persona): this {
    this._persona = persona;
    return this;
  }

  withJudgment(judgment: Judgment): this {
    this._judgments.push(judgment);
    return this;
  }

  withJudgments(judgments: Judgment[]): this {
    this._judgments.push(...judgments);
    return this;
  }

  withCapability(capability: Capability): this {
    this._capabilities.push(capability);
    return this;
  }

  withCapabilities(capabilities: Capability[]): this {
    this._capabilities.push(...capabilities);
    return this;
  }

  withResponsibility(responsibility: Responsibility): this {
    this._responsibilities.push(responsibility);
    return this;
  }

  withResponsibilities(responsibilities: Responsibility[]): this {
    this._responsibilities.push(...responsibilities);
    return this;
  }

  withTone(tone: Tone): this {
    this._tone = tone;
    return this;
  }

  withMethodology(methodology: Methodology): this {
    this._methodology = methodology;
    return this;
  }

  withRecovery(recovery: Recovery): this {
    this._recovery = recovery;
    return this;
  }

  withDefaultModel(model: string): this {
    this._defaultModel = model;
    return this;
  }

  build(): Role {
    if (!this._persona) {
      throw new Error("Persona is required. Call withPersona() before build().");
    }

    return new Role({
      name: this._name,
      persona: this._persona,
      judgments: [...this._judgments],
      capabilities: [...this._capabilities],
      responsibilities: [...this._responsibilities],
      tone: this._tone,
      methodology: this._methodology,
      recovery: this._recovery,
      defaultModel: this._defaultModel,
    });
  }
}
