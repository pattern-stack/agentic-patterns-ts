/**
 * SandboxEventBus - AgentEventBus with pluggable transport for cross-agent messaging.
 *
 * Extends AgentEventBus with dual publish: local handlers + transport publish
 * for SandboxEvents. Subscribes to both direct and broadcast channels.
 */

import type { Transport, TransportMessage } from "../transport/types.js";
import { AgentEventBus } from "./agent-event-bus.js";
import type { AgentAddress, BaseSandboxEvent, SandboxEvent } from "./sandbox-types.js";
import { deserializeSandboxEvent, serializeSandboxEvent } from "./sandbox-types.js";
import type { BaseEvent } from "./types.js";

/**
 * Check if an event is a SandboxEvent (has origin + agencyId fields).
 */
function isSandboxEvent(event: BaseEvent): event is SandboxEvent {
  return typeof event === "object" && event !== null && "origin" in event && "agencyId" in event;
}

/**
 * AgentEventBus extended with transport-aware publishing.
 *
 * - `publish()` dispatches both locally AND to transport for SandboxEvents.
 * - Regular AgentEvents only dispatch locally.
 * - Remote events received via transport are dispatched locally only (no echo loop).
 */
export class SandboxEventBus extends AgentEventBus {
  readonly address: AgentAddress;
  private _transport: Transport;
  /**
   * Set of spanIds that this bus has already dispatched locally.
   * Prevents duplicate local dispatch when the InProcessTransport
   * echoes our own publish back to us via subscription.
   */
  private _locallyPublished = new Set<string>();

  constructor(address: AgentAddress, transport: Transport) {
    super();
    this.address = address;
    this._transport = transport;
  }

  /**
   * Connect transport and set up subscriptions for direct + broadcast channels.
   */
  async start(): Promise<void> {
    await this._transport.connect();
    await this._transport.ensureStream("AGENCY_EVENTS", ["agency.>"]);

    // Subscribe to direct messages for this agent
    await this._transport.subscribe(
      `agency.*.run.*.agent.${this.address.agentId}`,
      (msg) => this._onRemoteEvent(msg),
      `agent-${this.address.agentId}`,
    );

    // Subscribe to broadcasts
    await this._transport.subscribe(
      "agency.*._broadcast",
      (msg) => this._onRemoteEvent(msg),
      `broadcast-${this.address.agentId}`,
    );
  }

  /**
   * Close transport.
   */
  async stop(): Promise<void> {
    await this._transport.close();
  }

  /**
   * Publish event locally and to transport if it's a SandboxEvent.
   *
   * 1. Local gate chain + handlers (via super.publish)
   * 2. If SandboxEvent, also publish to transport
   */
  override async publish(event: BaseEvent): Promise<unknown[]> {
    // Track this event to prevent duplicate local dispatch from transport echo
    this._locallyPublished.add(event.spanId);

    // Local dispatch
    const results = await super.publish(event);

    // If SandboxEvent, also publish to transport
    if (isSandboxEvent(event)) {
      const subject = this._resolveSubject(event);
      await this._transport.publish(subject, serializeSandboxEvent(event));
    }

    // Cleanup tracking (keep set bounded)
    if (this._locallyPublished.size > 1000) {
      const entries = [...this._locallyPublished];
      for (let i = 0; i < entries.length - 500; i++) {
        this._locallyPublished.delete(entries[i]!);
      }
    }

    return results;
  }

  /**
   * Map event target to transport subject.
   *
   * Targeted: agency.{agencyId}.run.{lineupRunId}.agent.{targetId}
   * Broadcast: agency.{agencyId}._broadcast
   */
  private _resolveSubject(event: SandboxEvent): string {
    const base = event as BaseSandboxEvent;
    if (base.target) {
      return `agency.${base.agencyId}.run.${base.lineupRunId}.agent.${base.target.agentId}`;
    }
    return `agency.${base.agencyId}._broadcast`;
  }

  /**
   * Inject remote transport message into local EventBus (no re-publish to transport).
   *
   * Skips events we already published locally (echo prevention for shared transport).
   */
  private async _onRemoteEvent(msg: TransportMessage): Promise<void> {
    const event = deserializeSandboxEvent(msg.data);

    // Skip events we already dispatched locally (echo from shared InProcessTransport)
    if (this._locallyPublished.has(event.spanId)) {
      await msg.ack();
      return;
    }

    // Mark as locally published to prevent re-entry
    this._locallyPublished.add(event.spanId);

    // Local dispatch only (do not re-publish to transport)
    await super.publish(event);
    await msg.ack();
  }
}
