/**
 * Persona datatype - WHO the agent is.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";

export const PersonaSchema = z.object({
  identity: z.string().min(1),
  tone: z.string(),
  priorities: z.array(z.string()).default([]),
  principles: z.array(z.string()).default([]),
});

export type PersonaData = z.infer<typeof PersonaSchema>;

/**
 * Defines WHO the agent is.
 */
export class Persona extends AgenticModel<typeof PersonaSchema.shape> {
  constructor(data: z.input<typeof PersonaSchema>) {
    super(PersonaSchema, data);
  }

  toPrompt(): string {
    const lines: string[] = [
      `You are ${this.data.identity}.`,
      `Communication style: ${this.data.tone}`,
    ];
    if (this.data.priorities.length > 0) {
      lines.push("\nPriorities:");
      for (const p of this.data.priorities) {
        lines.push(`- ${p}`);
      }
    }
    if (this.data.principles.length > 0) {
      lines.push("\nPrinciples:");
      for (const p of this.data.principles) {
        lines.push(`- ${p}`);
      }
    }
    return lines.join("\n");
  }
}
