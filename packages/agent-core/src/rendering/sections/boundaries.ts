/**
 * Boundaries section: what the agent WON'T do.
 */

import type { Judgment } from "../../atoms/judgment.js";
import type { PromptSection } from "./base.js";

/**
 * Renders Judgment constraints + escalation triggers into Boundaries section.
 */
export class BoundariesSection implements PromptSection {
  readonly name = "Boundaries";

  constructor(readonly judgments: Judgment[] = []) {}

  render(): string {
    const parts: string[] = ["## Boundaries"];

    if (this.judgments.length === 0) {
      return parts.join("\n");
    }

    const constraints: string[] = [];
    const escalations: string[] = [];

    for (const j of this.judgments) {
      if (j.data.constraints.length > 0) {
        constraints.push(...j.data.constraints);
      }
      if (j.data.escalation_triggers.length > 0) {
        escalations.push(...j.data.escalation_triggers);
      }
    }

    if (constraints.length > 0) {
      parts.push("");
      parts.push("### Constraints");
      parts.push("");
      for (const c of constraints) {
        parts.push(`- ${c}`);
      }
    }

    if (escalations.length > 0) {
      parts.push("");
      parts.push("### Escalate When");
      parts.push("");
      for (const e of escalations) {
        parts.push(`- ${e}`);
      }
    }

    return parts.join("\n");
  }
}
