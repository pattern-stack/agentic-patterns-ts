/**
 * Static model-facing Zod schema linter.
 *
 * `lintModelFacingSchema` walks a Zod schema's def tree structurally (Zod 3
 * `_def.typeName` AND Zod 4 `_zod.def.type` are both handled — no Zod-class
 * `instanceof`) and flags constructs unsupported by a given model-facing
 * conversion path ("dialect"). It is a PURE function: no vendor SDK imports,
 * no runtime imports, no environment/network access, no mutation of the
 * schema, and it never throws for a lint finding.
 *
 * Dialects are closed data/rule sets (see {@link DIALECT_RULES}) — there is
 * no runtime rule registration in v1. `defineTool` never calls this linter
 * automatically (see `docs/authoring-a-toolbox.md` § Lint model-facing
 * schemas in CI for why): the intended integration is explicit consumer
 * smoke/CI code, e.g. `tools/check-model-facing-schemas.ts` in this repo.
 */

import type { ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SchemaLintDialect = "gemini-bifrost" | "openai";

export type SchemaLintSeverity = "error" | "warning";

export type SchemaLintCode =
  | "exclusive-numeric-bound"
  | "recursive-lazy"
  | "tuple"
  | "optional-without-nullable"
  | "missing-description";

export interface SchemaLintFinding {
  readonly code: SchemaLintCode;
  readonly severity: SchemaLintSeverity;
  /** JSONPath-like location: $, $.field, $.items[], $.tuple[0]. */
  readonly path: string;
  readonly dialect: SchemaLintDialect;
  readonly message: string;
}

export interface SchemaLintOptions {
  /**
   * Provider/conversion-path rule set.
   * @default "gemini-bifrost"
   */
  readonly dialect?: SchemaLintDialect;
  /**
   * Warn when an object-property leaf has no `.describe()` metadata.
   * @default false
   */
  readonly requireDescribe?: boolean;
}

// ---------------------------------------------------------------------------
// Dialect rule registry (private, closed data — no runtime registration)
// ---------------------------------------------------------------------------

/** Rule ids that are dialect-scoped errors. `missing-description` is not one
 *  of these — it is dialect-independent and gated purely by `requireDescribe`. */
type SchemaRuleId =
  | "exclusive-numeric-bound"
  | "recursive-lazy"
  | "tuple"
  | "optional-without-nullable";

const DIALECT_RULES: Record<SchemaLintDialect, readonly SchemaRuleId[]> = {
  "gemini-bifrost": ["exclusive-numeric-bound", "recursive-lazy", "tuple"],
  openai: ["optional-without-nullable"],
};

// ---------------------------------------------------------------------------
// Version-tolerant Zod def-tree access (private) — Zod 3 `_def` / Zod 4
// `_zod.def`, mirroring the proven approach in the runtime's schema guard
// (packages/agent-runtime/src/runner/schema-guard.ts) without importing it.
// ---------------------------------------------------------------------------

type AnyDef = Record<string, unknown>;

/** Get the def record from a Zod 3 (`_def`) or Zod 4 (`_zod.def`) schema/check node. */
function getDef(node: unknown): AnyDef | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const v4 = (node as { _zod?: { def?: AnyDef } })._zod?.def;
  if (v4 && typeof v4 === "object") return v4;
  const v3 = (node as { _def?: AnyDef })._def;
  return v3 && typeof v3 === "object" ? v3 : undefined;
}

/**
 * Normalized kind of a schema node: Zod 3's `typeName` ("ZodObject") and
 * Zod 4's `type` ("object") both normalize to lowercase without the prefix.
 */
function kindOf(node: unknown): string | undefined {
  const def = getDef(node);
  if (!def) return undefined;
  const typeName = def.typeName;
  if (typeof typeName === "string") {
    return typeName.startsWith("Zod") ? typeName.slice(3).toLowerCase() : typeName.toLowerCase();
  }
  return typeof def.type === "string" ? def.type.toLowerCase() : undefined;
}

/**
 * A schema's `.describe()` text, if any. Both Zod 3 (`get description() {
 * return this._def.description }`) and Zod 4 classic (a registry-backed
 * `description` getter defined directly on the instance) expose this as a
 * plain string property/getter on the schema object itself — no `_def`
 * reach-through needed, which keeps this helper version-agnostic for free.
 */
function getDescription(node: unknown): string | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const desc = (node as { description?: unknown }).description;
  return typeof desc === "string" && desc.length > 0 ? desc : undefined;
}

/** Structural kinds where the walker stops unwrapping and dispatches by kind. */
const STRUCTURAL_KINDS = new Set([
  "object",
  "array",
  "tuple",
  "union",
  "discriminatedunion",
  "intersection",
  "record",
  "map",
  "set",
  "lazy",
]);

/**
 * The next transparent-wrapper layer, tried in priority order across the
 * wrapper field names actually used by Zod 3/4 (verified against both
 * installed packages): `innerType` (optional/nullable/default/catch/
 * readonly/nonoptional/…), `schema` (Zod 3 ZodEffects), `in` (Zod 4
 * ZodPipe — the pre-transform/input side, matching the OpenAPI 3 conversion
 * path's own preference), and `type` when it holds an object (Zod 3
 * ZodBranded/ZodPromise). `out` is a last resort for pipes with no `in`.
 */
function nextTransparentLayer(def: AnyDef): unknown {
  if (def.innerType !== undefined) return def.innerType;
  if (def.schema !== undefined) return def.schema;
  if (def.in !== undefined) return def.in;
  if (typeof def.type === "object" && def.type !== null) return def.type;
  if (def.out !== undefined) return def.out;
  return undefined;
}

interface Unwrapped {
  /** The structural core node (object/array/tuple/union/…/lazy/leaf primitive). */
  readonly core: unknown;
  readonly coreDef: AnyDef | undefined;
  readonly coreKind: string | undefined;
  /** Whether an `optional` wrapper was seen anywhere in the transparent chain. */
  readonly optional: boolean;
  /** Whether a `nullable` wrapper was seen anywhere in the transparent chain. */
  readonly nullable: boolean;
  /** Whether `.describe()` was found on ANY layer, including the core itself. */
  readonly described: boolean;
}

/** Unwrap transparent wrapper layers down to the structural core, tracking
 *  optional/nullable/description flags seen along the way. Never recurses
 *  into `lazy` (that requires cycle-safe handling — see {@link walkNode}). */
function unwrap(schema: unknown): Unwrapped {
  let current = schema;
  let optional = false;
  let nullable = false;
  let described = false;

  // Bounded loop: transparent wrapper chains are finite by construction
  // (unlike lazy cycles, which this loop never follows).
  for (let i = 0; i < 2000; i++) {
    if (current === null || typeof current !== "object") break;
    if (getDescription(current) !== undefined) described = true;

    const kind = kindOf(current);
    if (kind !== undefined && STRUCTURAL_KINDS.has(kind)) break;

    const def = getDef(current);
    if (!def) break;

    if (kind === "optional") optional = true;
    if (kind === "nullable") nullable = true;

    const next = nextTransparentLayer(def);
    if (next === undefined) break;
    current = next;
  }

  return {
    core: current,
    coreDef: getDef(current),
    coreKind: kindOf(current),
    optional,
    nullable,
    described,
  };
}

// ---------------------------------------------------------------------------
// Exclusive numeric bound detection
// ---------------------------------------------------------------------------

/**
 * `.positive()`/`.gt()` add an exclusive MINIMUM check; `.negative()`/`.lt()`
 * add an exclusive MAXIMUM check (installed Zod: `.positive()` → `{kind:
 * "min", inclusive:false}`, `.negative()` → `{kind:"max", inclusive:false}`;
 * Zod 4 core: `{check:"greater_than"|"less_than", inclusive}`). Inclusive
 * `.min()`/.`max()` (`inclusive:true`) and non-numeric length checks (Zod
 * string/array min/max carry no `inclusive` field at all) never match.
 */
function getExclusiveBounds(def: AnyDef): { exclusiveMin: boolean; exclusiveMax: boolean } {
  const checks = def.checks;
  let exclusiveMin = false;
  let exclusiveMax = false;
  if (Array.isArray(checks)) {
    for (const check of checks) {
      const checkDef =
        getDef(check) ??
        (check !== null && typeof check === "object" ? (check as AnyDef) : undefined);
      if (!checkDef) continue;
      if (checkDef.inclusive !== false) continue;
      const kind = typeof checkDef.kind === "string" ? checkDef.kind : undefined;
      const name = typeof checkDef.check === "string" ? checkDef.check : undefined;
      if (kind === "min" || name === "greater_than") exclusiveMin = true;
      if (kind === "max" || name === "less_than") exclusiveMax = true;
    }
  }
  return { exclusiveMin, exclusiveMax };
}

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

/** Zod 4: `def.element`; Zod 3: `def.type` (the array's element schema). */
function arrayElement(def: AnyDef | undefined): unknown {
  if (!def) return undefined;
  return def.element ?? (typeof def.type === "object" ? def.type : undefined);
}

function isArrayOfObjects(u: Unwrapped): boolean {
  if (u.coreKind !== "array") return false;
  return unwrap(arrayElement(u.coreDef)).coreKind === "object";
}

// ---------------------------------------------------------------------------
// Walk context + finding helpers
// ---------------------------------------------------------------------------

interface WalkContext {
  readonly dialect: SchemaLintDialect;
  readonly requireDescribe: boolean;
  readonly findings: SchemaLintFinding[];
  readonly seen: Set<string>;
}

function ruleEnabled(ctx: WalkContext, rule: SchemaRuleId): boolean {
  return DIALECT_RULES[ctx.dialect].includes(rule);
}

/** Push a finding, deduped by `(code, path)`. Fresh plain mutable objects —
 *  `readonly` on {@link SchemaLintFinding} is a type contract, not a freeze. */
function pushFinding(
  ctx: WalkContext,
  code: SchemaLintCode,
  severity: SchemaLintSeverity,
  path: string,
  message: string,
): void {
  const key = `${code} ${path}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  ctx.findings.push({ code, severity, path, dialect: ctx.dialect, message });
}

function exclusiveBoundMessage(
  path: string,
  exclusiveMin: boolean,
  exclusiveMax: boolean,
  dialect: SchemaLintDialect,
): string {
  const parts: string[] = [];
  if (exclusiveMin) parts.push("an exclusive lower bound (.positive()/.gt())");
  if (exclusiveMax) parts.push("an exclusive upper bound (.negative()/.lt())");
  return `Schema at ${path} declares ${parts.join(" and ")}; the ${dialect} OpenAPI 3 conversion emits boolean exclusiveMinimum/exclusiveMaximum, which the target conversion path does not support. Use an inclusive .min()/.max() instead.`;
}

function recursiveLazyMessage(path: string, dialect: SchemaLintDialect): string {
  return (
    `Schema at ${path} is recursive (a z.lazy() reference cycles back to an ancestor schema); ` +
    `recursive schemas are not representable in the ${dialect} conversion path.`
  );
}

function tupleMessage(path: string, dialect: SchemaLintDialect): string {
  return (
    `Schema at ${path} uses z.tuple(...); positional tuples are not representable in the ` +
    `${dialect} conversion path — use z.array() or a named z.object() instead.`
  );
}

function optionalWithoutNullableMessage(path: string): string {
  return `Object property at ${path} is .optional() without a nullable value form; the openai structured-output conversion requires optional properties to also accept null (e.g. .nullable().optional()) or to be made required.`;
}

function missingDescriptionMessage(path: string): string {
  return `Object property at ${path} has no .describe() — add one so the model understands what this field is for.`;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/**
 * Evaluate rules scoped to an OBJECT PROPERTY boundary — `optional-without-
 * nullable` (openai) and, when requested, `missing-description` on leaves —
 * then recurse structurally into the property's schema.
 */
function handleObjectProperty(
  propSchema: unknown,
  propertyPath: string,
  ctx: WalkContext,
  active: Set<object>,
  checkErrors: boolean,
): void {
  const u = unwrap(propSchema);

  if (checkErrors && ruleEnabled(ctx, "optional-without-nullable")) {
    if (u.optional && !u.nullable) {
      pushFinding(
        ctx,
        "optional-without-nullable",
        "error",
        propertyPath,
        optionalWithoutNullableMessage(propertyPath),
      );
    }
  }

  if (ctx.requireDescribe) {
    // A "leaf" is a property whose unwrapped schema does not lead to another
    // object-property structure: a direct object, or an array of objects.
    // Both cases defer the description requirement to the deeper properties
    // reached during the structural recursion below — a parent's own
    // description never substitutes for its children's.
    const isLeaf = u.coreKind !== "object" && !isArrayOfObjects(u);
    if (isLeaf && !u.described) {
      pushFinding(
        ctx,
        "missing-description",
        "warning",
        propertyPath,
        missingDescriptionMessage(propertyPath),
      );
    }
  }

  walkNode(propSchema, propertyPath, ctx, active, checkErrors);
}

/**
 * Walk one schema node at `path`. `checkErrors` gates dialect-error rules
 * (exclusive-numeric-bound / recursive-lazy / tuple / optional-without-
 * nullable) — it is forced to `false` while walking inside a tuple's items
 * (once a tuple is flagged, its dialect errors stop being reported), but
 * `missing-description` and cycle-safety are independent of it.
 */
function walkNode(
  schema: unknown,
  path: string,
  ctx: WalkContext,
  active: Set<object>,
  checkErrors: boolean,
): void {
  if (schema === null || typeof schema !== "object") return;

  const u = unwrap(schema);
  const core = u.core;
  if (core === null || typeof core !== "object") return;

  if (active.has(core)) {
    // A real cycle: the same structural node is already an ancestor on this
    // DFS path. Never recurse further — that's how recursion terminates.
    if (checkErrors && ruleEnabled(ctx, "recursive-lazy")) {
      pushFinding(ctx, "recursive-lazy", "error", path, recursiveLazyMessage(path, ctx.dialect));
    }
    return;
  }

  if (checkErrors && ruleEnabled(ctx, "exclusive-numeric-bound") && u.coreDef) {
    const { exclusiveMin, exclusiveMax } = getExclusiveBounds(u.coreDef);
    if (exclusiveMin || exclusiveMax) {
      pushFinding(
        ctx,
        "exclusive-numeric-bound",
        "error",
        path,
        exclusiveBoundMessage(path, exclusiveMin, exclusiveMax, ctx.dialect),
      );
    }
  }

  const coreKind = u.coreKind;

  if (coreKind === "tuple") {
    if (checkErrors && ruleEnabled(ctx, "tuple")) {
      pushFinding(ctx, "tuple", "error", path, tupleMessage(path, ctx.dialect));
    }
    // Stop descending for dialect errors — but a tuple may still be
    // inspected for description warnings when requested.
    if (ctx.requireDescribe) {
      active.add(core);
      const items = u.coreDef?.items;
      if (Array.isArray(items)) {
        items.forEach((item, i) => walkNode(item, `${path}[${i}]`, ctx, active, false));
      }
      active.delete(core);
    }
    return;
  }

  if (coreKind === "lazy") {
    const getter = u.coreDef?.getter;
    if (typeof getter === "function") {
      let resolved: unknown;
      try {
        resolved = (getter as () => unknown)();
      } catch {
        return; // A throwing lazy getter can't be inspected — skip rather than crash.
      }
      active.add(core);
      walkNode(resolved, path, ctx, active, checkErrors);
      active.delete(core);
    }
    return;
  }

  if (coreKind === "object") {
    active.add(core);
    const shapeRaw = u.coreDef?.shape;
    const shape =
      typeof shapeRaw === "function" ? (shapeRaw as () => Record<string, unknown>)() : shapeRaw;
    if (shape && typeof shape === "object") {
      for (const [key, propSchema] of Object.entries(shape as Record<string, unknown>)) {
        handleObjectProperty(propSchema, `${path}.${key}`, ctx, active, checkErrors);
      }
    }
    active.delete(core);
    return;
  }

  if (coreKind === "array") {
    active.add(core);
    walkNode(arrayElement(u.coreDef), `${path}[]`, ctx, active, checkErrors);
    active.delete(core);
    return;
  }

  if (coreKind === "union" || coreKind === "discriminatedunion") {
    active.add(core);
    const options = u.coreDef?.options;
    if (Array.isArray(options)) {
      for (const option of options) walkNode(option, path, ctx, active, checkErrors);
    }
    active.delete(core);
    return;
  }

  if (coreKind === "intersection") {
    active.add(core);
    walkNode(u.coreDef?.left, path, ctx, active, checkErrors);
    walkNode(u.coreDef?.right, path, ctx, active, checkErrors);
    active.delete(core);
    return;
  }

  if (coreKind === "record") {
    active.add(core);
    walkNode(u.coreDef?.valueType, `${path}[key]`, ctx, active, checkErrors);
    active.delete(core);
    return;
  }

  if (coreKind === "map" || coreKind === "set") {
    active.add(core);
    walkNode(u.coreDef?.valueType, `${path}[]`, ctx, active, checkErrors);
    active.delete(core);
    return;
  }

  // Primitive/opaque leaf (string, boolean, enum, literal, date, …) — nothing further to walk.
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Statically inspect a Zod schema for constructs unsupported by a
 * model-facing conversion path. Never throws for lint findings and never
 * mutates the schema.
 */
export function lintModelFacingSchema(
  schema: ZodTypeAny,
  opts?: SchemaLintOptions,
): SchemaLintFinding[] {
  const ctx: WalkContext = {
    dialect: opts?.dialect ?? "gemini-bifrost",
    requireDescribe: opts?.requireDescribe ?? false,
    findings: [],
    seen: new Set<string>(),
  };
  walkNode(schema, "$", ctx, new Set<object>(), true);
  return ctx.findings;
}
