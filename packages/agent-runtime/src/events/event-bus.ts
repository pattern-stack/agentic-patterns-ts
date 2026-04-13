/**
 * Async-capable event bus for publishing and subscribing to events.
 *
 * Handlers sorted by priority (higher = executed first).
 * Middleware can transform or drop events (return null).
 */

import type { BaseEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Handler function that receives an event. Can be sync or async. */
export type EventHandlerFn<E extends BaseEvent = BaseEvent> = (
  event: E,
) => unknown | Promise<unknown>;

/** Middleware function. Return null to stop propagation, or a new event to transform. */
export type MiddlewareFn<E extends BaseEvent = BaseEvent> = (
  event: E,
) => E | null | Promise<E | null>;

/** Wrapped handler with priority metadata. */
interface HandlerEntry {
  readonly handler: EventHandlerFn;
  readonly priority: number;
  readonly eventTypes: readonly string[];
}

function canHandle(entry: HandlerEntry, event: BaseEvent): boolean {
  return entry.eventTypes.length === 0 || entry.eventTypes.includes(event.type);
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export class EventBus {
  private _handlers: Map<string, HandlerEntry[]> = new Map();
  private _globalHandlers: HandlerEntry[] = [];
  private _middleware: MiddlewareFn[] = [];

  /**
   * Subscribe a handler to a specific event type.
   *
   * @param eventType - Event type string to listen for
   * @param handler - Handler function (sync or async)
   * @param priority - Higher priority executes first (default 0)
   */
  subscribe(eventType: string, handler: EventHandlerFn, priority = 0): void {
    const entry: HandlerEntry = {
      handler,
      priority,
      eventTypes: [eventType],
    };

    let list = this._handlers.get(eventType);
    if (!list) {
      list = [];
      this._handlers.set(eventType, list);
    }
    list.push(entry);
    // Sort descending by priority
    list.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Subscribe a handler to all events.
   */
  subscribeAll(handler: EventHandlerFn, priority = 0): void {
    const entry: HandlerEntry = { handler, priority, eventTypes: [] };
    this._globalHandlers.push(entry);
    this._globalHandlers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Unsubscribe a handler from a specific event type.
   */
  unsubscribe(eventType: string, handler: EventHandlerFn): void {
    const list = this._handlers.get(eventType);
    if (list) {
      this._handlers.set(
        eventType,
        list.filter((h) => h.handler !== handler),
      );
    }
  }

  /**
   * Unsubscribe a handler from all events.
   */
  unsubscribeAll(handler: EventHandlerFn): void {
    this._globalHandlers = this._globalHandlers.filter((h) => h.handler !== handler);
  }

  /**
   * Add middleware to process events before handlers.
   *
   * Middleware can modify events or stop propagation by returning null.
   */
  addMiddleware(middleware: MiddlewareFn): void {
    this._middleware.push(middleware);
  }

  /**
   * Publish an event to all registered handlers.
   *
   * @returns List of handler results
   */
  async publish(event: BaseEvent): Promise<unknown[]> {
    // Apply middleware
    let processed: BaseEvent | null = event;
    for (const mw of this._middleware) {
      const result = mw(processed);
      processed = result instanceof Promise ? await result : result;
      if (processed === null) {
        return [];
      }
    }

    // Gather handlers
    const specific = this._handlers.get(processed.type) ?? [];
    const globals = this._globalHandlers.filter((h) => canHandle(h, processed));

    const all = [...specific, ...globals].sort((a, b) => b.priority - a.priority);

    // Execute handlers
    const results: unknown[] = [];
    for (const entry of all) {
      try {
        const r = entry.handler(processed);
        results.push(r instanceof Promise ? await r : r);
      } catch (_err) {
        // Continue executing other handlers (matches Python behavior)
      }
    }

    return results;
  }

  /**
   * Clear all handlers and middleware.
   */
  clear(): void {
    this._handlers.clear();
    this._globalHandlers = [];
    this._middleware = [];
  }

  /**
   * Get the number of handlers for an event type or total.
   */
  getHandlerCount(eventType?: string): number {
    if (eventType) {
      return (this._handlers.get(eventType) ?? []).length;
    }
    let count = 0;
    for (const list of this._handlers.values()) {
      count += list.length;
    }
    return count + this._globalHandlers.length;
  }
}

// ---------------------------------------------------------------------------
// Global instance
// ---------------------------------------------------------------------------

let _globalEventBus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!_globalEventBus) {
    _globalEventBus = new EventBus();
  }
  return _globalEventBus;
}

export function setEventBus(bus: EventBus): void {
  _globalEventBus = bus;
}
