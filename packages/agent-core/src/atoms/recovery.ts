/**
 * Recovery datatype - controls agent error handling.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";

export const RecoverySchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  maxAttempts: z.number().int().min(1).default(3),
});

export type RecoveryData = z.infer<typeof RecoverySchema>;

/**
 * Controls HOW the agent handles failures.
 */
export class Recovery extends AgenticModel<typeof RecoverySchema.shape> {
  constructor(data: z.input<typeof RecoverySchema>) {
    super(RecoverySchema, data);
  }

  toPrompt(): string {
    return `${this.data.prompt}\nMax attempts before escalating: ${this.data.maxAttempts}`;
  }
}
