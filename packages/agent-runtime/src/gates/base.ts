/**
 * Gate base interface and types.
 *
 * Gates intercept intent events and can block, allow, or modify them.
 * They execute in category order: SAFETY -> RATE_LIMIT -> APPROVAL -> AUDIT.
 */

import type { BaseEvent } from "../events/types.js";
import type { AskContext, GateEvaluation, GateRequirements, HarnessDecision } from "./decisions.js";

// ---------------------------------------------------------------------------
// Gate category — lower values run first
// ---------------------------------------------------------------------------

export const GateCategory = {
  SAFETY: 0,
  RATE_LIMIT: 1,
  APPROVAL: 2,
  AUDIT: 3,
} as const;

export type GateCategory = (typeof GateCategory)[keyof typeof GateCategory];

export const GATE_CATEGORY_NAMES: Readonly<Record<GateCategory, string>> = {
  [GateCategory.SAFETY]: "SAFETY",
  [GateCategory.RATE_LIMIT]: "RATE_LIMIT",
  [GateCategory.APPROVAL]: "APPROVAL",
  [GateCategory.AUDIT]: "AUDIT",
};

// ---------------------------------------------------------------------------
// Gate result
// ---------------------------------------------------------------------------

export type GateResult =
  | { action: "allow"; decision?: HarnessDecision }
  | { action: "block"; reason: string; decision?: HarnessDecision }
  | { action: "modify"; event: BaseEvent; decision?: HarnessDecision };

export const GateAllow: GateResult = { action: "allow" };

export function GateBlock(reason: string): GateResult {
  return { action: "block", reason };
}

export function GateModify(event: BaseEvent): GateResult {
  return { action: "modify", event };
}

// ---------------------------------------------------------------------------
// Gate interface
// ---------------------------------------------------------------------------

export interface Gate {
  /** Category of this gate for ordering. */
  readonly category: GateCategory;

  /** Gate name for rejection messages. */
  readonly name: string;

  /** Human-readable category name. */
  readonly categoryName: string;

  /**
   * Optional adapter requirements (§5.2, B-2). A gate that must synchronously
   * intercept certain operation classes, or rewrite tool input, declares them
   * here so the {@link CodingAgentRunner} base can fail the run loud at start
   * on a harness that can't honor them. Absent (every existing gate) → no
   * requirements. See {@link GateRequirements}.
   */
  readonly requires?: GateRequirements;

  /**
   * Check an intent event. `ctx` is the optional native ask context (F-2),
   * threaded by the bus when a harness adapter drives the ask; plain intents
   * pass none. Gates that don't need it simply omit the parameter.
   */
  check(event: BaseEvent, ctx?: AskContext): Promise<GateResult>;

  /** Get reason why event was blocked. */
  getBlockReason(event: BaseEvent): string;

  /**
   * Optional audit-phase hook (F-2). Audit-category gates implement this to
   * record the full {@link GateEvaluation} — decision kind, actor, native
   * request id, scope, resulting policy, `settledBy`. `AgentEventBus`
   * invokes it in the GUARANTEED audit phase after the check chain, so it
   * runs even when a gate blocked the intent (fixing the audit-skipped-on-block
   * bug). `check()` cannot consume a decision record, hence the separate hook.
   */
  recordDecision?(evaluation: GateEvaluation, ctx?: AskContext): void | Promise<void>;
}

/**
 * Abstract base class for gates.
 * Subclasses must implement check() and set category.
 */
export abstract class BaseGate implements Gate {
  abstract readonly category: GateCategory;

  get name(): string {
    return this.constructor.name;
  }

  get categoryName(): string {
    return GATE_CATEGORY_NAMES[this.category];
  }

  abstract check(event: BaseEvent): Promise<GateResult>;

  getBlockReason(_event: BaseEvent): string {
    return "Blocked by gate policy";
  }
}
