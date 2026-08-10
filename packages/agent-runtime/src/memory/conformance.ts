/**
 * MemoryStore conformance kit — ADR-0007 D11, the SQLite↔Postgres portability
 * contract, split into two tiers by [ADR-0009](../../../../docs/adr/0009-memory-routing-and-background-composition.md)
 * Decision 13.
 *
 * **Tier 1 — universal.** Every backend runs it, whatever it declares. Write /
 * read-back, subset-match scope semantics, tags and kinds filtering,
 * invalidation chains, default exclusion of invalidated records, the two
 * relevance ORDERING invariants (never score values), the batch tie, limit
 * semantics including `limit: 0`, the updatedAt-only-on-invalidate rule, and
 * capabilities declaration.
 *
 * **Tier 2 — per declared capability class.** Keyed on `caps.search`. Two
 * backends that both declare `search: "keyword"` MUST produce IDENTICAL match
 * sets over one shared corpus — that is Doug's settled constraint D-3, and this
 * tier is the only thing that can enforce it. It replaces
 * `docs/memory/guide.md`'s former "match granularity is deliberately NOT
 * pinned … develop against the backend you ship on", which D-3 overrules.
 *
 * **What Tier 2 does NOT pin: total rank order.** In-memory ranks by matched
 * token count and falls back to recency; FTS5 uses bm25; a Postgres backend
 * would use `ts_rank`. Pinning total order would force a bm25 reimplementation
 * into the in-memory store and would then fail the `ts_rank` backend —
 * relocating the divergence rather than removing it (ADR-0009 Decision 13, and
 * the rejected alternative recorded there). So every Tier 2 assertion is on a
 * SORTED ID SET. The ordering that IS contractual lives in Tier 1: the recency
 * listing, more-matching-tokens-first, and the batch tie.
 */

import {
  type MemoryRecord,
  MemoryRecordSchema,
  MemoryStoreCapabilitiesSchema,
} from "@agentic-patterns/core";
import type { MemoryStore, MemoryWriteInput } from "./store.js";

/**
 * Store-assigned ISO timestamps have millisecond resolution; a `tick()`
 * between writes guarantees distinct `createdAt` wherever an ordering or
 * before/after assertion needs it.
 *
 * It is NOT a dodge around the batch tie any more — Tier 1 pins that directly,
 * with no `tick()` in sight.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** One entry of the Tier 2 shared corpus. */
export interface MemoryMatchCorpusEntry {
  /** Written as `kind: "fact"` content. */
  readonly content: string;
  /** Written as the record's tags — the tag-only match axis. */
  readonly tags?: readonly string[];
}

/**
 * The Tier 2 shared corpus — ONE corpus, every `search: "keyword"` backend, and
 * the same corpus the `memory-portability` eval family writes to both shipped
 * backends (`evals/memory-behavior/run.mts` imports this constant rather than
 * copying it, so the unit layer and the behaviour layer cannot drift).
 *
 * Each entry exists for a named axis; the axes are what make this a portability
 * contract instead of a smoke test:
 *
 *   0. word boundary (`prefer` vs `prefers`) + punctuation split (`dark-mode`)
 *   1. substring (`am` inside `name`) + apostrophe split (`user's`)
 *   2. diacritic folding (`cafe` ↔ `café`)
 *   3. disjoint-token half A — with 4, the OR-vs-AND combinator
 *   4. disjoint-token half B
 *   5. tag-only match: neither tag token appears in any content
 */
export const MEMORY_MATCH_CORPUS: readonly MemoryMatchCorpusEntry[] = Object.freeze([
  // Frozen per entry, not just at the top level: `Object.freeze` is shallow, and
  // this array crosses a package boundary (the eval harness imports it), where
  // `readonly` buys nothing at runtime.
  Object.freeze({ content: "Prefers dark-mode in the editor." }),
  Object.freeze({ content: "The user's name is Doug." }),
  Object.freeze({ content: "Met the team at the café on Tuesday." }),
  Object.freeze({ content: "Drinks espresso, no milk." }),
  Object.freeze({ content: "Ships the monorepo from Denver." }),
  Object.freeze({
    content: "Runs the deploy on Fridays.",
    tags: Object.freeze(["release", "cadence"]),
  }),
]);

/** Options for {@link runMemoryStoreConformance}. */
export interface MemoryStoreConformanceOptions {
  /**
   * Backend name, appended to the suite title. The kit now runs for two
   * in-repo backends over one shared Tier 2 corpus, so a bare "MemoryStore
   * conformance › Tier 2 › …" failure does not say WHICH backend diverged.
   * Purely cosmetic; defaults to no suffix.
   */
  readonly label?: string;
}

/**
 * Exported MemoryStore conformance kit — ADR-0007 D11, the SQLite↔Postgres
 * portability contract. Registers a vitest `describe` suite; call from a test
 * file with top-level await:
 *
 *   import { runMemoryStoreConformance } from "@agentic-patterns/runtime";
 *   await runMemoryStoreConformance(() => new InMemoryMemoryStore());
 *   await runMemoryStoreConformance(makeSqlite, { label: "SqliteMemoryStore" });
 *
 * `makeStore` is invoked once per test (beforeEach) — each test gets a fresh,
 * empty store. May be async (e.g. a SQLite temp file). `options` is OPTIONAL
 * with defaults: an external backend calling the one-argument form still
 * compiles (ADR-0009 Decision 15, B-3 check 4 — that subsystem is asserted to
 * import and run this kit, and this signature change must not break it).
 * Vitest is loaded via dynamic import so the runtime barrel stays importable in
 * production without vitest installed.
 */
export async function runMemoryStoreConformance(
  makeStore: () => MemoryStore | Promise<MemoryStore>,
  options: MemoryStoreConformanceOptions = {},
): Promise<void> {
  // Dynamic import — do NOT convert to a static import: this module is
  // bundled into the runtime barrel, and a top-level `import "vitest"` would
  // break every production consumer that doesn't install vitest.
  const { beforeEach, describe, expect, it } = await import("vitest");
  // Capabilities are declared, not probed (ADR-0007 D5) — read once up front
  // to key capability-gated sub-suites. This is the capability-keyed sub-suite
  // seam (ADR-0007 D11) that the ADR-0008 promotion extension will later hook.
  const caps = await (await makeStore()).capabilities();
  const suffix = options.label !== undefined ? ` — ${options.label}` : "";

  describe(`MemoryStore conformance${suffix}`, () => {
    let store: MemoryStore;
    beforeEach(async () => {
      store = await makeStore();
    });

    /** Write one input; return the single created record. */
    async function writeOne(input: MemoryWriteInput): Promise<MemoryRecord> {
      const records = await store.write([input]);
      const record = records[0];
      if (record === undefined) throw new Error("write returned no record");
      return record;
    }

    const fact = (
      content: string,
      overrides: Partial<MemoryWriteInput> = {},
    ): MemoryWriteInput => ({
      scope: { tenant: "acme" },
      kind: "fact",
      content,
      ...overrides,
    });

    // =======================================================================
    // TIER 1 — universal. Every backend, whatever it declares.
    // =======================================================================
    describe("Tier 1 — universal contract", () => {
      describe("write / read-back", () => {
        it("writes a full input and returns a valid, fully-preserved record", async () => {
          const input: MemoryWriteInput = {
            scope: { tenant: "t1", user: "u1" },
            kind: "preference",
            content: "prefers dark mode",
            tags: ["ui", "prefs"],
            provenance: { conversationId: "c1", author: "agent" },
            target: { primitive: "background", section: "conventions", key: "theme" },
            payload: { note: "opaque payload on a prose arm" },
          };
          const record = await writeOne(input);
          expect(record.id.length).toBeGreaterThan(0);
          expect(record.createdAt).toBe(record.updatedAt);
          expect(record.scope).toEqual(input.scope);
          expect(record.kind).toBe(input.kind);
          expect(record.content).toBe(input.content);
          expect(record.tags).toEqual(input.tags);
          expect(record.provenance).toEqual(input.provenance);
          expect(record.target).toEqual(input.target);
          expect(record.payload).toEqual(input.payload);
          expect(MemoryRecordSchema.safeParse(record).success).toBe(true);
        });

        it("stores scope canonically (sorted keys)", async () => {
          const record = await writeOne(fact("canonical", { scope: { user: "u", tenant: "t" } }));
          expect(Object.keys(record.scope)).toEqual(["tenant", "user"]);
        });

        it("returns a batch in input order with distinct ids", async () => {
          const records = await store.write([fact("first"), fact("second")]);
          expect(records).toHaveLength(2);
          expect(records[0]!.content).toBe("first");
          expect(records[1]!.content).toBe("second");
          expect(records[0]!.id).not.toBe(records[1]!.id);
        });

        it("write([]) resolves []", async () => {
          expect(await store.write([])).toEqual([]);
        });

        it("get(id) round-trips the written record; get of unknown id is null", async () => {
          const record = await writeOne(fact("round trip"));
          expect(await store.get(record.id)).toEqual(record);
          expect(await store.get("nope")).toBeNull();
        });
      });

      describe("subset-match scope semantics (ADR-0007 D3)", () => {
        let r1: MemoryRecord;
        let r2: MemoryRecord;
        let r3: MemoryRecord;
        beforeEach(async () => {
          r1 = await writeOne(fact("tenant-wide", { scope: { tenant: "acme" } }));
          r2 = await writeOne(fact("per-user", { scope: { tenant: "acme", user: "u42" } }));
          r3 = await writeOne(fact("other tenant", { scope: { tenant: "other" } }));
        });

        const ids = async (query: Parameters<MemoryStore["search"]>[0]) =>
          (await store.search(query)).map((hit) => hit.record.id).sort();

        it("filter {tenant} matches tenant-wide AND per-user records", async () => {
          expect(await ids({ scope: { tenant: "acme" } })).toEqual([r1.id, r2.id].sort());
        });

        it("filter {tenant,user} matches only the fully-matching record", async () => {
          expect(await ids({ scope: { tenant: "acme", user: "u42" } })).toEqual([r2.id]);
        });

        it("filter {user} matches records carrying that key regardless of others", async () => {
          expect(await ids({ scope: { user: "u42" } })).toEqual([r2.id]);
        });

        it("filter on an absent key matches nothing", async () => {
          expect(await ids({ scope: { region: "eu" } })).toEqual([]);
        });

        it("the empty filter {} matches every record", async () => {
          expect(await ids({ scope: {} })).toEqual([r1.id, r2.id, r3.id].sort());
        });

        it("kinds filters by record kind", async () => {
          const p = await writeOne(fact("a profile", { kind: "profile" }));
          expect(await ids({ scope: {}, kinds: ["profile"] })).toEqual([p.id]);
        });

        it("tags filter requires ALL queried tags (subset semantics)", async () => {
          const tagged = await writeOne(fact("tagged", { tags: ["a", "b"] }));
          expect(await ids({ scope: {}, tags: ["a"] })).toEqual([tagged.id]);
          expect(await ids({ scope: {}, tags: ["a", "b"] })).toEqual([tagged.id]);
          expect(await ids({ scope: {}, tags: ["a", "c"] })).toEqual([]);
        });
      });

      describe("invalidation chains (ADR-0007 D4)", () => {
        it("supersede invalidates the old record atomically with the write", async () => {
          const a = await writeOne(fact("old truth"));
          await tick();
          const b = await writeOne(fact("new truth", { supersedes: a.id }));

          const oldRecord = await store.get(a.id);
          expect(oldRecord).not.toBeNull();
          expect(oldRecord!.invalidAt).toBeDefined();
          expect(oldRecord!.supersededBy).toBe(b.id);
          expect(oldRecord!.updatedAt).toBe(oldRecord!.invalidAt);
          expect(oldRecord!.updatedAt > oldRecord!.createdAt).toBe(true);
          // the new record itself is untouched
          expect(b.createdAt).toBe(b.updatedAt);
        });

        it("standalone invalidate sets invalidAt without supersededBy", async () => {
          const c = await writeOne(fact("standalone"));
          await store.invalidate(c.id);
          const invalidated = await store.get(c.id);
          expect(invalidated!.invalidAt).toBeDefined();
          expect(invalidated!.supersededBy).toBeUndefined();
        });

        it("invalidate of unknown id rejects; re-invalidate is a no-op", async () => {
          await expect(store.invalidate("nope")).rejects.toThrow();
          const c = await writeOne(fact("idempotent"));
          await store.invalidate(c.id);
          const before = (await store.get(c.id))!.updatedAt;
          await tick();
          await store.invalidate(c.id);
          expect((await store.get(c.id))!.updatedAt).toBe(before);
        });

        it("write with unknown supersedes rejects atomically — valid sibling not stored", async () => {
          await expect(
            store.write([fact("valid sibling"), fact("bad", { supersedes: "nope" })]),
          ).rejects.toThrow();
          expect(await store.search({ scope: {}, includeInvalidated: true })).toEqual([]);
        });

        it("delete removes the record entirely; delete of unknown id resolves", async () => {
          const d = await writeOne(fact("to delete"));
          await store.delete(d.id);
          expect(await store.get(d.id)).toBeNull();
          expect(await store.search({ scope: {}, includeInvalidated: true })).toEqual([]);
          await expect(store.delete("nope")).resolves.toBeUndefined();
        });
      });

      describe("search excludes invalidated by default", () => {
        it("invalidated records are absent by default, present with includeInvalidated, always in get", async () => {
          const record = await writeOne(fact("soon invalid"));
          await store.invalidate(record.id);
          expect(await store.search({ scope: {} })).toEqual([]);
          const included = await store.search({ scope: {}, includeInvalidated: true });
          expect(included.map((hit) => hit.record.id)).toEqual([record.id]);
          expect(await store.get(record.id)).not.toBeNull();
        });
      });

      // Ordering is the contract; `score` is backend-advisory. NO assertion in
      // this kit ever checks a score NUMBER — only ordering (and, at most, that
      // score, when present, is a number).
      describe("relevance ordering — never score values (ADR-0007 D5)", () => {
        it("no query: recency listing, createdAt descending", async () => {
          const a = await writeOne(fact("first"));
          await tick();
          const b = await writeOne(fact("second"));
          await tick();
          const c = await writeOne(fact("third"));

          const hits = await store.search({ scope: {} });
          expect(hits.map((hit) => hit.record.id)).toEqual([c.id, b.id, a.id]);
          for (let i = 0; i < hits.length - 1; i++) {
            expect(hits[i]!.record.createdAt >= hits[i + 1]!.record.createdAt).toBe(true);
          }
        });

        if (caps.search !== "semantic") {
          it("with query: more matching tokens rank first; non-matching records are absent", async () => {
            const a = await writeOne(fact("alpha beta gamma"));
            await tick();
            const b = await writeOne(fact("alpha only here"));
            await tick();
            const c = await writeOne(fact("nothing relevant"));

            const hits = await store.search({ scope: {}, query: "alpha beta" });
            expect(hits.map((hit) => hit.record.id)).toEqual([a.id, b.id]);
            expect(hits.map((hit) => hit.record.id)).not.toContain(c.id);
            for (const hit of hits) {
              if (hit.score !== undefined) expect(typeof hit.score).toBe("number");
            }
          });
        }
      });

      describe("limit semantics", () => {
        it("omitted limit applies the schema default of 10", async () => {
          await store.write(Array.from({ length: 12 }, (_, i) => fact(`record ${i}`)));
          expect(await store.search({ scope: {} })).toHaveLength(10);
        });

        it("limit: 2 over 3 matches returns the 2 newest", async () => {
          await writeOne(fact("oldest"));
          await tick();
          const b = await writeOne(fact("middle"));
          await tick();
          const c = await writeOne(fact("newest"));
          const hits = await store.search({ scope: {}, limit: 2 });
          expect(hits.map((hit) => hit.record.id)).toEqual([c.id, b.id]);
        });

        it("limit: 0 returns [] — zero means zero", async () => {
          await writeOne(fact("present"));
          expect(await store.search({ scope: {}, limit: 0 })).toEqual([]);
        });
      });

      describe("updatedAt is touched ONLY by invalidate", () => {
        it("write sets it equal to createdAt; reads never bump it; invalidate does", async () => {
          const record = await writeOne(fact("watch my updatedAt"));
          expect(record.updatedAt).toBe(record.createdAt);

          await store.get(record.id);
          await store.search({ scope: {} });
          expect((await store.get(record.id))!.updatedAt).toBe(record.createdAt);

          await tick();
          await store.invalidate(record.id);
          const invalidated = (await store.get(record.id))!;
          expect(invalidated.updatedAt).toBe(invalidated.invalidAt);

          await store.search({ scope: {}, includeInvalidated: true });
          expect((await store.get(record.id))!.updatedAt).toBe(invalidated.updatedAt);
        });
      });

      describe("capabilities declaration", () => {
        it("parses against MemoryStoreCapabilitiesSchema", async () => {
          const declared = await store.capabilities();
          expect(MemoryStoreCapabilitiesSchema.safeParse(declared).success).toBe(true);
        });
      });

      /**
       * The batch tie — a MATCH-SET pin wearing an ordering costume, and the
       * reason it belongs in Tier 1 rather than Tier 2.
       *
       * Every reference backend assigns ONE `now` per batch, so a single
       * `write([a,b,c])` produces three records with identical `createdAt`. The
       * tie is therefore the DEFAULT for any multi-record write, not an exotic
       * edge — the kit's own `tick()` helper exists because of it. Until
       * ADR-0009 D-3 this was unpinned, and a `limit: 2` listing returned
       * `[a,b]` from the in-memory store and `[c,b]` from SQLite: DIFFERENT
       * RECORDS, which `sqlite-store.ts` blessed in a comment as "outside the
       * contract".
       *
       * Pinned direction: LAST WRITTEN IS NEWEST. It is what the shipped SQLite
       * backend already did (`ORDER BY … m.seq DESC`), it is the only reading
       * consistent with "createdAt descending" when the batch is one instant,
       * and it is trivially implementable by any backend with an insertion
       * counter. The in-memory store adopted it.
       */
      describe("batch-tie ordering (ADR-0009 D-3, Decision 13)", () => {
        it("one write([a,b,c]) ties createdAt, and a limited listing returns the LAST-written records", async () => {
          const [a, b, c] = await store.write([fact("tie a"), fact("tie b"), fact("tie c")]);
          // The tie is by construction — assert it, so a backend that assigns a
          // per-record `now` fails HERE with a legible reason rather than
          // passing the order assertion for an unrelated one.
          expect(a!.createdAt).toBe(b!.createdAt);
          expect(b!.createdAt).toBe(c!.createdAt);

          const limited = await store.search({ scope: {}, limit: 2 });
          expect(limited.map((hit) => hit.record.id)).toEqual([c!.id, b!.id]);

          const all = await store.search({ scope: {} });
          expect(all.map((hit) => hit.record.id)).toEqual([c!.id, b!.id, a!.id]);
        });

        it("a later batch outranks an earlier one regardless of within-batch position", async () => {
          const [older] = await store.write([fact("older batch")]);
          await tick();
          const [x, y] = await store.write([fact("newer x"), fact("newer y")]);
          const hits = await store.search({ scope: {} });
          expect(hits.map((hit) => hit.record.id)).toEqual([y!.id, x!.id, older!.id]);
        });
      });

      /**
       * Unknown-target tolerance — the Tier 1 slot ADR-0009 Decision 14 fills at
       * plan issue #464, deliberately left as a `todo` rather than a passing
       * test.
       *
       * The reproduction: rewrite one stored row's `target.section` to an
       * unrecognised value and EVERY query-less listing on that partition
       * throws, because the SQLite backend runs `MemoryRecordSchema.parse`
       * inside `rows.map` (`sqlite-store.ts` `_rowToRecord`). One bad row kills
       * the partition's recall — it does not skip a record. That listing is
       * exactly recall's profile tier.
       *
       * It cannot be written here yet: `MemoryWriteInputSchema` is strict, so
       * this kit has no protocol-level way to CREATE such a row (the
       * reproduction needs host SQL). #464 widens `MemoryRecordSchema.target`
       * with a tolerant passthrough arm and lands the assertion.
       */
      it.todo("tolerates an unrecognised stored target.section on get and on search — #464");

      /**
       * Non-Latin diacritic/combining-mark parity — a KNOWN Tier 2 hole,
       * measured in PR #454's review: `tokenize()` (NFD + strip \p{M}) and
       * FTS5 `unicode61` (`remove_diacritics 1`) agree for Latin-1-class
       * content but diverge outside it. `"Tiếng Việt"` matches query
       * `"tieng"` in-memory and returns zero rows on SQLite; same class of
       * divergence for Greek tonos, Cyrillic breve, and Hebrew/Arabic
       * combining marks (separators to `unicode61`, stripped by
       * `tokenize()`). Landing this as a passing pin means either widening
       * tokenize() to match unicode61 exactly or configuring FTS5 to match
       * tokenize() — a semantics decision, not a test-only change.
       */
      it.todo(
        "Tier 2 pins non-Latin diacritic parity (Vietnamese / Greek tonos / Cyrillic breve / Hebrew / Arabic) — tokenize() vs FTS5 unicode61 divergence, PR #454 review",
      );
    });

    // =======================================================================
    // TIER 2 — per declared capability class. `search: "keyword"`.
    //
    // D-3: two backends that both declare `keyword` must produce IDENTICAL
    // match sets over one shared corpus. SORTED ID SETS only — total rank
    // order is explicitly NOT pinned (see the module docblock).
    // =======================================================================
    if (caps.search === "keyword") {
      describe('Tier 2 — match semantics (search: "keyword")', () => {
        /** Corpus index → the id it was written under, per test. */
        let corpusIds: string[];

        beforeEach(async () => {
          // ONE write call: the corpus ties on createdAt by construction, which
          // is deliberate — a match-SET assertion must not be able to pass or
          // fail because of ordering. Tier 1 owns the tie.
          const written = await store.write(
            MEMORY_MATCH_CORPUS.map((entry) =>
              fact(entry.content, entry.tags !== undefined ? { tags: [...entry.tags] } : {}),
            ),
          );
          corpusIds = written.map((record) => record.id);
        });

        /** Sorted ids for a query — never order (module docblock). */
        const matched = async (query: string): Promise<string[]> =>
          (await store.search({ scope: {}, query, limit: MEMORY_MATCH_CORPUS.length }))
            .map((hit) => hit.record.id)
            .sort();

        /** The expected sorted id set for a set of corpus indices. */
        const expected = (...indices: number[]): string[] =>
          indices.map((i) => corpusIds[i]!).sort();

        /**
         * Every row is an axis on which two "keyword" backends could silently
         * disagree, and each one HAS disagreed between the two shipped
         * backends at some point in this repo's history.
         */
        const table: ReadonlyArray<{
          readonly axis: string;
          readonly query: string;
          readonly indices: number[];
        }> = [
          // -- word boundaries: the substring bug, from both sides ----------
          { axis: "whole-token match", query: "prefers", indices: [0] },
          { axis: "no stemming — 'prefer' does NOT match 'Prefers'", query: "prefer", indices: [] },
          { axis: "no substring — 'am' does NOT match 'name'", query: "am", indices: [] },
          { axis: "the whole token DOES match", query: "name", indices: [1] },

          // -- case + punctuation ------------------------------------------
          { axis: "case folding", query: "EDITOR", indices: [0] },
          { axis: "trailing punctuation on the query token", query: "editor.", indices: [0] },
          {
            axis: "hyphen splits into two tokens, OR'd — never an adjacency phrase",
            query: "dark-mode",
            indices: [0],
          },
          { axis: "apostrophe splits", query: "user's", indices: [1] },
          { axis: "a one-character token is a token", query: "s", indices: [1] },

          // -- diacritics ---------------------------------------------------
          { axis: "diacritics fold on the haystack", query: "cafe", indices: [2] },
          { axis: "diacritics fold on the query too", query: "café", indices: [2] },

          // -- the boolean combinator: the single most portability-critical
          //    axis. `espresso` and `Denver` do NOT co-occur in any record, so
          //    an OR backend returns two and an AND backend returns ZERO. A
          //    Postgres backend declaring "keyword" and reaching for
          //    `plainto_tsquery` (which defaults to AND) passes every other
          //    row in this table and fails only here.
          {
            axis: "multi-token is OR, over records that do not co-occur",
            query: "espresso Denver",
            indices: [3, 4],
          },
          // No record carries BOTH "the" and "espresso", so an AND backend
          // returns zero here while an OR backend returns the whole corpus.
          {
            axis: "OR — a record matching only one term is still in the set",
            query: "the espresso",
            indices: [0, 1, 2, 3, 4, 5],
          },

          // -- tags are part of the haystack --------------------------------
          {
            axis: "tag-only match — the token appears in no content",
            query: "release",
            indices: [5],
          },
          { axis: "multiple tag tokens still OR", query: "cadence release", indices: [5] },

          // -- no stopword list. `unicode61` ships none, and a backend that
          //    quietly adds one changes what a user's first message retrieves.
          { axis: "no stopword list — 'the' matches", query: "the", indices: [0, 1, 2, 4, 5] },

          // -- misses --------------------------------------------------------
          { axis: "an absent token matches nothing", query: "zanzibar", indices: [] },
          {
            axis: "a blank-but-present query is a query, and matches nothing",
            query: "   ",
            indices: [],
          },
          {
            axis: "punctuation-only query tokenizes to nothing",
            query: "?!—",
            indices: [],
          },
        ];

        for (const row of table) {
          it(`${row.axis}: ${JSON.stringify(row.query)}`, async () => {
            expect(await matched(row.query)).toEqual(expected(...row.indices));
          });
        }

        it("tags participate in the same tokenizer as content", async () => {
          // The SQLite backend indexes `tags` as its raw JSON text and relies
          // on unicode61 treating `[`, `"` and `,` as separators; the
          // in-memory backend joins tags with spaces. That equivalence was
          // asserted in a comment and tested nowhere.
          expect(await matched("release cadence")).toEqual(expected(5));
          expect(await matched('["release"]')).toEqual(expected(5));
        });
      });
    }
  });
}
