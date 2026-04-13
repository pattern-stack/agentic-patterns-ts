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
