/**
 * HttpEventExporter — forward the bus's events to a remote ingest endpoint over
 * HTTP, so a run in one process surfaces on another process's dashboard (e.g. a
 * consumer app's agent → the `ap playground` server's `POST /events`). Pairs with
 * that ingest, which republishes onto its own bus → existing SSE/collector → UI.
 *
 * Batched + fire-and-forget: observability must never block or break the run, so a
 * failed POST goes to `onError` (default: swallowed) and is never thrown into the
 * agent loop. Subscribes to ALL events via `subscribeAll`; the receiving server
 * decides what to render/aggregate.
 */

import type { EventBus } from "../events/event-bus.js";
import type { BaseEvent } from "../events/types.js";
import type { Exporter } from "./base.js";

export interface HttpEventExporterOptions {
  /** Ingest URL, e.g. `http://localhost:3456/events`. */
  url: string;
  /** Optional bearer token (sent as `Authorization: Bearer …`) for cross-host links. */
  token?: string;
  /** Flush after this many ms of inactivity (default 120). */
  flushMs?: number;
  /** Flush immediately when the buffer reaches this size (default 40). */
  maxBatch?: number;
  /** Injectable fetch (tests / non-standard runtimes). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Called on a failed POST. Default: swallow — never surface to the run. */
  onError?: (err: unknown) => void;
}

export class HttpEventExporter implements Exporter {
  private readonly url: string;
  private readonly token?: string;
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (err: unknown) => void;
  private buffer: BaseEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly handler = (event: BaseEvent): void => this.enqueue(event);

  constructor(options: HttpEventExporterOptions) {
    this.url = options.url;
    this.token = options.token;
    this.flushMs = options.flushMs ?? 120;
    this.maxBatch = options.maxBatch ?? 40;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onError = options.onError ?? (() => {});
  }

  attach(bus: EventBus): void {
    bus.subscribeAll(this.handler);
  }

  detach(bus: EventBus): void {
    bus.unsubscribeAll(this.handler);
    void this.flush();
  }

  private enqueue(event: BaseEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBatch) {
      void this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs);
    }
  }

  /** POST the buffered events. Fire-and-forget; errors go to `onError`, never thrown. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ events: batch }),
      });
    } catch (err) {
      this.onError(err);
    }
  }
}
