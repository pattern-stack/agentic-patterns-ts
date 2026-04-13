/**
 * Base exporter protocol and class for event-driven observability.
 *
 * Exporters subscribe to EventBus profiles and handle events for
 * rendering, tracing, or metrics collection.
 *
 * Ported from Python: systems/exporters/base.py
 */

import type { EventBus } from "../events/event-bus.js";
import { EventProfile, subscribeProfile, unsubscribeProfile } from "../events/event-profiles.js";
import type { BaseEvent } from "../events/types.js";

// ---------------------------------------------------------------------------
// Exporter interface
// ---------------------------------------------------------------------------

/** Protocol for event exporters. */
export interface Exporter {
  attach(bus: EventBus): void;
  detach(bus: EventBus): void;
}

// ---------------------------------------------------------------------------
// BaseExporter
// ---------------------------------------------------------------------------

/**
 * Base class with profile-based subscription.
 *
 * Subclasses set `profile` and implement `_on<Suffix>` methods.
 * The `handleEvent` dispatcher converts event_type to method name:
 *   "agent.message.start" -> "_onMessageStart"
 *   "agent.tool.end"      -> "_onToolEnd"
 *   "agent.reasoning"     -> "_onReasoning"
 *   "agent.error"         -> "_onError"
 */
export abstract class BaseExporter implements Exporter {
  profile: EventProfile = EventProfile.UX;

  /** Subscribe to all event types in this exporter's profile. */
  attach(bus: EventBus): void {
    subscribeProfile(bus, this.profile, this._boundHandleEvent);
  }

  /** Unsubscribe from all event types in this exporter's profile. */
  detach(bus: EventBus): void {
    unsubscribeProfile(bus, this.profile, this._boundHandleEvent);
  }

  /**
   * Dispatch to _on<Suffix> methods by event type.
   *
   * Converts event type (e.g. "agent.message.start") to handler
   * method name (e.g. "_onMessageStart") by stripping the "agent."
   * prefix and converting dot-separated segments to camelCase.
   */
  async handleEvent(event: BaseEvent): Promise<void> {
    const eventType = event.type;
    if (!eventType) return;

    // Strip "agent." prefix and convert to camelCase handler name
    const suffix = eventType
      .replace("agent.", "")
      .split(".")
      .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join("");

    const handlerName = `_on${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}`;

    // biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch by design
    const handler = (this as any)[handlerName];
    if (typeof handler === "function") {
      await handler.call(this, event);
    }
  }

  /** Bound reference for subscribe/unsubscribe identity. */
  private _boundHandleEvent = (event: BaseEvent) => this.handleEvent(event);
}
