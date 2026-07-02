/**
 * Mission section: WHAT the agent is doing.
 */

import type { Mission } from "../../atoms/mission.js";
import type { PromptSection } from "./base.js";

/**
 * Renders Mission into Mission section.
 *
 * Delegates to `Mission.toPrompt()` — the single formatting source for the
 * mission block, including the output-schema injection when `outputSchema`
 * is set with `strictOutput` false.
 */
export class MissionSection implements PromptSection {
  readonly name = "Mission";

  constructor(readonly mission?: Mission) {}

  render(): string {
    if (!this.mission) {
      return "";
    }

    return this.mission.toPrompt();
  }
}
