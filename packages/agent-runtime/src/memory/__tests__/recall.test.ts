/**
 * assembleRecall tests (#422) — tier ordering, the ADR-0008 D8 agent-key
 * post-filter, the char budget with its marked truncation, pinned candidates,
 * and agent.memory.recall emission.
 */

import type { MemoryScope, MemoryTarget } from "@agentic-patterns/core";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { MemoryRecallEvent } from "../../events/types.js";
import { capPreview } from "../../workflows/state-events.js";
import { DEFAULT_RECALL_BUDGET_CHARS, assembleRecall } from "../recall.js";
import { InMemoryMemoryStore, type MemoryWriteInput } from "../store.js";

const SCOPE: MemoryScope = { tenant: "acme", user: "u1" };

/** The pinned 4-line block scaffold (recall.ts) — budget math anchors on its joined length. */
const SCAFFOLD = [
  "## Recalled Memories",
  "",
  "From prior sessions, most relevant first — verify anything that may have changed:",
  "",
].join("\n");

/** The pinned truncation marker line. */
const marker = (omitted: number): string =>
  `… [recall budget reached — ${omitted} more record(s) omitted]`;

/**
 * An entry is `- [${kind} · ${date}] ${content}`: 22 fixed chars + content
 * for kind "fact" (date is always 10 chars). +1 for the "\n" joiner.
 * Pinned against the real block by the entry-format width test below.
 */
const FACT_ENTRY_OVERHEAD = 22;

/** Distinct createdAt values need distinct wall-clock ms — recency tests sleep between writes. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const seed = async (
  store: InMemoryMemoryStore,
  content: string,
  overrides: Partial<MemoryWriteInput> = {},
): Promise<void> => {
  await store.write([{ scope: SCOPE, kind: "fact", content, ...overrides }]);
};

describe("assembleRecall", () => {
  // -- Ordering / tiers -----------------------------------------------------

  describe("ordering / tiers", () => {
    it("places profile-kind records before query hits", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "user prefers dark mode", { kind: "profile" });
      await seed(store, "deploys run through the alpha pipeline");
      const result = await assembleRecall(store, SCOPE, { query: "alpha pipeline" });
      const profileAt = result.block.indexOf("prefers dark mode");
      const factAt = result.block.indexOf("alpha pipeline");
      expect(profileAt).toBeGreaterThanOrEqual(0);
      expect(factAt).toBeGreaterThanOrEqual(0);
      expect(profileAt).toBeLessThan(factAt);
    });

    it("orders multiple profiles newest first within the profile tier", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "older profile line", { kind: "profile" });
      await sleep(10);
      await seed(store, "newer profile line", { kind: "profile" });
      const result = await assembleRecall(store, SCOPE, {});
      expect(result.block.indexOf("newer profile line")).toBeLessThan(
        result.block.indexOf("older profile line"),
      );
    });

    it("ranks query hits by relevance after profiles; non-matching records are absent", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "gamma only content");
      await seed(store, "mentions alpha once");
      await sleep(10);
      // Written LAST (newest) but scores higher — relevance, not recency.
      await seed(store, "mentions alpha and beta together");
      const result = await assembleRecall(store, SCOPE, { query: "alpha beta" });
      expect(result.block.indexOf("alpha and beta together")).toBeLessThan(
        result.block.indexOf("alpha once"),
      );
      expect(result.block).not.toContain("gamma only content");
    });

    it("uses the recency listing for the hits tier when query is absent", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "a recent unqueried fact");
      const result = await assembleRecall(store, SCOPE);
      expect(result.block).toContain("a recent unqueried fact");
      expect(result.count).toBe(1);
    });

    it("dedupes a profile record that also matches the query (profile tier position)", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "alpha is the favorite word", { kind: "profile" });
      const result = await assembleRecall(store, SCOPE, { query: "alpha" });
      expect(result.count).toBe(1);
      const first = result.block.indexOf("alpha is the favorite word");
      expect(first).toBeGreaterThanOrEqual(0);
      expect(result.block.lastIndexOf("alpha is the favorite word")).toBe(first);
    });
  });

  // -- Agent post-filter (ADR-0008 D8) --------------------------------------

  describe("agent post-filter (ADR-0008 D8)", () => {
    const MINE: MemoryScope = { ...SCOPE, agent: "me" };
    const OTHERS: MemoryScope = { ...SCOPE, agent: "other" };

    it("recalls shared and own-agent records, excludes foreign-agent ones — both tiers", async () => {
      const store = new InMemoryMemoryStore();
      await store.write([
        { scope: SCOPE, kind: "profile", content: "PSHARED profile" },
        { scope: MINE, kind: "profile", content: "PMINE profile" },
        { scope: OTHERS, kind: "profile", content: "POTHER profile" },
        { scope: SCOPE, kind: "fact", content: "FSHARED alpha" },
        { scope: MINE, kind: "fact", content: "FMINE alpha" },
        { scope: OTHERS, kind: "fact", content: "FOTHER alpha" },
      ]);
      const result = await assembleRecall(store, MINE, { query: "alpha" });
      expect(result.block).toContain("PSHARED profile");
      expect(result.block).toContain("PMINE profile");
      expect(result.block).not.toContain("POTHER profile");
      expect(result.block).toContain("FSHARED alpha");
      expect(result.block).toContain("FMINE alpha");
      expect(result.block).not.toContain("FOTHER alpha");
    });

    it("a scope without the agent key sees shared records only", async () => {
      const store = new InMemoryMemoryStore();
      await store.write([
        { scope: SCOPE, kind: "fact", content: "FSHARED alpha" },
        { scope: MINE, kind: "fact", content: "FMINE alpha" },
      ]);
      const result = await assembleRecall(store, SCOPE, { query: "alpha" });
      expect(result.block).toContain("FSHARED alpha");
      expect(result.block).not.toContain("FMINE alpha");
    });
  });

  // -- Budget / truncation --------------------------------------------------

  describe("budget / truncation", () => {
    it("pins the entry-format width the budget math assumes", async () => {
      const store = new InMemoryMemoryStore();
      const content = "width probe fact";
      await seed(store, content);
      const result = await assembleRecall(store, SCOPE);
      const entry = result.block.split("\n").find((line) => line.includes(content));
      expect(entry).toBeDefined();
      // A formatEntry change fails HERE rather than skewing the budget math below.
      expect(entry?.length).toBe(FACT_ENTRY_OVERHEAD + content.length);
    });

    it("reports untruncated when everything fits", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "first small fact");
      await seed(store, "second small fact");
      const result = await assembleRecall(store, SCOPE);
      expect(result.truncated).toBe(false);
      expect(result.block).not.toContain("recall budget reached");
      expect(result.count).toBe(2);
      expect(result.chars).toBe(result.block.length);
      expect(result.chars).toBeLessThanOrEqual(DEFAULT_RECALL_BUDGET_CHARS);
    });

    it("marks truncation with the exact pinned marker line when the budget clips", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "L".repeat(2000)); // oldest — recency-listed last
      await sleep(10);
      await seed(store, "shortA-0001");
      await sleep(10);
      await seed(store, "shortB-0002");
      // Room for the two 11-char shorts (entry = 22 + 11, +1 joiner each) and
      // the marker, but nowhere near the 2000-char record.
      const budgetChars = SCAFFOLD.length + 2 * (1 + FACT_ENTRY_OVERHEAD + 11) + 60;
      const result = await assembleRecall(store, SCOPE, { budgetChars });
      expect(result.truncated).toBe(true);
      expect(result.block.endsWith(marker(1))).toBe(true);
      expect(result.count).toBe(2);
      expect(result.chars).toBe(result.block.length);
      expect(result.chars).toBeLessThanOrEqual(budgetChars);
    });

    it("never renders partial record content (whole-record granularity)", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "X".repeat(2000));
      await sleep(10);
      await seed(store, "shortA-0001");
      const budgetChars = SCAFFOLD.length + (1 + FACT_ENTRY_OVERHEAD + 11) + 60;
      const result = await assembleRecall(store, SCOPE, { budgetChars });
      expect(result.truncated).toBe(true);
      expect(result.block).toContain("shortA-0001");
      expect(result.block).not.toContain("X".repeat(30));
    });

    it("returns the empty truncated result for a degenerate budget", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "a fact that exists");
      const result = await assembleRecall(store, SCOPE, { budgetChars: 10 });
      expect(result).toEqual({ block: "", count: 0, chars: 0, truncated: true });
    });

    it("defaults the budget to DEFAULT_RECALL_BUDGET_CHARS = 4000", async () => {
      expect(DEFAULT_RECALL_BUDGET_CHARS).toBe(4000);
      const store = new InMemoryMemoryStore();
      await seed(store, "Y".repeat(5000)); // alone exceeds the default budget
      await sleep(10);
      await seed(store, "small enough fact");
      const result = await assembleRecall(store, SCOPE);
      expect(result.truncated).toBe(true);
      expect(result.count).toBe(1);
      expect(result.block).toContain("small enough fact");
      expect(result.block.endsWith(marker(1))).toBe(true);
      expect(result.chars).toBeLessThanOrEqual(DEFAULT_RECALL_BUDGET_CHARS);
    });
  });

  // -- Empty / validation ---------------------------------------------------

  describe("empty / validation", () => {
    it("returns the empty result when the partition holds no records", async () => {
      const store = new InMemoryMemoryStore();
      const result = await assembleRecall(store, SCOPE);
      expect(result).toEqual({ block: "", count: 0, chars: 0, truncated: false });
    });

    it("rejects an empty scope (an empty scope is an unscoped search)", async () => {
      const store = new InMemoryMemoryStore();
      await expect(assembleRecall(store, {})).rejects.toThrow(/unscoped search/);
    });

    it("rejects invalid budgetChars and pinCandidates", async () => {
      const store = new InMemoryMemoryStore();
      await expect(assembleRecall(store, SCOPE, { budgetChars: 0 })).rejects.toThrow(
        /positive integer/,
      );
      await expect(assembleRecall(store, SCOPE, { budgetChars: -5 })).rejects.toThrow(
        /positive integer/,
      );
      await expect(assembleRecall(store, SCOPE, { budgetChars: 1.5 })).rejects.toThrow(
        /positive integer/,
      );
      await expect(assembleRecall(store, SCOPE, { pinCandidates: -1 })).rejects.toThrow(
        /non-negative integer/,
      );
    });
  });

  // -- pinCandidates --------------------------------------------------------

  describe("pinCandidates", () => {
    const targetOf = (key: string): MemoryTarget => ({
      primitive: "background",
      section: "conventions",
      key,
    });

    it("pins the newest targeted record between the profile tier and the hits tier", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "profile dark mode", { kind: "profile" });
      await sleep(10);
      await seed(store, "beta targeted older", { target: targetOf("k1") });
      await sleep(10);
      await seed(store, "beta targeted newer", { target: targetOf("k2") });
      await sleep(10);
      await seed(store, "alpha matching fact");

      const pinned = await assembleRecall(store, SCOPE, { query: "alpha", pinCandidates: 1 });
      const profileAt = pinned.block.indexOf("profile dark mode");
      const candidateAt = pinned.block.indexOf("beta targeted newer");
      const hitAt = pinned.block.indexOf("alpha matching fact");
      expect(profileAt).toBeGreaterThanOrEqual(0);
      expect(candidateAt).toBeGreaterThan(profileAt);
      expect(hitAt).toBeGreaterThan(candidateAt);
      expect(pinned.block).not.toContain("beta targeted older");

      // pinCandidates omitted ⇒ targeted records surface only via normal hits.
      const unpinned = await assembleRecall(store, SCOPE, { query: "alpha" });
      expect(unpinned.block).not.toContain("beta targeted");
    });
  });

  // -- Event emission -------------------------------------------------------

  describe("event emission", () => {
    const MINE: MemoryScope = { ...SCOPE, agent: "me" };

    const capture = (bus: EventBus): MemoryRecallEvent[] => {
      const events: MemoryRecallEvent[] = [];
      bus.subscribe("agent.memory.recall", (event) => {
        events.push(event as MemoryRecallEvent);
      });
      return events;
    };

    it("publishes agent.memory.recall with correlation, full bound scope, and capped preview", async () => {
      const store = new InMemoryMemoryStore();
      await store.write([{ scope: MINE, kind: "fact", content: "Z".repeat(1000) }]);
      const bus = new EventBus();
      const events = capture(bus);

      const result = await assembleRecall(store, MINE, {
        emit: { bus, traceId: "t1", runId: "r1", parentSpanId: "p1" },
      });

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.traceId).toBe("t1");
      expect(event?.runId).toBe("r1");
      expect(event?.parentSpanId).toBe("p1");
      // The FULL canonical bound scope — agent key included (mirrors MemoryWriteEvent).
      expect(event?.scope).toEqual({ tenant: "acme", user: "u1", agent: "me" });
      expect(event?.count).toBe(result.count);
      expect(event?.chars).toBe(result.chars);
      expect(event?.budgetChars).toBe(DEFAULT_RECALL_BUDGET_CHARS);
      expect(event?.truncated).toBe(result.truncated);
      // 512B preview cap on a >512B block.
      expect(result.block.length).toBeGreaterThan(512);
      expect(event?.preview).toBe(capPreview(result.block));
      expect((event?.preview ?? "").length).toBeLessThan(result.block.length);
    });

    it("still publishes on an empty recall — nothing recalled is a signal", async () => {
      const store = new InMemoryMemoryStore();
      const bus = new EventBus();
      const events = capture(bus);
      await assembleRecall(store, SCOPE, { emit: { bus, traceId: "t1", runId: "r1" } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ count: 0, chars: 0, truncated: false, preview: "" });
    });

    it("does not publish when the emit option is absent", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "a fact");
      const bus = new EventBus();
      const publishSpy = vi.spyOn(bus, "publish");
      await assembleRecall(store, SCOPE);
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it("resolves normally when publish rejects (fire-and-forget sink)", async () => {
      const store = new InMemoryMemoryStore();
      await seed(store, "a fact");
      const bus = new EventBus();
      vi.spyOn(bus, "publish").mockRejectedValue(new Error("boom"));
      const result = await assembleRecall(store, SCOPE, {
        emit: { bus, traceId: "t1", runId: "r1" },
      });
      expect(result.count).toBe(1);
    });
  });
});
