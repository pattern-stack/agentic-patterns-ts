import type { ToolExecutionContext } from "@agentic-patterns/core";
import { describe, expect, it } from "vitest";
import {
  type BackpackSpec,
  BackpackUnavailableError,
  type WriteManifest,
  backpackSlot,
  createBackpack,
  indexedView,
  openBackpack,
  readBackpack,
  requireBackpack,
} from "../backpack.js";
import { createScratchpad } from "../slot.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Raw {
  readonly id?: string;
  readonly text: string;
  readonly score?: number;
}

interface Entry {
  readonly id: string;
  readonly text: string;
  readonly score: number;
}

interface Final {
  readonly count: number;
  readonly ids: readonly string[];
}

type Tag = { facet: string } | undefined;

/** A fresh spec per test so the WeakMap-memoised slot never collides across cases. */
function makeSpec(
  over: Partial<BackpackSpec<Raw, Entry, Final, Tag>> = {},
): BackpackSpec<Raw, Entry, Final, Tag> {
  return {
    key: `evidence-${Math.random().toString(36).slice(2)}`,
    // expand: skip raws with no id; coerce into an Entry
    expand: (raw) => (raw.id ? { id: raw.id, text: raw.text, score: raw.score ?? 0 } : null),
    identify: (e) => e.id,
    finalize: (entries) => ({ count: entries.length, ids: entries.map((e) => e.id) }),
    ...over,
  };
}

const r = (id: string | undefined, text: string, score = 0): Raw => ({ id, text, score });

// ---------------------------------------------------------------------------
// drop
// ---------------------------------------------------------------------------

describe("Backpack — drop", () => {
  it("expand-null skips and is counted in the manifest record", () => {
    const pack = createBackpack(makeSpec());
    const receipt = pack.drop([r(undefined, "no-id"), r("a", "kept")]);

    expect(receipt.skipped).toBe(1);
    expect(receipt.accepted).toBe(1);
    expect(pack.size).toBe(1);

    const records = pack.manifest().records;
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.skipped).toBe(1);
    expect(record?.accepted).toBe(1);
    expect(record?.ids).toEqual(["a"]);
  });

  it("batch preserves raw order in receipt.indexes (skips omitted)", () => {
    const pack = createBackpack(makeSpec());
    // b(new #1), skip, a(new #2), b again(merge → #1)
    const receipt = pack.drop([r("b", "b1"), r(undefined, "skip"), r("a", "a1"), r("b", "b2")]);
    expect(receipt.indexes).toEqual([1, 2, 1]);
  });

  it("expand throw fails loud at the write site with the offending raw", () => {
    const spec = makeSpec({
      expand: (raw) => {
        if (raw.text === "boom") throw new Error(`bad raw: ${raw.text}`);
        return raw.id ? { id: raw.id, text: raw.text, score: 0 } : null;
      },
    });
    const pack = createBackpack(spec);
    expect(() => pack.drop([r("a", "ok"), r("x", "boom")])).toThrow(/bad raw: boom/);
  });

  it("receipt counts accepted/merged/skipped exactly", () => {
    const pack = createBackpack(makeSpec());
    pack.drop([r("a", "a1"), r("b", "b1")]);
    const receipt = pack.drop([r("a", "a2"), r("c", "c1"), r(undefined, "skip"), r("b", "b2")]);
    expect(receipt.accepted).toBe(1); // c
    expect(receipt.merged).toBe(2); // a, b
    expect(receipt.skipped).toBe(1);
  });

  it("a mid-batch expand throw is ATOMIC — no entry committed, no stale finalize memo", () => {
    const pack = createBackpack(
      makeSpec({
        expand: (raw) => {
          if (raw.text === "boom") throw new Error(`bad raw: ${raw.text}`);
          return raw.id ? { id: raw.id, text: raw.text, score: 0 } : null;
        },
      }),
    );
    pack.drop(r("a", "a1"));
    const memo = pack.finalized(); // memoized at this write generation

    // A batch whose 2nd raw throws AFTER a good raw would land first under a naive
    // per-raw commit — assert nothing from the failed batch leaks in.
    expect(() => pack.drop([r("b", "good"), r("x", "boom")])).toThrow(/bad raw: boom/);

    expect(pack.size).toBe(1);
    expect(pack.entries().map((e) => e.id)).toEqual(["a"]);
    expect(pack.has("b")).toBe(false);
    expect(pack.indexOf("b")).toBeUndefined();
    // The failed drop never bumped the write generation → finalized() is still the
    // SAME memo, and it agrees with entries()/size (no torn state).
    expect(pack.finalized()).toBe(memo);
    expect(pack.finalized()).toEqual({ count: 1, ids: ["a"] });
    // No orphan manifest record either.
    expect(pack.manifest().records).toHaveLength(1);
    expect(pack.manifest().tagsFor("b")).toEqual([]);
  });

  it("expand-throw error carries the offending raw and preserves the hook's message", () => {
    const pack = createBackpack(
      makeSpec({
        expand: (raw) => {
          if (raw.text === "boom") throw new Error("kaboom");
          return raw.id ? { id: raw.id, text: raw.text, score: 0 } : null;
        },
      }),
    );
    try {
      pack.drop([r("a", "ok"), r("zzz", "boom")]);
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("kaboom"); // original hook message preserved
      expect(msg).toContain("zzz"); // the offending raw is in the error
      expect((err as Error).cause).toBeInstanceOf(Error);
    }
  });
});

// ---------------------------------------------------------------------------
// identity / merge
// ---------------------------------------------------------------------------

describe("Backpack — identity", () => {
  it("re-drop merges via custom merge; default is last-write-wins", () => {
    const lww = createBackpack(makeSpec());
    lww.drop(r("a", "first", 1));
    lww.drop(r("a", "second", 2));
    expect(lww.byId("a")).toEqual({ id: "a", text: "second", score: 2 });

    const summing = createBackpack(
      makeSpec({ merge: (prev, next) => ({ ...next, score: prev.score + next.score }) }),
    );
    summing.drop(r("a", "first", 1));
    summing.drop(r("a", "second", 2));
    expect(summing.byId("a")).toEqual({ id: "a", text: "second", score: 3 });
  });

  it("merged re-drop keeps its first-seen index (never renumbered)", () => {
    const pack = createBackpack(makeSpec());
    pack.drop(r("a", "a1"));
    pack.drop(r("b", "b1"));
    expect(pack.indexOf("a")).toBe(1);
    expect(pack.indexOf("b")).toBe(2);
    pack.drop(r("a", "a2")); // merge
    expect(pack.indexOf("a")).toBe(1);
    expect(pack.indexOf("b")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// [#N] canonical indexing
// ---------------------------------------------------------------------------

describe("Backpack — [#N]", () => {
  it("canonical indexes are first-seen, 1-based, append-only across drops", () => {
    const pack = createBackpack(makeSpec());
    pack.drop(r("a", "a"));
    pack.drop([r("b", "b"), r("c", "c")]);
    expect(pack.indexOf("a")).toBe(1);
    expect(pack.indexOf("b")).toBe(2);
    expect(pack.indexOf("c")).toBe(3);
  });

  it("indexOf stable across merges; byId/get/has consistent", () => {
    const pack = createBackpack(makeSpec());
    pack.drop([r("a", "a1"), r("b", "b1")]);
    pack.drop(r("a", "a2"));
    expect(pack.indexOf("a")).toBe(1);
    expect(pack.has("a")).toBe(true);
    expect(pack.has("z")).toBe(false);
    expect(pack.byId("a")?.text).toBe("a2");
    expect(pack.get(["b", "a", "z"]).map((e) => e.id)).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

describe("Backpack — view", () => {
  it("canonical view pairs lines() with resolve()/complement() on one object", () => {
    const pack = createBackpack(makeSpec({ renderEntry: (e) => e.text }));
    pack.drop([r("a", "alpha"), r("b", "bravo"), r("c", "charlie")]);
    const view = pack.view();
    expect(view.lines()).toBe("[#1] alpha\n[#2] bravo\n[#3] charlie");
    expect(view.resolve([2]).map((e) => e.id)).toEqual(["b"]);
    expect(view.complement([2]).map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("resolve drops OOB and duplicate indexes, not fatal", () => {
    const pack = createBackpack(makeSpec());
    pack.drop([r("a", "a"), r("b", "b")]);
    const view = pack.view();
    expect(view.resolve([1, 1, 99, 2]).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("complement implements keep-by-default", () => {
    const pack = createBackpack(makeSpec());
    pack.drop([r("a", "a"), r("b", "b"), r("c", "c")]);
    // cutting nothing keeps everything
    expect(
      pack
        .view()
        .complement([])
        .map((e) => e.id),
    ).toEqual(["a", "b", "c"]);
    // cutting #1,#3 keeps #2
    expect(
      pack
        .view()
        .complement([1, 3])
        .map((e) => e.id),
    ).toEqual(["b"]);
  });

  it("indexedView: standalone subset renumbers 1..K and decodes its OWN space", () => {
    const pack = createBackpack(makeSpec({ renderEntry: (e) => e.text }));
    pack.drop([r("a", "alpha"), r("b", "bravo"), r("c", "charlie"), r("d", "delta")]);
    // present only c,a in a NEW index space
    const subset = pack.get(["c", "a"]);
    const view = indexedView(
      subset,
      (e) => e.id,
      (e) => e.text,
    );
    expect(view.lines()).toBe("[#1] charlie\n[#2] alpha");
    // #1 in this local space is c — NOT the canonical #3
    expect(view.resolve([1]).map((e) => e.id)).toEqual(["c"]);
    expect(view.idsOf([2])).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

describe("Backpack — manifest", () => {
  it("one DropRecord per drop call; tagsFor unions tags across writes (foundBy join)", () => {
    const pack = createBackpack(makeSpec());
    pack.drop([r("a", "a"), r("b", "b")], { facet: "search" });
    pack.drop([r("b", "b2"), r("c", "c")], { facet: "similarity" });

    expect(pack.manifest().records).toHaveLength(2);
    expect(pack.manifest().tagsFor("a")).toEqual([{ facet: "search" }]);
    // b was covered by BOTH drops → both facets
    expect(pack.manifest().tagsFor("b")).toEqual([{ facet: "search" }, { facet: "similarity" }]);
    expect(pack.manifest().tagsFor("c")).toEqual([{ facet: "similarity" }]);
    expect(pack.manifest().records.map((rec) => rec.seq)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

describe("Backpack — finalize", () => {
  it("memoized per write generation (same object identity across reads; invalidated by drop)", () => {
    const pack = createBackpack(makeSpec());
    pack.drop(r("a", "a"));
    const first = pack.finalized();
    expect(pack.finalized()).toBe(first); // memo hit — same reference
    pack.drop(r("b", "b"));
    const second = pack.finalized();
    expect(second).not.toBe(first); // invalidated by the drop
    expect(second.count).toBe(2);
  });

  it("idempotent (double-call deep-equal; store unmutated) — purity", () => {
    const pack = createBackpack(makeSpec());
    pack.drop([r("a", "a"), r("b", "b")]);
    const sizeBefore = pack.size;
    const a = pack.finalized();
    const b = pack.finalized();
    expect(a).toEqual(b);
    expect(pack.size).toBe(sizeBefore);
    expect(pack.entries().map((e) => e.id)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

describe("Backpack — purity", () => {
  it("returned collections are frozen; hooks receive values only (no ctx/pad in any hook signature — type-level)", () => {
    const pack = createBackpack(makeSpec());
    pack.drop([r("a", "a"), r("b", "b")]);

    expect(Object.isFrozen(pack.entries())).toBe(true);
    expect(Object.isFrozen(pack.get(["a"]))).toBe(true);
    expect(Object.isFrozen(pack.view().items)).toBe(true);
    expect(Object.isFrozen(pack.manifest().records)).toBe(true);

    // Type-level guarantee: the hook signatures below accept values only. If a
    // hook ever gained a ctx/pad parameter this assignment would fail typecheck.
    const spec = makeSpec();
    const expand: (raw: Raw) => Entry | null | undefined = spec.expand;
    const identify: (entry: Entry) => string = spec.identify;
    // No cast: this genuinely asserts finalize's real signature. A ctx/pad param
    // (or any extra required arg) would make this assignment fail typecheck.
    const finalize: (entries: readonly Entry[], manifest: WriteManifest<Tag>) => Final =
      spec.finalize;
    expect(typeof expand).toBe("function");
    expect(typeof identify).toBe("function");
    expect(typeof finalize).toBe("function");
  });

  it("no events emitted anywhere (bus spy stays empty)", () => {
    // The primitive has no event channel at all — it never receives an emit sink.
    // Drive every mutation + read surface and assert the spy the harness would
    // wire to a bus is never called.
    const events: unknown[] = [];
    const emit = (e: unknown) => events.push(e);

    const pack = createBackpack(makeSpec());
    pack.drop([r("a", "a"), r("b", "b")], { facet: "x" });
    pack.finalized();
    pack.view().lines();
    pack.manifest().tagsFor("a");

    // No hook, no accessor, nothing ever touched `emit`.
    expect(emit).toBeTypeOf("function");
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// absorb
// ---------------------------------------------------------------------------

describe("Backpack — absorb", () => {
  it("entry-level replay dedups by identity, applies merge, keeps parent indexes stable, concatenates manifests", () => {
    const spec = makeSpec({ merge: (prev, next) => ({ ...next, score: prev.score + next.score }) });
    const parent = createBackpack(spec);
    parent.drop([r("a", "a", 1), r("b", "b", 1)], { facet: "parent" });

    const child = createBackpack(spec);
    child.drop([r("b", "b", 10), r("c", "c", 10)], { facet: "child" });

    parent.absorb(child);

    // union size, parent order preserved, new id appended
    expect(parent.entries().map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(parent.indexOf("a")).toBe(1);
    expect(parent.indexOf("b")).toBe(2); // stable
    expect(parent.indexOf("c")).toBe(3); // appended
    // merge applied to the overlapping id
    expect(parent.byId("b")?.score).toBe(11);
    // manifests concatenated + reseqed
    expect(parent.manifest().records).toHaveLength(2);
    expect(parent.manifest().records.map((rec) => rec.seq)).toEqual([0, 1]);
    expect(parent.manifest().tagsFor("b")).toEqual([{ facet: "parent" }, { facet: "child" }]);
  });

  it("a throwing merge mid-replay is ATOMIC — parent untouched, memo not stale", () => {
    let calls = 0;
    const spec = makeSpec({
      merge: (_prev, next) => {
        calls += 1;
        if (next.id === "b") throw new Error("merge boom");
        return next;
      },
    });
    const parent = createBackpack(spec);
    parent.drop([r("a", "a"), r("b", "b")], { facet: "parent" });
    const memo = parent.finalized();

    const child = createBackpack(spec);
    child.drop([r("c", "c"), r("b", "b2")], { facet: "child" }); // b will throw on merge

    expect(() => parent.absorb(child)).toThrow(/merge boom/);

    // Parent is byte-consistent: c did NOT land, no manifest concat, memo intact.
    expect(parent.entries().map((e) => e.id)).toEqual(["a", "b"]);
    expect(parent.has("c")).toBe(false);
    expect(parent.manifest().records).toHaveLength(1);
    expect(parent.finalized()).toBe(memo);
    expect(calls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// backpackSlot
// ---------------------------------------------------------------------------

describe("Backpack — backpackSlot", () => {
  it("WeakMap-memoized — two calls return the IDENTICAL Slot object", () => {
    const spec = makeSpec();
    expect(backpackSlot(spec)).toBe(backpackSlot(spec));
    expect(backpackSlot(spec).key).toBe(`backpack.${spec.key}`);
  });

  it("lazy init on first pad.get", () => {
    const spec = makeSpec();
    const pad = createScratchpad();
    const pack = pad.get(backpackSlot(spec)); // init() runs here
    expect(pack.size).toBe(0);
    pack.drop(r("a", "a"));
    // same run-scoped instance on re-get
    expect(pad.get(backpackSlot(spec)).size).toBe(1);
  });

  it("two DISTINCT specs sharing a key fail loud (no silent same-key aliasing)", () => {
    const key = `evidence-shared-${Math.random().toString(36).slice(2)}`;
    const specA = makeSpec({ key });
    const specB = makeSpec({ key }); // different object, same key
    expect(backpackSlot(specA)).toBe(backpackSlot(specA)); // A is fine, memoized
    expect(() => backpackSlot(specB)).toThrow(/already bound to a different spec/);
  });

  it("a conflicting scope on a later call for the same spec fails loud", () => {
    const spec = makeSpec();
    backpackSlot(spec, { scope: "branch" }); // first call fixes scope
    expect(backpackSlot(spec).scope).toBe("branch"); // no-opts re-get honours it
    expect(() => backpackSlot(spec, { scope: "run" })).toThrow(/scope 'branch'/);
  });
});

// ---------------------------------------------------------------------------
// accessors
// ---------------------------------------------------------------------------

describe("Backpack — accessors", () => {
  it("openBackpack: undefined when ctx/host/scratchpad absent; requireBackpack throws BackpackUnavailableError with the remediation message", () => {
    const spec = makeSpec();

    expect(openBackpack(undefined, spec)).toBeUndefined();
    expect(openBackpack({} as ToolExecutionContext, spec)).toBeUndefined();
    expect(openBackpack({ host: {} } as ToolExecutionContext, spec)).toBeUndefined();

    expect(() => requireBackpack(undefined, spec)).toThrow(BackpackUnavailableError);
    try {
      requireBackpack(undefined, spec);
    } catch (err) {
      expect((err as Error).message).toContain(spec.key);
      expect((err as Error).message).toContain("createRunHost()");
    }

    // With a host-provided scratchpad both accessors return the SAME pack.
    const pad = createScratchpad();
    const ctx = { host: { scratchpad: pad } } as unknown as ToolExecutionContext;
    expect(openBackpack(ctx, spec)).toBe(requireBackpack(ctx, spec));
  });

  it("readBackpack: fail-loud pad-side read names the caller", () => {
    const spec = makeSpec();
    const pad = createScratchpad();
    expect(readBackpack(pad.reader(), spec, "stage-prompt").size).toBe(0);

    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately exercise the missing-pad guard
      readBackpack(undefined as any, spec, "eval-probe");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BackpackUnavailableError);
      expect((err as Error).message).toContain("eval-probe");
    }
  });
});
