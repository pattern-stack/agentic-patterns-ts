/**
 * `AgentStep<TIn, TOut>` — the LLM leaf node (DESIGN §5.1).
 *
 * input → LLM → typed output, with **structured output as the DEFAULT**. Provide
 * an `output` schema and `run()` routes through `ctx.runner.runStructured` (the
 * capability-gated path, §9.4); omit it (or pass `z.string()`) to get the legacy
 * `generateText` text path — a byte-identical migration anchor for today's `Step`.
 *
 * A leaf ALWAYS catches and returns `{ succeeded: false, error }` (§5.3); it never
 * throws to the composite, which is the single place that decides continue-vs-abort.
 *
 * ADDITIVE: new file. Does not touch `Step`/`MessageTemplate`/`executeStep`.
 */

import { ZodString, type ZodType } from "zod";
import type { AgentLike } from "../runner/agent-runner.js";
import { deriveToolboxExecutor } from "../runner/toolbox-executor.js";
import type { RunOptions, RunnerProtocol } from "../runner/types.js";
import { applyStepModel } from "./base.js";
import type { Node, NodeResult, NodeRunContext } from "./node.js";
import { type ScratchpadReader, createScratchpad } from "./slot.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown (and caught internally → surfaced as `succeeded:false`) when an
 * `AgentStep` declares an `output` schema but the resolved runner has no
 * `runStructured` method (§5.1).
 */
export class StructuredOutputUnsupported extends Error {
  constructor(nodeName?: string) {
    super(
      `AgentStep${nodeName ? ` "${nodeName}"` : ""} declares an output schema but the runner does not implement runStructured(). Use a runner that supports structured output, or drop the output schema for the raw-text path.`,
    );
    this.name = "StructuredOutputUnsupported";
  }
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export interface AgentStepSpec<TIn, TOut = string> {
  readonly name?: string;
  readonly agent: AgentLike;

  /**
   * Typed prompt builder — replaces `MessageTemplate`. Receives the typed input
   * (NOT an untyped bag) and a read-only view of scratchpad. Returns the user message.
   */
  readonly prompt: (input: TIn, scratchpad: ScratchpadReader) => string;

  /**
   * Output schema → `runner.runStructured`. THIS IS THE DEFAULT. Omit (or pass
   * `z.string()`) for the legacy `generateText` text path. Structured IS the norm;
   * raw string is the special case `TOut = string`.
   */
  readonly output?: ZodType<TOut>;

  /** Per-step model override (via {@link applyStepModel}). Defaults to the agent's model. */
  readonly model?: string;

  /**
   * Per-node runner override (#116). v1: a concrete RunnerProtocol — the
   * declared form of the ctx-rewriting closure hack. Resolution:
   * `spec.runner ?? ctx.runner`. NOTE: the structured-output guard checks
   * the RESOLVED runner; an override without `runStructured` fails loud.
   */
  readonly runner?: RunnerProtocol;

  /**
   * System prompt. Default = `agent.renderInitialPrompt()` (the renderer the runner
   * already uses). Override with a string, or `null` to omit entirely.
   *
   * NOTE: threading a custom/omitted system prompt into the runner is reserved for a
   * later phase; today the runner renders the agent's own prompt. The field is
   * accepted now so authored specs are forward-compatible.
   */
  readonly system?: string | null;

  readonly maxIterations?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `z.string()` (and only that) takes the raw-text path. */
function isStringSchema(schema: ZodType<unknown>): boolean {
  return schema instanceof ZodString;
}

/** Read-only slot view; an empty ephemeral store when the ctx carries no scratchpad. */
function slotReader(scratchpad: NodeRunContext["scratchpad"]): ScratchpadReader {
  return (scratchpad ?? createScratchpad()).reader();
}

// ---------------------------------------------------------------------------
// AgentStep
// ---------------------------------------------------------------------------

export class AgentStep<TIn, TOut = string> implements Node<TIn, TOut> {
  readonly name?: string;

  constructor(private readonly spec: AgentStepSpec<TIn, TOut>) {
    this.name = spec.name;
  }

  async run(input: TIn, ctx: NodeRunContext): Promise<NodeResult<TOut>> {
    const agent = applyStepModel(this.spec.agent, this.spec.model);
    const runner = this.spec.runner ?? ctx.runner; // #116
    const message = this.spec.prompt(input, slotReader(ctx.scratchpad));
    // An AgentStep leaf gets no executor for its OWN tools unless one is handed
    // to it: `nodeTool` correctly re-roots the sub-run ctx WITHOUT a toolExecutor
    // (a subagent must run its own tools, not the parent's), and a bare
    // pipeline never sets one. So the running agent's tool calls silently return
    // "No tool executor configured" and it answers "data unavailable". Fix:
    // when no executor is ambient, DERIVE one from the agent we are about to run
    // (its tools ARE its own capabilities). An explicitly-passed executor always
    // wins (e.g. CoordinatorStep's team executor covering team + direct tools);
    // a capability-less agent derives `undefined`, keeping the no-tools path
    // byte-identical.
    const toolExecutor = ctx.toolExecutor ?? deriveToolboxExecutor(agent);
    const opts: RunOptions = {
      toolExecutor,
      maxIterations: this.spec.maxIterations,
      traceId: ctx.traceId,
      parentSpanId: ctx.parentSpanId,
      host: { scratchpad: ctx.scratchpad, deps: ctx.deps }, // #124
    };

    try {
      if (this.spec.output && !isStringSchema(this.spec.output)) {
        if (!runner.runStructured) {
          throw new StructuredOutputUnsupported(this.name);
        }
        const r = await runner.runStructured(agent, message, this.spec.output, opts);
        return {
          output: r.object,
          succeeded: true,
          totalInputTokens: r.inputTokens,
          totalOutputTokens: r.outputTokens,
        };
      }

      // String special case — identical to today's executeStep path (generateText).
      const r = await runner.run(agent, message, opts);
      return {
        output: r.response as TOut,
        succeeded: true,
        totalInputTokens: r.inputTokens,
        totalOutputTokens: r.outputTokens,
      };
    } catch (error) {
      // Leaf ALWAYS returns a failed result; the composite decides continue-vs-abort (§5.3).
      return {
        output: undefined as TOut,
        succeeded: false,
        error: error as Error,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      };
    }
  }
}
