import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgenticModel } from "../base.js";

const TestSchema = z.object({
  name: z.string(),
  items: z.array(z.string()).default([]),
  meta: z.record(z.string()).default({}),
  count: z.number().default(0),
});

class TestModel extends AgenticModel<typeof TestSchema.shape> {
  constructor(data: z.input<typeof TestSchema>) {
    super(TestSchema, data);
  }

  toPrompt(): string {
    return `Name: ${this.data.name}`;
  }
}

describe("AgenticModel", () => {
  it("validates input on construction", () => {
    const m = new TestModel({ name: "test" });
    expect(m.data.name).toBe("test");
    expect(m.data.items).toEqual([]);
    expect(m.data.meta).toEqual({});
    expect(m.data.count).toBe(0);
  });

  it("rejects invalid input", () => {
    expect(() => new TestModel({ name: 123 } as unknown as z.input<typeof TestSchema>)).toThrow();
  });

  it("returns frozen data", () => {
    const m = new TestModel({ name: "test" });
    expect(() => {
      (m.data as Record<string, unknown>).name = "changed";
    }).toThrow();
  });

  it("replace() returns new instance with original unchanged", () => {
    const m = new TestModel({ name: "original", count: 1 });
    const replaced = m.replace({ name: "updated" });
    expect(replaced.data.name).toBe("updated");
    expect(replaced.data.count).toBe(1);
    expect(m.data.name).toBe("original");
    expect(replaced).toBeInstanceOf(TestModel);
  });

  it("merge() concatenates arrays", () => {
    const a = new TestModel({ name: "a", items: ["x"] });
    const b = new TestModel({ name: "b", items: ["y"] });
    const merged = a.merge(b);
    expect(merged.data.items).toEqual(["x", "y"]);
  });

  it("merge() spreads records", () => {
    const a = new TestModel({ name: "a", meta: { k1: "v1" } });
    const b = new TestModel({ name: "b", meta: { k2: "v2" } });
    const merged = a.merge(b);
    expect(merged.data.meta).toEqual({ k1: "v1", k2: "v2" });
  });

  it("merge() takes other's non-default scalar", () => {
    const a = new TestModel({ name: "a", count: 5 });
    const b = new TestModel({ name: "b", count: 10 });
    const merged = a.merge(b);
    expect(merged.data.count).toBe(10);
    expect(merged.data.name).toBe("b");
  });

  it("merge() keeps self's scalar when other has default", () => {
    const a = new TestModel({ name: "a", count: 5 });
    const b = new TestModel({ name: "b", count: 0 }); // 0 is the default
    const merged = a.merge(b);
    expect(merged.data.count).toBe(5);
  });

  it("merge() throws TypeError for different types", () => {
    class OtherModel extends AgenticModel<typeof TestSchema.shape> {
      constructor(data: z.input<typeof TestSchema>) {
        super(TestSchema, data);
      }
      toPrompt(): string {
        return "";
      }
    }
    const a = new TestModel({ name: "a" });
    const b = new OtherModel({ name: "b" });
    expect(() => a.merge(b as unknown as TestModel)).toThrow(TypeError);
  });

  it("toJSON() returns a plain object", () => {
    const m = new TestModel({ name: "test", items: ["a"] });
    const json = m.toJSON();
    expect(json).toEqual({
      name: "test",
      items: ["a"],
      meta: {},
      count: 0,
    });
  });
});
