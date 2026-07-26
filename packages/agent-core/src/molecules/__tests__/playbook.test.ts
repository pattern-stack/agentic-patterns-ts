import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { Capability } from "../capability.js";
import { Playbook, definePlay, playbook } from "../playbook.js";
import type { PlayDefinition } from "../playbook.js";
import { ToolSchema } from "../tool-schema.js";
import { Toolbox, defineTool, toolbox } from "../toolbox.js";
import type { ToolDefinition } from "../toolbox.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

class TestPlaybook extends Playbook {
  readonly name = "test-playbook";
  readonly description = "A test playbook";
  readonly plays: Record<string, PlayDefinition> = {
    greet: {
      description: "Greet someone",
      parameters: z.object({ name: z.string() }),
      returns: z.object({ greeting: z.string() }),
      execute: async (args) => `Hello, ${args.name}!`,
    },
    fail: {
      description: "Always fails",
      parameters: z.object({}),
      execute: async () => {
        throw new Error("Play failed");
      },
    },
    returnDate: {
      description: "Returns a date object",
      parameters: z.object({}),
      execute: async () => ({ date: new Date("2025-01-01T00:00:00.000Z") }),
    },
    // D2 caveat fixture — extends `returnDate` above rather than introducing
    // a parallel one. Same Date-round-tripping shape, but `definePlay`-built,
    // so it pins that validation runs on the LIVE `Date` (before the
    // JSON round-trip flattens it to an ISO string).
    returnDateValidated: definePlay({
      description: "Returns a date object, validated against `returns` before serialization",
      parameters: z.object({}),
      returns: z.object({ date: z.date() }),
      execute: async () => ({ date: new Date("2025-01-01T00:00:00.000Z") }),
    }),
  };
}

class TestToolbox extends Toolbox {
  readonly name = "test-toolbox";
  readonly description = "A test toolbox";
  readonly tools: Record<string, ToolDefinition> = {
    search: {
      description: "Search for something",
      parameters: z.object({ query: z.string() }),
      execute: async (args) => `Results for: ${args.query}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Playbook", () => {
  it("should have name and description", () => {
    const playbook = new TestPlaybook();
    expect(playbook.name).toBe("test-playbook");
    expect(playbook.description).toBe("A test playbook");
  });

  it("should have plays record", () => {
    const playbook = new TestPlaybook();
    expect(Object.keys(playbook.plays)).toEqual([
      "greet",
      "fail",
      "returnDate",
      "returnDateValidated",
    ]);
  });

  it("should return play names", () => {
    const playbook = new TestPlaybook();
    expect(playbook.getPlayNames()).toEqual(["greet", "fail", "returnDate", "returnDateValidated"]);
  });

  it("should return ToolSchema instances from getPlaySchemas", () => {
    const playbook = new TestPlaybook();
    const schemas = playbook.getPlaySchemas();

    expect(schemas).toHaveLength(4);
    expect(schemas[0]).toBeInstanceOf(ToolSchema);
    expect(schemas[0]!.name).toBe("greet");
    expect(schemas[0]!.description).toBe("Greet someone");
    expect(schemas[1]!.name).toBe("fail");
    expect(schemas[1]!.description).toBe("Always fails");
  });

  it("should thread returns through getPlaySchemas", () => {
    const playbook = new TestPlaybook();
    const schemas = playbook.getPlaySchemas();

    expect(schemas[0]!.returns).toMatchObject({
      type: "object",
      properties: { greeting: { type: "string" } },
    });
    expect(schemas[1]!.returns).toBeUndefined();
  });

  describe("execute", () => {
    it("should execute a successful play", async () => {
      const playbook = new TestPlaybook();
      const result = await playbook.execute("greet", { name: "World" });
      expect(result).toBe("Hello, World!");
    });

    it("should JSON-serialize results", async () => {
      const playbook = new TestPlaybook();
      const result = await playbook.execute("returnDate", {});
      expect(result).toEqual({ date: "2025-01-01T00:00:00.000Z" });
    });

    // D2 caveat, pinned as behavior: `definePlay`'s `returns.safeParseAsync`
    // runs on the LIVE `Date` value (validation succeeds against `z.date()`)
    // BEFORE `Playbook.execute`'s JSON round-trip flattens it to an ISO
    // string. "Validated" means the live value matched `returns`, not that
    // the payload the host receives matches `returns`.
    it("validates a definePlay's live Date value before the JSON round-trip flattens it (D2)", async () => {
      const playbook = new TestPlaybook();
      const result = await playbook.execute("returnDateValidated", {});
      // Validation passed (no { error } envelope) AND the host still receives
      // the ISO string, not a Date instance — both things are true at once.
      expect(result).toEqual({ date: "2025-01-01T00:00:00.000Z" });
    });

    it("should return error envelope for unknown play", async () => {
      const playbook = new TestPlaybook();
      const result = await playbook.execute("nonexistent", {});
      expect(result).toEqual({ error: "Unknown play: nonexistent" });
    });

    it("should return error envelope when play throws", async () => {
      const playbook = new TestPlaybook();
      const result = await playbook.execute("fail", {});
      expect(result).toEqual({ error: "Play failed" });
    });

    it("should return error envelope on Zod validation failure", async () => {
      const playbook = new TestPlaybook();
      const result = await playbook.execute("greet", {});
      expect(result).toEqual(
        expect.objectContaining({ error: expect.stringContaining("Required") }),
      );
    });

    it("should return null for undefined result", async () => {
      const playbook = new (class extends Playbook {
        readonly name = "void-playbook";
        readonly description = "test";
        readonly plays = {
          noop: {
            description: "no-op",
            parameters: z.object({}),
            execute: async () => undefined,
          },
        };
      })();
      const result = await playbook.execute("noop", {});
      expect(result).toBeNull();
    });
  });
});

describe("definePlay", () => {
  it("infers parsed parameter output in execute (args arrive typed)", async () => {
    const def = definePlay({
      description: "Greet with a defaulted title",
      parameters: z.object({ name: z.string(), title: z.string().default("friend") }),
      returns: z.object({ greeting: z.string() }),
      execute: async (args) => {
        // Post-parse types: the default has been applied by definePlay's own
        // parsing — args arrive typed, no cast needed.
        expectTypeOf(args.name).toEqualTypeOf<string>();
        expectTypeOf(args.title).toEqualTypeOf<string>();
        return { greeting: `Hello, ${args.title} ${args.name}!` };
      },
    });

    const pb = playbook("greetings", "Greeting plays", { greet: def });
    const result = await pb.execute("greet", { name: "World" });
    expect(result).toEqual({ greeting: "Hello, friend World!" });
  });

  it("returns a plain PlayDefinition (no generic leak)", () => {
    const def = definePlay({
      description: "Plain surface",
      parameters: z.object({}),
      returns: z.string(),
      execute: async () => "ok",
    });

    expectTypeOf(def).toEqualTypeOf<PlayDefinition>();
    expect(Object.keys(def).sort()).toEqual(["description", "execute", "parameters", "returns"]);
  });

  it("parses output through returns by default (transforms, defaults, unknown-key stripping)", async () => {
    const def = definePlay({
      description: "Normalizes its result",
      parameters: z.object({}),
      returns: z.object({
        kept: z.string().transform((s) => s.toUpperCase()),
        stamped: z.string().default("yes"),
      }),
      execute: async () => ({ kept: "k", extra: "x" }) as { kept: string; extra: string },
    });

    const pb = playbook("normalize", "Normalizing plays", { go: def });
    const result = await pb.execute("go", {});
    expect(result).toEqual({ kept: "K", stamped: "yes" });
  });

  it("validateReturns: false returns the raw value unparsed", async () => {
    const def = definePlay({
      description: "Skips validation",
      parameters: z.object({}),
      returns: z.object({ shape: z.string() }),
      validateReturns: false,
      execute: async () => ({ unrelated: true }) as unknown as { shape: string },
    });

    const pb = playbook("raw", "Raw plays", { go: def });
    const result = await pb.execute("go", {});
    expect(result).toEqual({ unrelated: true });
  });

  it("passes displayType through to getPlaySchemas()", () => {
    const def = definePlay({
      description: "Renders as code",
      parameters: z.object({}),
      returns: z.string(),
      displayType: "code",
      execute: async () => "console.log(1)",
    });

    const pb = playbook("render", "Render plays", { go: def });
    const schemas = pb.getPlaySchemas();
    expect(schemas[0]!.displayType).toBe("code");
  });
});

describe("definePlay — violation semantics", () => {
  it("yields a play-named { error } envelope for a returns violation, and does not throw", async () => {
    const pb = playbook("violating", "Violating plays", {
      bad: definePlay({
        description: "Violates its own returns schema",
        parameters: z.object({}),
        returns: z.object({ count: z.number() }),
        execute: async () => ({ count: "not a number" }) as unknown as { count: number },
      }),
    });

    await expect(pb.execute("bad", {})).resolves.toEqual({
      error: expect.stringContaining("play 'bad' output violated its returns schema:"),
    });
  });

  it("names the play (the record key), not the schema", async () => {
    const pb = playbook("violating", "Violating plays", {
      my_named_play: definePlay({
        description: "Violates its own returns schema",
        parameters: z.object({}),
        returns: z.object({ count: z.number() }),
        execute: async () => ({ count: "nope" }) as unknown as { count: number },
      }),
    });

    const result = (await pb.execute("my_named_play", {})) as { error: string };
    expect(result.error.startsWith("play 'my_named_play'")).toBe(true);
  });

  it("an ordinary thrown error from a definePlay body still yields the plain { error: message }", async () => {
    const pb = playbook("throwing", "Throwing plays", {
      boom: definePlay({
        description: "Throws an ordinary error",
        parameters: z.object({}),
        returns: z.string(),
        execute: async () => {
          throw new Error("ordinary failure");
        },
      }),
    });

    await expect(pb.execute("boom", {})).resolves.toEqual({ error: "ordinary failure" });
  });

  it("unknown play and parameter-validation failures are byte-identical to a plain PlayDefinition", async () => {
    const pb = playbook("mixed", "Mixed plays", {
      typed: definePlay({
        description: "Requires a name",
        parameters: z.object({ name: z.string() }),
        returns: z.string(),
        execute: async ({ name }) => name,
      }),
    });

    await expect(pb.execute("nonexistent", {})).resolves.toEqual({
      error: "Unknown play: nonexistent",
    });
    await expect(pb.execute("typed", {})).resolves.toEqual(
      expect.objectContaining({ error: expect.stringContaining("Required") }),
    );
  });
});

describe("definePlay — direct-execute shape (outside a Playbook)", () => {
  it("throws the tagged violation when .execute() is called directly, bypassing Playbook", async () => {
    const def = definePlay({
      description: "Violates its own returns schema",
      parameters: z.object({}),
      returns: z.object({ count: z.number() }),
      execute: async () => ({ count: "nope" }) as unknown as { count: number },
    });

    // New observable behavior for a public shape (PlayDefinition.execute is
    // part of the type) — outside the supported path, but pinned so it's a
    // known contract, not a surprise.
    await expect(def.execute({})).rejects.toThrow(/output violated its returns schema/);
  });
});

describe("Correction #3 — inbound returns-violation misattribution", () => {
  it("play calling someToolbox.execute(...) on a violating tool yields the TOOL-named message (safe)", async () => {
    const tb = toolbox("inner-tools", "Inner tools", {
      violating_tool: defineTool({
        description: "Violates its own returns schema",
        parameters: z.object({}),
        returns: z.object({ count: z.number() }),
        execute: async () => ({ count: "nope" }) as unknown as { count: number },
      }),
    });

    const pb = playbook("outer-plays", "Outer plays", {
      outer_play: definePlay({
        description: "Delegates to a violating tool via the Toolbox boundary",
        parameters: z.object({}),
        returns: z.object({ count: z.number() }),
        execute: async () => {
          // Routed through Toolbox.execute — toolbox.ts:250-257 strips the tag
          // before rethrowing, so this is NOT tagged by the time it reaches
          // outer_play's own catch (inside definePlay's wrapper) or Playbook.execute.
          return (await tb.execute("violating_tool", {})) as { count: number };
        },
      }),
    });

    const result = (await pb.execute("outer_play", {})) as { error: string };
    expect(result.error).toMatch(/^tool 'violating_tool' output violated its returns schema:/);
    expect(result.error).not.toContain("outer_play");
  });

  it("play calling a definition's .execute() directly yields the PLAY-named message (accepted misattribution)", async () => {
    const innerTool = defineTool({
      description: "Violates its own returns schema",
      parameters: z.object({}),
      returns: z.object({ count: z.number() }),
      execute: async () => ({ count: "nope" }) as unknown as { count: number },
    });

    const pb = playbook("outer-plays", "Outer plays", {
      outer_play: {
        description: "Calls a tool definition's .execute() directly, bypassing Toolbox.execute",
        parameters: z.object({}),
        execute: async () => {
          // Direct .execute() call — bypasses Toolbox.execute's tag-strip, so
          // the inner tool's tagged violation survives and is misattributed to
          // outer_play by Playbook.execute's catch. Accepted, documented
          // limitation (Correction #3) — NOT the supported path.
          return innerTool.execute({});
        },
      },
    });

    const result = (await pb.execute("outer_play", {})) as { error: string };
    expect(result.error).toMatch(/^play 'outer_play' output violated its returns schema:/);
  });
});

describe("playbook() literal", () => {
  it("is indistinguishable from the subclass form for schemas/names/execute", async () => {
    const literal = playbook("literal-playbook", "A literal playbook", {
      greet: {
        description: "Greet someone",
        parameters: z.object({ name: z.string() }),
        returns: z.object({ greeting: z.string() }),
        execute: async (args) => `Hello, ${(args as { name: string }).name}!`,
      },
    });

    expect(literal.getPlayNames()).toEqual(["greet"]);
    expect(literal.getPlaySchemas()).toHaveLength(1);
    expect(literal.getPlaySchemas()[0]).toBeInstanceOf(ToolSchema);
    await expect(literal.execute("greet", { name: "World" })).resolves.toBe("Hello, World!");
  });

  it("satisfies instanceof Playbook", () => {
    const literal = playbook("literal-playbook", "A literal playbook", {});
    expect(literal).toBeInstanceOf(Playbook);
  });

  it("retains the plays record by reference (mutation after construction is visible)", async () => {
    const plays: Record<string, PlayDefinition> = {
      original: {
        description: "Original play",
        parameters: z.object({}),
        execute: async () => "original",
      },
    };
    const literal = playbook("mutable-playbook", "A mutable playbook", plays);

    plays.added = {
      description: "Added after construction",
      parameters: z.object({}),
      execute: async () => "added",
    };

    expect(literal.getPlayNames()).toEqual(["original", "added"]);
    await expect(literal.execute("added", {})).resolves.toBe("added");
  });
});

describe("Capability with Playbook", () => {
  it("should include playbook schemas in getTools", () => {
    const toolbox = new TestToolbox();
    const playbook = new TestPlaybook();
    const cap = new Capability("TestCap", "test capability", toolbox, undefined, playbook);

    const tools = cap.getTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search");
    expect(names).toContain("greet");
    expect(names).toContain("fail");
    expect(names).toContain("returnDate");
  });

  it("should list playbook tools in toPrompt", () => {
    const toolbox = new TestToolbox();
    const playbook = new TestPlaybook();
    const cap = new Capability("TestCap", "test", toolbox, undefined, playbook);

    const prompt = cap.toPrompt();
    expect(prompt).toContain("**greet**");
    expect(prompt).toContain("**search**");
  });

  it("should work without playbook (backward compat)", () => {
    const toolbox = new TestToolbox();
    const cap = new Capability("TestCap", "test", toolbox);

    const tools = cap.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("search");
  });
});
