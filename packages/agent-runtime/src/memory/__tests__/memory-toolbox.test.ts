/**
 * MemoryToolbox tests (#421) — scope confinement, the ADR-0008 D2 supersede
 * nudge, the D8 agent-key post-filter, #420 event emission, and the
 * memoryCapability wrapper.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Capability, type MemoryScope, type MemoryTarget } from "@agentic-patterns/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxEventBus } from "../../events/sandbox-event-bus.js";
import { createAgentAddress } from "../../events/sandbox-types.js";
import { MessagingToolbox } from "../../transport/messaging-toolbox.js";
import { PREVIEW_MARKER, byteLength } from "../../workflows/state-events.js";
import { SqliteMemoryStore, resetMemoryDegradedReadWarningsForTests } from "../sqlite-store.js";
import { InMemoryMemoryStore, type MemoryWriteInput } from "../store.js";
import {
  MemoryToolbox,
  RESERVED_AGENT_SCOPE_KEY,
  matchesAgentConvention,
  memoryCapability,
} from "../toolbox.js";

const BOUND: MemoryScope = { tenant: "acme", user: "u1" };
const FOREIGN: MemoryScope = { tenant: "other", user: "u9" };

const TARGET: MemoryTarget = { primitive: "background", section: "conventions", key: "deploy" };

const writeInput = (
  scope: MemoryScope,
  content: string,
  overrides: Partial<MemoryWriteInput> = {},
): MemoryWriteInput => ({ scope, kind: "fact", content, ...overrides });

interface SavedResult {
  status: "saved" | "conflict" | "not_found";
  id?: string;
  supersededId?: string;
  existing?: { id: string };
  guidance?: string;
}

interface HitsResult {
  hits: Array<Record<string, unknown> & { id: string }>;
}

describe("MemoryToolbox", () => {
  let store: InMemoryMemoryStore;
  let toolbox: MemoryToolbox;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    toolbox = new MemoryToolbox({ store, scope: BOUND });
  });

  const save = async (args: Record<string, unknown>): Promise<SavedResult> =>
    (await toolbox.execute("memory_save", { kind: "fact", ...args })) as SavedResult;

  // -- Construction & surface -----------------------------------------------

  describe("construction & surface", () => {
    it("throws on an empty scope (an empty scope is an unscoped search)", () => {
      expect(() => new MemoryToolbox({ store, scope: {} })).toThrow(/unscoped search/);
    });

    it("exposes exactly the four tools — no delete", () => {
      expect(toolbox.getToolNames()).toEqual([
        "memory_save",
        "memory_search",
        "memory_list",
        "memory_invalidate",
      ]);
    });

    it("tool names are disjoint from MessagingToolbox's (issue acceptance pin)", () => {
      // docs/authoring-a-toolbox.md: "Name every play distinctly from every
      // tool reachable by the agent" — tool-wins shadowing on the
      // ToolboxExecutor path, FATAL on the SDK-bridge path.
      const fakeBus = { publish: async () => {} } as unknown as SandboxEventBus;
      const messaging = new MessagingToolbox(fakeBus, createAgentAddress(), "agency", "run", {});
      const memoryNames = new Set(toolbox.getToolNames());
      for (const name of messaging.getToolNames()) {
        expect(memoryNames.has(name)).toBe(false);
      }
    });
  });

  // -- Scope confinement ----------------------------------------------------

  describe("scope confinement", () => {
    it("writes the canonical bound scope; a smuggled scope arg is stripped by Zod", async () => {
      const result = await save({ content: "durable fact", scope: { tenant: "evil" } });
      expect(result.status).toBe("saved");
      const record = await store.get(result.id as string);
      expect(record?.scope).toEqual({ tenant: "acme", user: "u1" });
      expect(Object.keys(record?.scope ?? {})).toEqual(["tenant", "user"]); // canonical order
    });

    it("search/list never return foreign-partition records", async () => {
      await store.write([writeInput(FOREIGN, "foreign secret fact")]);
      await save({ content: "my own fact" });
      const listed = (await toolbox.execute("memory_list", {})) as HitsResult;
      expect(listed.hits).toHaveLength(1);
      const searched = (await toolbox.execute("memory_search", {
        query: "secret fact",
      })) as HitsResult;
      expect(searched.hits.every((h) => h.content !== "foreign secret fact")).toBe(true);
    });

    it("invalidate on a foreign-partition id returns not_found and mutates nothing", async () => {
      const [foreign] = await store.write([writeInput(FOREIGN, "foreign fact")]);
      const result = await toolbox.execute("memory_invalidate", { id: foreign?.id });
      expect(result).toEqual({ status: "not_found", id: foreign?.id });
      expect((await store.get(foreign?.id as string))?.invalidAt).toBeUndefined();
    });

    it("save with supersedes pointing at a foreign record returns not_found, writes nothing", async () => {
      const [foreign] = await store.write([writeInput(FOREIGN, "foreign fact")]);
      const result = await save({ content: "correction", supersedes: foreign?.id });
      expect(result).toEqual({ status: "not_found", id: foreign?.id });
      const mine = await store.search({ scope: BOUND, includeInvalidated: true });
      expect(mine).toHaveLength(0);
      expect((await store.get(foreign?.id as string))?.invalidAt).toBeUndefined();
    });

    it("unknown supersedes id returns not_found", async () => {
      const result = await save({ content: "correction", supersedes: "nope" });
      expect(result).toEqual({ status: "not_found", id: "nope" });
    });
  });

  // -- Supersede nudge (ADR-0008 D2) ----------------------------------------

  describe("targeted-collision nudge", () => {
    it("same scope + same target without supersedes returns the conflict envelope", async () => {
      const first = await save({ content: "deploys freeze monthly", target: TARGET });
      expect(first.status).toBe("saved");
      const second = await save({ content: "deploys freeze weekly", target: TARGET });
      expect(second.status).toBe("conflict");
      expect(second.existing?.id).toBe(first.id);
      expect(second.guidance).toContain(first.id as string);
      // No silent duplicate: exactly one valid record stands.
      expect(await store.search({ scope: BOUND })).toHaveLength(1);
    });

    it("the same collision WITH supersedes corrects atomically", async () => {
      const first = await save({ content: "deploys freeze monthly", target: TARGET });
      const second = await save({
        content: "deploys freeze weekly",
        target: TARGET,
        supersedes: first.id,
      });
      expect(second.status).toBe("saved");
      expect(second.supersededId).toBe(first.id);
      const old = await store.get(first.id as string);
      expect(old?.invalidAt).toBeDefined();
      expect(old?.supersededBy).toBe(second.id);
    });

    it("re-keying (same arm, different key) saves — both valid", async () => {
      await save({ content: "a", target: TARGET });
      const other = await save({ content: "b", target: { ...TARGET, key: "release" } });
      expect(other.status).toBe("saved");
      expect(await store.search({ scope: BOUND })).toHaveLength(2);
    });

    it("untargeted duplicate content gets no hard gate", async () => {
      await save({ content: "same words" });
      const second = await save({ content: "same words" });
      expect(second.status).toBe("saved");
      expect(await store.search({ scope: BOUND })).toHaveLength(2);
    });

    it("collision check ignores invalidated records", async () => {
      const first = await save({ content: "old", target: TARGET });
      await toolbox.execute("memory_invalidate", { id: first.id });
      const second = await save({ content: "new", target: TARGET });
      expect(second.status).toBe("saved");
    });
  });

  // -- Agent-key post-filter (ADR-0008 D8) ----------------------------------

  describe("reserved agent scope key", () => {
    const AGENT_BOUND: MemoryScope = { tenant: "acme", user: "u1", agent: "support" };

    it("bound WITH agent: reads see shared + mine, never theirs; writes are tagged", async () => {
      const agentBox = new MemoryToolbox({ store, scope: AGENT_BOUND });
      await store.write([
        writeInput(BOUND, "shared fact"),
        writeInput({ ...BOUND, agent: "support" }, "my fact"),
        writeInput({ ...BOUND, agent: "researcher" }, "their fact"),
      ]);
      const listed = (await agentBox.execute("memory_list", {})) as HitsResult;
      const contents = listed.hits.map((h) => h.content);
      expect(contents).toContain("shared fact");
      expect(contents).toContain("my fact");
      expect(contents).not.toContain("their fact");

      const saved = (await agentBox.execute("memory_save", {
        kind: "fact",
        content: "written by support",
      })) as SavedResult;
      const record = await store.get(saved.id as string);
      expect(record?.scope[RESERVED_AGENT_SCOPE_KEY]).toBe("support");
      expect(record?.provenance?.author).toBe("support");
    });

    it("bound WITHOUT agent: agent-tagged records are excluded from reads", async () => {
      await store.write([
        writeInput(BOUND, "shared fact"),
        writeInput({ ...BOUND, agent: "support" }, "tagged fact"),
      ]);
      const listed = (await toolbox.execute("memory_list", {})) as HitsResult;
      expect(listed.hits.map((h) => h.content)).toEqual(["shared fact"]);
    });

    it("matchesAgentConvention unit cases", () => {
      expect(matchesAgentConvention({}, "me")).toBe(true); // unset ⇒ always visible
      expect(matchesAgentConvention({}, undefined)).toBe(true);
      expect(matchesAgentConvention({ agent: "me" }, "me")).toBe(true);
      expect(matchesAgentConvention({ agent: "other" }, "me")).toBe(false);
      expect(matchesAgentConvention({ agent: "other" }, undefined)).toBe(false);
    });
  });

  // -- Event emission (#420 via ctx.emit) -----------------------------------

  describe("event emission", () => {
    it("memory_save emits one agent.memory.write with capped preview", async () => {
      const emit = vi.fn();
      const longContent = `start ${"x".repeat(600)}`;
      await toolbox.execute(
        "memory_save",
        { kind: "fact", content: longContent },
        { emit, runId: "r1" },
      );
      expect(emit).toHaveBeenCalledTimes(1);
      const event = emit.mock.calls[0]?.[0] as {
        type: string;
        data: { scope: MemoryScope; count: number; records: Array<Record<string, unknown>> };
      };
      expect(event.type).toBe("agent.memory.write");
      expect(event.data.scope).toEqual({ tenant: "acme", user: "u1" });
      expect(event.data.count).toBe(1);
      const preview = event.data.records[0]?.preview as string;
      expect(event.data.records[0]?.id).toBeTruthy();
      expect(event.data.records[0]?.kind).toBe("fact");
      expect(preview.endsWith(PREVIEW_MARKER)).toBe(true);
      expect(byteLength(preview)).toBeLessThanOrEqual(512);
      expect(event.data.records[0]?.supersededId).toBeUndefined();
      // provenance carries the ctx runId
      const saved = emit.mock.calls[0]?.[0].data.records[0]?.id as string;
      expect((await store.get(saved))?.provenance?.runId).toBe("r1");
    });

    it("supersede path carries supersededId", async () => {
      const first = await save({ content: "old fact" });
      const emit = vi.fn();
      await toolbox.execute(
        "memory_save",
        { kind: "fact", content: "new fact", supersedes: first.id },
        { emit },
      );
      const event = emit.mock.calls[0]?.[0] as {
        data: { records: Array<{ supersededId?: string }> };
      };
      expect(event.data.records[0]?.supersededId).toBe(first.id);
    });

    it("memory_search emits agent.memory.search with post-default fields and post-filter ids", async () => {
      const agentBox = new MemoryToolbox({ store, scope: { ...BOUND, agent: "support" } });
      const [shared] = await store.write([writeInput(BOUND, "alpha shared fact")]);
      await store.write([writeInput({ ...BOUND, agent: "researcher" }, "alpha their fact")]);
      const emit = vi.fn();
      await agentBox.execute("memory_search", { query: "alpha" }, { emit });
      const event = emit.mock.calls[0]?.[0] as {
        type: string;
        data: Record<string, unknown>;
      };
      expect(event.type).toBe("agent.memory.search");
      // scope is the READ filter — no agent key.
      expect(event.data.scope).toEqual({ tenant: "acme", user: "u1" });
      expect(event.data.query).toBe("alpha");
      expect(event.data.limit).toBe(10); // post-default
      expect(event.data.includeInvalidated).toBe(false); // post-default
      expect(event.data.resultCount).toBe(1);
      expect(event.data.resultIds).toEqual([shared?.id]); // post-filter — theirs excluded
    });

    it("memory_list emits with query absent and limit default 20", async () => {
      const emit = vi.fn();
      await toolbox.execute("memory_list", {}, { emit });
      const event = emit.mock.calls[0]?.[0] as { type: string; data: Record<string, unknown> };
      expect(event.type).toBe("agent.memory.search");
      expect("query" in event.data).toBe(false);
      expect(event.data.limit).toBe(20);
    });

    it("conflict, not_found, and invalidate paths emit nothing; undefined ctx does not throw", async () => {
      const first = await save({ content: "targeted", target: TARGET });
      const emit = vi.fn();
      const conflict = await toolbox.execute(
        "memory_save",
        { kind: "fact", content: "again", target: TARGET },
        { emit },
      );
      expect((conflict as SavedResult).status).toBe("conflict");
      const notFound = await toolbox.execute(
        "memory_save",
        { kind: "fact", content: "x", supersedes: "nope" },
        { emit },
      );
      expect((notFound as SavedResult).status).toBe("not_found");
      await toolbox.execute("memory_invalidate", { id: first.id }, { emit });
      expect(emit).not.toHaveBeenCalled();

      // ctx entirely absent — no throw on any tool.
      await expect(toolbox.execute("memory_list", {})).resolves.toBeDefined();
      await expect(
        toolbox.execute("memory_save", { kind: "fact", content: "no ctx" }),
      ).resolves.toBeDefined();
    });
  });

  // -- Returns & capability -------------------------------------------------

  describe("returns & capability", () => {
    it("search hits match the documented view — no score, no payload, no provenance", async () => {
      await save({
        content: "viewable fact",
        tags: ["t1"],
        target: TARGET,
        payload: { note: "structured" },
      });
      const result = (await toolbox.execute("memory_search", {
        query: "viewable",
      })) as HitsResult;
      expect(result.hits).toHaveLength(1);
      const hit = result.hits[0] as Record<string, unknown>;
      expect(hit.content).toBe("viewable fact");
      expect(hit.tags).toEqual(["t1"]);
      expect(hit.target).toEqual(TARGET);
      expect("score" in hit).toBe(false);
      expect("payload" in hit).toBe(false);
      expect("provenance" in hit).toBe(false);
      expect("expiresAt" in hit).toBe(false);
    });

    it("memory_invalidate round-trips through the store", async () => {
      const saved = await save({ content: "to invalidate" });
      const result = await toolbox.execute("memory_invalidate", {
        id: saved.id,
        reason: "stale",
      });
      expect(result).toEqual({ status: "invalidated", id: saved.id });
      expect((await store.get(saved.id as string))?.invalidAt).toBeDefined();
    });

    it("memoryCapability wraps the toolbox with the built-in Manual", () => {
      const capability = memoryCapability(store, BOUND);
      expect(capability).toBeInstanceOf(Capability);
      expect(capability.toolbox).toBeInstanceOf(MemoryToolbox);
      const prompt = capability.manual?.toPrompt() ?? "";
      expect(prompt).toContain("supersedes");
      expect(prompt).toContain("Do NOT save");
      expect(capability.name).toBe("Memory");
    });

    it("memoryCapability appends guidance and honors the name override", () => {
      const capability = memoryCapability(store, BOUND, {
        guidance: "Always save renewal dates.",
        name: "TeamMemory",
      });
      expect(capability.name).toBe("TeamMemory");
      const prompt = capability.manual?.toPrompt() ?? "";
      expect(prompt).toContain("Do NOT save"); // baseline retained
      expect(prompt).toContain("Always save renewal dates."); // appended after
      expect(prompt.indexOf("Do NOT save")).toBeLessThan(prompt.indexOf("Always save"));
    });
  });
});

// ---------------------------------------------------------------------------
// Tolerated stored targets (ADR-0009 Decision 14)
// ---------------------------------------------------------------------------
// The toolbox is the layer the MODEL sees, so it is where a tolerated record
// either survives or detonates a second time. Two call sites widened for D14 —
// the D2 collision gate and `MemoryRecordViewSchema` — and both are exercised
// here through the real SQLite backend with a hand-edited row, because that is
// the only way to produce a record `MemoryWriteInputSchema` refuses to make.

describe("MemoryToolbox — tolerated stored targets (ADR-0009 D14)", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteMemoryStore;
  let raw: InstanceType<typeof Database>;
  let toolbox: MemoryToolbox;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ap-memory-toolbox-"));
    dbPath = path.join(dir, "memory.db");
    store = new SqliteMemoryStore({ path: dbPath, Database });
    raw = new Database(dbPath);
    toolbox = new MemoryToolbox({ store, scope: BOUND });
    resetMemoryDegradedReadWarningsForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    raw.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const saveHere = async (args: Record<string, unknown>): Promise<SavedResult> =>
    (await toolbox.execute("memory_save", { kind: "fact", ...args })) as SavedResult;

  const setStoredTarget = (id: string, column: string): void => {
    raw.prepare("UPDATE memory_records SET target = ? WHERE id = ?").run(column, id);
  };

  it("returns a tolerated record in a hit list — the view schema widened with the record", async () => {
    const saved = await saveHere({ content: "deploys freeze monthly", target: TARGET });
    const future = { primitive: "background", section: "userProfile", key: "name" };
    setStoredTarget(saved.id as string, JSON.stringify(future));

    const listed = (await toolbox.execute("memory_list", {})) as HitsResult;
    expect(listed.hits.map((hit) => hit.id)).toEqual([saved.id]);
    expect(listed.hits[0]?.target).toEqual(future);
  });

  it("returns a DEGRADED record in a hit list, target-less rather than not at all", async () => {
    const saved = await saveHere({ content: "deploys freeze monthly", target: TARGET });
    setStoredTarget(saved.id as string, "42");

    const listed = (await toolbox.execute("memory_list", {})) as HitsResult;
    expect(listed.hits.map((hit) => hit.id)).toEqual([saved.id]);
    expect(listed.hits[0]?.target).toBeUndefined();
  });

  it("does NOT treat an unreadable-vocabulary stored target as a D2 collision", async () => {
    // Narrow, never loosen: the gate compares KNOWN arms. A stored target this
    // build cannot read names a slot it cannot reason about, and blocking the
    // write on it would brick saves against a partition a newer version wrote.
    const first = await saveHere({ content: "deploys freeze monthly", target: TARGET });
    setStoredTarget(
      first.id as string,
      JSON.stringify({ primitive: "background", section: "userProfile", key: "deploy" }),
    );

    const second = await saveHere({ content: "deploys freeze weekly", target: TARGET });
    expect(second.status).toBe("saved");
  });

  it("still gates a KNOWN target that survived a sibling row's corruption", async () => {
    // The tolerance must not become a way to lose the gate: one bad row in the
    // partition, and the collision on a good row still fires.
    const bad = await saveHere({ content: "unrelated", target: { ...TARGET, key: "release" } });
    const good = await saveHere({ content: "deploys freeze monthly", target: TARGET });
    setStoredTarget(bad.id as string, "42");

    const second = await saveHere({ content: "deploys freeze weekly", target: TARGET });
    expect(second.status).toBe("conflict");
    expect(second.existing?.id).toBe(good.id);
  });
});
