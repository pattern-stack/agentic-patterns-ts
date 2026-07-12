/**
 * `ObservedScratchpad` — the event-publishing Scratchpad decorator (#226).
 *
 * EXTENDS `DefaultScratchpad` (it must: `join()` guards
 * `instanceof DefaultScratchpad` at `slot.ts` — a plain wrapper would silently
 * no-op FanOut merges). Behavior is byte-identical to the base class; the only
 * addition is state-delta emission on every mutation/read:
 *
 *  - `set`/`update`  → `agent.scratchpad.write` (before/after previews)
 *  - `get`/`reader()`→ `agent.scratchpad.read` (skipped for `backpack.*` slot
 *    keys — the observed backpack ACCESSORS own that domain's read reporting;
 *    a slot-handle fetch is plumbing, not a semantic read)
 *  - `fork`          → `agent.scratchpad.fork` (origin always `"innate"`)
 *  - `join`          → `agent.scratchpad.join` + one `agent.backpack.absorb`
 *    per branch-scoped backpack merged in (the FanOut fan-in seam), with the
 *    silent-discard case (no `merge` reducer) explicitly reported
 *
 * Installed by `NodeBackedRunner` when the run has an event bus; a run with no
 * bus gets a plain `DefaultScratchpad` and emits nothing (today's behavior).
 * Default origin is `"explicit"`; framework call sites tag their own writes
 * innate via {@link ObservedScratchpad.withOrigin} (see `sequential-agents.ts`).
 */

import { createEvent } from "../events/types.js";
import type { BackpackDisplay, StateOrigin } from "../events/types.js";
import { DefaultScratchpad, type Scratchpad, type Slot, type SlotEntry } from "./slot.js";
import { BACKPACK_SLOT_PREFIX, type StateEmitter, previewValue } from "./state-events.js";

/** Duck-typed view of a Backpack living in a slot (no import — stays layered). */
interface PackLike {
  readonly size: number;
  readonly spec?: { readonly display?: BackpackDisplay };
}

function asPack(value: unknown): PackLike | undefined {
  if (typeof value === "object" && value !== null && typeof (value as PackLike).size === "number") {
    return value as PackLike;
  }
  return undefined;
}

export class ObservedScratchpad extends DefaultScratchpad {
  /** Origin stamped on emitted events; scoped writes flip it via {@link withOrigin}. */
  private origin: StateOrigin = "explicit";

  constructor(
    readonly emitter: StateEmitter,
    runEntries?: Map<string, SlotEntry>,
    branchEntries?: Map<string, SlotEntry>,
  ) {
    super(runEntries, branchEntries);
  }

  /**
   * Run `fn` with every event this pad emits tagged `origin` — the innate-write
   * hook for framework call sites (a sequentialAgent stage emission). Restores
   * the previous origin on exit; `fn` must be synchronous (the §8.1 RMW
   * contract already requires synchronous writes).
   */
  withOrigin<T>(origin: StateOrigin, fn: () => T): T {
    const prev = this.origin;
    this.origin = origin;
    try {
      return fn();
    } finally {
      this.origin = prev;
    }
  }

  /** Common BaseEvent + StateEventBase fields (mints the next ordinal). */
  private stamp(origin: StateOrigin = this.origin): {
    traceId: string;
    runId: string;
    parentSpanId?: string;
    origin: StateOrigin;
    ordinal: number;
  } {
    return {
      traceId: this.emitter.traceId,
      runId: this.emitter.runId,
      ...(this.emitter.parentSpanId !== undefined
        ? { parentSpanId: this.emitter.parentSpanId }
        : {}),
      origin,
      ordinal: this.emitter.nextOrdinal(),
    };
  }

  private table(s: Slot<unknown>): Map<string, SlotEntry> {
    return s.scope === "run" ? this.runEntries : this.branchEntries;
  }

  override get<T>(s: Slot<T>): T {
    const value = super.get(s);
    // Backpack slot-handle fetches are plumbing (every accessor call makes one);
    // the observed accessors publish the semantic `agent.backpack.read` instead.
    if (!s.key.startsWith(BACKPACK_SLOT_PREFIX)) {
      this.emitter.publish(
        createEvent("agent.scratchpad.read", {
          ...this.stamp(),
          key: s.key,
          preview: previewValue(value),
        }),
      );
    }
    return value;
  }

  override set<T>(s: Slot<T>, value: T): void {
    const existing = this.table(s as Slot<unknown>).get(s.key);
    const hadValue = existing !== undefined;
    const before = hadValue ? previewValue(existing.value) : undefined;
    super.set(s, value);
    this.emitter.publish(
      createEvent("agent.scratchpad.write", {
        ...this.stamp(),
        key: s.key,
        op: "set",
        hadValue,
        ...(before !== undefined ? { before } : {}),
        after: previewValue(value),
      }),
    );
  }

  override update<T>(s: Slot<T>, fn: (cur: T) => T): void {
    const hadValue = this.table(s as Slot<unknown>).get(s.key) !== undefined;
    let before: string | undefined;
    let after = "";
    super.update(s, (cur) => {
      // `before` only when the slot was materialized — an init() default is not
      // a prior value the run ever observed.
      if (hadValue) before = previewValue(cur);
      const next = fn(cur);
      after = previewValue(next);
      return next;
    });
    this.emitter.publish(
      createEvent("agent.scratchpad.write", {
        ...this.stamp(),
        key: s.key,
        op: "update",
        hadValue,
        ...(before !== undefined ? { before } : {}),
        after,
      }),
    );
  }

  override fork(): Scratchpad {
    // Same sharing semantics as the base class: run entries by reference,
    // branch entries fresh. The child shares THIS emitter, so the per-run
    // ordinal stream stays single and monotonic across branches.
    const child = new ObservedScratchpad(this.emitter, this.runEntries, new Map());
    this.emitter.publish(
      createEvent("agent.scratchpad.fork", {
        ...this.stamp("innate"),
        sharedKeys: [...this.runEntries.keys()],
      }),
    );
    return child;
  }

  override join(child: Scratchpad): void {
    if (!(child instanceof DefaultScratchpad)) return;
    if (!(child instanceof ObservedScratchpad)) {
      // A foreign (uninstrumented) pad — merge exactly as the base class would;
      // we cannot introspect its entries beyond what super.join already does.
      super.join(child);
      return;
    }
    // Mirror of DefaultScratchpad.join, instrumented per slot.
    const mergedKeys: string[] = [];
    const discardedKeys: string[] = [];
    for (const entry of child.branchEntries.values()) {
      const merge = entry.slot.merge;
      if (!merge) {
        // DEFERRED: branch scratch with no reducer is discarded — the classic
        // silent-loss trap, now reported on the join event.
        discardedKeys.push(entry.slot.key);
        continue;
      }
      const parent = this.entryFor(entry.slot);
      const parentPackBefore = asPack(parent.value)?.size;
      const childSize = asPack(entry.value)?.size; // captured BEFORE the merge runs
      parent.value = merge(parent.value, entry.value);
      mergedKeys.push(entry.slot.key);

      // A branch-scoped backpack fans in via absorb inside its merge reducer —
      // report it as the semantic `agent.backpack.absorb` (the FanOut seam).
      if (
        entry.slot.key.startsWith(BACKPACK_SLOT_PREFIX) &&
        parentPackBefore !== undefined &&
        childSize !== undefined
      ) {
        const parentPackAfter = asPack(parent.value)?.size ?? parentPackBefore;
        const accepted = parentPackAfter - parentPackBefore;
        const display = asPack(parent.value)?.spec?.display;
        const appendedIndexes: number[] = [];
        for (let n = parentPackBefore + 1; n <= parentPackAfter; n += 1) appendedIndexes.push(n);
        this.emitter.publish(
          createEvent("agent.backpack.absorb", {
            ...this.stamp("innate"),
            key: entry.slot.key,
            childSize,
            accepted,
            merged: childSize - accepted,
            sizeBefore: parentPackBefore,
            sizeAfter: parentPackAfter,
            appendedIndexes,
            ...(display !== undefined ? { display } : {}),
          }),
        );
      }
    }
    this.emitter.publish(
      createEvent("agent.scratchpad.join", {
        ...this.stamp("innate"),
        mergedKeys,
        discardedKeys,
      }),
    );
  }
}
