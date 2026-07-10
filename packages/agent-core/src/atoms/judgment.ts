/**
 * Judgment datatype - HOW the agent decides.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";
import { Example, type ExampleData, ExampleSchema } from "./example.js";

export const JudgmentSchema = z.object({
  domain: z.string(),
  heuristics: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  escalationTriggers: z.array(z.string()).default([]),
  examples: z.array(ExampleSchema).default([]),
});

export type JudgmentData = z.infer<typeof JudgmentSchema>;

/**
 * Defines HOW the agent decides within a domain.
 */
export class Judgment extends AgenticModel<typeof JudgmentSchema.shape> {
  constructor(data: z.input<typeof JudgmentSchema>) {
    super(JudgmentSchema, data);
  }

  toPrompt(): string {
    const lines: string[] = [`## Judgment: ${this.data.domain}`];
    if (this.data.heuristics.length > 0) {
      lines.push("\n**Heuristics:**");
      for (const h of this.data.heuristics) {
        lines.push(`- ${h}`);
      }
    }
    if (this.data.constraints.length > 0) {
      lines.push("\n**Constraints (never violate):**");
      for (const c of this.data.constraints) {
        lines.push(`- ${c}`);
      }
    }
    if (this.data.escalationTriggers.length > 0) {
      lines.push("\n**Escalate to human when:**");
      for (const t of this.data.escalationTriggers) {
        lines.push(`- ${t}`);
      }
    }
    if (this.data.examples.length > 0) {
      lines.push("\n**Examples:**");
      for (const ex of this.data.examples) {
        const exInstance = new Example(ex);
        lines.push(exInstance.toPrompt());
      }
    }
    return lines.join("\n");
  }

  /** Add heuristics to this judgment. */
  withHeuristics(heuristics: string[]): Judgment {
    return this.replace({
      heuristics: [...this.data.heuristics, ...heuristics],
    });
  }

  /** Add constraints to this judgment. */
  withConstraints(constraints: string[]): Judgment {
    return this.replace({
      constraints: [...this.data.constraints, ...constraints],
    });
  }

  /** Add escalation triggers to this judgment. */
  withEscalation(triggers: string[]): Judgment {
    return this.replace({
      escalationTriggers: [...this.data.escalationTriggers, ...triggers],
    });
  }

  /** Add few-shot examples to this judgment. */
  withExamples(examples: ExampleData[]): Judgment {
    return this.replace({
      examples: [...this.data.examples, ...examples],
    });
  }
}
