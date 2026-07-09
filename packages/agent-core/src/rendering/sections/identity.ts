/**
 * Identity section: WHO the agent is.
 */

import type { Persona } from "../../atoms/persona.js";
import type { Responsibility } from "../../atoms/responsibility.js";
import type { Tone } from "../../atoms/tone.js";
import type { PromptSection } from "./base.js";

/**
 * Renders Persona + Responsibilities into the Identity prompt section.
 *
 * The persona block itself is formatted by `Persona.toPrompt()` — the single
 * formatting source for the persona; this section adds the heading and the
 * responsibilities subsection.
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
      parts.push("");
      parts.push(this.persona.toPrompt({ tone: this.tone }));
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
