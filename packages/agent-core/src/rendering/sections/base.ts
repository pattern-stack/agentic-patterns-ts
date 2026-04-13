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
   * @returns Markdown-formatted prompt fragment, or "" if nothing to render.
   */
  render(): string;
}
