import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ScopeItem, SessionScope, scopeItem, sessionScope } from "../session-scope.js";
import type { ScopeValue } from "../session-scope.js";

describe("ScopeItem", () => {
  it("carries schema, description, and redact", () => {
    const item = scopeItem(z.string().min(1), { description: "Tenant workspace", redact: true });
    expect(item.schema).toBeInstanceOf(z.ZodString);
    expect(item.description).toBe("Tenant workspace");
    expect(item.redact).toBe(true);
  });

  it("leaves description and redact undefined when not provided", () => {
    const item = scopeItem(z.string());
    expect(item.description).toBeUndefined();
    expect(item.redact).toBeUndefined();
  });

  it("scopeItem() satisfies instanceof ScopeItem", () => {
    const item = scopeItem(z.string());
    expect(item).toBeInstanceOf(ScopeItem);
  });

  it("is frozen after construction", () => {
    const item = scopeItem(z.string());
    expect(() => {
      (item as unknown as Record<string, unknown>).description = "changed";
    }).toThrow();
  });
});

describe("SessionScope", () => {
  describe("schema composition", () => {
    it("composes a Zod object schema from item schemas", () => {
      const scope = new SessionScope({
        workspace: scopeItem(z.string().min(1)),
        count: scopeItem(z.number().int()),
      });
      expect(scope.schema.parse({ workspace: "acme", count: 3 })).toEqual({
        workspace: "acme",
        count: 3,
      });
    });

    it("rejects input missing a required item field", () => {
      const scope = new SessionScope({ workspace: scopeItem(z.string().min(1)) });
      expect(() => scope.schema.parse({})).toThrow();
    });
  });

  describe("parse", () => {
    const scope = new SessionScope({
      workspace: scopeItem(z.string().min(1)),
      user: scopeItem(z.string().email()),
    });

    it("returns the parsed value for valid input", () => {
      const result = scope.parse({ workspace: "acme", user: "a@acme.dev" });
      expect(result).toEqual({ workspace: "acme", user: "a@acme.dev" });
    });

    it("lets the ZodError propagate for invalid input", () => {
      expect(() => scope.parse({ workspace: "acme", user: "not-an-email" })).toThrow();
    });
  });

  describe("redactKeys", () => {
    it("collects keys marked redact: true", () => {
      const scope = new SessionScope({
        workspace: scopeItem(z.string()),
        apiKey: scopeItem(z.string(), { redact: true }),
        user: scopeItem(z.string(), { redact: false }),
      });
      expect(scope.redactKeys).toEqual(["apiKey"]);
    });

    it("is empty when no items are marked redact", () => {
      const scope = new SessionScope({ workspace: scopeItem(z.string()) });
      expect(scope.redactKeys).toEqual([]);
    });

    it("is frozen", () => {
      const scope = new SessionScope({ apiKey: scopeItem(z.string(), { redact: true }) });
      expect(() => {
        (scope.redactKeys as unknown as string[]).push("nope");
      }).toThrow();
    });
  });

  describe("toJsonSchema", () => {
    it("converts the composed schema to JSON Schema", () => {
      const scope = new SessionScope({
        workspace: scopeItem(z.string()),
        count: scopeItem(z.number().optional()),
      });
      const jsonSchema = scope.toJsonSchema();
      expect(jsonSchema).toHaveProperty("type", "object");
      expect(jsonSchema).toHaveProperty("properties");
    });

    it("strips $schema (sets to undefined, matching ToolSchema.fromZod precedent)", () => {
      const scope = new SessionScope({ workspace: scopeItem(z.string()) });
      const jsonSchema = scope.toJsonSchema();
      expect(jsonSchema.$schema).toBeUndefined();
    });
  });

  describe("defaults", () => {
    it("stores a frozen, parsed copy when valid", () => {
      const scope = new SessionScope(
        { workspace: scopeItem(z.string().min(1)) },
        { defaults: { workspace: "acme" } },
      );
      expect(scope.defaults).toEqual({ workspace: "acme" });
      expect(() => {
        (scope.defaults as unknown as Record<string, unknown>).workspace = "changed";
      }).toThrow();
    });

    it("throws naming 'defaults' when invalid", () => {
      expect(
        () =>
          new SessionScope(
            { workspace: scopeItem(z.string().min(1)) },
            { defaults: { workspace: "" } },
          ),
      ).toThrow(/defaults/);
    });

    it("is undefined when not declared", () => {
      const scope = new SessionScope({ workspace: scopeItem(z.string()) });
      expect(scope.defaults).toBeUndefined();
    });
  });

  describe("presets", () => {
    it("stores frozen, parsed copies keyed by preset name", () => {
      const scope = new SessionScope(
        { workspace: scopeItem(z.string().min(1)) },
        { presets: { acme: { workspace: "acme-ops" }, globex: { workspace: "globex-ops" } } },
      );
      expect(scope.presets).toEqual({
        acme: { workspace: "acme-ops" },
        globex: { workspace: "globex-ops" },
      });
      expect(() => {
        (scope.presets as unknown as Record<string, unknown>).acme = {};
      }).toThrow();
      expect(() => {
        (scope.presets?.acme as unknown as Record<string, unknown>).workspace = "changed";
      }).toThrow();
    });

    it("throws naming the offending preset when invalid", () => {
      expect(
        () =>
          new SessionScope(
            { workspace: scopeItem(z.string().min(1)) },
            { presets: { good: { workspace: "acme" }, bad: { workspace: "" } } },
          ),
      ).toThrow(/preset "bad"/);
    });

    it("is undefined when not declared", () => {
      const scope = new SessionScope({ workspace: scopeItem(z.string()) });
      expect(scope.presets).toBeUndefined();
    });
  });

  describe("sessionScope()", () => {
    it("satisfies instanceof SessionScope", () => {
      const scope = sessionScope({ workspace: scopeItem(z.string()) });
      expect(scope).toBeInstanceOf(SessionScope);
    });
  });

  describe("ScopeValue", () => {
    it("infers a plain object type over the composed items", () => {
      const scope = new SessionScope({
        name: scopeItem(z.string()),
        age: scopeItem(z.number()),
      });
      type Value = ScopeValue<typeof scope>;
      const value: Value = scope.parse({ name: "Ada", age: 32 });
      expect(value.name).toBe("Ada");
      expect(value.age).toBe(32);
    });
  });

  it("is frozen after construction", () => {
    const scope = new SessionScope({ workspace: scopeItem(z.string()) });
    expect(() => {
      (scope as unknown as Record<string, unknown>).redactKeys = [];
    }).toThrow();
  });
});
