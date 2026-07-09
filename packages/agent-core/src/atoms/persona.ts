/**
 * Persona datatype - WHO the agent is.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";
import type { Tone } from "./tone.js";

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

  /**
   * Render the persona block.
   *
   * When `opts.tone` is provided, its `toPrompt()` is rendered under `### Tone`
   * instead of the persona's plain-string tone. This is the single formatting
   * source for the persona block — IdentitySection delegates here.
   */
  toPrompt(opts?: { tone?: Tone }): string {
    const lines: string[] = [`You are ${this.data.identity}.`];

    if (opts?.tone) {
      lines.push("", "### Tone", "", opts.tone.toPrompt());
    } else if (this.data.tone) {
      lines.push("", "### Tone", "", this.data.tone);
    }

    if (this.data.priorities.length > 0) {
      lines.push("", "### Priorities", "");
      for (const p of this.data.priorities) {
        lines.push(`- ${p}`);
      }
    }

    if (this.data.principles.length > 0) {
      lines.push("", "### Principles", "");
      for (const p of this.data.principles) {
        lines.push(`- ${p}`);
      }
    }

    return lines.join("\n");
  }

  /** Add priorities to this persona. */
  withPriorities(priorities: string[]): Persona {
    return this.replace({
      priorities: [...this.data.priorities, ...priorities],
    });
  }

  /** Add principles to this persona. */
  withPrinciples(principles: string[]): Persona {
    return this.replace({
      principles: [...this.data.principles, ...principles],
    });
  }
}
