/**
 * Agent-specific event bus with gate chain for intent filtering.
 *
 * Extends the base EventBus with safety gates that can intercept,
 * block, or modify intent events before they're published.
 */

import type { Gate, GateResult } from "../gates/base.js";
import type {
  AskContext,
  GateEvaluation,
  GateTrailEntry,
  HarnessDecision,
} from "../gates/decisions.js";
import { EventBus } from "./event-bus.js";
import { createEvent } from "./types.js";
import type { BaseEvent, ToolCallIntent, ToolCallRejectedEvent } from "./types.js";

export class AgentEventBus extends EventBus {
  private _gateChain: Gate[] = [];

  /**
   * Add a gate to the chain, automatically sorted by category.
   */
  addGate(gate: Gate): void {
    this._gateChain.push(gate);
    this._gateChain.sort((a, b) => a.category - b.category);
  }

  /**
   * Remove a gate from the chain.
   */
  removeGate(gate: Gate): void {
    const idx = this._gateChain.indexOf(gate);
    if (idx !== -1) {
      this._gateChain.splice(idx, 1);
    }
  }

  /**
   * Clear all gates from the chain.
   */
  clearGates(): void {
    this._gateChain = [];
  }

  /**
   * Get a copy of the gate chain.
   */
  get gates(): readonly Gate[] {
    return [...this._gateChain];
  }

  /**
   * Publish an event, running intent events through the gate chain.
   *
   * Intent events (type ending in ".intent") are evaluated by {@link evaluateIntent};
   * on allow the (possibly modified) intent is published to subscribers, on block
   * a ToolCallRejected event is emitted instead and subscribers never see the
   * intent. Regular events bypass gates entirely. Subscriber semantics are
   * unchanged from the pre-F-2 behavior.
   */
  override async publish(event: BaseEvent): Promise<unknown[]> {
    if (!event.type.endsWith(".intent")) {
      return super.publish(event);
    }
    const { evaluation, results } = await this._runIntent(event as ToolCallIntent);
    return evaluation.outcome === "block" ? [] : results;
  }

  /**
   * Run an intent through the gate chain and return the full {@link GateEvaluation}.
   *
   * Runs SAFETY → RATE_LIMIT → APPROVAL (→ any AUDIT gate's check) in category
   * order, collecting a trail and applying modifications to the intent, then
   * ALWAYS runs the audit phase over the resulting evaluation — fixing the
   * pre-F-2 early-return-on-block that skipped audit exactly when it mattered.
   * On allow the modified intent is published to subscribers; on block a
   * `agent.tool.rejected` event is emitted. A post-decision `agent.gate.decision`
   * event is published for exporters in every case.
   *
   * `ctx` is optional because `AgentRunner`'s own loop evaluates plain intents
   * with no native ask.
   */
  async evaluateIntent(intent: ToolCallIntent, ctx?: AskContext): Promise<GateEvaluation> {
    const { evaluation } = await this._runIntent(intent, ctx);
    return evaluation;
  }

  /**
   * Shared core for {@link publish} and {@link evaluateIntent}: evaluate, emit
   * rejection/decision, run the guaranteed audit phase, and (on allow) publish
   * the intent to subscribers. Returns the evaluation plus the subscriber
   * results (empty on block) so `publish` keeps its `unknown[]` contract.
   */
  private async _runIntent(
    intent: ToolCallIntent,
    ctx?: AskContext,
  ): Promise<{ evaluation: GateEvaluation; results: unknown[] }> {
    let current: BaseEvent = intent;
    const trail: GateTrailEntry[] = [];
    let outcome: "allow" | "block" = "allow";
    let blockingGate: Gate | undefined;
    let reason: string | undefined;
    let decision: HarnessDecision | undefined;
    let settledBy: "gate" | "human" | "timeout" = "gate";

    for (const gate of this._gateChain) {
      const result = await gate.check(current, ctx);

      if (!isGateResultObject(result)) {
        trail.push({ gate: gate.name, result: "allow" });
        continue;
      }

      // A decision payload means an approval gate (human/policy) decided.
      if (result.decision) {
        decision = result.decision;
        settledBy = "human";
      }

      if (result.action === "block") {
        trail.push({ gate: gate.name, result: "block" });
        outcome = "block";
        blockingGate = gate;
        reason = result.reason;
        break;
      }

      if (result.action === "modify" && result.event) {
        current = result.event;
        trail.push({ gate: gate.name, result: "modified" });
        continue;
      }

      trail.push({ gate: gate.name, result: "allow" });
    }

    const evaluation: GateEvaluation = {
      outcome,
      intent: current as ToolCallIntent,
      ...(decision ? { decision } : {}),
      settledBy,
      ...(blockingGate ? { blockedBy: blockingGate.name } : {}),
      ...(reason !== undefined ? { reason } : {}),
      trail,
    };

    // On block, emit the rejection BEFORE the audit phase so subscribers and
    // the audit record observe a consistent ordering.
    if (outcome === "block" && blockingGate) {
      await this._emitRejection(intent, blockingGate, reason);
    }

    // Guaranteed audit phase — runs on allow AND block.
    await this._runAuditPhase(evaluation, ctx);

    // On allow, publish the (possibly modified) intent to subscribers.
    const results = outcome === "allow" ? await super.publish(evaluation.intent) : [];
    return { evaluation, results };
  }

  /**
   * The guaranteed audit phase: invoke `recordDecision` on every gate that
   * implements it (audit-category gates), then publish `agent.gate.decision`
   * for exporters. Runs regardless of allow/block.
   */
  private async _runAuditPhase(evaluation: GateEvaluation, ctx?: AskContext): Promise<void> {
    for (const gate of this._gateChain) {
      if (typeof gate.recordDecision === "function") {
        await gate.recordDecision(evaluation, ctx);
      }
    }

    const decisionEvent = createEvent("agent.gate.decision", {
      traceId: evaluation.intent.traceId,
      runId: evaluation.intent.runId,
      parentSpanId: evaluation.intent.parentSpanId,
      toolName: evaluation.intent.toolName ?? "",
      outcome: evaluation.outcome,
      settledBy: evaluation.settledBy,
      ...(evaluation.decision ? { decisionKind: evaluation.decision.kind } : {}),
      ...(evaluation.blockedBy ? { blockedBy: evaluation.blockedBy } : {}),
      ...(evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
      trail: evaluation.trail,
    });
    await super.publish(decisionEvent);
  }

  private async _emitRejection(event: BaseEvent, gate: Gate, reason?: string): Promise<void> {
    const intent = event as ToolCallIntent;
    const rejection: ToolCallRejectedEvent = {
      type: "agent.tool.rejected",
      traceId: intent.traceId,
      runId: intent.runId,
      spanId: `${Date.now().toString(36)}-rejection`,
      timestamp: new Date(),
      toolName: intent.toolName ?? "",
      reason: reason ?? gate.getBlockReason(event),
      gateName: gate.name,
      gateCategory: gate.categoryName,
      originalIntent: intent,
    };
    await super.publish(rejection);
  }
}

function isGateResultObject(result: GateResult): result is GateResult {
  return typeof result === "object" && result !== null && "action" in result;
}

// ---------------------------------------------------------------------------
// Global instance
// ---------------------------------------------------------------------------

let _agentEventBus: AgentEventBus | null = null;

export function getAgentEventBus(): AgentEventBus {
  if (!_agentEventBus) {
    _agentEventBus = new AgentEventBus();
  }
  return _agentEventBus;
}

export function setAgentEventBus(bus: AgentEventBus): void {
  _agentEventBus = bus;
}
