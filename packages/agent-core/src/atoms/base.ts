/**
 * Base classes for agentic-patterns models.
 *
 * AgenticModel wraps a Zod schema, providing immutable validated data,
 * replace(), merge(), and abstract toPrompt().
 */

import type { ZodObject, ZodRawShape, z } from "zod";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Context threaded into a render call — an optional server-parsed session
 * scope bag plus an optional host-assembled turn-1 recall block. Lives here
 * at layer 0 (atoms) so both the rendering layer and an atom-level render
 * hook (see `Awareness.fromScope` / `Awareness.fromRecall`) can reference it
 * without atoms ever importing upward into rendering or molecules.
 * Re-exported upward through `atoms/index.ts` and the rendering barrels so
 * callers can import it from wherever's convenient.
 */
export interface RenderContext {
  readonly scope?: Readonly<Record<string, unknown>>;
  /**
   * Pre-formatted, pre-budgeted turn-1 recall block assembled by the runtime
   * host (ADR-0007 D8a) — a finished string, never structured data. Rendering
   * stays pure: core places it (Awareness.fromRecall), never fetches or
   * formats it. Absent ⇒ byte-identical pre-recall rendering.
   */
  readonly recall?: string;
}

/**
 * Base model for all agentic-patterns datatypes.
 *
 * All datatypes must implement toPrompt() to render as prompt fragments.
 * Supports composition via replace() and merge() methods.
 */
export abstract class AgenticModel<T extends ZodRawShape> {
  protected readonly _schema: ZodObject<T>;
  protected readonly _data: Readonly<z.infer<ZodObject<T>>>;

  constructor(schema: ZodObject<T>, data: z.input<ZodObject<T>>) {
    this._schema = schema;
    this._data = Object.freeze(schema.parse(data));
  }

  /** Render this model as a prompt fragment. */
  abstract toPrompt(): string;

  /** Returns the validated, frozen data. */
  get data(): Readonly<z.infer<ZodObject<T>>> {
    return this._data;
  }

  /**
   * Create a new instance with specified fields replaced.
   * Since models are frozen, this returns a new instance.
   */
  replace(updates: Partial<z.infer<ZodObject<T>>>): this {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const Ctor = this.constructor as new (data: z.input<ZodObject<T>>) => this;
    return new Ctor({ ...this._data, ...updates });
  }

  /**
   * Merge another instance of the same type into this one.
   *
   * For list fields: extends with other's items.
   * For dict fields: spreads (other overwrites).
   * For scalars: uses other's value if different from default.
   */
  merge(other: this): this {
    if (other.constructor !== this.constructor) {
      throw new TypeError(`Cannot merge ${this.constructor.name} with ${other.constructor.name}`);
    }

    const merged: Record<string, unknown> = {};

    for (const [key, fieldSchema] of Object.entries(this._schema.shape)) {
      const thisVal = (this._data as Record<string, unknown>)[key];
      const otherVal = (other._data as Record<string, unknown>)[key];

      if (Array.isArray(thisVal) && Array.isArray(otherVal)) {
        // Lists: concatenate
        merged[key] = [...thisVal, ...otherVal];
      } else if (isRecord(thisVal) && isRecord(otherVal)) {
        // Records: spread (other overwrites)
        merged[key] = { ...thisVal, ...otherVal };
      } else {
        // Scalars: use other if different from default
        const def = (fieldSchema as z.ZodTypeAny)._def;
        const defaultValue = def.defaultValue?.();
        if (otherVal !== defaultValue) {
          merged[key] = otherVal;
        } else {
          merged[key] = thisVal;
        }
      }
    }

    return this.replace(merged as Partial<z.infer<ZodObject<T>>>);
  }

  /** Serialization — returns a plain object copy. */
  toJSON(): z.infer<ZodObject<T>> {
    return { ...this._data };
  }
}

/**
 * Base model for protocol data structures.
 * Protocol models are data containers that don't need custom prompts.
 */
export abstract class ProtocolModel<T extends ZodRawShape> extends AgenticModel<T> {
  toPrompt(): string {
    return JSON.stringify(this.toJSON());
  }
}
