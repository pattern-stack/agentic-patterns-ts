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
      // FAIL-SAFE (#491): observability must never take the agent loop down.
      // This is the single dispatch site for every exporter, so one catch here
      // covers all of them. A handler that throws — a broken Langfuse client,
      // a closed SQLite handle, an OTel tracer mid-shutdown — is reported and
      // swallowed. It must not propagate into `EventBus.publish` and from
      // there into the run.
      try {
        await handler.call(this, event);
      } catch (err) {
        this._reportExporterError(err, event);
      }
    }
  }

  /**
   * Called when an `_on*` handler throws. Override by assignment to route
   * exporter failures somewhere useful (a logger, a counter, an alert).
   * Never rethrow from here — the whole point is that the run survives.
   */
  onExporterError?: (err: unknown, event: BaseEvent) => void;

  /** Invoke the caller's handler if set, else log and continue. */
  private _reportExporterError(err: unknown, event: BaseEvent): void {
    if (this.onExporterError) {
      try {
        this.onExporterError(err, event);
      } catch {
        // A throwing error handler is not allowed to escalate either.
      }
      return;
    }
    console.error(
      `[${this.constructor.name}] handler for "${event.type}" threw and was swallowed:`,
      err,
    );
  }

  /** Bound reference for subscribe/unsubscribe identity. */
  private _boundHandleEvent = (event: BaseEvent) => this.handleEvent(event);
}
