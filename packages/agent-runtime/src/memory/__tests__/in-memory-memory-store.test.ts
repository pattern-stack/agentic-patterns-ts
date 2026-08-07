/**
 * InMemoryMemoryStore impl-specific tests — behavior NOT part of the portable
 * conformance contract (see `../conformance.ts` for the contract itself).
 */

import { beforeEach, describe, expect, it } from "vitest";
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
    await expect(store.write([fact("")])).rejects.toThrow();
    expect(await store.search({ scope: {}, includeInvalidated: true })).toEqual([]);
  });

  it("write rejects an invalid kind with no mutation", async () => {
    const bad = { scope: {}, kind: "vibe", content: "x" } as unknown as MemoryWriteInput;
    await expect(store.write([bad])).rejects.toThrow();
    expect(await store.search({ scope: {}, includeInvalidated: true })).toEqual([]);
  });

  it("structured-target payload validation flows through from core memoryRecord", async () => {
    // `example` target requires { scenario, good, ... } — missing `good` fails
    // the core superRefine.
    const input = fact("an example", {
      target: { primitive: "example", judgmentDomain: "code-review" },
      payload: { scenario: "reviewer sees a large diff" },
    });
    await expect(store.write([input])).rejects.toThrow();
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

  it("capabilities resolves { search: 'keyword' }", async () => {
    expect(await store.capabilities()).toEqual({ search: "keyword" });
  });
});
