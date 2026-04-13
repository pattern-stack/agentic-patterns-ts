/**
 * State section: WHERE the agent is in execution.
 */

import type { State } from "../../atoms/state.js";
import type { PromptSection } from "./base.js";

/**
 * Renders execution State into State section.
 *
 * Used in continuation prompts to inform the agent of current progress.
 */
export class StateSection implements PromptSection {
  readonly name = "State";

  constructor(readonly state?: State) {}

  render(): string {
    if (!this.state) {
      return "";
    }

    return this.state.toPrompt();
  }
}
