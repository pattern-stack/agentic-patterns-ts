/**
 * Structured-output schema guard — fail LOUD on open-object schemas.
 *
 * WHY THIS EXISTS (verified 2026-07-02): @ai-sdk/google's
 * `convertJSONSchemaToOpenAPISchema` destructures only `{type, description,
 * required, properties, items, allOf, anyOf, oneOf, format, const, minLength,
 * enum}` — `additionalProperties` is silently DISCARDED. Any open-keyed object
 * (z.record / .passthrough() / .catchall() / z.map) in a structured-output
 * schema therefore reaches Gemini's `responseSchema` as a propertyless object,
 * and constrained decoding can ONLY emit `{}` — a silent failure
 * indistinguishable from model error. OpenAI strict mode prohibits open maps
 * outright. The portable remedy is the WIRE-SEAM pattern: carry free-form
 * objects as a JSON-encoded string field and decode after parsing.
 *
 * This module walks a Zod schema's def tree (Zod 3 `_def.typeName` and Zod 4
 * `_zod.def.type` are both handled) and collects the paths of OPEN-OBJECT
 * nodes — objects whose keys are not fully declared. `runStructured` calls
 * {@link guardOpenObjectSchemas} BEFORE any LLM call and throws by default;
 * `RunOptions.allowOpenObjectSchemas` downgrades to a once-per-schema warning
 * for consumers who know their provider handles open objects.
 */

// ---------------------------------------------------------------------------
// Zod def-tree access (version-tolerant)
// ---------------------------------------------------------------------------

type AnyDef = Record<string, unknown>;

/** Get the def record from a Zod 3 (`_def`) or Zod 4 (`_zod.def`) schema. */
function getDef(schema: unknown): AnyDef | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  const v4 = (schema as { _zod?: { def?: AnyDef } })._zod?.def;
  if (v4 && typeof v4 === "object") return v4;
  const v3 = (schema as { _def?: AnyDef })._def;
  return v3 && typeof v3 === "object" ? v3 : undefined;
}

/**
 * Normalized kind of a schema node: Zod 3's `typeName` ("ZodRecord") and
 * Zod 4's `type` ("record") both normalize to lowercase without the prefix.
 * (Zod 3 also uses `def.type` for an array's ELEMENT schema — an object, not
 * a string — so `typeName` is checked first and `type` only when a string.)
 */
function kindOf(schema: unknown): string | undefined {
  const def = getDef(schema);
  if (!def) return undefined;
  const typeName = def.typeName;
  if (typeof typeName === "string") {
    return typeName.startsWith("Zod") ? typeName.slice(3).toLowerCase() : typeName.toLowerCase();
  }
  return typeof def.type === "string" ? def.type.toLowerCase() : undefined;
}

/** Is this schema node present and NOT `never`? (catchall default is never). */
function isRealCatchall(schema: unknown): boolean {
  if (schema === null || schema === undefined) return false;
  const kind = kindOf(schema);
  return kind !== undefined && kind !== "never";
}

/** Records keyed by a closed key set (enum/literal keys) declare every key. */
function recordKeysAreClosed(def: AnyDef): boolean {
  const keyKind = kindOf(def.keyType);
  return keyKind === "enum" || keyKind === "nativeenum" || keyKind === "literal";
}

// ---------------------------------------------------------------------------
// Open-object collection
// ---------------------------------------------------------------------------

/**
 * Walk `schema`'s def tree and return the paths (`$`, `$.body`,
 * `$.items[].meta`, …) of every OPEN-OBJECT node: `z.record` / `z.map`, or a
 * `ZodObject` with `.passthrough()` / a non-`never` `.catchall()`.
 */
export function collectOpenObjectPaths(schema: unknown): string[] {
  const paths: string[] = [];
  const visited = new Set<object>();
  walk(schema, "$", paths, visited);
  return paths;
}

function walk(schema: unknown, path: string, paths: string[], visited: Set<object>): void {
  if (schema === null || typeof schema !== "object") return;
  if (visited.has(schema)) return;
  visited.add(schema);

  const def = getDef(schema);
  if (!def) return;
  const kind = kindOf(schema);

  switch (kind) {
    case "record": {
      if (!recordKeysAreClosed(def)) {
        paths.push(path);
        return; // flagging the outermost open node is enough
      }
      // Closed-key record: keys are fully declared; check the value schema.
      walk(def.valueType, `${path}[key]`, paths, visited);
      return;
    }
    case "map": {
      paths.push(path);
      return;
    }
    case "object": {
      const unknownKeys = def.unknownKeys; // Zod 3: "strip" | "strict" | "passthrough"
      const open = unknownKeys === "passthrough" || isRealCatchall(def.catchall);
      if (open) {
        paths.push(path);
        return;
      }
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      if (shape && typeof shape === "object") {
        for (const [key, child] of Object.entries(shape as Record<string, unknown>)) {
          walk(child, `${path}.${key}`, paths, visited);
        }
      }
      return;
    }
    case "array": {
      // Zod 4: def.element; Zod 3: def.type (the element schema object).
      const element = def.element ?? (typeof def.type === "object" ? def.type : undefined);
      walk(element, `${path}[]`, paths, visited);
      return;
    }
    case "set": {
      walk(def.valueType, `${path}[]`, paths, visited);
      return;
    }
    case "tuple": {
      const items = def.items;
      if (Array.isArray(items)) {
        items.forEach((item, i) => walk(item, `${path}[${i}]`, paths, visited));
      }
      walk(def.rest, `${path}[]`, paths, visited);
      return;
    }
    case "union":
    case "discriminatedunion": {
      const options = def.options;
      if (Array.isArray(options)) {
        for (const option of options) walk(option, path, paths, visited);
      }
      return;
    }
    case "intersection": {
      walk(def.left, path, paths, visited);
      walk(def.right, path, paths, visited);
      return;
    }
    case "lazy": {
      if (typeof def.getter === "function") {
        try {
          walk((def.getter as () => unknown)(), path, paths, visited);
        } catch {
          // A throwing lazy getter can't be inspected — skip rather than crash.
        }
      }
      return;
    }
    default: {
      // Wrappers (optional/nullable/default/catch/readonly/nonoptional/brand/
      // promise/effects/pipe/…): recurse into whichever inner slots exist.
      walk(def.innerType, path, paths, visited);
      walk(def.schema, path, paths, visited); // Zod 3 ZodEffects
      walk(def.in, path, paths, visited); // pipeline / Zod 4 pipe
      walk(def.out, path, paths, visited);
      // Zod 3 ZodBranded/ZodPromise keep the inner schema under `type` (object).
      if (typeof def.type === "object") walk(def.type, path, paths, visited);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

function buildMessage(paths: string[]): string {
  return [
    `runStructured: structured-output schema contains open-object node(s) at ${paths.join(", ")}.`,
    "Open-keyed objects (z.record / .passthrough() / .catchall() / z.map) break constrained",
    "decoding on schema-subset providers: @ai-sdk/google's convertJSONSchemaToOpenAPISchema",
    "silently discards `additionalProperties`, so Gemini's responseSchema sees a propertyless",
    "object and can only emit {} — a silent failure indistinguishable from model error — and",
    "OpenAI strict mode rejects open maps outright. Remedy: carry free-form objects as a",
    "JSON-encoded string field and decode after parsing — the wire-seam pattern. If your",
    "provider genuinely supports open objects, set RunOptions.allowOpenObjectSchemas: true to",
    "downgrade this error to a warning.",
  ].join(" ");
}

/** Thrown by {@link guardOpenObjectSchemas} when a schema has open-object nodes. */
export class OpenObjectSchemaError extends Error {
  /** Paths of the open-object nodes (e.g. `["$.body", "$.items[].meta"]`). */
  readonly paths: readonly string[];

  constructor(paths: string[]) {
    super(buildMessage(paths));
    this.name = "OpenObjectSchemaError";
    this.paths = paths;
  }
}

/** Schemas already warned about under `allowOpenObjectSchemas` (warn once per schema). */
const warnedSchemas = new WeakSet<object>();

/**
 * Throw {@link OpenObjectSchemaError} if `schema` contains open-object nodes.
 * With `allowOpenObjectSchemas: true`, downgrade to a `console.warn` emitted
 * once per schema instance. Runs BEFORE any LLM call.
 */
export function guardOpenObjectSchemas(schema: unknown, allowOpenObjectSchemas?: boolean): void {
  const paths = collectOpenObjectPaths(schema);
  if (paths.length === 0) return;
  if (!allowOpenObjectSchemas) {
    throw new OpenObjectSchemaError(paths);
  }
  if (schema !== null && typeof schema === "object" && !warnedSchemas.has(schema)) {
    warnedSchemas.add(schema);
    console.warn(`[agentic-patterns] ${buildMessage(paths)}`);
  }
}
