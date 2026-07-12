/**
 * Instrumented Backpack accessors (#226) — the ONLY place `agent.backpack.*`
 * events are minted for tool-side access.
 *
 * `backpack.ts` emits zero events BY CONSTRUCTION (a structural test bans any
 * event channel in that module), so instrumentation lives here, in the
 * accessor layer: `requireBackpack`/`openBackpack` keep their exact contracts
 * but return a forwarding proxy that publishes after each real operation:
 *
 *  - `drop()`      → `agent.backpack.drop` (DropReceipt → payload, plus
 *                    sizeBefore/After and byte-capped per-row previews)
 *  - `absorb()`    → `agent.backpack.absorb`
 *  - `finalized()` → `agent.backpack.read` (memo hit/miss, best-effort:
 *                    tracked by result identity, which mirrors the pack's
 *                    per-write-generation memo)
 *
 * The proxy exists only when the run's pad is an `ObservedScratchpad` (i.e. the
 * run has an event bus) — otherwise the RAW pack is returned and nothing is
 * emitted, preserving today's silent behavior exactly. The underlying pack
 * stored in the slot is NEVER the proxy: fork/join and the branch merge
 * reducer keep operating on the real pack.
 *
 * This module is swapped in for the raw accessors at the workflows barrel
 * (`workflows/index.ts`); no consumer imports the raw ones directly.
 */

import type { ToolExecutionContext } from "@agentic-patterns/core"; // type-only
import { createEvent } from "../events/types.js";
import type { BackpackRowPreview } from "../events/types.js";
import {
  type Backpack,
  type BackpackSpec,
  type DropReceipt,
  openBackpack as rawOpenBackpack,
  requireBackpack as rawRequireBackpack,
} from "./backpack.js";
import { ObservedScratchpad } from "./observed-scratchpad.js";
import {
  FRAME_PREVIEW_BYTES,
  ROW_PREVIEW_BYTES,
  type StateEmitter,
  byteLength,
  capPreview,
  renderPreviewSource,
} from "./state-events.js";

// ---------------------------------------------------------------------------
// Emitter discovery — the host's scratchpad IS the emission context
// ---------------------------------------------------------------------------

function emitterFromCtx(ctx: ToolExecutionContext | undefined): StateEmitter | undefined {
  const host = ctx?.host as { scratchpad?: unknown } | undefined;
  const pad = host?.scratchpad;
  return pad instanceof ObservedScratchpad ? pad.emitter : undefined;
}

// ---------------------------------------------------------------------------
// The forwarding proxy
// ---------------------------------------------------------------------------

/** Proxy → real pack, so absorb() can unwrap (preserves the self-absorb no-op). */
const proxyTarget = new WeakMap<object, object>();

/** Real pack → last finalized() result, for best-effort memo hit/miss. */
const lastFinalized = new WeakMap<object, { value: unknown }>();

/** Byte-capped previews for the rows a drop touched, within the frame budget. */
function buildRowPreviews<TIn, TEntry, TFinal, TTag>(
  pack: Backpack<TIn, TEntry, TFinal, TTag>,
  receipt: DropReceipt,
  sizeBefore: number,
): { previews: readonly BackpackRowPreview[]; previewsOmitted: number } {
  const entries = pack.entries();
  const render = pack.spec.renderEntry;
  const seen = new Set<number>();
  const previews: BackpackRowPreview[] = [];
  let budget = FRAME_PREVIEW_BYTES;
  let uniqueRows = 0;
  // Below this leftover budget a preview is all marker and no content — treat
  // the frame as full instead of emitting useless slivers.
  const MIN_USEFUL_ROW_BYTES = 64;
  for (const index of receipt.indexes) {
    if (seen.has(index)) continue;
    seen.add(index);
    uniqueRows += 1;
    if (budget < MIN_USEFUL_ROW_BYTES) continue; // frame budget exhausted — counted as omitted
    const entry = entries[index - 1];
    if (entry === undefined) continue;
    let rendered: string;
    try {
      rendered = render ? render(entry, index) : renderPreviewSource(entry);
    } catch {
      rendered = renderPreviewSource(entry); // a throwing renderEntry never breaks emission
    }
    const preview = capPreview(rendered, Math.min(ROW_PREVIEW_BYTES, budget));
    budget -= byteLength(preview);
    previews.push({
      index,
      // An index minted past the pre-drop size is net-new to this drop.
      op: index > sizeBefore ? "added" : "merged",
      preview,
    });
  }
  return { previews, previewsOmitted: uniqueRows - previews.length };
}

function observePack<TIn, TEntry, TFinal, TTag>(
  pack: Backpack<TIn, TEntry, TFinal, TTag>,
  emitter: StateEmitter,
  toolCallId: string | undefined,
): Backpack<TIn, TEntry, TFinal, TTag> {
  const key = `backpack.${pack.spec.key}`;
  const display = pack.spec.display;

  /** Common event fields. Tool-side mutations nest under the causing tool call
   *  (a tool call's span IS the parent span for anything it spawns). */
  const stamp = () => ({
    traceId: emitter.traceId,
    runId: emitter.runId,
    ...(toolCallId !== undefined
      ? { parentSpanId: toolCallId }
      : emitter.parentSpanId !== undefined
        ? { parentSpanId: emitter.parentSpanId }
        : {}),
    origin: "explicit" as const,
    ordinal: emitter.nextOrdinal(),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    key,
    ...(display !== undefined ? { display } : {}),
  });

  const proxy: Backpack<TIn, TEntry, TFinal, TTag> = {
    spec: pack.spec,
    get size() {
      return pack.size;
    },
    drop(raw: TIn | readonly TIn[], tag?: TTag): DropReceipt {
      const sizeBefore = pack.size;
      const receipt = pack.drop(raw, tag); // an expand() throw propagates untouched (fail-loud)
      const { previews, previewsOmitted } = buildRowPreviews(pack, receipt, sizeBefore);
      emitter.publish(
        createEvent("agent.backpack.drop", {
          ...stamp(),
          accepted: receipt.accepted,
          merged: receipt.merged,
          skipped: receipt.skipped,
          indexes: receipt.indexes,
          sizeBefore,
          sizeAfter: pack.size,
          previews,
          previewsOmitted,
          ...(tag !== undefined ? { tag: capPreview(renderPreviewSource(tag)) } : {}),
        }),
      );
      return receipt;
    },
    has: (id) => pack.has(id),
    byId: (id) => pack.byId(id),
    indexOf: (id) => pack.indexOf(id),
    entries: () => pack.entries(),
    get: (ids) => pack.get(ids),
    manifest: () => pack.manifest(),
    finalized(): TFinal {
      const value = pack.finalized();
      // Best-effort memo detection: the pack's finalize memo returns the SAME
      // reference until a write invalidates it, so result identity mirrors it
      // (a primitive-valued finalize can alias — acceptable for a preview).
      const prev = lastFinalized.get(pack as object);
      const memoHit = prev !== undefined && Object.is(prev.value, value);
      lastFinalized.set(pack as object, { value });
      emitter.publish(
        createEvent("agent.backpack.read", {
          ...stamp(),
          memoHit,
          size: pack.size,
          preview: capPreview(renderPreviewSource(value)),
        }),
      );
      return value;
    },
    view: () => pack.view(),
    absorb(other: Backpack<TIn, TEntry, TFinal, TTag>): void {
      // Unwrap a proxied `other` so the real pack's self-absorb no-op guard
      // still sees identity (and its entries replay without double emission).
      const target = (proxyTarget.get(other as object) ?? other) as Backpack<
        TIn,
        TEntry,
        TFinal,
        TTag
      >;
      if ((target as unknown) === (pack as unknown)) {
        pack.absorb(target); // delegates the documented no-op; nothing to report
        return;
      }
      const sizeBefore = pack.size;
      const childSize = target.size;
      pack.absorb(target);
      const sizeAfter = pack.size;
      const accepted = sizeAfter - sizeBefore;
      const appendedIndexes: number[] = [];
      for (let n = sizeBefore + 1; n <= sizeAfter; n += 1) appendedIndexes.push(n);
      emitter.publish(
        createEvent("agent.backpack.absorb", {
          ...stamp(),
          childSize,
          accepted,
          merged: childSize - accepted,
          sizeBefore,
          sizeAfter,
          appendedIndexes,
        }),
      );
    },
  };
  proxyTarget.set(proxy as object, pack as object);
  return Object.freeze(proxy);
}

// ---------------------------------------------------------------------------
// The swapped-in accessors — contracts identical to backpack.ts's raw pair
// ---------------------------------------------------------------------------

/**
 * Soft probe — undefined when the run has no host/pad (see the raw
 * `openBackpack` for the full contract). When the host pad is observed, the
 * returned pack additionally publishes `agent.backpack.*` state events.
 */
export function openBackpack<TIn, TEntry, TFinal, TTag = undefined>(
  ctx: ToolExecutionContext | undefined,
  spec: BackpackSpec<TIn, TEntry, TFinal, TTag>,
): Backpack<TIn, TEntry, TFinal, TTag> | undefined {
  const pack = rawOpenBackpack(ctx, spec);
  if (pack === undefined) return undefined;
  const emitter = emitterFromCtx(ctx);
  return emitter ? observePack(pack, emitter, ctx?.parentToolCallId) : pack;
}

/**
 * Fail-loud accessor — the DEFAULT write path (see the raw `requireBackpack`
 * for the full contract). When the host pad is observed, the returned pack
 * additionally publishes `agent.backpack.*` state events.
 */
export function requireBackpack<TIn, TEntry, TFinal, TTag = undefined>(
  ctx: ToolExecutionContext | undefined,
  spec: BackpackSpec<TIn, TEntry, TFinal, TTag>,
): Backpack<TIn, TEntry, TFinal, TTag> {
  const pack = rawRequireBackpack(ctx, spec);
  const emitter = emitterFromCtx(ctx);
  return emitter ? observePack(pack, emitter, ctx?.parentToolCallId) : pack;
}
