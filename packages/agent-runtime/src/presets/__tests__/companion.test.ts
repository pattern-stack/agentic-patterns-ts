/**
 * Companion preset tests (#445) — composition, scope-bound memory tools, and
 * the recall render path. Deep store/toolbox behavior is pinned by
 * `memory/__tests__`; these tests pin what the PRESET assembles.
 */

import type { ToolSchema } from "@agentic-patterns/core";
import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "../../memory/store.js";
import { buildCompanionAgent } from "../agents/companion.js";

const SCOPE = { user: "dug", agent: "companion" };

function companion() {
  return buildCompanionAgent({ store: new InMemoryMemoryStore(), scope: SCOPE });
}

describe("buildCompanionAgent", () => {
  it("composes the memory capability — all four scope-bound tools, no others", () => {
    const agent = companion();
    const names = (agent.getTools() as ToolSchema[]).map((t) => t.name).sort();
    expect(names).toEqual(["memory_invalidate", "memory_list", "memory_save", "memory_search"]);
  });

  it("pins no model (#179) — the runner resolves one", () => {
    expect(companion().getModel()).toBeUndefined();
  });

  it("renders the host-assembled recall block via Awareness.fromRecall", () => {
    const agent = companion();
    const block = "## Recalled Memories\n- [preference · 2026-08-08] Doug takes espresso, no milk.";
    const withRecall = agent.renderInitialPrompt({ recall: block });
    expect(withRecall).toContain("Doug takes espresso, no milk.");
  });

  it("renders byte-identically with no recall in context (empty ctx == no ctx)", () => {
    const agent = companion();
    expect(agent.renderInitialPrompt({})).toBe(agent.renderInitialPrompt());
    expect(agent.renderInitialPrompt()).not.toContain("Recalled Memories");
  });

  it("names memory as an awareness domain and carries the memory-discipline judgment", () => {
    const prompt = companion().renderInitialPrompt();
    expect(prompt).toContain("cross-session memory");
    expect(prompt).toContain("supersedes");
  });

  it("writes through the bound partition only — the toolbox carries the build-time scope", async () => {
    const store = new InMemoryMemoryStore();
    const agent = buildCompanionAgent({ store, scope: SCOPE });
    const capability = agent.role.capabilities.find((c) => c.toolbox?.name === "Memory");
    expect(capability).toBeDefined();
    await capability?.toolbox?.execute("memory_save", {
      kind: "preference",
      content: "espresso, no milk",
    });
    const hits = await store.search({ scope: { user: "dug" } });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.record.scope).toEqual(SCOPE);
  });
});
