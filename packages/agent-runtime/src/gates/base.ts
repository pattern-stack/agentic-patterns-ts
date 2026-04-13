/**
 * Gate base interface and types.
 *
 * Gates intercept intent events and can block, allow, or modify them.
 * They execute in category order: SAFETY -> RATE_LIMIT -> APPROVAL -> AUDIT.
 */

import type { BaseEvent } from "../events/types.js";

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
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "modify"; event: BaseEvent };

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

  /** Check an intent event. */
  check(event: BaseEvent): Promise<GateResult>;

  /** Get reason why event was blocked. */
  getBlockReason(event: BaseEvent): string;
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
