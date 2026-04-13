/**
 * Prompt renderer that composes sections into full prompts.
 */

import type { State } from "../atoms/state.js";
import type {
  BoundariesSection,
  CapabilitiesSection,
  ContextSection,
  IdentitySection,
  MethodologySection,
  MissionSection,
} from "./sections/index.js";
import { StateSection } from "./sections/state.js";

/**
 * Composes prompt sections into full system prompts.
 *
 * Handles both initial and continuation prompt variants.
 * Initial prompts include all sections. Continuation prompts
 * only include state, mission, and methodology (identity and
 * boundaries are in conversation history).
 */
export class PromptRenderer {
  constructor(
    readonly identity: IdentitySection,
    readonly boundaries: BoundariesSection,
    readonly capabilities: CapabilitiesSection,
    readonly context: ContextSection,
    readonly mission: MissionSection,
    readonly methodology: MethodologySection,
  ) {}

  /**
   * Render full prompt for turn 1.
   *
   * Includes all sections - agent has no history yet.
   */
  renderInitial(): string {
    const sections = [
      this.identity.render(),
      this.boundaries.render(),
      this.capabilities.render(),
      this.context.render(),
      this.mission.render(),
      this.methodology.render(),
    ];
    return sections.filter(Boolean).join("\n\n");
  }

  /**
   * Render delta prompt for turn N.
   *
   * Only includes state, mission, and methodology.
   * Identity/boundaries/capabilities are in history.
   */
  renderContinuation(state: State): string {
    const stateSection = new StateSection(state);

    const sections = [stateSection.render(), this.mission.render(), this.methodology.render()];
    return sections.filter(Boolean).join("\n\n");
  }
}
