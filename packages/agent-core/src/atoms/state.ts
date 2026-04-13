/**
 * State datatype - loop-managed execution state.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";

/** Typed phases an agent moves through during execution. */
export const Phase = {
  PLANNING: "planning",
  EXECUTING: "executing",
  BLOCKED: "blocked",
  FINISHING: "finishing",
} as const;

export type Phase = (typeof Phase)[keyof typeof Phase];

export const PhaseEnum = z.enum([Phase.PLANNING, Phase.EXECUTING, Phase.BLOCKED, Phase.FINISHING]);

export const StateSchema = z.object({
  iteration: z.number().int().min(0).default(0),
  phase: PhaseEnum.default(Phase.PLANNING),
  accumulated_context: z.record(z.unknown()).default({}),
  last_action: z.string().nullable().default(null),
});

export type StateData = z.infer<typeof StateSchema>;

/**
 * Execution state managed by loops, not agents.
 *
 * Note: Unlike most atoms, State is not frozen in Python.
 * In TypeScript we still create new instances via with*() methods.
 */
export class State extends AgenticModel<typeof StateSchema.shape> {
  constructor(data: z.input<typeof StateSchema>) {
    super(StateSchema, data);
  }

  toPrompt(): string {
    const lines: string[] = [
      "## Current State",
      `Iteration: ${this.data.iteration}`,
      `Phase: ${this.data.phase}`,
    ];
    if (this.data.last_action) {
      lines.push(`Last action: ${this.data.last_action}`);
    }
    return lines.join("\n");
  }

  /** Return new State with updated phase. */
  withPhase(phase: Phase): State {
    return new State({
      iteration: this.data.iteration,
      phase,
      accumulated_context: { ...this.data.accumulated_context },
      last_action: this.data.last_action,
    });
  }

  /** Return new State with updated iteration. */
  withIteration(iteration: number): State {
    return new State({
      iteration,
      phase: this.data.phase,
      accumulated_context: { ...this.data.accumulated_context },
      last_action: this.data.last_action,
    });
  }

  /** Return new State with updated last action. */
  withAction(action: string): State {
    return new State({
      iteration: this.data.iteration,
      phase: this.data.phase,
      accumulated_context: { ...this.data.accumulated_context },
      last_action: action,
    });
  }
}
