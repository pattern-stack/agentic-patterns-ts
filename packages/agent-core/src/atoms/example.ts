/**
 * Example datatype - reusable few-shot learning examples.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";

export const ExampleSchema = z.object({
  scenario: z.string().min(1),
  good: z.string().min(1),
  bad: z.string().default(""),
  reasoning: z.string().default(""),
});

export type ExampleData = z.infer<typeof ExampleSchema>;

/**
 * A reusable example for few-shot learning.
 */
export class Example extends AgenticModel<typeof ExampleSchema.shape> {
  constructor(data: z.input<typeof ExampleSchema>) {
    super(ExampleSchema, data);
  }

  toPrompt(): string {
    const lines: string[] = [`**Scenario:** ${this.data.scenario}`];
    lines.push(`  \u2713 Good: ${this.data.good}`);
    if (this.data.bad) {
      lines.push(`  \u2717 Bad: ${this.data.bad}`);
    }
    if (this.data.reasoning) {
      lines.push(`  Why: ${this.data.reasoning}`);
    }
    return lines.join("\n");
  }
}
