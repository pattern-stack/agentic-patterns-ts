/**
 * SQLiteExporter — bus sink that durably logs every UX-profile event.
 *
 * Symmetric in shape to {@link SSEExporter} and {@link InMemoryEventCollector}:
 * attaches to the bus, observes the UX profile (which includes
 * `claude_code.hook`), and writes every event to an {@link EventStore}.
 *
 * Writes are best-effort: a thrown exception inside `handleEvent` is caught
 * and logged to stderr so a misbehaving storage layer cannot break the bus.
 */

import { EventProfile } from "../events/event-profiles.js";
import type { BaseEvent } from "../events/types.js";
import type { EventStore } from "../storage/event-store.js";
import { BaseExporter } from "./base.js";

export class SQLiteExporter extends BaseExporter {
  override profile = EventProfile.UX;

  private readonly _store: EventStore;
  private readonly _onError: (err: unknown, event: BaseEvent) => void;

  constructor(opts: {
    store: EventStore;
    onError?: (err: unknown, event: BaseEvent) => void;
  }) {
    super();
    this._store = opts.store;
    this._onError =
      opts.onError ??
      ((err, event) => {
        const msg = (err as Error)?.message ?? String(err);
        process.stderr.write(`[sqlite-exporter] failed to persist ${event.type}: ${msg}\n`);
      });
  }

  /**
   * Single-method dispatch (vs `_on<Suffix>` per type) — we want EVERY event
   * persisted, so a generic write is simpler than 12 handler methods.
   */
  override async handleEvent(event: BaseEvent): Promise<void> {
    try {
      this._store.append(event);
    } catch (err) {
      this._onError(err, event);
    }
  }
}
