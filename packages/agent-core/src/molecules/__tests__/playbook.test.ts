import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Capability } from "../capability.js";
import { Playbook } from "../playbook.js";
import type { PlayDefinition } from "../playbook.js";
import { ToolSchema } from "../tool-schema.js";
import { Toolbox } from "../toolbox.js";
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
    expect(Object.keys(playbook.plays)).toEqual(["greet", "fail", "returnDate"]);
  });

  it("should return play names", () => {
    const playbook = new TestPlaybook();
    expect(playbook.getPlayNames()).toEqual(["greet", "fail", "returnDate"]);
  });

  it("should return ToolSchema instances from getPlaySchemas", () => {
    const playbook = new TestPlaybook();
    const schemas = playbook.getPlaySchemas();

    expect(schemas).toHaveLength(3);
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
