/**
 * In-process transport with NATS-compatible subject wildcards.
 *
 * Zero-dependency in-memory pub/sub for multi-agent communication.
 * Supports NATS wildcard patterns: `*` (single token) and `>` (trailing tokens).
 */

import type { Transport, TransportMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Subject matching (NATS-style)
// ---------------------------------------------------------------------------

interface Subscription {
  readonly pattern: string;
  readonly regex: RegExp;
  readonly callback: (msg: TransportMessage) => void | Promise<void>;
}

/**
 * Convert a NATS subject pattern to a RegExp.
 *
 * NATS wildcards:
 *   `*` matches exactly one token (segment between dots)
 *   `>` matches one or more trailing tokens (must be the last segment)
 */
export function subjectToRegex(pattern: string): RegExp {
  const parts = pattern.split(".");
  const regexParts: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === ">") {
      regexParts.push("[^.]+(?:\\.[^.]+)*");
      break; // > must be last
    }
    if (part === "*") {
      regexParts.push("[^.]+");
    } else {
      regexParts.push(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
  }

  return new RegExp(`^${regexParts.join("\\.")}$`);
}

/**
 * Test whether a subject matches a NATS-style pattern.
 */
export function matchSubject(pattern: string, subject: string): boolean {
  return subjectToRegex(pattern).test(subject);
}

// ---------------------------------------------------------------------------
// InProcessTransport
// ---------------------------------------------------------------------------

/**
 * Zero-dependency in-process transport with NATS-compatible wildcards.
 *
 * All messaging is synchronous within the process -- no network I/O.
 * `connect()` and `ensureStream()` are no-ops.
 */
export class InProcessTransport implements Transport {
  private _subscriptions: Subscription[] = [];
  private _connected = false;

  async connect(): Promise<void> {
    this._connected = true;
  }

  async close(): Promise<void> {
    this._subscriptions = [];
    this._connected = false;
  }

  async ensureStream(_name: string, _subjects: string[]): Promise<void> {
    // No-op: streams are a JetStream concept
  }

  async publish(subject: string, data: Uint8Array): Promise<void> {
    const msg: TransportMessage = {
      data,
      subject,
      ack: async () => {
        // No-op for in-memory transport
      },
    };

    for (const sub of [...this._subscriptions]) {
      if (sub.regex.test(subject)) {
        const result = sub.callback(msg);
        if (result instanceof Promise) {
          await result;
        }
      }
    }
  }

  async subscribe(
    subject: string,
    callback: (msg: TransportMessage) => void | Promise<void>,
    _durable?: string,
  ): Promise<void> {
    const sub: Subscription = {
      pattern: subject,
      regex: subjectToRegex(subject),
      callback,
    };
    this._subscriptions.push(sub);
  }

  async request(subject: string, data: Uint8Array, _timeout = 5000): Promise<Uint8Array> {
    const msg: TransportMessage = {
      data,
      subject,
      ack: async () => {},
    };

    for (const sub of [...this._subscriptions]) {
      if (sub.regex.test(subject)) {
        const result = sub.callback(msg);
        let resp: unknown;
        if (result instanceof Promise) {
          resp = await result;
        } else {
          resp = result;
        }
        if (resp instanceof Uint8Array) {
          return resp;
        }
      }
    }

    throw new Error(`No handler for request on ${subject}`);
  }

  /** Whether the transport is currently connected. */
  get connected(): boolean {
    return this._connected;
  }
}
