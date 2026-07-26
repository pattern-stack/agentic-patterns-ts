/**
 * Base toolbox abstract class.
 *
 * Toolboxes compose protocols into domain-specific tool collections.
 * Each tool is defined with an explicit Zod parameter schema (no runtime
 * introspection), aligning with Vercel AI SDK's tool() API.
 */

import type { ZodTypeAny, z } from "zod";
import type { RenderArtifact } from "./render-artifact.js";
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
  /** Fire-and-forget event sink. Host bridges to its bus; core never awaits it. */
  readonly emit?: (event: ToolEvent) => void;
  /** Correlates emitted events to the enclosing run. */
  readonly runId?: string;
  readonly traceId?: string;
  /** The tool-call id of the invoking tool, so children nest under their parent. */
  readonly parentToolCallId?: string;
  /**
   * Host-declared opaque passthrough — core NEVER interprets it (same
   * philosophy as `emit`: core declares the slot, the host wires the meaning).
   * The host copies its `RunOptions.host` here per tool call; a consumer that
   * knows the host narrows it itself (e.g. runtime's `nodeTool` reads
   * `{ scratchpad, deps }` to propagate run context across the
   * agent-as-tool seam, #124).
   */
  readonly host?: unknown;
  /**
   * Fire-and-forget render-artifact publication sink
   * ([ADR-0006](../../../../docs/adr/0006-render-artifacts.md)). Deliberately
   * INDEPENDENT of the tool's return value to the model (§1) — a tool may
   * publish a 500-row table here while returning a two-token ref to the
   * agent. Same philosophy as `emit`: core declares the slot and never
   * awaits, validates, or interprets what's published; the host wires it to
   * whatever transport/ceiling it runs (§4). Present only when the run's
   * caller opted in (ADR §2's "two-layer opt-in" — the tool declares via
   * `ToolSchema.displayType`, the caller/registration decides whether
   * publication is wired for this run); absent otherwise, so a tool can
   * cheaply skip building an artifact it isn't allowed to publish.
   */
  readonly publishArtifact?: (artifact: RenderArtifact) => void;
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
   * consumers (e.g. a tool workbench rendering a `Returns` block). On a plain
   * object definition this is metadata only — output is never validated.
   * Tools built with `defineTool` opt into runtime output validation against
   * this schema. Omit it and consumers simply get no return shape.
   */
  returns?: ZodTypeAny;
  /**
   * Marks a TERMINAL tool — the harness-addressed "I'm done" verb. A successful
   * call ends the enclosing raw tool loop on hosts that honor the flag (the
   * runtime's AgentRunner), and the tool's result becomes the run's final
   * response. This gives a bare (unstructured) tool-loop agent an EXPLICIT exit
   * it can decide to take, instead of the implicit "reply with no tool call"
   * convention. An ERRORED call does not terminate — the model sees the error
   * and corrects. Omit (default) for ordinary tools; core carries the flag,
   * the host enforces the semantics.
   */
  terminal?: boolean;
  /**
   * Optional render hint for transports/clients ("code" | "diff" | "bash" today,
   * by convention — the string is opaque to core). Same philosophy as `terminal`:
   * core carries the flag, the host/renderer interprets it.
   *
   * Producer contract for the conventional values (B-5):
   *   "diff" — result must be unified-diff TEXT and `arguments.path` names the file;
   *   "code" — result is the code string; language inferred from `arguments.path`;
   *   "bash" — result rendered as a bash block.
   * Renderers rich-render STRING results only — object-returning tools get the
   * generic render regardless of the hint.
   */
  displayType?: string;
  /**
   * Executes the tool. `ctx` is an optional execution context (event sink +
   * correlation ids) supplied by the host; existing implementations that
   * ignore it remain valid (assignment-compatible trailing optional param).
   */
  execute: (args: Record<string, unknown>, ctx?: ToolExecutionContext) => Promise<unknown>;
}

/**
 * Marks a return-schema validation failure raised inside a `defineTool`
 * wrapper. A globally registered symbol rather than an error subclass:
 * deployments are known to carry two copies of core across a package
 * boundary, where an `instanceof` check would spuriously fail.
 */
const RETURNS_VIOLATION = Symbol.for("agentic-patterns.core.returns-violation");

/** Structural check for the marker — never `instanceof`. */
function isReturnsViolation(err: unknown): err is Error & { cause: unknown } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<PropertyKey, unknown>)[RETURNS_VIOLATION] === true
  );
}

/**
 * Define a schema-typed tool while returning the framework's stable,
 * non-generic `ToolDefinition` surface.
 *
 * Arguments arrive contextually typed from `parameters` (`z.infer<P>`) — the
 * host boundary (`Toolbox.execute`) already parses them, so this is
 * type-level only. The callback's raw result is compile-checked against
 * `z.input<R>`. Unless disabled via `validateReturns: false`, the result is
 * parsed through `returns`, so the parsed `z.output<R>` value is what the
 * host receives — Zod defaults, transforms, and unknown-key stripping apply.
 *
 * Deliberately non-generic at the boundary: the returned value's inferred
 * declaration type is plain `ToolDefinition`, so no concrete Zod types leak
 * into a consumer's published `.d.ts`.
 *
 * Validation failures are tagged and renamed by `Toolbox.execute(name, ...)`
 * ("tool 'x' output violated its returns schema: ..."): a `ToolDefinition`
 * has no intrinsic name — the record key is the name — so the fully named
 * guarantee lives at the toolbox boundary.
 */
export function defineTool<P extends ZodTypeAny, R extends ZodTypeAny>(spec: {
  description: string;
  parameters: P;
  returns: R;
  terminal?: boolean;
  /** Optional render hint — see `ToolDefinition.displayType`. */
  displayType?: string;
  /**
   * Parse output through `returns` before returning it.
   * @default true
   */
  validateReturns?: boolean;
  execute: (args: z.infer<P>, ctx?: ToolExecutionContext) => Promise<z.input<R>>;
}): ToolDefinition {
  const validateReturns = spec.validateReturns ?? true;
  const definition: ToolDefinition = {
    description: spec.description,
    parameters: spec.parameters,
    returns: spec.returns,
    execute: async (args, ctx) => {
      const raw = await spec.execute(args as z.infer<P>, ctx);
      if (!validateReturns) {
        return raw;
      }
      // safeParseAsync so async refinements/transforms in `returns` are supported.
      const result = await spec.returns.safeParseAsync(raw);
      if (!result.success) {
        const violation = new Error(
          `tool output violated its returns schema: ${result.error.message}`,
          { cause: result.error },
        );
        (violation as unknown as Record<PropertyKey, unknown>)[RETURNS_VIOLATION] = true;
        throw violation;
      }
      return result.data;
    },
  };
  if (spec.terminal !== undefined) {
    definition.terminal = spec.terminal;
  }
  if (spec.displayType !== undefined) {
    definition.displayType = spec.displayType;
  }
  return definition;
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
      ToolSchema.fromZod(
        name,
        def.description,
        def.parameters,
        def.returns,
        def.terminal,
        def.displayType,
      ),
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
   * This boundary owns the tool's name (the record key), so it is also where
   * `defineTool` return-schema violations gain their uniform, tool-named
   * message. Ordinary execution errors pass through untouched.
   *
   * @throws Error if the tool name is unknown, args fail parameter
   * validation, or a `defineTool`-built tool's output violates its `returns`
   * schema.
   */
  async execute(name: string, args: unknown, ctx?: ToolExecutionContext): Promise<unknown> {
    const tool = this.tools[name];
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const parsed = tool.parameters.parse(args) as Record<string, unknown>;
    try {
      return await tool.execute(parsed, ctx);
    } catch (err) {
      if (isReturnsViolation(err)) {
        const detail = err.cause instanceof Error ? err.cause.message : err.message;
        throw new Error(`tool '${name}' output violated its returns schema: ${detail}`, {
          cause: err.cause,
        });
      }
      throw err;
    }
  }
}

/** Concrete Toolbox over a static tool record — see `toolbox()`. */
class LiteralToolbox extends Toolbox {
  readonly name: string;
  readonly description: string;
  readonly tools: Record<string, ToolDefinition>;

  constructor(name: string, description: string, tools: Record<string, ToolDefinition>) {
    super();
    this.name = name;
    this.description = description;
    this.tools = tools;
  }
}

/**
 * Create a concrete Toolbox from a static tool record — the literal
 * counterpart to subclassing, as `TextManual`/`SimpleManual` are for
 * `Manual`. The record is retained by reference (not cloned or frozen —
 * decorators and composition code rely on record identity); inherited
 * schema, name-listing, and execution behavior are unchanged, and the
 * result satisfies `instanceof Toolbox`.
 */
export function toolbox(
  name: string,
  description: string,
  tools: Record<string, ToolDefinition>,
): Toolbox {
  return new LiteralToolbox(name, description, tools);
}
