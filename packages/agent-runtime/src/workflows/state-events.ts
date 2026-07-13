/**
 * State-event emission plumbing (#226) — shared by the observed Scratchpad
 * decorator (`observed-scratchpad.ts`) and the instrumented Backpack accessors
 * (`observed-backpack.ts`).
 *
 * Two jobs, both load-bearing for the state-viz contract:
 *
 *  1. `StateEmitter` — one per run, carrying the run's event identity
 *     (traceId/runId/parentSpanId) and minting the SINGLE monotonic per-run
 *     state ordinal (one `w#` stream across backpack + scratchpad — the design
 *     spec's "single write ordinal" graft). Publishing is fire-and-forget and
 *     fully guarded: observability must never break the run.
 *
 *  2. Byte-capped previews — applied AT EVENT CONSTRUCTION (512B per row, 2KB
 *     per frame, explicit "(preview only)" marker). The SSE formatter and every
 *     exporter pass payloads through verbatim, so capping here is the only
 *     place that prevents wire/persistence bloat — never silently clipped.
 */

import type { AgentEventBus } from "../events/agent-event-bus.js";
import type { AgentEvent } from "../events/types.js";

// ---------------------------------------------------------------------------
// Caps (Resolved questions, 2026-07-12 — tune later if real payloads argue)
// ---------------------------------------------------------------------------

/** Per-row preview budget, in bytes (UTF-8). */
export const ROW_PREVIEW_BYTES = 512;
/** Per-frame total preview budget, in bytes (UTF-8) — bounds multi-row drops. */
export const FRAME_PREVIEW_BYTES = 2048;
/** Explicit truncation marker appended to every clipped preview. */
export const PREVIEW_MARKER = "… (preview only)";

/** Slot-key prefix minted by `backpackSlot()` — the backpack namespace. */
export const BACKPACK_SLOT_PREFIX = "backpack.";

// ---------------------------------------------------------------------------
// StateEmitter
// ---------------------------------------------------------------------------

/**
 * The per-run emission context. Created once by the runner that installs the
 * observed scratchpad (`NodeBackedRunner`) and shared BY REFERENCE across
 * forks and the backpack accessor proxies, so the ordinal stream stays single
 * and monotonic for the whole run.
 */
export interface StateEmitter {
  readonly bus: AgentEventBus;
  readonly traceId: string;
  readonly runId: string;
  readonly parentSpanId?: string;
  /** Mint the next per-run state ordinal (1-based, monotonic, shared). */
  nextOrdinal(): number;
  /**
   * Fire-and-forget publish. Both a synchronous throw and an async rejection
   * are swallowed — the non-throw contract every observability side-channel
   * in this runtime honors (see `AgentRunner.buildToolCtx`'s Channel B).
   */
  publish(event: AgentEvent): void;
}

export function createStateEmitter(
  bus: AgentEventBus,
  ids: { traceId: string; runId: string; parentSpanId?: string },
): StateEmitter {
  let ordinal = 0;
  return Object.freeze({
    bus,
    traceId: ids.traceId,
    runId: ids.runId,
    ...(ids.parentSpanId !== undefined ? { parentSpanId: ids.parentSpanId } : {}),
    nextOrdinal: (): number => {
      ordinal += 1;
      return ordinal;
    },
    publish: (event: AgentEvent): void => {
      try {
        void bus.publish(event).catch(() => {
          // Swallow — state events are a best-effort observability channel.
        });
      } catch {
        // Swallow a SYNCHRONOUS throw too — same non-throw contract.
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Reader branding — pad-side emitter discovery
// ---------------------------------------------------------------------------

/**
 * `ScratchpadReader` → the run's emitter, branded by
 * `ObservedScratchpad.reader()`. Lets pad-side accessors (the observed
 * `readBackpack`) discover the emission context through a read-only view
 * WITHOUT widening the `ScratchpadReader` interface — a reader minted by a
 * plain pad simply isn't in the map, so it stays emission-free.
 *
 * Lives here (not in `observed-scratchpad.ts`) so `observed-backpack.ts` can
 * consume it without a circular import.
 */
const readerEmitters = new WeakMap<object, StateEmitter>();

/** Brand a reader with its pad's emitter (called by `ObservedScratchpad.reader()`). */
export function brandReaderEmitter(reader: object, emitter: StateEmitter): void {
  readerEmitters.set(reader, emitter);
}

/** The emitter a reader was branded with, if any. */
export function readerEmitter(reader: object): StateEmitter | undefined {
  return readerEmitters.get(reader);
}

// ---------------------------------------------------------------------------
// Byte-capped previews
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Render any value to a one-line string suitable for previewing. */
export function renderPreviewSource(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}

/**
 * Cap a rendered string at `maxBytes` (UTF-8), appending the explicit
 * {@link PREVIEW_MARKER} when clipped. The marker counts AGAINST the budget —
 * the result never exceeds `maxBytes`. Never splits a surrogate pair.
 */
export function capPreview(text: string, maxBytes: number = ROW_PREVIEW_BYTES): string {
  if (byteLength(text) <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - byteLength(PREVIEW_MARKER));
  // Binary-search the longest prefix within budget (bytes are monotonic in length).
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  let cut = text.slice(0, lo);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // dangling high surrogate
  return `${cut}${PREVIEW_MARKER}`;
}

/** Render + cap in one step — the default preview path for slot values. */
export function previewValue(value: unknown, maxBytes: number = ROW_PREVIEW_BYTES): string {
  return capPreview(renderPreviewSource(value), maxBytes);
}
