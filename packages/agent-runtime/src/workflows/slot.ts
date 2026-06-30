/**
 * Typed scoped Slot / Backpack — the typed replacement for `PatternContext`'s
 * shared-state duty (DESIGN §7).
 *
 * A `Slot<T>` is a module-level handle that nodes close over and access via the
 * `SlotReader` / `SlotAccess` passed into `prompt(input, slots)` / `fn(input, slots)`.
 * This keeps the `Node<TIn, TOut>` signature clean (threaded I/O only) while shared
 * state stays ambient.
 *
 *  - `scope: "run"`    — exactly one shared instance for the whole workflow tree,
 *                        lazily `init()`-ed on first access.
 *  - `scope: "branch"` — each FanOut/Parallel branch forks a fresh instance off
 *                        `init()`, so concurrent branches can't clobber each other.
 *
 * `merge` is DEFERRED (Open-Q1, §8.1): declared in the type but only applied by
 * `join()` when a slot actually defines it. Branch slots shipped for real cases
 * define no `merge`, so branch scratch is discarded at branch exit.
 */

// ---------------------------------------------------------------------------
// Slot definition
// ---------------------------------------------------------------------------

export interface Slot<T> {
  readonly key: string;
  readonly scope: "run" | "branch";
  readonly init: () => T;
  /**
   * Branch-scope reconciliation. DEFERRED (Open-Q1, §8.1) — declared but not
   * auto-invoked until concurrent branch-writes are actually enabled. `join()`
   * applies it only when defined.
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

export interface SlotReader {
  get<T>(s: Slot<T>): T;
}

export interface SlotAccess extends SlotReader {
  /**
   * MUST be synchronous and self-contained (read-modify-write in one tick — no
   * `await` between read and write), per the §8.1 ordering contract.
   */
  set<T>(s: Slot<T>, value: T): void;
  update<T>(s: Slot<T>, fn: (cur: T) => T): void;
}

export interface SlotStore extends SlotAccess {
  /** A read-only view over this store. */
  reader(): SlotReader;
  /**
   * Fork for a FanOut/Parallel branch: run-scoped slots stay shared (aliased into
   * the fork); branch-scoped slots are fresh (re-`init()`-ed on first access).
   */
  fork(): SlotStore;
  /**
   * Merge a forked child back. Applies `Slot.merge` only for branch slots that
   * define it (DEFERRED otherwise — §8.1); run-scoped slots are already shared and
   * need no reconciliation.
   */
  join(child: SlotStore): void;
}

// ---------------------------------------------------------------------------
// Concrete implementation
// ---------------------------------------------------------------------------

interface SlotEntry {
  readonly slot: Slot<unknown>;
  value: unknown;
}

/**
 * Default `SlotStore`. Run-scoped state lives in a map that is shared by reference
 * across forks; branch-scoped state lives in a map that is fresh per store.
 */
export class DefaultSlotStore implements SlotStore {
  /** Shared across all forks of the same workflow run. */
  private readonly runEntries: Map<string, SlotEntry>;
  /** Private to this store (fresh per branch fork). */
  private readonly branchEntries: Map<string, SlotEntry>;

  constructor(runEntries?: Map<string, SlotEntry>, branchEntries?: Map<string, SlotEntry>) {
    this.runEntries = runEntries ?? new Map();
    this.branchEntries = branchEntries ?? new Map();
  }

  private entryFor<T>(s: Slot<T>): SlotEntry {
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

  reader(): SlotReader {
    return Object.freeze({ get: <T>(s: Slot<T>): T => this.get(s) });
  }

  fork(): SlotStore {
    // Run-scoped entries are shared by reference; branch-scoped start empty (fresh init).
    return new DefaultSlotStore(this.runEntries, new Map());
  }

  join(child: SlotStore): void {
    if (!(child instanceof DefaultSlotStore)) return;
    for (const entry of child.branchEntries.values()) {
      const merge = entry.slot.merge;
      if (!merge) continue; // DEFERRED: discard branch scratch unless a merge is declared.
      const parent = this.entryFor(entry.slot);
      parent.value = merge(parent.value, entry.value);
    }
  }
}

/** Factory for an empty top-level store (run + branch state both fresh). */
export function createSlotStore(): SlotStore {
  return new DefaultSlotStore();
}
