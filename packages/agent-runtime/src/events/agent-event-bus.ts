/**
 * Agent-specific event bus with gate chain for intent filtering.
 *
 * Extends the base EventBus with safety gates that can intercept,
 * block, or modify intent events before they're published.
 */

import type { Gate, GateResult } from "../gates/base.js";
import { EventBus } from "./event-bus.js";
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
   * Publish an event, running intent events through gate chain.
   *
   * Intent events (those with type ending in ".intent") are checked by each gate.
   * If any gate blocks the event, a ToolCallRejected event is emitted instead.
   * Regular events bypass gates entirely.
   */
  override async publish(event: BaseEvent): Promise<unknown[]> {
    const isIntent = event.type.endsWith(".intent");

    if (!isIntent) {
      return super.publish(event);
    }

    // Run intent event through gate chain
    let currentEvent: BaseEvent = event;
    for (const gate of this._gateChain) {
      const result = await gate.check(currentEvent);

      if (isGateResultObject(result)) {
        if (result.action === "block") {
          await this._emitRejection(currentEvent, gate, result.reason);
          return [];
        }
        if (result.action === "modify" && result.event) {
          currentEvent = result.event;
        }
      }
    }

    // All gates passed, publish the (possibly modified) event
    return super.publish(currentEvent);
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
