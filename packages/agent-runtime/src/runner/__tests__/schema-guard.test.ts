/**
 * Tests for the runStructured open-object schema guard.
 *
 * Open-object nodes (z.record / .passthrough() / .catchall() / z.map) are
 * silently decoded to {} by schema-subset providers (Gemini responseSchema
 * drops `additionalProperties`; OpenAI strict prohibits open maps) — the
 * guard makes that hazard LOUD before any LLM call.
 */

import { MockLanguageModelV2 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../agent-runner.js";
import type { AgentLike } from "../agent-runner.js";
import {
  OpenObjectSchemaError,
  collectOpenObjectPaths,
  guardOpenObjectSchemas,
} from "../schema-guard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    role: { name: "test-agent" },
    getModel: () => "test-model",
    getTools: () => [],
    getSystemPrompt: () => "You are a helpful assistant.",
    renderInitialPrompt: () => "You are a helpful assistant.",
    ...overrides,
  };
}

/** A structured-output doGenerate result: the object as a text part. */
function structuredTextResult(object: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(object) }],
    finishReason: "stop" as const,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    warnings: [],
  };
}

const WIRE_SEAM_REMEDY =
  "carry free-form objects as a JSON-encoded string field and decode after parsing — the wire-seam pattern";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// collectOpenObjectPaths — the walker
// ---------------------------------------------------------------------------

describe("collectOpenObjectPaths", () => {
  it("flags a z.record at a root property with its path", () => {
    const schema = z.object({ title: z.string(), body: z.record(z.string()) });
    expect(collectOpenObjectPaths(schema)).toEqual(["$.body"]);
  });

  it("flags a nested record with the nested path", () => {
    const schema = z.object({
      results: z.array(z.object({ id: z.string(), meta: z.record(z.unknown()) })),
    });
    expect(collectOpenObjectPaths(schema)).toEqual(["$.results[].meta"]);
  });

  it("flags a record at the schema root", () => {
    expect(collectOpenObjectPaths(z.record(z.number()))).toEqual(["$"]);
  });

  it("flags ZodObject.passthrough()", () => {
    const schema = z.object({ inner: z.object({ a: z.string() }).passthrough() });
    expect(collectOpenObjectPaths(schema)).toEqual(["$.inner"]);
  });

  it("flags ZodObject.catchall()", () => {
    const schema = z.object({ a: z.string() }).catchall(z.number());
    expect(collectOpenObjectPaths(schema)).toEqual(["$"]);
  });

  it("flags z.map", () => {
    const schema = z.object({ lookup: z.map(z.string(), z.number()) });
    expect(collectOpenObjectPaths(schema)).toEqual(["$.lookup"]);
  });

  it("finds open nodes through optional/nullable/default/effects wrappers and unions", () => {
    const schema = z.object({
      a: z.record(z.string()).optional(),
      b: z.union([z.string(), z.object({ c: z.record(z.string()) })]),
      d: z
        .object({ e: z.string() })
        .strict()
        .transform((v) => v),
    });
    expect(collectOpenObjectPaths(schema)).toEqual(["$.a", "$.b.c"]);
  });

  it("treats enum-keyed records as closed (keys fully declared)", () => {
    const schema = z.object({
      byStage: z.record(z.enum(["open", "closed"]), z.number()),
    });
    expect(collectOpenObjectPaths(schema)).toEqual([]);
  });

  it("passes a fully closed .strict() schema", () => {
    const schema = z
      .object({
        title: z.string(),
        items: z.array(z.object({ id: z.string(), score: z.number() }).strict()),
      })
      .strict();
    expect(collectOpenObjectPaths(schema)).toEqual([]);
  });

  it("passes a plain (strip) object schema — unknown keys are dropped, not open", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    expect(collectOpenObjectPaths(schema)).toEqual([]);
  });

  it("does not loop on recursive lazy schemas", () => {
    type Node = { name: string; children: Node[] };
    const node: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(node) }),
    );
    expect(collectOpenObjectPaths(node)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// guardOpenObjectSchemas — throw / warn behavior
// ---------------------------------------------------------------------------

describe("guardOpenObjectSchemas", () => {
  it("throws OpenObjectSchemaError naming the path, the why, and the wire-seam remedy", () => {
    const schema = z.object({ body: z.record(z.string()) });
    try {
      guardOpenObjectSchemas(schema);
      expect.unreachable("guard should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OpenObjectSchemaError);
      const err = e as OpenObjectSchemaError;
      expect(err.paths).toEqual(["$.body"]);
      expect(err.message).toContain("$.body");
      expect(err.message).toContain("responseSchema");
      expect(err.message).toContain("additionalProperties");
      expect(err.message).toContain("OpenAI strict");
      expect(err.message).toContain(WIRE_SEAM_REMEDY);
    }
  });

  it("does nothing for a closed schema", () => {
    expect(() => guardOpenObjectSchemas(z.object({ a: z.string() }).strict())).not.toThrow();
  });

  it("with allowOpenObjectSchemas warns once per schema instance and proceeds", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = z.object({ body: z.record(z.string()) });

    expect(() => guardOpenObjectSchemas(schema, true)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(WIRE_SEAM_REMEDY);

    // Same schema instance again → no second warning.
    guardOpenObjectSchemas(schema, true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AgentRunner.runStructured integration
// ---------------------------------------------------------------------------

describe("AgentRunner.runStructured open-object guard", () => {
  it("throws before any LLM call when the schema has an open-object node", async () => {
    let llmCalled = false;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        llmCalled = true;
        return structuredTextResult({ body: {} });
      },
    });
    const runner = new AgentRunner(model);

    await expect(
      runner.runStructured(makeAgent(), "extract", z.object({ body: z.record(z.string()) })),
    ).rejects.toThrow(OpenObjectSchemaError);
    expect(llmCalled).toBe(false);
  });

  it("with allowOpenObjectSchemas: true warns and proceeds to a structured result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new MockLanguageModelV2({
      doGenerate: async () => structuredTextResult({ body: { anything: "goes" } }),
    });
    const runner = new AgentRunner(model);

    const result = await runner.runStructured(
      makeAgent(),
      "extract",
      z.object({ body: z.record(z.string()) }),
      { allowOpenObjectSchemas: true },
    );
    expect((result.object as { body: Record<string, string> }).body).toEqual({
      anything: "goes",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(WIRE_SEAM_REMEDY);
  });

  it("runs closed schemas untouched", async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => structuredTextResult({ title: "ok" }),
    });
    const runner = new AgentRunner(model);

    const result = await runner.runStructured(
      makeAgent(),
      "extract",
      z.object({ title: z.string() }).strict(),
    );
    expect(result.object).toEqual({ title: "ok" });
  });
});
