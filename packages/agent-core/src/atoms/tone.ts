/**
 * Tone datatype - controls agent communication style.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";

export const ToneSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  examples: z.array(z.tuple([z.string(), z.string()])).default([]),
  anti_patterns: z.array(z.string()).default([]),
});

export type ToneData = z.infer<typeof ToneSchema>;

/**
 * Controls HOW the agent communicates.
 */
export class Tone extends AgenticModel<typeof ToneSchema.shape> {
  constructor(data: z.input<typeof ToneSchema>) {
    super(ToneSchema, data);
  }

  toPrompt(): string {
    const parts: string[] = [this.data.prompt];

    if (this.data.examples.length > 0) {
      parts.push("\nExamples:");
      for (const [label, example] of this.data.examples) {
        parts.push(`  ${label}: ${example}`);
      }
    }

    if (this.data.anti_patterns.length > 0) {
      parts.push("\nAvoid phrases like:");
      for (const pattern of this.data.anti_patterns) {
        parts.push(`  - "${pattern}"`);
      }
    }

    return parts.join("\n");
  }
}
