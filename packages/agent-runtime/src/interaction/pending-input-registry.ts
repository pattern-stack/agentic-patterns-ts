/**
 * Pending human-input registry — the return leg of a human-in-the-loop
 * round-trip.
 *
 * A run that BLOCKS awaiting a human decision (an approval gate, or a tool
 * asking the user to pick / type) registers a pending request here, keyed by a
 * `correlationId`, and awaits the returned promise. The transport (the chat
 * route's `POST /conversations/:id/input`) resolves it when the human answers.
 *
 * The registry is deliberately transport-agnostic: it neither emits the
 * outbound `agent.input.request` event nor knows about HTTP. It is a plain
 * `Map` of pending promises with an optional timeout — nothing survives a
 * resolved/timed-out request, so it holds no durable session state.
 */

import type { HumanInputKind } from "../events/types.js";

/** The human's answer to an {@link InputRequestEvent}. */
export interface HumanInputResponse {
  /** For `kind: "approval"` — whether the guarded action may proceed. */
  readonly decision: "approve" | "deny";
  /** For `kind: "select" | "text"` — the chosen option / typed value. */
  readonly value?: string;
  /** True when the answer is the timeout fallback, not a real human response. */
  readonly timedOut?: boolean;
}

/** Options for {@link PendingInputRegistry.create}. */
export interface CreatePendingOptions {
  /**
   * Auto-resolve after this many ms if no human answers, so a blocked run can
   * never hang forever. The fallback is a DENY (`timedOut: true`) — fail
   * closed, since the gated action is destructive by assumption. Omit for no
   * timeout.
   */
  readonly timeoutMs?: number;
  /** What a request is meant to collect — informational, echoed to callers. */
  readonly kind?: HumanInputKind;
}

interface PendingEntry {
  readonly resolve: (response: HumanInputResponse) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

/** The DENY fallback used when a pending request times out. */
const TIMED_OUT_DENY: HumanInputResponse = { decision: "deny", timedOut: true };

export class PendingInputRegistry {
  private _pending = new Map<string, PendingEntry>();

  /**
   * Register a pending request and return a promise that settles when the
   * human answers (via {@link resolve}) or the optional timeout fires.
   *
   * Registration is synchronous: the `correlationId` is live in the map before
   * this method returns, so a resolve that races in immediately after the
   * outbound event is delivered still finds it.
   */
  create(correlationId: string, options: CreatePendingOptions = {}): Promise<HumanInputResponse> {
    // A duplicate correlationId (e.g. the runner's double gate-check) must NOT
    // register twice — return the already-pending promise. Callers that dedupe
    // upstream never hit this; it is a safety net, not the primary guard.
    const existing = this._pending.get(correlationId);
    if (existing) {
      return new Promise<HumanInputResponse>((resolve) => {
        const prior = existing.resolve;
        // Chain so BOTH awaiters settle on a single resolve.
        this._pending.set(correlationId, {
          ...existing,
          resolve: (r) => {
            prior(r);
            resolve(r);
          },
        });
      });
    }

    return new Promise<HumanInputResponse>((resolve) => {
      const timer =
        options.timeoutMs !== undefined && options.timeoutMs > 0
          ? setTimeout(() => {
              this._pending.delete(correlationId);
              resolve(TIMED_OUT_DENY);
            }, options.timeoutMs)
          : undefined;
      this._pending.set(correlationId, { resolve, timer });
    });
  }

  /**
   * Resolve a pending request with the human's answer. Returns `false` when no
   * request is pending for `correlationId` (already answered, timed out, or
   * unknown) so the transport can 404 an orphaned answer.
   */
  resolve(correlationId: string, response: HumanInputResponse): boolean {
    const entry = this._pending.get(correlationId);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this._pending.delete(correlationId);
    entry.resolve(response);
    return true;
  }

  /** Whether a request is currently pending for `correlationId`. */
  has(correlationId: string): boolean {
    return this._pending.has(correlationId);
  }

  /** Number of currently-pending requests. */
  get size(): number {
    return this._pending.size;
  }

  /**
   * Resolve every pending request with a DENY. Used when a transport tears
   * down (client navigated away mid-approval) so blocked runs fail closed
   * instead of hanging.
   */
  denyAll(reason: HumanInputResponse = { decision: "deny" }): number {
    const n = this._pending.size;
    for (const [, entry] of this._pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(reason);
    }
    this._pending.clear();
    return n;
  }
}
