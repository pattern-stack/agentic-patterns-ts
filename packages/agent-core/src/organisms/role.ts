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
import { type Persona, PersonaSchema } from "../atoms/persona.js";
import { type Responsibility, ResponsibilitySchema } from "../atoms/responsibility.js";
import type { Capability } from "../molecules/capability.js";
import type { ToolSchema } from "../molecules/tool-schema.js";

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

  constructor(data: {
    name: string;
    persona: Persona;
    judgments?: Judgment[];
    capabilities?: Capability[];
    responsibilities?: Responsibility[];
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
      defaultModel: data.defaultModel,
    });

    // Store the actual class instances for method access.
    this.persona = data.persona;
    this.judgments = Object.freeze([...(data.judgments ?? [])]);
    this.capabilities = Object.freeze([...(data.capabilities ?? [])]);
    this.responsibilities = Object.freeze([...(data.responsibilities ?? [])]);
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
   * Generate base system prompt (without runtime context).
   *
   * Sections:
   * 1. Identity (Persona)
   * 2. Responsibilities
   * 3. Decision Guidelines (Judgments)
   * 4. Capability Guidance
   * 5. Available Tools (names + descriptions)
   */
  renderSystemPrompt(): string {
    const sections: string[] = [`# ${this.name}`, ""];

    // Identity
    sections.push("## Identity");
    sections.push("");
    sections.push(this.persona.toPrompt());
    sections.push("");

    // Responsibilities
    if (this.responsibilities.length > 0) {
      sections.push("## Responsibilities");
      sections.push("");
      for (const r of this.responsibilities) {
        sections.push(r.toPrompt());
      }
      sections.push("");
    }

    // Decision Guidelines
    if (this.judgments.length > 0) {
      sections.push("## Decision Guidelines");
      sections.push("");
      for (const j of this.judgments) {
        sections.push(j.toPrompt());
      }
      sections.push("");
    }

    // Capability Guidance
    if (this.capabilities.length > 0) {
      sections.push("## Guidance");
      sections.push("");
      sections.push(this.getGuidance());
      sections.push("");

      // Available Tools (names + descriptions only)
      sections.push("## Available Tools");
      sections.push("");
      for (const tool of this.getTools()) {
        sections.push(`- **${tool.name}**: ${tool.description}`);
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  toPrompt(): string {
    return this.renderSystemPrompt();
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
      defaultModel: this._defaultModel,
    });
  }
}
