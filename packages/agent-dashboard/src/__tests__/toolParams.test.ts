/**
 * `foldToolParams` — the JSON-schema→flat-param fold behind the Tool
 * Workbench's Construction table and `ToolRunner` form (port-map §2.3).
 */
import { describe, expect, it } from "vitest";
import { foldToolParams } from "../lib/toolParams";

describe("foldToolParams", () => {
  it("flattens an object schema's properties into name/type/required/description", () => {
    const schema = {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to slugify" },
        uppercase: { type: "boolean", description: "Emit SCREAMING-KEBAB" },
      },
      required: ["text"],
    };

    expect(foldToolParams(schema)).toEqual([
      { name: "text", type: "string", required: true, description: "Text to slugify" },
      { name: "uppercase", type: "boolean", required: false, description: "Emit SCREAMING-KEBAB" },
    ]);
  });

  it("preserves property declaration order", () => {
    const schema = {
      type: "object",
      properties: {
        b: { type: "number" },
        a: { type: "string" },
      },
    };
    expect(foldToolParams(schema).map((p) => p.name)).toEqual(["b", "a"]);
  });

  it("defaults `required` to false when no `required` array is present", () => {
    const schema = { type: "object", properties: { x: { type: "number" } } };
    expect(foldToolParams(schema)).toEqual([
      { name: "x", type: "number", required: false, description: undefined },
    ]);
  });

  it("degrades an untyped property to type 'unknown' rather than omitting it", () => {
    const schema = { type: "object", properties: { mystery: {} } };
    expect(foldToolParams(schema)[0]).toMatchObject({ name: "mystery", type: "unknown" });
  });

  it("returns [] for a schema with no properties, undefined, or a non-object shape", () => {
    expect(foldToolParams({ type: "object", properties: {} })).toEqual([]);
    expect(foldToolParams(undefined)).toEqual([]);
    expect(foldToolParams({ type: "string" })).toEqual([]);
  });

  it("folds a nested object-typed property as a single 'object' param (not recursed)", () => {
    const schema = {
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
        },
      },
      required: ["a"],
    };
    expect(foldToolParams(schema)).toEqual([
      { name: "a", type: "object", required: true, description: undefined },
    ]);
  });
});
