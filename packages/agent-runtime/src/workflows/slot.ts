/**
 * Typed scoped Slot / Scratchpad — the typed replacement for `PatternContext`'s
 * shared-state duty (DESIGN §7).
 *
 * A `Slot<T>` is a module-level handle that nodes close over and access via the
 * `ScratchpadReader` / `ScratchpadAccess` passed into `prompt(input, scratchpad)` / `fn(input, scratchpad)`.
 * This keeps the `Node<TIn, TOut>` signature clean (threaded I/O only) while shared
 * state stays ambient.
 *
 *  - `scope: "run"`    — exactly one shared instance for the whole workflow tree,
 *                        lazily `init()`-ed on first access.
 *  - `scope: "branch"` — each FanOut/Parallel branch forks a fresh instance off
 *                        `init()`, so concurrent branches can't clobber each other.
 *
 * `merge` is the branch-scope REDUCER: `FanOut`/`Parallel` `join()` each branch's
 * forked value back into the parent in INDEX order after all branches settle, so
 * concurrent fan-in is deterministic (the LangGraph reducer pattern). A branch slot
 * with no `merge` simply discards its scratch at branch exit.
 */

// ---------------------------------------------------------------------------
// Slot definition
// ---------------------------------------------------------------------------

export interface Slot<T> {
  readonly key: string;
  readonly scope: "run" | "branch";
  readonly init: () => T;
  /**
   * Branch-scope reducer: combines a branch's forked value back into the parent.
   * `FanOut`/`Parallel` apply it via `join()` in INDEX order after all branches
   * settle → deterministic concurrent fan-in. Omit it and the branch's scratch is
   * discarded at branch exit.
   */
  readonly merge?: (parent: T, child: T) => T;
}

/** Identity helper that pins the `T` of a slot definition at the call site. */
export function slot<T>(def: Slot<T>): Slot<T> {
  return Object.freeze({ ...def });
}

// ---------------------------------------------------------------------------
// Access interfaces
// ---------------------------------------------------------------------------

export interface ScratchpadReader {
  get<T>(s: Slot<T>): T;
}

export interface ScratchpadAccess extends ScratchpadReader {
  /**
   * MUST be synchronous and self-contained (read-modify-write in one tick — no
   * `await` between read and write), per the §8.1 ordering contract.
   */
  set<T>(s: Slot<T>, value: T): void;
  update<T>(s: Slot<T>, fn: (cur: T) => T): void;
}

export interface Scratchpad extends ScratchpadAccess {
  /** A read-only view over this store. */
  reader(): ScratchpadReader;
  /**
   * Fork for a FanOut/Parallel branch: run-scoped scratchpad stay shared (aliased into
   * the fork); branch-scoped scratchpad are fresh (re-`init()`-ed on first access).
   */
  fork(): Scratchpad;
  /**
   * Merge a forked child back. Applies `Slot.merge` only for branch scratchpad that
   * define it (DEFERRED otherwise — §8.1); run-scoped scratchpad are already shared and
   * need no reconciliation.
   */
  join(child: Scratchpad): void;
}

// ---------------------------------------------------------------------------
// Concrete implementation
// ---------------------------------------------------------------------------

/** One materialized slot in a scratchpad table. Exported for subclasses
 *  (`ObservedScratchpad`) that need constructor/table access — not public API. */
export interface SlotEntry {
  readonly slot: Slot<unknown>;
  value: unknown;
}

/**
 * Default `Scratchpad`. Run-scoped state lives in a map that is shared by reference
 * across forks; branch-scoped state lives in a map that is fresh per store.
 *
 * The tables and `entryFor` are `protected` (not `private`) so the observed
 * decorator subclass (`observed-scratchpad.ts`, #226) can fork/join with the
 * exact same sharing semantics. They remain non-public API.
 */
export class DefaultScratchpad implements Scratchpad {
  /** Shared across all forks of the same workflow run. */
  protected readonly runEntries: Map<string, SlotEntry>;
  /** Private to this store (fresh per branch fork). */
  protected readonly branchEntries: Map<string, SlotEntry>;

  constructor(runEntries?: Map<string, SlotEntry>, branchEntries?: Map<string, SlotEntry>) {
    this.runEntries = runEntries ?? new Map();
    this.branchEntries = branchEntries ?? new Map();
  }

  protected entryFor<T>(s: Slot<T>): SlotEntry {
    const table = s.scope === "run" ? this.runEntries : this.branchEntries;
    let entry = table.get(s.key);
    if (entry === undefined) {
      entry = { slot: s as Slot<unknown>, value: s.init() };
      table.set(s.key, entry);
    }
    return entry;
  }

  get<T>(s: Slot<T>): T {
    return this.entryFor(s).value as T;
  }

  set<T>(s: Slot<T>, value: T): void {
    this.entryFor(s).value = value;
  }

  update<T>(s: Slot<T>, fn: (cur: T) => T): void {
    const entry = this.entryFor(s);
    entry.value = fn(entry.value as T);
  }

  reader(): ScratchpadReader {
    return Object.freeze({ get: <T>(s: Slot<T>): T => this.get(s) });
  }

  fork(): Scratchpad {
    // Run-scoped entries are shared by reference; branch-scoped start empty (fresh init).
    return new DefaultScratchpad(this.runEntries, new Map());
  }

  join(child: Scratchpad): void {
    if (!(child instanceof DefaultScratchpad)) return;
    for (const entry of child.branchEntries.values()) {
      const merge = entry.slot.merge;
      if (!merge) continue; // DEFERRED: discard branch scratch unless a merge is declared.
      const parent = this.entryFor(entry.slot);
      parent.value = merge(parent.value, entry.value);
    }
  }
}

/** Factory for an empty top-level store (run + branch state both fresh). */
export function createScratchpad(): Scratchpad {
  return new DefaultScratchpad();
}
