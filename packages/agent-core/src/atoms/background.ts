/**
 * Background datatype - what the agent KNOWS.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";

export const BackgroundSchema = z.object({
  team_context: z.record(z.unknown()).default({}),
  project_context: z.record(z.unknown()).default({}),
  conventions: z.record(z.unknown()).default({}),
  current_state: z.record(z.unknown()).default({}),
});

export type BackgroundData = z.infer<typeof BackgroundSchema>;

/**
 * Defines what the agent KNOWS - runtime context.
 */
export class Background extends AgenticModel<typeof BackgroundSchema.shape> {
  constructor(data: z.input<typeof BackgroundSchema>) {
    super(BackgroundSchema, data);
  }

  toPrompt(): string {
    const sections: string[] = [];
    if (Object.keys(this.data.team_context).length > 0) {
      sections.push("## Team Context");
      sections.push(this._formatDict(this.data.team_context));
    }
    if (Object.keys(this.data.project_context).length > 0) {
      sections.push("## Project Context");
      sections.push(this._formatDict(this.data.project_context));
    }
    if (Object.keys(this.data.conventions).length > 0) {
      sections.push("## Conventions");
      sections.push(this._formatDict(this.data.conventions));
    }
    if (Object.keys(this.data.current_state).length > 0) {
      sections.push("## Current State");
      sections.push(this._formatDict(this.data.current_state));
    }
    return sections.length > 0 ? sections.join("\n\n") : "";
  }

  private _formatDict(d: Record<string, unknown>, indent = 0): string {
    const lines: string[] = [];
    const prefix = "  ".repeat(indent);
    for (const [key, value] of Object.entries(d)) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        lines.push(`${prefix}- **${key}**:`);
        lines.push(this._formatDict(value as Record<string, unknown>, indent + 1));
      } else if (Array.isArray(value)) {
        lines.push(`${prefix}- **${key}**: ${value.map((v) => String(v)).join(", ")}`);
      } else {
        lines.push(`${prefix}- **${key}**: ${String(value)}`);
      }
    }
    return lines.join("\n");
  }
}
