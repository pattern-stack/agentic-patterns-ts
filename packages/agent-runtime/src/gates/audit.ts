/**
 * Audit gate for logging all intents.
 *
 * Category: AUDIT (runs last, never blocks)
 */

import type { BaseEvent } from "../events/types.js";
import { BaseGate, GateAllow, GateCategory, type GateResult } from "./base.js";

/** Logger interface — matches console.info signature. */
export interface AuditLogger {
  info(message: string, ...args: unknown[]): void;
}

export class AuditGate extends BaseGate {
  readonly category = GateCategory.AUDIT;

  /** Recorded entries for testing/inspection. */
  readonly entries: Array<{ type: string; toolName: string; timestamp: Date }> = [];

  private _logger: AuditLogger | undefined;

  constructor(options?: { logger?: AuditLogger }) {
    super();
    this._logger = options?.logger;
  }

  async check(event: BaseEvent): Promise<GateResult> {
    const toolName = (event as { toolName?: string }).toolName ?? "";
    this.entries.push({
      type: event.type,
      toolName,
      timestamp: new Date(),
    });

    if (this._logger) {
      this._logger.info(`Intent: ${event.type}`, {
        type: event.type,
        toolName,
        runId: event.runId,
      });
    }

    return GateAllow;
  }
}
