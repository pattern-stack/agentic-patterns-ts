/**
 * Context section: WHAT the agent knows.
 */

import type { Awareness } from "../../atoms/awareness.js";
import type { Background } from "../../atoms/background.js";
import type { PromptSection, RenderContext } from "./base.js";

/**
 * Renders Background + Awareness into Context section.
 */
export class ContextSection implements PromptSection {
  readonly name = "Context";

  constructor(
    readonly background?: Background,
    readonly awareness?: Awareness,
  ) {}

  render(ctx?: RenderContext): string {
    const parts: string[] = ["## Context"];

    if (this.background) {
      const bgPrompt = this.background.toPrompt();
      if (bgPrompt) {
        parts.push(bgPrompt);
      }
    }

    if (this.awareness) {
      // ctx forwards ONLY here — Background.toPrompt() stays nullary.
      const awarenessPrompt = this.awareness.toPrompt(ctx);
      if (awarenessPrompt) {
        parts.push(awarenessPrompt);
      }
    }

    // If nothing to render, return empty
    if (parts.length === 1) {
      return "";
    }

    return parts.join("\n\n");
  }
}
