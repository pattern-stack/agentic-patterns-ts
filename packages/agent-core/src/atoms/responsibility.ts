/**
 * Responsibility datatype - WHAT the agent handles.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";

export const ResponsibilitySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  examples: z.array(z.string()).default([]),
});

export type ResponsibilityData = z.infer<typeof ResponsibilitySchema>;

/**
 * Defines WHAT types of tasks the agent handles.
 */
export class Responsibility extends AgenticModel<typeof ResponsibilitySchema.shape> {
  constructor(data: z.input<typeof ResponsibilitySchema>) {
    super(ResponsibilitySchema, data);
  }

  toPrompt(): string {
    const lines: string[] = [`**${this.data.name}**: ${this.data.description}`];
    if (this.data.examples.length > 0) {
      lines.push("  Examples:");
      for (const e of this.data.examples) {
        lines.push(`  - ${e}`);
      }
    }
    return lines.join("\n");
  }
}
