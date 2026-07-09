/**
 * Methodology section: HOW the agent works.
 */

import { Example } from "../../atoms/example.js";
import type { Judgment } from "../../atoms/judgment.js";
import type { Methodology } from "../../atoms/methodology.js";
import type { PromptSection } from "./base.js";

/**
 * Renders work approach guidance from a Methodology and Judgments.
 *
 * When a Methodology is provided, its prompt + checklist render as the first
 * block under the heading. Heuristics and examples are then extracted from
 * judgments to form domain-specific guidance.
 */
export class MethodologySection implements PromptSection {
  readonly name = "Methodology";

  constructor(
    readonly judgments: Judgment[] = [],
    readonly methodology?: Methodology,
  ) {}

  /**
   * Format domain name for display as a readable header.
   * Converts snake_case to Title Case.
   */
  private _formatDomainName(domain: string): string {
    return domain.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  render(): string {
    const parts: string[] = ["## Methodology"];

    if (this.methodology) {
      parts.push("");
      parts.push(this.methodology.toPrompt());
    }

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
            parts.push(new Example(ex).toPrompt());
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
