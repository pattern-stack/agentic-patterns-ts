/**
 * MemoryStore conformance kit — ADR-0007 D11, the SQLite↔Postgres portability
 * contract. Every MemoryStore backend (in-memory, SQLite, external Postgres)
 * runs this exact suite; it pins subset-match scope semantics, invalidation
 * chains, default exclusion of invalidated records, relevance ORDERING (never
 * score values), limit semantics including `limit: 0`, the
 * updatedAt-only-on-invalidate rule, and capabilities declaration.
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
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Exported MemoryStore conformance kit — ADR-0007 D11, the SQLite↔Postgres
 * portability contract. Registers a vitest `describe` suite; call from a test
 * file with top-level await:
 *
 *   import { runMemoryStoreConformance } from "@agentic-patterns/runtime";
 *   await runMemoryStoreConformance(() => new InMemoryMemoryStore());
 *
 * `makeStore` is invoked once per test (beforeEach) — each test gets a fresh,
 * empty store. May be async (e.g. a SQLite temp file). Vitest is loaded via
 * dynamic import so the runtime barrel stays importable in production without
 * vitest installed.
 */
export async function runMemoryStoreConformance(
  makeStore: () => MemoryStore | Promise<MemoryStore>,
): Promise<void> {
  // Dynamic import — do NOT convert to a static import: this module is
  // bundled into the runtime barrel, and a top-level `import "vitest"` would
  // break every production consumer that doesn't install vitest.
  const { beforeEach, describe, expect, it } = await import("vitest");
  // Capabilities are declared, not probed (ADR-0007 D5) — read once up front
  // to key capability-gated sub-suites. This is the capability-keyed sub-suite
  // seam (ADR-0007 D11) that the ADR-0008 promotion extension will later hook.
  const caps = await (await makeStore()).capabilities();

  describe("MemoryStore conformance", () => {
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
  });
}
