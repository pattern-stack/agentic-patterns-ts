/**
 * Boundaries section: what the agent WON'T do.
 */

import type { Judgment } from "../../atoms/judgment.js";
import type { Recovery } from "../../atoms/recovery.js";
import type { PromptSection } from "./base.js";

/**
 * Renders Judgment constraints + escalation triggers into Boundaries section.
 *
 * Aggregation across judgments is inherently section-level, so this section
 * does not delegate to a single atom. When a Recovery is provided, it renders
 * as a `### Recovery` subsection after the escalation block.
 */
export class BoundariesSection implements PromptSection {
  readonly name = "Boundaries";

  constructor(
    readonly judgments: Judgment[] = [],
    readonly recovery?: Recovery,
  ) {}

  render(): string {
    const parts: string[] = ["## Boundaries"];

    const constraints: string[] = [];
    const escalations: string[] = [];

    for (const j of this.judgments) {
      if (j.data.constraints.length > 0) {
        constraints.push(...j.data.constraints);
      }
      if (j.data.escalationTriggers.length > 0) {
        escalations.push(...j.data.escalationTriggers);
      }
    }

    // Nothing to bound — omit the section entirely rather than render a bare heading.
    if (constraints.length === 0 && escalations.length === 0 && !this.recovery) {
      return "";
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

    if (this.recovery) {
      parts.push("");
      parts.push("### Recovery");
      parts.push("");
      parts.push(this.recovery.toPrompt());
    }

    return parts.join("\n");
  }
}
