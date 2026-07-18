import type { RenderContext } from "../../atoms/base.js";

export type { RenderContext } from "../../atoms/base.js";

/**
 * Base protocol for prompt sections.
 *
 * Prompt sections are composable units that render into prompt fragments.
 * They can be assembled by a PromptRenderer to create full prompts.
 */
export interface PromptSection {
  readonly name: string;

  /**
   * Render this section as a prompt fragment.
   *
   * @param ctx - Optional render context (e.g. session scope), threaded from
   *   `Agent.renderInitialPrompt(ctx)` / `renderSections(ctx)`. Sections are
   *   ephemeral objects built fresh per render call, so this param is
   *   stateless; most sections ignore it entirely (implementing the nullary
   *   `render()` is a valid, assignable implementation of this interface).
   *   `ContextSection` is the one section that forwards it — to
   *   `Awareness.toPrompt(ctx)` only.
   * @returns Markdown-formatted prompt fragment, or "" if nothing to render.
   */
  render(ctx?: RenderContext): string;
}
