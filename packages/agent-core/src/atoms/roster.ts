/**
 * Roster datatype - deployment manifest combining agencies.
 */

import { z } from "zod";

import {
  AgencyBaseSchema,
  type AgentSpecSchema,
  TransportConfig,
  TransportConfigSchema,
} from "./agency.js";
import { AgenticModel } from "./base.js";

export const AgencyDeploymentSchema = z.object({
  agency: AgencyBaseSchema,
  isolated: z.boolean().default(false),
  resource_profile: z.enum(["light", "standard", "heavy"]).default("standard"),
});

export type AgencyDeploymentData = z.infer<typeof AgencyDeploymentSchema>;

/**
 * How to deploy one agency within a roster.
 */
export class AgencyDeployment extends AgenticModel<typeof AgencyDeploymentSchema.shape> {
  constructor(data: z.input<typeof AgencyDeploymentSchema>) {
    super(AgencyDeploymentSchema, data);
  }

  toPrompt(): string {
    let line = `- ${this.data.agency.name} (profile: ${this.data.resource_profile})`;
    if (this.data.isolated) {
      line += " [isolated]";
    }
    return line;
  }
}

export const RosterBaseSchema = z.object({
  name: z.string().min(1),
  agencies: z.array(AgencyDeploymentSchema).default([]),
  workspace_id: z.string().nullable().default(null),
  inter_agency_transport: TransportConfigSchema.default({ type: "nats" }),
});

export type RosterData = z.infer<typeof RosterBaseSchema>;

/**
 * Deployment manifest combining agencies.
 *
 * Validates:
 * - Agency names must be unique within the roster
 */
export class Roster extends AgenticModel<typeof RosterBaseSchema.shape> {
  constructor(data: z.input<typeof RosterBaseSchema>) {
    super(RosterBaseSchema, data);
    this._validate();
  }

  private _validate(): void {
    const names = this.data.agencies.map((d) => d.agency.name);
    const uniqueNames = new Set(names);
    if (names.length !== uniqueNames.size) {
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      throw new Error(
        `Agency names must be unique within roster, duplicates: ${[...new Set(dupes)].join(", ")}`,
      );
    }
  }

  /** All agents across all agencies. */
  get allAgents(): z.infer<typeof AgentSpecSchema>[] {
    const agents: z.infer<typeof AgentSpecSchema>[] = [];
    for (const deployment of this.data.agencies) {
      agents.push(...deployment.agency.agents);
    }
    return agents;
  }

  /** All coordinators across all agencies. */
  get coordinators(): z.infer<typeof AgentSpecSchema>[] {
    return this.data.agencies
      .map((d) => d.agency.agents.find((a) => a.is_coordinator))
      .filter((c): c is z.infer<typeof AgentSpecSchema> => c !== undefined);
  }

  toPrompt(): string {
    const lines: string[] = [`# Roster: ${this.data.name}`];
    if (this.data.workspace_id) {
      lines.push(`Workspace: ${this.data.workspace_id}`);
    }
    lines.push("");

    if (this.data.agencies.length > 0) {
      lines.push("## Agencies");
      for (const deployment of this.data.agencies) {
        lines.push(new AgencyDeployment(deployment).toPrompt());
      }
      lines.push("");
    }

    lines.push(new TransportConfig(this.data.inter_agency_transport).toPrompt());
    return lines.join("\n");
  }
}
