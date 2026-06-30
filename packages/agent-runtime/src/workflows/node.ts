/**
 * Core node contract — `Node<TIn, TOut>`, `NodeResult<TOut>`, `NodeOutcome<TOut>`,
 * `NodeRunContext` (DESIGN §3).
 *
 * Typed object I/O generalizes the legacy string-pinned Step/StepResult/PatternResult.
 * Every leaf AND composite implements `Node<TIn, TOut>` — the single contract that
 * unifies the five incompatible legacy `run()` shapes.
 *
 * ADDITIVE: this file adds the new substrate alongside `base.ts`. The legacy
 * `Step`/`StepResult`/`PatternResult` types are NOT touched here.
 */

import type { RunResult, RunnerProtocol, ToolExecutor } from "../runner/types.js";
import type { PatternHooks } from "./base.js";
import type { Scratchpad } from "./slot.js";

// ---------------------------------------------------------------------------
// NodeRunContext
// ---------------------------------------------------------------------------

/**
 * Ambient services every node receives. A *superset* of today's
 * {@link PatternRunOptions} (`base.ts` = `{ runner; hooks?; toolExecutor?; traceId? }`).
 * Every field added here is OPTIONAL or engine-defaulted, so any existing
 * `PatternRunOptions` value is a valid `NodeRunContext` — the back-compat hinge (§9).
 */
export interface NodeRunContext {
  readonly runner: RunnerProtocol;
  readonly hooks?: PatternHooks;
  readonly toolExecutor?: ToolExecutor;
  readonly traceId?: string;
  /**
   * The shared scoped-slot store (the Scratchpad, §6/§7). OPTIONAL: when absent the
   * engine lazily constructs an empty store at the top-level `run()` call. Existing
   * callers that pass `{ runner }` keep compiling and behave identically (they never
   * touch scratchpad).
   */
  readonly scratchpad?: Scratchpad;
}

// ---------------------------------------------------------------------------
// NodeResult
// ---------------------------------------------------------------------------

/**
 * Typed aggregate result. Generalizes `PatternResult`: `output` replaces the
 * string-pinned `finalContent`; `succeeded` + token fields keep their EXACT legacy
 * names (no silent rename). The string world reuses these fields directly as
 * `NodeResult<string>`.
 */
export interface NodeResult<TOut> {
  /** The typed payload (was: `finalContent: string`). */
  readonly output: TOut;
  /** SAME NAME as `PatternResult.succeeded` — not renamed. */
  readonly succeeded: boolean;
  /** Present iff `succeeded === false`. */
  readonly error?: Error;
  /** Subtree rollup — same fields as `PatternResult`. */
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

// ---------------------------------------------------------------------------
// NodeOutcome
// ---------------------------------------------------------------------------

/**
 * What a composite records per child. Generalizes `StepResult`: `output: TOut`
 * replaces `content: string`; `runResult` is OPTIONAL because a `FunctionStep` has
 * no LLM call.
 */
export interface NodeOutcome<TOut> {
  readonly nodeName: string;
  readonly output: TOut;
  readonly succeeded: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Present for `AgentStep`, absent for `FunctionStep`. */
  readonly runResult?: RunResult;
  readonly error?: Error;
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

/**
 * The universal contract. Every leaf AND composite implements this — the thing
 * that unifies the five incompatible legacy `run()` shapes.
 */
export interface Node<TIn, TOut> {
  readonly name?: string;
  run(input: TIn, ctx: NodeRunContext): Promise<NodeResult<TOut>>;
}
