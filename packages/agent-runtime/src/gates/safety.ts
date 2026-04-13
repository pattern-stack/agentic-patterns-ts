/**
 * Safety gate for blocking dangerous operations.
 *
 * Category: SAFETY (runs first in chain)
 */

import type { BaseEvent } from "../events/types.js";
import { BaseGate, GateAllow, GateBlock, GateCategory, type GateResult } from "./base.js";

export class SafetyGate extends BaseGate {
  readonly category = GateCategory.SAFETY;

  private _blockedTools: Set<string>;
  private _blockedPatterns: RegExp[];
  private _blockMessage: string;

  constructor(options?: {
    blockedTools?: Set<string>;
    blockedPatterns?: string[];
    blockMessage?: string;
  }) {
    super();
    this._blockedTools = options?.blockedTools ?? new Set();
    this._blockedPatterns = (options?.blockedPatterns ?? []).map((p) => new RegExp(p));
    this._blockMessage = options?.blockMessage ?? "Tool is not allowed by safety policy";
  }

  async check(event: BaseEvent): Promise<GateResult> {
    if (event.type !== "agent.tool.intent") {
      return GateAllow;
    }

    const toolName = (event as { toolName?: string }).toolName ?? "";

    if (this._blockedTools.has(toolName)) {
      return GateBlock(this.getBlockReason(event));
    }

    for (const pattern of this._blockedPatterns) {
      if (pattern.test(toolName)) {
        return GateBlock(this.getBlockReason(event));
      }
    }

    return GateAllow;
  }

  override getBlockReason(event: BaseEvent): string {
    const toolName = (event as { toolName?: string }).toolName ?? "unknown";
    return `${this._blockMessage}: '${toolName}'`;
  }
}
