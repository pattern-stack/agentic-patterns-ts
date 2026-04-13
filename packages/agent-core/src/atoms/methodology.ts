/**
 * Methodology datatype - controls agent work approach.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";

export const MethodologySchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  checklist: z.array(z.string()).default([]),
});

export type MethodologyData = z.infer<typeof MethodologySchema>;

/**
 * Controls HOW the agent approaches work.
 */
export class Methodology extends AgenticModel<typeof MethodologySchema.shape> {
  constructor(data: z.input<typeof MethodologySchema>) {
    super(MethodologySchema, data);
  }

  toPrompt(): string {
    const parts: string[] = [this.data.prompt];

    if (this.data.checklist.length > 0) {
      parts.push("\nApproach:");
      for (const step of this.data.checklist) {
        parts.push(`  - ${step}`);
      }
    }

    return parts.join("\n");
  }
}
