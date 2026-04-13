/**
 * Identity section: WHO the agent is.
 */

import type { Persona } from "../../atoms/persona.js";
import type { Responsibility } from "../../atoms/responsibility.js";
import type { Tone } from "../../atoms/tone.js";
import type { PromptSection } from "./base.js";

/**
 * Renders Persona + Responsibilities into the Identity prompt section.
 */
export class IdentitySection implements PromptSection {
  readonly name = "Identity";

  constructor(
    readonly persona?: Persona,
    readonly responsibilities: Responsibility[] = [],
    readonly tone?: Tone,
  ) {}

  render(): string {
    const parts: string[] = ["## Identity"];

    if (this.persona) {
      // Render identity statement
      parts.push("");
      parts.push(`You are ${this.persona.data.identity}.`);

      // Render tone as its own subsection
      // Use Tone object if provided, otherwise fall back to persona.tone string
      if (this.tone) {
        parts.push("");
        parts.push("### Tone");
        parts.push("");
        parts.push(this.tone.toPrompt());
      } else if (this.persona.data.tone) {
        parts.push("");
        parts.push("### Tone");
        parts.push("");
        parts.push(this.persona.data.tone);
      }

      // Render priorities if present
      if (this.persona.data.priorities.length > 0) {
        parts.push("");
        parts.push("### Priorities");
        parts.push("");
        for (const p of this.persona.data.priorities) {
          parts.push(`- ${p}`);
        }
      }

      // Render principles if present
      if (this.persona.data.principles.length > 0) {
        parts.push("");
        parts.push("### Principles");
        parts.push("");
        for (const p of this.persona.data.principles) {
          parts.push(`- ${p}`);
        }
      }
    }

    if (this.responsibilities.length > 0) {
      parts.push("");
      parts.push("### Responsibilities");
      parts.push("");
      for (const resp of this.responsibilities) {
        parts.push(`- ${resp.toPrompt()}`);
      }
    }

    return parts.join("\n");
  }
}
