import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ToolDefinition, Toolbox } from "../toolbox.js";

/** Concrete test toolbox with 2 tools. */
class MathToolbox extends Toolbox {
  readonly name = "Math";
  readonly description = "Basic math operations";
  readonly tools: Record<string, ToolDefinition> = {
    add: {
      description: "Add two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return a + b;
      },
    },
    multiply: {
      description: "Multiply two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      returns: z.object({ product: z.number() }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return { product: a * b };
      },
    },
  };
}

describe("Toolbox", () => {
  const toolbox = new MathToolbox();

  describe("getToolSchemas", () => {
    it("returns ToolSchema for each tool", () => {
      const schemas = toolbox.getToolSchemas();
      expect(schemas).toHaveLength(2);
      expect(schemas[0]!.name).toBe("add");
      expect(schemas[0]!.description).toBe("Add two numbers");
      expect(schemas[1]!.name).toBe("multiply");
    });

    it("carries a tool's declared returns schema through, and omits it otherwise", () => {
      const schemas = toolbox.getToolSchemas();
      // `add` declares no returns; `multiply` declares one.
      expect(schemas[0]!.returns).toBeUndefined();
      expect(schemas[1]!.returns).toHaveProperty("type", "object");
    });
  });

  describe("getToolNames", () => {
    it("returns names of all tools", () => {
      expect(toolbox.getToolNames()).toEqual(["add", "multiply"]);
    });
  });

  describe("execute", () => {
    it("dispatches to correct tool and validates args", async () => {
      const result = await toolbox.execute("add", { a: 3, b: 4 });
      expect(result).toBe(7);
    });

    it("validates args via Zod (rejects invalid)", async () => {
      await expect(toolbox.execute("add", { a: "not a number", b: 4 })).rejects.toThrow();
    });

    it("throws on unknown tool", async () => {
      await expect(toolbox.execute("unknown", {})).rejects.toThrow("Unknown tool: unknown");
    });
  });
});
