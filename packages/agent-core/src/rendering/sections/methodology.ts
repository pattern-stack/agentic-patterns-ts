/**
 * Methodology section: HOW the agent works.
 */

import { Example } from "../../atoms/example.js";
import type { Judgment } from "../../atoms/judgment.js";
import type { PromptSection } from "./base.js";

/**
 * Renders work approach guidance from Judgments.
 *
 * Extracts heuristics and examples from judgments to form methodology guidance.
 */
export class MethodologySection implements PromptSection {
  readonly name = "Methodology";

  constructor(readonly judgments: Judgment[] = []) {}

  /**
   * Format domain name for display as a readable header.
   * Converts snake_case to Title Case.
   */
  private _formatDomainName(domain: string): string {
    return domain.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  render(): string {
    if (this.judgments.length === 0) {
      return "";
    }

    const parts: string[] = ["## Methodology"];

    for (const j of this.judgments) {
      if (j.data.heuristics.length > 0 || j.data.examples.length > 0) {
        const domainTitle = this._formatDomainName(j.data.domain);
        parts.push("");
        parts.push(`### ${domainTitle}`);

        if (j.data.heuristics.length > 0) {
          parts.push("");
          for (const h of j.data.heuristics) {
            parts.push(`- ${h}`);
          }
        }

        // Render examples for few-shot learning
        if (j.data.examples.length > 0) {
          parts.push("");
          parts.push("**Examples:**");
          for (const ex of j.data.examples) {
            const exInstance = new Example(ex);
            parts.push(`- **Scenario:** ${exInstance.data.scenario}`);
            parts.push(`  - \u2713 ${exInstance.data.good}`);
            if (exInstance.data.bad) {
              parts.push(`  - \u2717 ${exInstance.data.bad}`);
            }
            if (exInstance.data.reasoning) {
              parts.push(`  - *Why:* ${exInstance.data.reasoning}`);
            }
          }
        }
      }
    }

    // If no content found, return empty
    if (parts.length === 1) {
      return "";
    }

    return parts.join("\n");
  }
}
