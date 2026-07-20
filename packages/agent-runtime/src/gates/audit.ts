/**
 * Audit gate for logging all intents.
 *
 * Category: AUDIT (runs last, never blocks)
 */

import type { BaseEvent } from "../events/types.js";
import { BaseGate, GateAllow, GateCategory, type GateResult } from "./base.js";
import type { AskContext, DecisionKind, GateEvaluation } from "./decisions.js";

/** Logger interface — matches console.info signature. */
export interface AuditLogger {
  info(message: string, ...args: unknown[]): void;
}

/** One recorded gate decision (F-2). */
export interface AuditDecisionEntry {
  readonly toolName: string;
  readonly outcome: "allow" | "block";
  readonly settledBy: "gate" | "human" | "timeout";
  readonly decisionKind?: DecisionKind;
  readonly blockedBy?: string;
  readonly reason?: string;
  /** The native ask's local settlement key, when the decision came via a harness ask. */
  readonly requestId?: string;
  readonly timestamp: Date;
}

export class AuditGate extends BaseGate {
  readonly category = GateCategory.AUDIT;

  /** Recorded intent entries via check() — legacy per-intent log. */
  readonly entries: Array<{ type: string; toolName: string; timestamp: Date }> = [];

  /**
   * Recorded DECISIONS via recordDecision() — the F-2 audit phase. Distinct from
   * {@link entries}: this is populated in the guaranteed audit phase and so
   * captures blocked decisions too (which never reach check()).
   */
  readonly decisions: AuditDecisionEntry[] = [];

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

  /**
   * Guaranteed audit-phase hook (F-2). Records the full evaluation — including
   * blocks and modifications, which the check() chain stops short of — with
   * decision kind, native request id, scope, and `settledBy`.
   */
  recordDecision(evaluation: GateEvaluation, ctx?: AskContext): void {
    const entry: AuditDecisionEntry = {
      toolName: evaluation.intent.toolName ?? "",
      outcome: evaluation.outcome,
      settledBy: evaluation.settledBy,
      ...(evaluation.decision ? { decisionKind: evaluation.decision.kind } : {}),
      ...(evaluation.blockedBy ? { blockedBy: evaluation.blockedBy } : {}),
      ...(evaluation.reason ? { reason: evaluation.reason } : {}),
      ...(ctx ? { requestId: ctx.requestId } : {}),
      timestamp: new Date(),
    };
    this.decisions.push(entry);

    if (this._logger) {
      this._logger.info(`Decision: ${entry.outcome}`, {
        toolName: entry.toolName,
        outcome: entry.outcome,
        settledBy: entry.settledBy,
        decisionKind: entry.decisionKind,
        blockedBy: entry.blockedBy,
        requestId: entry.requestId,
        runId: evaluation.intent.runId,
      });
    }
  }
}
