import { describe, expect, it } from "vitest";
import { createToolboxExecutor } from "../toolbox-executor.js";

// ---------------------------------------------------------------------------
// Test fixtures
//
// The executor consumes only a duck-typed projection of `Agent` (role.name +
// role.capabilities[] with { name, toolbox, playbook? }), so we build minimal
// toolbox / playbook stubs rather than full molecules. The play stub mirrors
// `Playbook.execute` semantics: it returns an `{ error }` envelope on failure
// instead of throwing (see playbook.ts).
// ---------------------------------------------------------------------------

function makeToolbox(
  name: string,
  tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
) {
  return {
    name,
    tools: Object.fromEntries(Object.keys(tools).map((t) => [t, { execute: tools[t]! }])),
    async execute(toolName: string, args: unknown) {
      const tool = tools[toolName];
      if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
      }
      return tool(args as Record<string, unknown>);
    },
  };
}

function makePlaybook(
  name: string,
  plays: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
) {
  return {
    name,
    plays: Object.fromEntries(Object.keys(plays).map((p) => [p, { description: p }])),
    // Mirrors Playbook.execute: catches and returns { error }, never throws.
    async execute(playName: string, args: unknown) {
      const play = plays[playName];
      if (!play) {
        return { error: `Unknown play: ${playName}` };
      }
      try {
        return await play(args as Record<string, unknown>);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function makeAgent(capabilities: unknown[]) {
  return { role: { name: "TestAgent", capabilities } } as Parameters<
    typeof createToolboxExecutor
  >[0];
}

// A capability named "deal-evidence" with a `search` tool and `gather_evidence`
// + `fail` plays. toSnake("deal-evidence") === "deal_evidence".
function dealEvidenceCapability() {
  return {
    name: "deal-evidence",
    toolbox: makeToolbox("test-toolbox", {
      search: async (args) => `Results for: ${args.query}`,
    }),
    playbook: makePlaybook("deal-evidence-playbook", {
      gather_evidence: async (args) => ({ evidence: `gathered for ${args.topic}` }),
      fail: async () => {
        throw new Error("Play failed");
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createToolboxExecutor — playbook play dispatch", () => {
  // (a) play executes via the executor, under plain + MCP-prefixed names
  it("executes a play under its plain name", async () => {
    const executor = createToolboxExecutor(makeAgent([dealEvidenceCapability()]));
    await expect(executor.execute("gather_evidence", { topic: "acme" })).resolves.toEqual({
      evidence: "gathered for acme",
    });
  });

  it("executes a play under the capability-derived mcp__ prefix", async () => {
    const executor = createToolboxExecutor(makeAgent([dealEvidenceCapability()]));
    await expect(
      executor.execute("mcp__deal_evidence__gather_evidence", { topic: "acme" }),
    ).resolves.toEqual({ evidence: "gathered for acme" });
  });

  // (b) play error returns the { error } envelope, does not throw
  it("returns the { error } envelope for a failing play instead of throwing", async () => {
    const executor = createToolboxExecutor(makeAgent([dealEvidenceCapability()]));
    await expect(executor.execute("fail", {})).resolves.toEqual({ error: "Play failed" });
  });

  // (c) existing toolbox dispatch unchanged
  it("dispatches toolbox tools under plain + mcp__<toolbox>__ names", async () => {
    const executor = createToolboxExecutor(makeAgent([dealEvidenceCapability()]));
    await expect(executor.execute("search", { query: "q" })).resolves.toBe("Results for: q");
    await expect(executor.execute("mcp__test-toolbox__search", { query: "q" })).resolves.toBe(
      "Results for: q",
    );
  });

  it("still throws when a toolbox tool throws (toolbox semantics unchanged)", async () => {
    const cap = {
      name: "boom-cap",
      toolbox: makeToolbox("boom-toolbox", {
        boom: async () => {
          throw new Error("toolbox boom");
        },
      }),
    };
    const executor = createToolboxExecutor(makeAgent([cap]));
    await expect(executor.execute("boom", {})).rejects.toThrow("toolbox boom");
  });

  // (d) collision precedence — toolbox wins
  it("dispatches to the toolbox when a tool and play share a name", async () => {
    const cap = {
      name: "collide-cap",
      toolbox: makeToolbox("collide-toolbox", {
        echo: async () => "from-toolbox",
      }),
      playbook: makePlaybook("collide-playbook", {
        echo: async () => "from-playbook",
      }),
    };
    const executor = createToolboxExecutor(makeAgent([cap]));
    await expect(executor.execute("echo", {})).resolves.toBe("from-toolbox");
  });

  // (e) unknown name — throws, message lists both tool and play names
  it("throws for an unknown name and lists both tools and plays", async () => {
    const executor = createToolboxExecutor(makeAgent([dealEvidenceCapability()]));
    await expect(executor.execute("nope", {})).rejects.toThrow(/not found/);
    await expect(executor.execute("nope", {})).rejects.toThrow(/search/);
    await expect(executor.execute("nope", {})).rejects.toThrow(/gather_evidence/);
  });

  // (f) no-playbook capability behaves as today (toolbox-only)
  it("handles a capability with no playbook (toolbox-only)", async () => {
    const cap = {
      name: "tool-only",
      toolbox: makeToolbox("tool-only-toolbox", {
        ping: async () => "pong",
      }),
    };
    const executor = createToolboxExecutor(makeAgent([cap]));
    await expect(executor.execute("ping", {})).resolves.toBe("pong");
    await expect(executor.execute("any_play", {})).rejects.toThrow(/not found/);
  });

  // Spec Review note: a present-but-empty playbook registers no play keys.
  it("handles a capability with a present-but-empty playbook (toolbox-only)", async () => {
    const cap = {
      name: "empty-pb",
      toolbox: makeToolbox("empty-pb-toolbox", {
        ping: async () => "pong",
      }),
      playbook: makePlaybook("empty-playbook", {}),
    };
    const executor = createToolboxExecutor(makeAgent([cap]));
    await expect(executor.execute("ping", {})).resolves.toBe("pong");
    // No play keys registered → unknown play still throws not-found.
    await expect(executor.execute("ghost", {})).rejects.toThrow(/not found/);
  });
});
