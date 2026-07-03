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
 * A minimal, vendor-neutral event a tool may emit during execution.
 * Deliberately NOT runtime's BaseEvent: no traceId/runId/spanId/timestamp —
 * those correlation fields live on ToolExecutionContext and are stamped by the
 * host (runtime) when it bridges to a real event bus. Keeps core decoupled.
 */
export interface ToolEvent {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

/**
 * Optional execution context handed to a tool's `execute`. Every field is
 * optional: a tool that ignores it, or a caller that omits it, is fully valid
 * (backward compatible). `emit` is a minimal fire-and-forget sink — NOT an
 * AgentEventBus. The host wires it to whatever bus/exporter it runs.
 */
export interface ToolExecutionContext {
  /**
   * Fire-and-forget event sink. Host bridges to its bus; core never awaits it.
   *
   * Contract: implementations MUST NOT throw. Tools call `ctx?.emit?.(...)`
   * synchronously inside `execute`, so a throwing `emit` would abort tool
   * execution — core cannot insulate this. A host's `emit` must swallow its
   * own sink/bus errors internally, e.g. a bus adapter should be
   * `(e) => void safePublish(e)` where `safePublish` catches synchronously.
   */
  readonly emit?: (event: ToolEvent) => void;
  /** Correlates emitted events to the enclosing run. */
  readonly runId?: string;
  readonly traceId?: string;
  /** The tool-call id of the invoking tool, so children nest under their parent. */
  readonly parentToolCallId?: string;
}

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
  /**
   * Executes the tool. `ctx` is an optional execution context (event sink +
   * correlation ids) supplied by the host; existing implementations that
   * ignore it remain valid (assignment-compatible trailing optional param).
   */
  execute: (args: Record<string, unknown>, ctx?: ToolExecutionContext) => Promise<unknown>;
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
   * `ctx` is an optional execution context (event sink + correlation ids)
   * forwarded verbatim to the tool's `execute`; never validated or inspected.
   *
   * @throws Error if the tool name is unknown.
   */
  async execute(name: string, args: unknown, ctx?: ToolExecutionContext): Promise<unknown> {
    const tool = this.tools[name];
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const parsed = tool.parameters.parse(args) as Record<string, unknown>;
    return tool.execute(parsed, ctx);
  }
}
