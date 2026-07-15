/**
 * Tests for the static, dialect-driven model-facing schema linter.
 *
 * `lintModelFacingSchema` is a PURE structural Zod walker (no vendor SDK
 * imports, no runtime imports, no env/network) that flags Zod constructs a
 * given model-facing conversion path ("dialect") can't represent faithfully.
 * See `.ai-docs/specs/tool-authoring-sugar.md` § API design § Schema linter.
 */

import { describe, expect, it } from "vitest";
import { type ZodTypeAny, z } from "zod";
// Zod 3.25.76 also exposes the `zod/v4` subpath — mirror the four killer
// construct tests against it to prove the walker is version-tolerant
// (Zod 3 `_def.typeName` AND Zod 4 `_zod.def.type`).
import { z as z4 } from "zod/v4";
import { type SchemaLintFinding, lintModelFacingSchema } from "../model-facing-schema-lint.js";

function codesAt(findings: SchemaLintFinding[], path: string): string[] {
  return findings.filter((f) => f.path === path).map((f) => f.code);
}

function paths(findings: SchemaLintFinding[], code: string): string[] {
  return findings.filter((f) => f.code === code).map((f) => f.path);
}

describe("lintModelFacingSchema", () => {
  // -------------------------------------------------------------------------
  // PR-2: killer constructs
  // -------------------------------------------------------------------------

  it("gemini-bifrost: flags OpenAPI 3 boolean exclusive bounds from .positive(), .gt(), .negative(), and .lt()", () => {
    const schema = z.object({
      minAge: z.number().positive(),
      maxScore: z.number().gt(0),
      minTemp: z.number().negative(),
      maxTemp: z.number().lt(100),
      count: z.number().min(0),
      limit: z.number().max(100),
    });

    const findings = lintModelFacingSchema(schema);

    expect(paths(findings, "exclusive-numeric-bound").sort()).toEqual([
      "$.maxScore",
      "$.maxTemp",
      "$.minAge",
      "$.minTemp",
    ]);
    // Inclusive .min()/.max() must not produce findings.
    expect(codesAt(findings, "$.count")).toEqual([]);
    expect(codesAt(findings, "$.limit")).toEqual([]);
    for (const f of findings) {
      expect(f.severity).toBe("error");
      expect(f.dialect).toBe("gemini-bifrost");
    }
  });

  it("gemini-bifrost: flags recursive z.lazy schemas", () => {
    interface CategoryT {
      name: string;
      children: CategoryT[];
    }
    const Category: z.ZodType<CategoryT> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(Category) }),
    );

    const findings = lintModelFacingSchema(Category);

    expect(paths(findings, "recursive-lazy")).toEqual(["$.children[]"]);

    // A non-recursive lazy wrapper is clean.
    const nonRecursive = z.object({ note: z.lazy(() => z.string()) });
    expect(lintModelFacingSchema(nonRecursive)).toEqual([]);
  });

  it("gemini-bifrost: flags z.tuple array-form items", () => {
    const rootTuple = z.tuple([z.string(), z.number()]);
    expect(paths(lintModelFacingSchema(rootTuple), "tuple")).toEqual(["$"]);

    const nested = z.object({ pair: z.tuple([z.number(), z.number()]) });
    expect(paths(lintModelFacingSchema(nested), "tuple")).toEqual(["$.pair"]);
  });

  it("openai: flags structured-output .optional() without .nullable()", () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
      bio: z.string().nullable(),
      tag: z.string().nullable().optional(),
      address: z.object({
        zip: z.string().optional(),
      }),
    });

    const findings = lintModelFacingSchema(schema, { dialect: "openai" });

    expect(paths(findings, "optional-without-nullable").sort()).toEqual([
      "$.address.zip",
      "$.nickname",
    ]);
    // Required nullable is clean; nullable-optional is not reported by this rule.
    expect(codesAt(findings, "$.bio")).toEqual([]);
    expect(codesAt(findings, "$.tag")).toEqual([]);
    expect(codesAt(findings, "$.name")).toEqual([]);
    for (const f of findings) {
      expect(f.severity).toBe("error");
      expect(f.dialect).toBe("openai");
    }
  });

  // -------------------------------------------------------------------------
  // PR-2: supporting linter behavior — defaults, dialect isolation
  // -------------------------------------------------------------------------

  it("defaults to the gemini-bifrost dialect", () => {
    const schema = z.object({ n: z.number().positive() });
    const withDefault = lintModelFacingSchema(schema);
    const explicit = lintModelFacingSchema(schema, { dialect: "gemini-bifrost" });
    expect(withDefault).toEqual(explicit);
    expect(paths(withDefault, "exclusive-numeric-bound")).toEqual(["$.n"]);
  });

  it("isolates dialects: gemini rules do not appear under openai, and vice versa", () => {
    const schema = z.object({
      n: z.number().positive(),
      pair: z.tuple([z.number(), z.number()]),
      opt: z.string().optional(),
    });

    const gemini = lintModelFacingSchema(schema, { dialect: "gemini-bifrost" });
    expect(gemini.map((f) => f.code).sort()).toEqual(["exclusive-numeric-bound", "tuple"]);

    const openai = lintModelFacingSchema(schema, { dialect: "openai" });
    expect(openai.map((f) => f.code)).toEqual(["optional-without-nullable"]);
  });

  // -------------------------------------------------------------------------
  // PR-2: requireDescribe / missing-description
  // -------------------------------------------------------------------------

  it("requireDescribe defaults off — no missing-description findings", () => {
    const schema = z.object({ a: z.string(), b: z.object({ c: z.number() }) });
    expect(lintModelFacingSchema(schema)).toEqual([]);
  });

  it("missing leaf descriptions produce warnings, never errors", () => {
    const schema = z.object({ a: z.string() });
    const findings = lintModelFacingSchema(schema, { requireDescribe: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "missing-description",
      severity: "warning",
      path: "$.a",
    });
  });

  it("recognizes descriptions on optional/nullable wrappers", () => {
    const schema = z.object({
      a: z.string().describe("described before optional").optional(),
      b: z.string().optional().describe("described after optional"),
      c: z.string().nullable().describe("described after nullable"),
    });
    expect(lintModelFacingSchema(schema, { requireDescribe: true })).toEqual([]);
  });

  it("does not let a parent object's description satisfy its child leaves", () => {
    const schema = z.object({
      inner: z.object({ a: z.string() }).describe("the inner thing"),
    });
    const findings = lintModelFacingSchema(schema, { requireDescribe: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "missing-description",
      severity: "warning",
      path: "$.inner.a",
    });
  });

  it("arrays of primitives use the property path; arrays of objects recurse with []", () => {
    const schema = z.object({
      tags: z.array(z.string()),
      items: z.array(z.object({ name: z.string() })),
    });
    const findings = lintModelFacingSchema(schema, { requireDescribe: true });
    const byPath = findings.map((f) => f.path).sort();
    expect(byPath).toEqual(["$.items[].name", "$.tags"]);
  });

  it("a described object property does not need its own description even when it leads to undescribed leaves", () => {
    const schema = z.object({
      described: z.string().describe("has one"),
      obj: z.object({ leaf: z.string() }),
    });
    const findings = lintModelFacingSchema(schema, { requireDescribe: true });
    // `obj` itself is not a leaf (leads to further object properties) — only
    // `obj.leaf` should be reported, never `obj` itself.
    expect(findings.map((f) => f.path)).toEqual(["$.obj.leaf"]);
  });

  // -------------------------------------------------------------------------
  // PR-2: path correctness across wrapper/nesting semantics
  // -------------------------------------------------------------------------

  it("finds exclusive numeric bounds through default/readonly wrappers", () => {
    const schema = z.object({
      score: z.number().positive().default(1).readonly(),
    });
    expect(paths(lintModelFacingSchema(schema), "exclusive-numeric-bound")).toEqual(["$.score"]);
  });

  it("finds exclusive numeric bounds through effects/pipe (refine/transform)", () => {
    const refined = z.object({
      count: z
        .number()
        .positive()
        .refine((n) => n < 1000),
    });
    expect(paths(lintModelFacingSchema(refined), "exclusive-numeric-bound")).toEqual(["$.count"]);

    const transformed = z.object({
      count: z
        .number()
        .positive()
        .transform((n) => String(n)),
    });
    expect(paths(lintModelFacingSchema(transformed), "exclusive-numeric-bound")).toEqual([
      "$.count",
    ]);
  });

  it("finds exclusive numeric bounds through branded schemas", () => {
    const schema = z.object({
      meters: z.number().positive().brand<"Meters">(),
    });
    expect(paths(lintModelFacingSchema(schema), "exclusive-numeric-bound")).toEqual(["$.meters"]);
  });

  it("finds exclusive numeric bounds through union members at the same path", () => {
    const schema = z.object({
      value: z.union([z.number().positive(), z.string()]),
    });
    expect(paths(lintModelFacingSchema(schema), "exclusive-numeric-bound")).toEqual(["$.value"]);
  });

  it("finds exclusive numeric bounds through intersection members, descending object shape", () => {
    const schema = z.object({
      value: z.intersection(z.object({ a: z.number().positive() }), z.object({ b: z.string() })),
    });
    expect(paths(lintModelFacingSchema(schema), "exclusive-numeric-bound")).toEqual(["$.value.a"]);
  });

  it("reports correct paths through nested arrays of arrays and objects", () => {
    const schema = z.object({
      grid: z.array(z.array(z.number().positive())),
    });
    expect(paths(lintModelFacingSchema(schema), "exclusive-numeric-bound")).toEqual(["$.grid[][]"]);
  });

  // -------------------------------------------------------------------------
  // PR-2: reused nodes, recursion termination, ordering, dedup
  // -------------------------------------------------------------------------

  it("reports a reused schema node at both of its paths", () => {
    const Coord = z.object({ x: z.number().positive() });
    const schema = z.object({ a: Coord, b: Coord });
    expect(paths(lintModelFacingSchema(schema), "exclusive-numeric-bound").sort()).toEqual([
      "$.a.x",
      "$.b.x",
    ]);
  });

  it("terminates deterministically on a recursive graph without hanging", () => {
    interface NodeT {
      name: string;
      next?: NodeT;
    }
    const Node: z.ZodType<NodeT> = z.lazy(() =>
      z.object({ name: z.string(), next: Node.optional() }),
    );
    const findings = lintModelFacingSchema(Node);
    expect(paths(findings, "recursive-lazy")).toEqual(["$.next"]);
  });

  it("produces stable DFS-ordered findings and dedups by (code, path)", () => {
    const schema = z.object({
      first: z.number().positive(),
      second: z.object({
        nested: z.number().gt(0),
      }),
      third: z.union([z.number().positive(), z.number().gt(0)]),
    });

    const findings = lintModelFacingSchema(schema);
    // DFS pre-order: shallower/earlier keys before deeper/later ones.
    expect(findings.map((f) => f.path)).toEqual(["$.first", "$.second.nested", "$.third"]);
    // `third` is a union of two exclusive-bound members at the same path —
    // must dedup to a single (code, path) finding.
    expect(findings.filter((f) => f.path === "$.third")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // PR-2: tuple stop-descending-for-errors / description-inspection semantics
  // -------------------------------------------------------------------------

  it("stops descending into tuple items for dialect errors, but still checks descriptions when requested", () => {
    const schema = z.object({
      pair: z.tuple([z.number().positive(), z.object({ label: z.string() })]),
    });

    // Error rules: only the tuple itself is flagged — the exclusive bound
    // inside item 0 is not reported once the tuple has already blocked descent.
    const errors = lintModelFacingSchema(schema);
    expect(errors.map((f) => f.code)).toEqual(["tuple"]);

    // Description warnings: the tuple property itself is a leaf (no describe),
    // and — since requireDescribe is on — the tuple is still inspected enough
    // to find the undescribed property nested inside its object-shaped item.
    // Item 0 (a bare number) is positional, not an object property, so it is
    // never itself a description target.
    const withDescribe = lintModelFacingSchema(schema, { requireDescribe: true });
    const warningPaths = withDescribe
      .filter((f) => f.code === "missing-description")
      .map((f) => f.path)
      .sort();
    expect(warningPaths).toEqual(["$.pair", "$.pair[1].label"]);
  });

  // -------------------------------------------------------------------------
  // PR-2: zod/v4 mirror of the four killer construct tests
  // -------------------------------------------------------------------------

  describe("zod/v4 compatibility", () => {
    it("gemini-bifrost: flags exclusive bounds from .positive()/.gt()/.negative()/.lt() (zod/v4)", () => {
      const schema = z4.object({
        minAge: z4.number().positive(),
        maxScore: z4.number().gt(0),
        minTemp: z4.number().negative(),
        maxTemp: z4.number().lt(100),
        count: z4.number().min(0),
      });

      const findings = lintModelFacingSchema(schema as unknown as ZodTypeAny);

      expect(paths(findings, "exclusive-numeric-bound").sort()).toEqual([
        "$.maxScore",
        "$.maxTemp",
        "$.minAge",
        "$.minTemp",
      ]);
      expect(codesAt(findings, "$.count")).toEqual([]);
    });

    it("gemini-bifrost: flags recursive z.lazy schemas (zod/v4)", () => {
      interface CategoryT {
        name: string;
        children: CategoryT[];
      }
      const Category: z4.ZodType<CategoryT> = z4.lazy(() =>
        z4.object({ name: z4.string(), children: z4.array(Category) }),
      );

      const findings = lintModelFacingSchema(Category as unknown as ZodTypeAny);
      expect(paths(findings, "recursive-lazy")).toEqual(["$.children[]"]);

      const nonRecursive = z4.object({ note: z4.lazy(() => z4.string()) });
      expect(lintModelFacingSchema(nonRecursive as unknown as ZodTypeAny)).toEqual([]);
    });

    it("gemini-bifrost: flags z.tuple array-form items, root and nested (zod/v4)", () => {
      const rootTuple = z4.tuple([z4.string(), z4.number()]);
      expect(paths(lintModelFacingSchema(rootTuple as unknown as ZodTypeAny), "tuple")).toEqual([
        "$",
      ]);

      const nested = z4.object({ pair: z4.tuple([z4.number(), z4.number()]) });
      expect(paths(lintModelFacingSchema(nested as unknown as ZodTypeAny), "tuple")).toEqual([
        "$.pair",
      ]);
    });

    it("openai: flags structured-output .optional() without .nullable() (zod/v4)", () => {
      const schema = z4.object({
        nickname: z4.string().optional(),
        bio: z4.string().nullable(),
        tag: z4.string().nullable().optional(),
      });

      const findings = lintModelFacingSchema(schema as unknown as ZodTypeAny, {
        dialect: "openai",
      });

      expect(paths(findings, "optional-without-nullable")).toEqual(["$.nickname"]);
      expect(codesAt(findings, "$.bio")).toEqual([]);
      expect(codesAt(findings, "$.tag")).toEqual([]);
    });
  });
});
