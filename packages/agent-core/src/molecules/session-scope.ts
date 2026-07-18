/**
 * Session-scoped configuration declared by an agent.
 *
 * SessionScope composes ScopeItem field declarations into a single Zod
 * object schema, tracks which fields should be redacted from echoes/logs,
 * and carries optional defaults and named presets. Defaults and every
 * preset are validated against the composed schema at construction — a
 * malformed declaration fails fast, at agent-authoring time, rather than at
 * first request.
 */

import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/** Named options for {@link scopeItem}. */
export interface ScopeItemOptions {
  readonly description?: string;
  readonly redact?: boolean;
}

/**
 * A single field declaration within a SessionScope: the field's Zod schema
 * plus presentation metadata (`description`) and a redaction flag consumed
 * by `SessionScope.redactKeys`.
 */
export class ScopeItem<T extends ZodTypeAny> {
  readonly schema: T;
  readonly description?: string;
  readonly redact?: boolean;

  constructor(schema: T, options?: ScopeItemOptions) {
    this.schema = schema;
    this.description = options?.description;
    this.redact = options?.redact;
    Object.freeze(this);
  }
}

/**
 * Create a ScopeItem from a schema and named options instead of the
 * positional constructor. A pure adapter: constructor freezing is
 * preserved, and the result satisfies `instanceof ScopeItem`.
 */
export function scopeItem<T extends ZodTypeAny>(
  schema: T,
  options?: ScopeItemOptions,
): ScopeItem<T> {
  return new ScopeItem(schema, options);
}

/** Named options for the SessionScope constructor / {@link sessionScope}. */
export interface SessionScopeOptions {
  readonly defaults?: Record<string, unknown>;
  readonly presets?: Record<string, Record<string, unknown>>;
}

/**
 * A validated collection of ScopeItem fields, composed into one Zod object
 * schema.
 *
 * Public surface is deliberately FLAT — `.defaults`, `.presets`, and
 * `.redactKeys` are top-level readonly properties, not nested under an
 * `.options` bag — so hosts consuming SessionScope through a structural
 * (duck-typed) interface stay simple.
 */
export class SessionScope<I extends Record<string, ScopeItem<ZodTypeAny>>> {
  readonly items: Readonly<I>;
  readonly schema: ZodTypeAny;
  readonly redactKeys: readonly string[];
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly presets?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;

  constructor(items: I, options?: SessionScopeOptions) {
    this.items = Object.freeze({ ...items }) as Readonly<I>;

    const shape = Object.fromEntries(
      Object.entries(items).map(([key, item]) => [key, item.schema]),
    );
    this.schema = z.object(shape);

    this.redactKeys = Object.freeze(
      Object.entries(items)
        .filter(([, item]) => item.redact === true)
        .map(([key]) => key),
    );

    if (options?.defaults !== undefined) {
      this.defaults = Object.freeze(this.validateNamed(options.defaults, "defaults")) as Readonly<
        Record<string, unknown>
      >;
    }

    if (options?.presets !== undefined) {
      const presets: Record<string, Readonly<Record<string, unknown>>> = {};
      for (const [name, preset] of Object.entries(options.presets)) {
        presets[name] = Object.freeze(this.validateNamed(preset, `preset "${name}"`)) as Readonly<
          Record<string, unknown>
        >;
      }
      this.presets = Object.freeze(presets);
    }

    Object.freeze(this);
  }

  /** Parses `value` against the composed schema, throwing a labeled error naming what failed. */
  private validateNamed(value: Record<string, unknown>, label: string): Record<string, unknown> {
    try {
      return this.schema.parse(value) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`SessionScope ${label} failed validation: ${detail}`, { cause: err });
    }
  }

  /** Parses `input` against the composed schema. Zod validation errors propagate unwrapped. */
  parse(input: unknown): ScopeValue<SessionScope<I>> {
    return this.schema.parse(input) as ScopeValue<SessionScope<I>>;
  }

  /** Converts the composed schema to a JSON Schema (OpenAPI 3 dialect). */
  toJsonSchema(): Record<string, unknown> {
    const jsonSchema = zodToJsonSchema(this.schema, { target: "openApi3" }) as Record<
      string,
      unknown
    >;
    // Remove $schema top-level noise (sets to undefined; see ToolSchema.fromZod precedent)
    jsonSchema.$schema = undefined;
    return jsonSchema;
  }
}

/**
 * Create a SessionScope from an items record and named options instead of
 * the positional constructor. A pure adapter: constructor validation and
 * freezing are preserved, and the result satisfies `instanceof SessionScope`.
 */
export function sessionScope<I extends Record<string, ScopeItem<ZodTypeAny>>>(
  items: I,
  options?: SessionScopeOptions,
): SessionScope<I> {
  return new SessionScope(items, options);
}

/** Infers the parsed value shape of a SessionScope's composed fields. */
export type ScopeValue<S> = S extends SessionScope<infer I>
  ? { [K in keyof I]: z.infer<I[K]["schema"]> }
  : never;
