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
  /** Optional output schema (JSON schema) — the shape `execute` resolves to. */
  readonly returns?: Record<string, unknown>;
  /**
   * Marks a terminal tool (see ToolDefinition.terminal): a successful call ends
   * the enclosing raw tool loop on hosts that honor the flag.
   */
  readonly terminal?: boolean;

  /** Optional: original Zod schema, kept for toVercelAI(). */
  private readonly _zodSchema?: ZodTypeAny;

  constructor(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    zodSchema?: ZodTypeAny,
    returns?: Record<string, unknown>,
    terminal?: boolean,
  ) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this._zodSchema = zodSchema;
    this.returns = returns;
    this.terminal = terminal;
    Object.freeze(this);
  }

  /**
   * Create ToolSchema from a Zod parameters schema, and optionally a Zod
   * returns schema (the tool's declared output shape — see ToolDefinition.returns)
   * and the terminal flag (see ToolDefinition.terminal).
   */
  static fromZod(
    name: string,
    description: string,
    schema: ZodTypeAny,
    returnsSchema?: ZodTypeAny,
    terminal?: boolean,
  ): ToolSchema {
    const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" }) as Record<string, unknown>;
    // Remove $schema and additionalProperties top-level noise
    jsonSchema.$schema = undefined;
    let returns: Record<string, unknown> | undefined;
    if (returnsSchema) {
      returns = zodToJsonSchema(returnsSchema, { target: "openApi3" }) as Record<string, unknown>;
      returns.$schema = undefined;
    }
    return new ToolSchema(name, description, jsonSchema, schema, returns, terminal);
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
  toDict(): {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    returns?: Record<string, unknown>;
    terminal?: boolean;
  } {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      // only present when declared — keeps the dict byte-identical for params-only tools
      ...(this.returns !== undefined ? { returns: this.returns } : {}),
      ...(this.terminal !== undefined ? { terminal: this.terminal } : {}),
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
