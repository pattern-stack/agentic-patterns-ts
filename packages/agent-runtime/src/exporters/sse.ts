/**
 * SSE Exporter — Fan-out broadcast to connected admin dashboard clients.
 *
 * Extends BaseExporter with UX profile. Formats events using SSEFormatter
 * and broadcasts to all connected ReadableStream clients.
 */

import { EventProfile } from "../events/event-profiles.js";
import type { BaseEvent } from "../events/types.js";
import type { AgentEvent } from "../events/types.js";
import { SSEFormatter } from "../transport/sse-formatter.js";
import { BaseExporter } from "./base.js";

// ---------------------------------------------------------------------------
// SSEExporter
// ---------------------------------------------------------------------------

/**
 * Broadcasts agent events as SSE frames to connected clients.
 *
 * Usage:
 *   const exporter = new SSEExporter();
 *   exporter.attach(eventBus);
 *   const stream = exporter.connect(); // return to HTTP response
 *   // Later:
 *   exporter.disconnect(stream);
 */
export class SSEExporter extends BaseExporter {
  override profile = EventProfile.UX;

  private _clients = new Map<
    ReadableStream<Uint8Array>,
    ReadableStreamDefaultController<Uint8Array>
  >();
  private _formatter = new SSEFormatter();
  private _encoder = new TextEncoder();

  /** Connect a new client. Returns a ReadableStream to pipe to the HTTP response. */
  connect(): ReadableStream<Uint8Array> {
    let savedController: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        savedController = controller;
      },
    });
    this._clients.set(stream, savedController!);
    return stream;
  }

  /** Disconnect a client stream. */
  disconnect(stream: ReadableStream<Uint8Array>): void {
    const controller = this._clients.get(stream);
    if (controller) {
      try {
        controller.close();
      } catch {
        // Already closed
      }
      this._clients.delete(stream);
    }
  }

  /** Number of connected clients. */
  get clientCount(): number {
    return this._clients.size;
  }

  /** Handle any event by broadcasting to all connected clients. */
  override async handleEvent(event: BaseEvent): Promise<void> {
    const frame = this._formatter.format(event as AgentEvent);
    if (!frame) return;

    const encoded = this._encoder.encode(frame);
    for (const [stream, controller] of this._clients) {
      try {
        controller.enqueue(encoded);
      } catch {
        // Client disconnected, clean up
        this._clients.delete(stream);
      }
    }
  }
}
