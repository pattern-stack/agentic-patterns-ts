/**
 * Mission section: WHAT the agent is doing.
 */

import type { Mission } from "../../atoms/mission.js";
import type { PromptSection } from "./base.js";

/**
 * Renders Mission into Mission section.
 */
export class MissionSection implements PromptSection {
  readonly name = "Mission";

  constructor(readonly mission?: Mission) {}

  render(): string {
    if (!this.mission) {
      return "";
    }

    const parts: string[] = ["## Mission"];

    // Render objective
    parts.push("");
    parts.push("### Objective");
    parts.push("");
    parts.push(this.mission.data.objective);

    // Render success criteria if present
    if (this.mission.data.success_criteria.length > 0) {
      parts.push("");
      parts.push("### Success Criteria");
      parts.push("");
      for (const c of this.mission.data.success_criteria) {
        parts.push(`- ${c}`);
      }
    }

    // Render constraints if present
    if (this.mission.data.constraints.length > 0) {
      parts.push("");
      parts.push("### Constraints");
      parts.push("");
      for (const c of this.mission.data.constraints) {
        parts.push(`- ${c}`);
      }
    }

    // Render rationale if present
    if (this.mission.data.rationale) {
      parts.push("");
      parts.push("### Rationale");
      parts.push("");
      parts.push(this.mission.data.rationale);
    }

    return parts.join("\n");
  }
}
