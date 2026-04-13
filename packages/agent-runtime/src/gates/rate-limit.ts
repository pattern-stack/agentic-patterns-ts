/**
 * Rate limit gate using token bucket algorithm.
 *
 * Category: RATE_LIMIT (runs second)
 */

import type { BaseEvent } from "../events/types.js";
import { BaseGate, GateAllow, GateBlock, GateCategory, type GateResult } from "./base.js";

export class RateLimitGate extends BaseGate {
  readonly category = GateCategory.RATE_LIMIT;

  private _rate: number;
  private _burst: number;
  private _tokens: number;
  private _lastUpdate: number;

  constructor(options?: {
    callsPerMinute?: number;
    burstSize?: number;
  }) {
    super();
    const callsPerMinute = options?.callsPerMinute ?? 60;
    this._rate = callsPerMinute / 60.0;
    this._burst = options?.burstSize ?? callsPerMinute;
    this._tokens = this._burst;
    this._lastUpdate = Date.now() / 1000; // seconds
  }

  async check(event: BaseEvent): Promise<GateResult> {
    if (event.type !== "agent.tool.intent") {
      return GateAllow;
    }

    const now = Date.now() / 1000;
    const elapsed = now - this._lastUpdate;
    this._tokens = Math.min(this._burst, this._tokens + elapsed * this._rate);
    this._lastUpdate = now;

    if (this._tokens >= 1.0) {
      this._tokens -= 1.0;
      return GateAllow;
    }

    return GateBlock(this.getBlockReason(event));
  }

  override getBlockReason(_event: BaseEvent): string {
    return `Rate limit exceeded (${Math.round(this._rate * 60)} calls/min)`;
  }
}
