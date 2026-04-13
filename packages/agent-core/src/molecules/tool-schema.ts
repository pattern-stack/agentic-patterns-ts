/**
 * Universal tool schema with pluggable format converters.
 *
 * ToolSchema provides a canonical representation of tool definitions.
 * Format conversion methods (toOpenAI, toClaude, toVercelAI) produce
 * the shapes expected by each provider.
 */

import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/** OpenAI function-calling tool definition shape. */
export interface OpenAIFunctionDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Claude tool definition shape. */
export interface ClaudeFunctionDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Vercel AI SDK tool shape (description + Zod schema). */
export interface VercelAIToolDef {
  description: string;
  parameters: ZodTypeAny;
}

/**
 * Universal tool schema representation.
 *
 * This is the canonical representation of a tool definition. Format-specific
 * conversion methods produce output for each provider.
 */
export class ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  /** Optional: original Zod schema, kept for toVercelAI(). */
  private readonly _zodSchema?: ZodTypeAny;

  constructor(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    zodSchema?: ZodTypeAny,
  ) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this._zodSchema = zodSchema;
    Object.freeze(this);
  }

  /** Create ToolSchema from a Zod schema. */
  static fromZod(name: string, description: string, schema: ZodTypeAny): ToolSchema {
    const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" }) as Record<string, unknown>;
    // Remove $schema and additionalProperties top-level noise
    jsonSchema.$schema = undefined;
    return new ToolSchema(name, description, jsonSchema, schema);
  }

  /** Create ToolSchema from OpenAI function calling format. */
  static fromOpenAI(toolDef: OpenAIFunctionDef | Record<string, unknown>): ToolSchema {
    const func = (toolDef as Record<string, unknown>).function ?? toolDef;
    const f = func as Record<string, unknown>;
    return new ToolSchema(
      f.name as string,
      (f.description as string) ?? "",
      (f.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
    );
  }

  /** Convert to a plain dict representation. */
  toDict(): { name: string; description: string; parameters: Record<string, unknown> } {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }

  /** Convert to OpenAI function calling format. */
  toOpenAI(): OpenAIFunctionDef {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }

  /** Convert to Claude tool definition format. */
  toClaude(): ClaudeFunctionDef {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.parameters,
    };
  }

  /** Convert to Vercel AI SDK tool format. */
  toVercelAI(): VercelAIToolDef {
    if (!this._zodSchema) {
      throw new Error(
        `ToolSchema '${this.name}' was not created from a Zod schema. Use ToolSchema.fromZod() to enable toVercelAI().`,
      );
    }
    return {
      description: this.description,
      parameters: this._zodSchema,
    };
  }
}
