/**
 * Backpack — a run-scoped accumulator that rides the existing Slot / Scratchpad
 * plumbing (DESIGN §7) with ZERO new framework seams (issue #213).
 *
 * A `Backpack<TIn, TEntry, TFinal, TTag>` is a live, id-keyed bag that a tool
 * drops raws into during a run and a later stage (or a post-run reader) marshals
 * out of. It exists to give a multi-stage workflow ONE shared, deduped, indexed
 * evidence pool without an `onEmit` harvest tail, a `deps` closure chain, or a
 * hand-rolled `[#N]` decoder — the three things every consumer was re-inventing.
 *
 * The whole primitive is a Slot VALUE: `backpackSlot(spec)` is an ordinary
 * run-scoped `Slot<Backpack>` (key `backpack.<spec.key>`), so `slot.ts`,
 * `agent-step.ts`, `agent-runner.ts` and all of `agent-core` ship unmodified.
 * The write channel is the blessed `ToolExecutionContext.host` passthrough
 * (#124), narrowed exactly as `nodeTool` does (`node-tool.ts:57`). No event
 * types, no SSE mapping, no profile edits — the primitive is invisible to the
 * transport.
 *
 * Discipline (the issue's spooky-action clause): every spec hook is a PURE,
 * SYNCHRONOUS value transform. It receives values only — never the pad, ctx, or
 * emit — so it is structurally incapable of writing other slots, stopping a
 * stage, or emitting an event. Asynchronous I/O is the named `hydrateThenDrop`
 * opt-in, which awaits OUTSIDE the read-modify-write window; `drop()` itself is
 * synchronous end-to-end so it honours the §8.1 Scratchpad RMW contract and
 * stays race-free under the runner's `Promise.all` tool dispatch.
 */

import type { ToolExecutionContext } from "@agentic-patterns/core"; // type-only — core never learns the word Backpack
import type { DepRegistry } from "./deps.js";
import {
  type Scratchpad,
  type ScratchpadReader,
  type Slot,
  createScratchpad,
  slot,
} from "./slot.js";

// ---------------------------------------------------------------------------
// Write manifest — per-drop metadata (generalises the ledger's coverage +
// facet attribution: which drop, tagged how, covered which identities)
// ---------------------------------------------------------------------------

export interface DropRecord<TTag> {
  /** Monotonic per backpack; first drop = 0. */
  readonly seq: number;
  /** Caller-supplied write metadata (facet, coverage counts, source, …). */
  readonly tag: TTag;
  /** Identities this drop covered — post-expand, post-skip, deduped, first-touch order. */
  readonly ids: readonly string[];
  /** Non-skipped identities this drop covered (= `ids.length`, new + merged alike —
   *  deliberately NOT DropReceipt.accepted, which counts NEW identities only). */
  readonly covered: number;
  /** Raws for which `expand()` returned null/undefined. */
  readonly skipped: number;
}

export interface WriteManifest<TTag> {
  readonly records: readonly DropRecord<TTag>[];
  /** Every tag whose drop covered this identity — the generic foundBy/facet join. */
  tagsFor(id: string): readonly TTag[];
}

// ---------------------------------------------------------------------------
// The spec — the dev's declaration. ALL hooks are PURE, SYNCHRONOUS value
// transforms; no pad, no ctx, no emit ever appears in a signature.
// ---------------------------------------------------------------------------

export interface BackpackSpec<TIn, TEntry, TFinal, TTag = undefined> {
  /** Slot-key stem; the backing slot key is `backpack.<key>`. */
  readonly key: string;

  /**
   * ON-WRITE (issue `expand`): coerce one raw dropped thing → a stored entry.
   * Return null/undefined ⇒ SKIP (recorded in the manifest, not stored).
   * Throw ⇒ the drop fails LOUD at the write site, never at a later assembly
   * step. MUST be synchronous (§8.1 RMW-in-one-tick). Async hydrate =
   * {@link hydrateThenDrop}.
   */
  readonly expand: (raw: TIn) => TEntry | null | undefined;

  /**
   * IDENTITY — the dev's ONLY contract. Must be stable across re-drops of the
   * same source: it drives (a) write-time dedup/merge, (b) idempotency under
   * Retry re-runs / Loop re-entry on the shared pad, (c) the branch-scope join
   * reducer. For id-less domains, derive a DETERMINISTIC content/request hash —
   * never a sequence counter.
   */
  readonly identify: (entry: TEntry) => string;

  /**
   * Collision reducer for a re-dropped identity. Omit ⇒ last-write-wins. The
   * winner KEEPS the first-seen [#N] index. Also the branch fan-in reducer.
   */
  readonly merge?: (prev: TEntry, next: TEntry) => TEntry;

  /**
   * ON-READ (issue `finalize`): the cross-entry pass — manifest join, coverage
   * totals, global cutoffs, FINAL ordering, schema parse (fail-loud here). Pure
   * + idempotent; memoised per write generation (see {@link Backpack.finalized}).
   */
  readonly finalize: (entries: readonly TEntry[], manifest: WriteManifest<TTag>) => TFinal;

  /** Model-facing line for one entry in a view. Default: JSON one-liner. */
  readonly renderEntry?: (entry: TEntry, index: number) => string;
}

// ---------------------------------------------------------------------------
// The [#N] primitive — ONE numbering + decode authority. A view is a VALUE that
// pairs a numbering with its decode, so render and resolve can never disagree.
// ---------------------------------------------------------------------------

export interface IndexedView<TEntry> {
  readonly items: readonly {
    readonly n: number;
    readonly id: string;
    readonly entry: TEntry;
    readonly label: string;
  }[];
  /** "[#1] …\n[#2] …" — the prompt block. */
  lines(): string;
  /** Decode; OOB/duplicate indexes dropped, not fatal. */
  resolve(ns: readonly number[]): TEntry[];
  /** Keep-by-default doctrine (cut → keep the rest). */
  complement(ns: readonly number[]): TEntry[];
  idsOf(ns: readonly number[]): string[];
}

const defaultRenderEntry = (entry: unknown): string => JSON.stringify(entry);

/** Best-effort one-line preview of a raw for a fail-loud expand error (§3). */
function safeRawPreview(raw: unknown): string {
  try {
    const s = JSON.stringify(raw);
    if (s === undefined) return String(raw);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(raw);
  }
}

/**
 * Standalone: number ANY ordered entry list 1..K and carry the decode with it.
 * This is the "second index space" mechanism (e.g. a re-indexed presented view)
 * and is reusable by consumers with no backpack at all.
 */
export function indexedView<TEntry>(
  entries: readonly TEntry[],
  identify: (e: TEntry) => string,
  renderEntry?: (e: TEntry, n: number) => string,
): IndexedView<TEntry> {
  const render = renderEntry ?? ((e: TEntry) => defaultRenderEntry(e));
  const items = Object.freeze(
    entries.map((entry, i) => {
      const n = i + 1;
      return Object.freeze({ n, id: identify(entry), entry, label: render(entry, n) });
    }),
  );

  /** Dedupe + drop OOB, preserving first-seen request order. */
  const pick = (ns: readonly number[]): typeof items => {
    const seen = new Set<number>();
    const out: (typeof items)[number][] = [];
    for (const n of ns) {
      if (seen.has(n)) continue;
      seen.add(n);
      const item = items[n - 1];
      if (item !== undefined) out.push(item);
    }
    return Object.freeze(out);
  };

  return Object.freeze<IndexedView<TEntry>>({
    items,
    lines: () => items.map((it) => `[#${it.n}] ${it.label}`).join("\n"),
    resolve: (ns: readonly number[]) => Object.freeze(pick(ns).map((it) => it.entry)) as TEntry[],
    complement: (ns: readonly number[]) => {
      const cut = new Set(ns);
      return Object.freeze(items.filter((it) => !cut.has(it.n)).map((it) => it.entry)) as TEntry[];
    },
    idsOf: (ns: readonly number[]) => Object.freeze(pick(ns).map((it) => it.id)) as string[],
  });
}

// ---------------------------------------------------------------------------
// The live container (a Slot VALUE — mutable interior in, frozen views out)
// ---------------------------------------------------------------------------

export interface DropReceipt {
  /** New identities. */
  readonly accepted: number;
  /** Re-dropped identities folded via merge (or last-write-wins replaced). */
  readonly merged: number;
  /** Raws for which `expand()` returned null/undefined. */
  readonly skipped: number;
  /**
   * Canonical [#N] indexes touched by this drop, in raw order (skips omitted) —
   * the tool returns these so the model speaks handles from the first landing.
   */
  readonly indexes: readonly number[];
}

export interface Backpack<TIn, TEntry, TFinal, TTag = undefined> {
  readonly spec: BackpackSpec<TIn, TEntry, TFinal, TTag>;
  readonly size: number;

  /**
   * THE write. Synchronous end-to-end (expand → identify → merge → index →
   * manifest append in one tick, no await) — honours the §8.1 Scratchpad RMW
   * contract; race-free under the runner's `Promise.all` tool dispatch and
   * across aliased run-scoped forks.
   */
  drop(raw: TIn | readonly TIn[], tag?: TTag): DropReceipt;

  has(id: string): boolean;
  byId(id: string): TEntry | undefined;
  /** Canonical [#N] for an identity (1-based), or undefined. */
  indexOf(id: string): number | undefined;
  /** First-seen order, post-merge. */
  entries(): readonly TEntry[];
  /** Request order; unknown ids dropped. */
  get(ids: readonly string[]): TEntry[];
  manifest(): WriteManifest<TTag>;

  /**
   * SELF-MARSHAL: finalize-on-read. Memoised against an internal write
   * generation — repeated reads are free; any drop/absorb invalidates the memo.
   */
  finalized(): TFinal;

  /**
   * The CANONICAL [#N] view: every entry, first-seen order, stable append-only
   * indexes (assigned at first drop, never renumbered; merge keeps the original
   * index; nothing is ever removed — a shown handle never dangles). Second index
   * spaces are minted with the standalone {@link indexedView} over any subset.
   */
  view(): IndexedView<TEntry>;

  /**
   * Entry-level replay of another pack (identify + merge apply; manifests
   * concatenated). The branch-scope `Slot.merge` reducer; type-sound
   * (TEntry-level, never re-expands). Deterministic under `join()`'s
   * index-order application.
   */
  absorb(other: Backpack<TIn, TEntry, TFinal, TTag>): void;
}

class BackpackImpl<TIn, TEntry, TFinal, TTag> implements Backpack<TIn, TEntry, TFinal, TTag> {
  /** Current merged entry per identity. */
  private readonly entriesById = new Map<string, TEntry>();
  /** Canonical 1-based index per identity (append-only, never renumbered). */
  private readonly indexById = new Map<string, number>();
  /** First-seen identity order — `order[i]` has canonical index `i + 1`. */
  private readonly order: string[] = [];
  private readonly records: DropRecord<TTag>[] = [];

  /** Bumped by every drop/absorb; invalidates the finalize memo. */
  private writeGen = 0;
  private finalizeMemo?: { gen: number; value: TFinal };
  /** True while drop()/absorb() runs. A hook that synchronously re-enters would
   *  mint colliding indexes off a stale staging cursor — fail loud instead. */
  private mutating = false;

  private guardReentry(op: "drop" | "absorb"): void {
    if (this.mutating) {
      throw new Error(
        `Backpack '${this.spec.key}' ${op}() re-entered from inside a hook — hooks are pure value transforms and must not touch the pack.`,
      );
    }
  }

  constructor(readonly spec: BackpackSpec<TIn, TEntry, TFinal, TTag>) {}

  get size(): number {
    return this.order.length;
  }

  drop(raw: TIn | readonly TIn[], tag?: TTag): DropReceipt {
    this.guardReentry("drop");
    const raws = Array.isArray(raw) ? (raw as readonly TIn[]) : [raw as TIn];
    // Empty batch = a true no-op: no record, no writeGen bump (a busted finalize
    // memo for zero entries would be pure waste).
    if (raws.length === 0) {
      return Object.freeze({ accepted: 0, merged: 0, skipped: 0, indexes: Object.freeze([]) });
    }
    this.mutating = true;
    try {
      let accepted = 0;
      let merged = 0;
      let skipped = 0;
      const indexes: number[] = [];
      const coveredIds: string[] = [];
      const coveredSet = new Set<string>();

      // ── PHASE 1: compute into a staging buffer. Every developer hook (expand,
      // identify, merge) runs HERE, touching NO instance field. So a throw from any
      // hook leaves the store byte-identical — the drop is atomic. Committing per-raw
      // (the naive form) would leave partial entries with no manifest record and no
      // writeGen bump, so finalized() would keep serving a stale memo that contradicts
      // entries()/view()/size (§3 "any drop invalidates the memo"). ──
      const stagedValues = new Map<string, TEntry>(); // final value per touched id
      const stagedNewOrder: string[] = []; // new ids, in first-seen order
      const stagedNewIndex = new Map<string, number>(); // provisional index for new ids
      let nextIdx = this.order.length; // pre-increment ⇒ first new id = order.length + 1

      for (let i = 0; i < raws.length; i++) {
        const one = raws[i] as TIn;
        let entry: TEntry | null | undefined;
        try {
          entry = this.spec.expand(one); // throw ⇒ fails loud here, at the write site
        } catch (err) {
          // §3: fail LOUD with the offending raw in the error (not just the hook's
          // own message). Preserve the original message so a hook that already names
          // the raw still surfaces cleanly, and attach the cause.
          throw new Error(
            `Backpack '${this.spec.key}' expand() threw on raw ${i} (${safeRawPreview(one)}): ${
              err instanceof Error ? err.message : String(err)
            }`,
            { cause: err },
          );
        }
        if (entry === null || entry === undefined) {
          skipped += 1;
          continue;
        }
        const id = this.spec.identify(entry);
        const committed = this.entriesById.has(id);
        const staged = stagedValues.has(id);
        if (committed || staged) {
          const prev = (staged ? stagedValues.get(id) : this.entriesById.get(id)) as TEntry;
          stagedValues.set(id, this.spec.merge ? this.spec.merge(prev, entry) : entry);
          merged += 1;
          indexes.push((committed ? this.indexById.get(id) : stagedNewIndex.get(id)) as number);
        } else {
          nextIdx += 1; // 1-based, first-seen, append-only
          stagedNewOrder.push(id);
          stagedNewIndex.set(id, nextIdx);
          stagedValues.set(id, entry);
          accepted += 1;
          indexes.push(nextIdx);
        }
        if (!coveredSet.has(id)) {
          coveredSet.add(id);
          coveredIds.push(id);
        }
      }

      // ── PHASE 2: commit. No developer hook runs from here — only pure Map/array
      // writes, so this can never throw and the mutation is all-or-nothing. ──
      for (const id of stagedNewOrder) {
        this.order.push(id);
        this.indexById.set(id, stagedNewIndex.get(id) as number);
      }
      for (const [id, value] of stagedValues) {
        this.entriesById.set(id, value);
      }
      this.records.push(
        Object.freeze({
          seq: this.records.length,
          tag: tag as TTag,
          ids: Object.freeze(coveredIds),
          covered: coveredIds.length,
          skipped,
        }),
      );
      this.writeGen += 1;

      return Object.freeze({ accepted, merged, skipped, indexes: Object.freeze(indexes) });
    } finally {
      this.mutating = false;
    }
  }

  has(id: string): boolean {
    return this.entriesById.has(id);
  }

  byId(id: string): TEntry | undefined {
    return this.entriesById.get(id);
  }

  indexOf(id: string): number | undefined {
    return this.indexById.get(id);
  }

  entries(): readonly TEntry[] {
    return Object.freeze(this.order.map((id) => this.entriesById.get(id) as TEntry));
  }

  get(ids: readonly string[]): TEntry[] {
    const out: TEntry[] = [];
    for (const id of ids) {
      const entry = this.entriesById.get(id);
      if (entry !== undefined) out.push(entry);
    }
    return Object.freeze(out) as TEntry[];
  }

  manifest(): WriteManifest<TTag> {
    const records = Object.freeze([...this.records]);
    return Object.freeze({
      records,
      tagsFor: (id: string): readonly TTag[] =>
        Object.freeze(records.filter((r) => r.ids.includes(id)).map((r) => r.tag)),
    });
  }

  finalized(): TFinal {
    // The returned value IS the memo (shared across reads until the next drop):
    // treat it as immutable — mutating it in place poisons every subsequent read.
    if (this.finalizeMemo?.gen === this.writeGen) return this.finalizeMemo.value;
    const value = this.spec.finalize(this.entries(), this.manifest());
    this.finalizeMemo = { gen: this.writeGen, value };
    return value;
  }

  view(): IndexedView<TEntry> {
    return indexedView(this.entries(), this.spec.identify, this.spec.renderEntry);
  }

  absorb(other: Backpack<TIn, TEntry, TFinal, TTag>): void {
    this.guardReentry("absorb");
    // absorb(self) is a no-op: replaying a pack into itself would double every
    // merged value and duplicate the manifest for zero information.
    if ((other as unknown) === this) return;
    this.mutating = true;
    try {
      // Entry-level replay: identify + merge apply, but never re-expand. New ids
      // append after the parent's, so parent indexes stay stable. Two-phase for the
      // same atomicity reason as drop(): identify/merge run in PHASE 1 against a
      // staging buffer, so a mid-replay throw leaves the parent untouched (no torn
      // state, no stale finalize memo).
      const otherEntries = other.entries();
      const otherRecords = other.manifest().records; // read before mutating
      const stagedValues = new Map<string, TEntry>();
      const stagedNewOrder: string[] = [];
      for (const entry of otherEntries) {
        const id = this.spec.identify(entry);
        const committed = this.entriesById.has(id);
        const staged = stagedValues.has(id);
        if (committed || staged) {
          const prev = (staged ? stagedValues.get(id) : this.entriesById.get(id)) as TEntry;
          stagedValues.set(id, this.spec.merge ? this.spec.merge(prev, entry) : entry);
        } else {
          stagedNewOrder.push(id);
          stagedValues.set(id, entry);
        }
      }

      // COMMIT — pure Map/array writes only; cannot throw.
      for (const id of stagedNewOrder) {
        this.order.push(id);
        this.indexById.set(id, this.order.length);
      }
      for (const [id, value] of stagedValues) {
        this.entriesById.set(id, value);
      }
      // Concatenate manifests, reseqing to stay monotonic per backpack.
      for (const rec of otherRecords) {
        this.records.push(Object.freeze({ ...rec, seq: this.records.length }));
      }
      this.writeGen += 1;
    } finally {
      this.mutating = false;
    }
  }
}

export function createBackpack<TIn, TEntry, TFinal, TTag = undefined>(
  spec: BackpackSpec<TIn, TEntry, TFinal, TTag>,
): Backpack<TIn, TEntry, TFinal, TTag> {
  return new BackpackImpl(spec);
}

// ---------------------------------------------------------------------------
// Slot binding — the backpack IS the slot value. Memoised per spec (WeakMap),
// so every call site gets the IDENTICAL frozen Slot: usable directly in a
// stage's reads/writes, and same-key/divergent-spec aliasing is impossible.
// ---------------------------------------------------------------------------

// Value is `unknown` (per-spec homogeneous but heterogeneous across specs); the
// public fn re-narrows on read. Keyed by the spec object ⇒ canonical handle.
const slotCache = new WeakMap<object, Slot<unknown>>();

// Fail-loud guard behind the §2 "same-key/divergent-spec aliasing is impossible"
// claim. The WeakMap alone cannot deliver it: DefaultScratchpad stores by the slot
// KEY STRING (slot.ts:100-108), so two DISTINCT spec objects sharing `key` would
// each mint a slot keyed `backpack.<key>` and silently alias to ONE pack running
// only the first spec's hooks. This registry maps slot-key → owning spec and throws
// on a divergent re-registration. Held via WeakRef so a GC'd spec frees its key
// (matching slotCache's non-retaining intent) and can be legitimately rebound.
// NOTE: the string key itself is retained until rebound (only the spec is weakly
// held) — spec keys are meant to be STATIC module-scope constants, not
// runtime-generated; a dead ref is evicted on the next lookup either way.
const keyOwners = new Map<string, WeakRef<object>>();

export function backpackSlot<TIn, TEntry, TFinal, TTag = undefined>(
  spec: BackpackSpec<TIn, TEntry, TFinal, TTag>,
  /** Default "run"; opts are only honoured on the FIRST call per spec (WeakMap-memoised). */
  opts?: { scope?: "run" | "branch" },
): Slot<Backpack<TIn, TEntry, TFinal, TTag>> {
  const cached = slotCache.get(spec);
  if (cached) {
    // Same spec object: canonical handle. A CONFLICTING scope on a later call must
    // not be silently swallowed (it would make branch-vs-run depend on module
    // evaluation order); fail loud instead.
    if (opts?.scope && opts.scope !== cached.scope) {
      throw new Error(
        `Backpack '${spec.key}' was already bound with scope '${cached.scope}'; a later backpackSlot() call requested scope '${opts.scope}'. A backpack's scope is fixed on first use — pass the scope on the first call, or use a distinct spec/key.`,
      );
    }
    return cached as Slot<Backpack<TIn, TEntry, TFinal, TTag>>;
  }

  const slotKey = `backpack.${spec.key}`;
  const ownerRef = keyOwners.get(slotKey);
  const owner = ownerRef?.deref();
  if (ownerRef !== undefined && owner === undefined) keyOwners.delete(slotKey); // GC'd spec — free the key
  if (owner !== undefined && owner !== spec) {
    throw new Error(
      `Backpack key '${spec.key}' is already bound to a different spec object. Each backpack key must map to exactly one spec (they share the string-keyed Scratchpad slot and would silently alias). Reuse the same spec instance, or pick a distinct key.`,
    );
  }

  const scope = opts?.scope ?? "run";
  const s = slot<Backpack<TIn, TEntry, TFinal, TTag>>({
    key: slotKey,
    scope,
    init: () => createBackpack(spec),
    merge:
      scope === "branch"
        ? (parent, child) => {
            parent.absorb(child);
            return parent;
          }
        : undefined,
  });
  slotCache.set(spec, s as Slot<unknown>);
  keyOwners.set(slotKey, new WeakRef(spec));
  return s;
}

// ---------------------------------------------------------------------------
// Tool-side accessors — narrow ctx.host EXACTLY as nodeTool does
// (node-tool.ts:57), then pad.get(backpackSlot(spec)); the Scratchpad lazily
// init()s the pack on first touch. No closure capture, no deps factory.
// ---------------------------------------------------------------------------

export class BackpackUnavailableError extends Error {
  constructor(key: string, who?: string) {
    const where = who ? ` (reader "${who}")` : "";
    super(
      `Backpack '${key}'${where} needs a host-provided scratchpad. Run this agent inside an AgentStep/sequentialAgent, or pass RunOptions.host = { scratchpad } on a bare runner (see createRunHost()).`,
    );
    this.name = "BackpackUnavailableError";
  }
}

function padFromCtx(ctx: ToolExecutionContext | undefined): Scratchpad | undefined {
  const host = ctx?.host as { scratchpad?: Scratchpad } | undefined;
  return host?.scratchpad;
}

/**
 * Soft probe — undefined when the run has no host/pad. Use ONLY for tools that
 * genuinely must run pad-less; the write path default is {@link requireBackpack}.
 */
export function openBackpack<TIn, TEntry, TFinal, TTag = undefined>(
  ctx: ToolExecutionContext | undefined,
  spec: BackpackSpec<TIn, TEntry, TFinal, TTag>,
): Backpack<TIn, TEntry, TFinal, TTag> | undefined {
  const pad = padFromCtx(ctx);
  return pad ? pad.get(backpackSlot(spec)) : undefined;
}

/**
 * Fail-loud accessor — the DEFAULT write path. A mis-hosted run must never
 * silently lose drops. Throws {@link BackpackUnavailableError} with remediation.
 */
export function requireBackpack<TIn, TEntry, TFinal, TTag = undefined>(
  ctx: ToolExecutionContext | undefined,
  spec: BackpackSpec<TIn, TEntry, TFinal, TTag>,
): Backpack<TIn, TEntry, TFinal, TTag> {
  const pad = padFromCtx(ctx);
  if (!pad) throw new BackpackUnavailableError(spec.key);
  return pad.get(backpackSlot(spec));
}

/** Pad-side fail-loud read (stage prompts, post-run readers, eval probes). */
export function readBackpack<TIn, TEntry, TFinal, TTag = undefined>(
  pad: ScratchpadReader,
  spec: BackpackSpec<TIn, TEntry, TFinal, TTag>,
  who: string,
): Backpack<TIn, TEntry, TFinal, TTag> {
  if (!pad) throw new BackpackUnavailableError(spec.key, who);
  return pad.get(backpackSlot(spec));
}

// ---------------------------------------------------------------------------
// Bare-runner affordance — mint the host from ABOVE. The runner stays a pure
// conduit; a runner-minted pad would be unreachable by the caller, hence useless.
// ---------------------------------------------------------------------------

export function createRunHost(
  scratchpad?: Scratchpad,
  deps?: DepRegistry,
): {
  /** Pass as `RunOptions.host`. */
  readonly host: { scratchpad: Scratchpad; deps?: DepRegistry };
  readonly scratchpad: Scratchpad;
  open<TIn, TEntry, TFinal, TTag>(
    spec: BackpackSpec<TIn, TEntry, TFinal, TTag>,
  ): Backpack<TIn, TEntry, TFinal, TTag>;
} {
  const pad = scratchpad ?? createScratchpad();
  return Object.freeze({
    host: { scratchpad: pad, deps },
    scratchpad: pad,
    open: <TIn, TEntry, TFinal, TTag>(spec: BackpackSpec<TIn, TEntry, TFinal, TTag>) =>
      pad.get(backpackSlot(spec)),
  });
}

// ---------------------------------------------------------------------------
// Named async-hydrate opt-in — I/O happens OUTSIDE the read-modify-write window;
// the drop itself stays synchronous. The client comes from the TOOL's own deps,
// never from the spec, so hooks stay pure.
// ---------------------------------------------------------------------------

export async function hydrateThenDrop<TRaw, TIn, TEntry, TFinal, TTag>(
  pack: Backpack<TIn, TEntry, TFinal, TTag>,
  raws: readonly TRaw[],
  hydrate: (raws: readonly TRaw[]) => Promise<readonly TIn[]>,
  tag?: TTag,
): Promise<DropReceipt> {
  const ins = await hydrate(raws); // I/O outside the RMW window
  return pack.drop(ins, tag); // one synchronous drop
}
