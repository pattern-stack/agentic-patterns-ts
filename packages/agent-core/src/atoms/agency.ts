/**
 * Agency datatype - a self-contained group of agents with a coordinator.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";
import { Judgment, JudgmentSchema } from "./judgment.js";
import { Persona, PersonaSchema } from "./persona.js";

export const TransportConfigSchema = z.object({
  type: z.string().default("in_process"),
  nats_url: z.string().default("nats://localhost:4222"),
});

export type TransportConfigData = z.infer<typeof TransportConfigSchema>;

/**
 * How agents communicate.
 */
export class TransportConfig extends AgenticModel<typeof TransportConfigSchema.shape> {
  constructor(data: z.input<typeof TransportConfigSchema> = {}) {
    super(TransportConfigSchema, data);
  }

  toPrompt(): string {
    if (this.data.type === "nats") {
      return `Transport: NATS (${this.data.nats_url})`;
    }
    return `Transport: ${this.data.type}`;
  }
}

export const AgentSpecSchema = z.object({
  role: z.string().min(1),
  agent_definition_id: z.string().nullable().default(null),
  persona: PersonaSchema.nullable().default(null),
  judgment: JudgmentSchema.nullable().default(null),
  model: z.string().default("anthropic/claude-sonnet-4-20250514"),
  max_turns: z.number().int().positive().default(10),
  capabilities: z.array(z.string()).default([]),
  is_coordinator: z.boolean().default(false),
});

export type AgentSpecData = z.infer<typeof AgentSpecSchema>;

/**
 * One agent within an agency.
 */
export class AgentSpec extends AgenticModel<typeof AgentSpecSchema.shape> {
  constructor(data: z.input<typeof AgentSpecSchema>) {
    super(AgentSpecSchema, data);
  }

  toPrompt(): string {
    const lines: string[] = [`### Agent: ${this.data.role}`];
    lines.push(`Model: ${this.data.model}`);
    lines.push(`Max turns: ${this.data.max_turns}`);
    if (this.data.is_coordinator) {
      lines.push("Role: **Coordinator**");
    }
    if (this.data.capabilities.length > 0) {
      lines.push(`Capabilities: ${this.data.capabilities.join(", ")}`);
    }
    if (this.data.persona) {
      lines.push("");
      lines.push(new Persona(this.data.persona).toPrompt());
    }
    if (this.data.judgment) {
      lines.push("");
      lines.push(new Judgment(this.data.judgment).toPrompt());
    }
    return lines.join("\n");
  }
}

// Base schema without refinements, used for AgenticModel constructor and roster composition
export const AgencyBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  agents: z.array(AgentSpecSchema).min(1),
  transport: TransportConfigSchema.default({}),
  env_vars: z.record(z.string()).default({}),
});

export type AgencyData = z.infer<typeof AgencyBaseSchema>;

/**
 * Self-contained group of agents with a coordinator.
 *
 * Validates:
 * - Exactly one agent must have is_coordinator=true
 * - Agent roles must be unique within the agency
 */
export class Agency extends AgenticModel<typeof AgencyBaseSchema.shape> {
  constructor(data: z.input<typeof AgencyBaseSchema>) {
    super(AgencyBaseSchema, data);
    // Post-construction validation (mirrors Pydantic model_validator)
    this._validate();
  }

  private _validate(): void {
    const coordinators = this.data.agents.filter((a) => a.is_coordinator);
    if (coordinators.length !== 1) {
      throw new Error(`Agency must have exactly one coordinator, found ${coordinators.length}`);
    }

    const roles = this.data.agents.map((a) => a.role);
    const uniqueRoles = new Set(roles);
    if (roles.length !== uniqueRoles.size) {
      const dupes = roles.filter((r, i) => roles.indexOf(r) !== i);
      throw new Error(
        `Agent roles must be unique within agency, duplicates: ${[...new Set(dupes)].join(", ")}`,
      );
    }
  }

  /** Find the agent with is_coordinator=true. */
  get coordinator(): AgentSpecData | undefined {
    return this.data.agents.find((a) => a.is_coordinator);
  }

  /** Agents where is_coordinator=false. */
  get internalAgents(): AgentSpecData[] {
    return this.data.agents.filter((a) => !a.is_coordinator);
  }

  toPrompt(): string {
    const lines: string[] = [`# Agency: ${this.data.name}`];
    if (this.data.description) {
      lines.push(this.data.description);
    }
    lines.push("");

    const coord = this.coordinator;
    if (coord) {
      lines.push("## Coordinator");
      lines.push(new AgentSpec(coord).toPrompt());
      lines.push("");
    }

    const internal = this.internalAgents;
    if (internal.length > 0) {
      lines.push("## Agents");
      for (const agent of internal) {
        lines.push(new AgentSpec(agent).toPrompt());
        lines.push("");
      }
    }

    lines.push(new TransportConfig(this.data.transport).toPrompt());
    return lines.join("\n");
  }
}
