import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolSchema } from "../tool-schema.js";

describe("ToolSchema", () => {
  describe("fromZod", () => {
    it("creates schema from Zod type", () => {
      const params = z.object({ query: z.string(), limit: z.number().optional() });
      const schema = ToolSchema.fromZod("search", "Search items", params);

      expect(schema.name).toBe("search");
      expect(schema.description).toBe("Search items");
      expect(schema.parameters).toHaveProperty("type", "object");
      expect(schema.parameters).toHaveProperty("properties");
    });

    it("carries a returns schema when one is provided", () => {
      const params = z.object({ q: z.string() });
      const returns = z.array(z.object({ id: z.string(), title: z.string() }));
      const schema = ToolSchema.fromZod("search", "Search", params, returns);

      expect(schema.returns).toBeDefined();
      expect(schema.returns).toHaveProperty("type", "array");
      expect((schema.returns as { items?: unknown }).items).toBeDefined();
    });

    it("leaves returns undefined when no returns schema is given", () => {
      const schema = ToolSchema.fromZod("search", "Search", z.object({ q: z.string() }));
      expect(schema.returns).toBeUndefined();
    });

    it("carries the terminal flag when set, undefined otherwise", () => {
      const params = z.object({ summary: z.string() });
      const terminal = ToolSchema.fromZod("finish", "Done", params, undefined, true);
      expect(terminal.terminal).toBe(true);

      const ordinary = ToolSchema.fromZod("search", "Search", params);
      expect(ordinary.terminal).toBeUndefined();
    });

    it("carries the displayType hint when set, undefined otherwise", () => {
      const params = z.object({ path: z.string() });
      const withHint = ToolSchema.fromZod(
        "edit",
        "Edit a file",
        params,
        undefined,
        undefined,
        "diff",
      );
      expect(withHint.displayType).toBe("diff");

      const ordinary = ToolSchema.fromZod("search", "Search", params);
      expect(ordinary.displayType).toBeUndefined();
    });
  });

  describe("fromOpenAI", () => {
    it("creates schema from OpenAI function calling format", () => {
      const openAIDef = {
        type: "function" as const,
        function: {
          name: "create_task",
          description: "Create a new task",
          parameters: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      };
      const schema = ToolSchema.fromOpenAI(openAIDef);

      expect(schema.name).toBe("create_task");
      expect(schema.description).toBe("Create a new task");
      expect(schema.parameters).toEqual(openAIDef.function.parameters);
    });

    it("handles flat dict (no function wrapper)", () => {
      const flat = {
        name: "get_task",
        description: "Get a task",
        parameters: { type: "object", properties: {} },
      };
      const schema = ToolSchema.fromOpenAI(flat);
      expect(schema.name).toBe("get_task");
    });
  });

  describe("toDict", () => {
    it("returns plain object", () => {
      const schema = new ToolSchema("test", "Test tool", { type: "object", properties: {} });
      expect(schema.toDict()).toEqual({
        name: "test",
        description: "Test tool",
        parameters: { type: "object", properties: {} },
      });
    });

    it("includes returns only when declared", () => {
      const ret = { type: "object", properties: { ok: { type: "boolean" } } };
      const withReturns = new ToolSchema("t", "T", { type: "object" }, undefined, ret);
      expect(withReturns.toDict()).toHaveProperty("returns", ret);

      const noReturns = new ToolSchema("t", "T", { type: "object" });
      expect(noReturns.toDict()).not.toHaveProperty("returns");
    });

    it("includes terminal only when declared", () => {
      const terminal = new ToolSchema("t", "T", { type: "object" }, undefined, undefined, true);
      expect(terminal.toDict()).toHaveProperty("terminal", true);

      const ordinary = new ToolSchema("t", "T", { type: "object" });
      expect(ordinary.toDict()).not.toHaveProperty("terminal");
    });

    it("includes displayType only when declared", () => {
      const withHint = new ToolSchema(
        "t",
        "T",
        { type: "object" },
        undefined,
        undefined,
        undefined,
        "diff",
      );
      expect(withHint.toDict()).toHaveProperty("displayType", "diff");

      const ordinary = new ToolSchema("t", "T", { type: "object" });
      expect(ordinary.toDict()).not.toHaveProperty("displayType");
    });
  });

  describe("toOpenAI", () => {
    it("produces OpenAI function calling format", () => {
      const schema = new ToolSchema("my_tool", "Does stuff", {
        type: "object",
        properties: { x: { type: "string" } },
      });
      const result = schema.toOpenAI();
      expect(result).toEqual({
        type: "function",
        function: {
          name: "my_tool",
          description: "Does stuff",
          parameters: { type: "object", properties: { x: { type: "string" } } },
        },
      });
    });
  });

  describe("toClaude", () => {
    it("produces Claude tool definition format", () => {
      const schema = new ToolSchema("my_tool", "Does stuff", {
        type: "object",
        properties: {},
      });
      const result = schema.toClaude();
      expect(result).toEqual({
        name: "my_tool",
        description: "Does stuff",
        input_schema: { type: "object", properties: {} },
      });
    });
  });

  describe("toVercelAI", () => {
    it("returns Zod schema when created via fromZod", () => {
      const params = z.object({ query: z.string() });
      const schema = ToolSchema.fromZod("search", "Search", params);
      const result = schema.toVercelAI();

      expect(result.description).toBe("Search");
      expect(result.parameters).toBeDefined();
    });

    it("throws when not created from Zod", () => {
      const schema = new ToolSchema("test", "Test", { type: "object", properties: {} });
      expect(() => schema.toVercelAI()).toThrow("was not created from a Zod schema");
    });
  });

  it("is frozen after construction", () => {
    const schema = new ToolSchema("test", "Test", { type: "object" });
    expect(() => {
      (schema as unknown as Record<string, unknown>).name = "changed";
    }).toThrow();
  });
});
