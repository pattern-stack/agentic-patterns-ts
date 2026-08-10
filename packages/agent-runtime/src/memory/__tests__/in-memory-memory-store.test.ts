/**
 * InMemoryMemoryStore impl-specific tests — behavior NOT part of the portable
 * conformance contract (see `../conformance.ts` for the contract itself).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryMemoryStore, type MemoryWriteInput } from "../store.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const fact = (content: string, overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput => ({
  scope: { tenant: "acme" },
  kind: "fact",
  content,
  ...overrides,
});

describe("InMemoryMemoryStore (impl-specific)", () => {
  let store: InMemoryMemoryStore;
  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  it("write rejects empty content with no mutation", async () => {
    await expect(store.write([fact("")])).rejects.toThrow(z.ZodError);
    expect(await store.search({ scope: {}, includeInvalidated: true })).toEqual([]);
  });

  it("write rejects an invalid kind with no mutation", async () => {
    const bad = { scope: {}, kind: "vibe", content: "x" } as unknown as MemoryWriteInput;
    await expect(store.write([bad])).rejects.toThrow(z.ZodError);
    expect(await store.search({ scope: {}, includeInvalidated: true })).toEqual([]);
  });

  it("structured-target payload validation flows through from core memoryRecord", async () => {
    // `example` target requires { scenario, good, ... } — missing `good` fails
    // the core superRefine.
    const input = fact("an example", {
      target: { primitive: "example", judgmentDomain: "code-review" },
      payload: { scenario: "reviewer sees a large diff" },
    });
    await expect(store.write([input])).rejects.toThrow(z.ZodError);
  });

  it("returned records are deep-frozen", async () => {
    const [record] = await store.write([fact("frozen", { tags: ["a", "b"] })]);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record!.scope)).toBe(true);
    expect(Object.isFrozen(record!.tags)).toBe(true);
  });

  it("superseding an already-invalidated record keeps invalidAt, overwrites supersededBy, bumps updatedAt", async () => {
    const [a] = await store.write([fact("original")]);
    await store.invalidate(a!.id);
    const invalidated = (await store.get(a!.id))!;
    await tick();

    const [b] = await store.write([fact("correction", { supersedes: a!.id })]);
    const after = (await store.get(a!.id))!;
    expect(after.invalidAt).toBe(invalidated.invalidAt);
    expect(after.supersededBy).toBe(b!.id);
    expect(after.updatedAt > invalidated.updatedAt).toBe(true);
  });

  it("invalidate accepts a reason (unrecorded in v1)", async () => {
    const [record] = await store.write([fact("with reason")]);
    await expect(store.invalidate(record!.id, "a reason")).resolves.toBeUndefined();
  });

  it("keyword ordering: two-token match ranks above one-token; ties fall back to createdAt desc", async () => {
    const [two] = await store.write([fact("alpha beta both here")]);
    await tick();
    const [one] = await store.write([fact("alpha alone")]);
    const hits = await store.search({ scope: {}, query: "alpha beta" });
    expect(hits.map((hit) => hit.record.id)).toEqual([two!.id, one!.id]);

    // equal scores: newer record first
    const [older] = await store.write([fact("gamma")]);
    await tick();
    const [newer] = await store.write([fact("gamma")]);
    const tied = await store.search({ scope: {}, query: "gamma" });
    expect(tied.map((hit) => hit.record.id)).toEqual([newer!.id, older!.id]);
  });

  /**
   * These are impl-specific by placement only — the SEMANTICS are the portable
   * contract, asserted for every backend by conformance Tier 2. They live here
   * as well because this store is the one that CHANGED at #462, and a reader
   * of this file should be able to see the behaviour delta without opening the
   * kit. If one of these fails and Tier 2 does not, the bug is in the fixture,
   * not the store.
   */
  describe("match semantics — the #462 behaviour change", () => {
    it("no longer matches substrings: 'am' does not hit 'name'", async () => {
      await store.write([fact("The user's name is Doug.")]);
      expect(await store.search({ scope: {}, query: "am" })).toEqual([]);
      expect(await store.search({ scope: {}, query: "cat" })).toEqual([]);
      // The whole token still hits.
      expect(await store.search({ scope: {}, query: "name" })).toHaveLength(1);
    });

    it("no longer matches prefixes: 'prefer' does not hit 'Prefers'", async () => {
      await store.write([fact("Prefers dark-mode in the editor.")]);
      expect(await store.search({ scope: {}, query: "prefer" })).toEqual([]);
      expect(await store.search({ scope: {}, query: "prefers" })).toHaveLength(1);
    });

    it("strips punctuation from the query, so 'name?' finds 'name'", async () => {
      await store.write([fact("The user's name is Doug.")]);
      // Pre-#462 this returned nothing: the query split on whitespace only, so
      // the token was literally `name?` and no haystack contained it.
      expect(await store.search({ scope: {}, query: "name?" })).toHaveLength(1);
    });

    it("folds diacritics, which this backend previously did not", async () => {
      await store.write([fact("Met the team at the café on Tuesday.")]);
      expect(await store.search({ scope: {}, query: "cafe" })).toHaveLength(1);
      expect(await store.search({ scope: {}, query: "café" })).toHaveLength(1);
    });

    it("splits a punctuated query token and ORs the parts", async () => {
      await store.write([fact("Prefers dark-mode in the editor.")]);
      const hits = await store.search({ scope: {}, query: "dark-mode" });
      expect(hits).toHaveLength(1);
      // Both sub-tokens matched — an adjacency phrase would have been one
      // match, and SQLite must not treat it as one either. Score NUMBERS are
      // backend-advisory and never pinned (conformance.ts, ADR-0007 D5), so
      // assert only that both tokens contributed.
      expect(hits[0]!.score).toBeGreaterThan(1);
    });
  });

  it("capabilities resolves { search: 'keyword' }", async () => {
    expect(await store.capabilities()).toEqual({ search: "keyword" });
  });
});
