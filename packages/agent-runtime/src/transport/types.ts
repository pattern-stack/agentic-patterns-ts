/**
 * Transport protocol abstraction for cross-agent communication.
 *
 * Defines the Transport interface and TransportMessage type.
 * Only InProcessTransport is implemented for v1; the interface
 * preserves the NATS upgrade path.
 */

/**
 * Wrapper around raw transport message bytes.
 */
export interface TransportMessage {
  readonly data: Uint8Array;
  readonly subject: string;
  ack(): Promise<void>;
}

/**
 * Abstract transport for inter-agent messaging.
 *
 * Implementations must support NATS-style subject wildcards:
 * - `*` matches exactly one token
 * - `>` matches one or more trailing tokens (must be last segment)
 */
export interface Transport {
  connect(): Promise<void>;
  close(): Promise<void>;
  ensureStream(name: string, subjects: string[]): Promise<void>;
  publish(subject: string, data: Uint8Array): Promise<void>;
  subscribe(
    subject: string,
    callback: (msg: TransportMessage) => void | Promise<void>,
    durable?: string,
  ): Promise<void>;
  request(subject: string, data: Uint8Array, timeout?: number): Promise<Uint8Array>;
}
