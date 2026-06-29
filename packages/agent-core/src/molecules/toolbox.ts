/**
 * Base toolbox abstract class.
 *
 * Toolboxes compose protocols into domain-specific tool collections.
 * Each tool is defined with an explicit Zod parameter schema (no runtime
 * introspection), aligning with Vercel AI SDK's tool() API.
 */

import type { ZodTypeAny } from "zod";
import { ToolSchema } from "./tool-schema.js";

/**
 * A single tool definition: description, Zod parameters schema, and execute fn.
 *
 * Note: `execute` uses `unknown` for args because Zod `.parse()` handles
 * validation before the function is called.
 */
export interface ToolDefinition {
  description: string;
  parameters: ZodTypeAny;
  /**
   * Optional output schema — what `execute` resolves to. Symmetric with
   * `parameters`. A tool's TS return type is erased at runtime, so it can't be
   * introspected; declare `returns` to make the output shape visible to
   * consumers (e.g. a tool workbench rendering a `Returns` block) and to enable
   * future output validation. Omit it and consumers simply get no return shape.
   */
  returns?: ZodTypeAny;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Abstract base class for all toolboxes.
 *
 * Subclasses must provide `name`, `description`, and a `tools` record
 * mapping tool names to ToolDefinition objects.
 */
export abstract class Toolbox {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly tools: Record<string, ToolDefinition>;

  /** Get tool definitions as ToolSchema objects. */
  getToolSchemas(): ToolSchema[] {
    return Object.entries(this.tools).map(([name, def]) =>
      ToolSchema.fromZod(name, def.description, def.parameters, def.returns),
    );
  }

  /** Get names of all tools in this toolbox. */
  getToolNames(): string[] {
    return Object.keys(this.tools);
  }

  /**
   * Execute a tool by name, validating args via Zod.
   *
   * @throws Error if the tool name is unknown.
   */
  async execute(name: string, args: unknown): Promise<unknown> {
    const tool = this.tools[name];
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const parsed = tool.parameters.parse(args) as Record<string, unknown>;
    return tool.execute(parsed);
  }
}
