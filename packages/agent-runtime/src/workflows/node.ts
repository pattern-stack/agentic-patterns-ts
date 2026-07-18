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

import type { AgentEventBus } from "../events/agent-event-bus.js";
import type { RunResult, RunnerProtocol, ToolExecutor } from "../runner/types.js";
import type { PatternHooks } from "./base.js";
import type { DepReader } from "./deps.js";
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
   * The run's correlation id — matches `BaseEvent.runId` on every event this
   * run publishes (#226). OPTIONAL / engine-defaulted: `NodeBackedRunner` sets
   * it when executing a promoted pipeline; emission layers mint a fallback
   * when absent. Existing callers that pass `{ runner }` keep compiling and
   * behave identically — the back-compat hinge.
   */
  readonly runId?: string;
  /**
   * The invoking tool call's span id, when this node is being run as a
   * sub-workflow (agent-as-tool / CoordinatorStep / a promoted pipeline)
   * (#102). Nests this node's `agent.tool.*` events under the parent call's
   * span so nested sub-agent activity is attributable in Live/Tools/Graph
   * views instead of forming an orphan trace. OPTIONAL / engine-defaulted:
   * absent → today's behavior (no nesting), preserving the back-compat hinge.
   */
  readonly parentSpanId?: string;
  /**
   * The shared scoped-slot store (the Scratchpad, §6/§7). OPTIONAL: when absent the
   * engine lazily constructs an empty store at the top-level `run()` call. Existing
   * callers that pass `{ runner }` keep compiling and behave identically (they never
   * touch scratchpad).
   */
  readonly scratchpad?: Scratchpad;
  /**
   * User-supplied dependencies (clients, resolvers, loggers), keyed by
   * `DepKey<T>` (`deps.ts`). OPTIONAL: injected once at the root and shared by
   * reference across the whole node tree (combinators carry it via
   * `{ ...ctx }`). Existing callers that pass `{ runner }` keep compiling and
   * behave identically (they never read deps).
   */
  readonly deps?: DepReader;
  /**
   * The run's live event bus. OPTIONAL: when present, a node may publish its
   * lifecycle events (`agent.tool.start` / `agent.tool.end` per stage,
   * `agent.message.chunk`, …) onto it, and a streaming runner
   * ({@link NodeBackedRunner.stream}) relays them to the transport AS THEY
   * HAPPEN — so a promoted multi-step pipeline reports each step live instead
   * of collapsing to one terminal chunk. Injected by the runner and carried by
   * reference across the node tree (`{ ...ctx }`). Absent → today's behavior
   * (a node emits nothing extra; the terminal chunk is the only output). The
   * back-compat hinge: existing callers that pass `{ runner }` never touch it.
   */
  readonly eventBus?: AgentEventBus;
  /**
   * A server-parsed `SessionScope` value (tenant/user/region-style
   * conversation-lifetime config), when this run's host carries one. Rides
   * as a SIBLING key on `RunOptions.host` (`host.scope`) — NOT inside
   * `host.deps`, which is a `DepReader` a plain scope object would crash
   * (`ctx.deps.get()`). OPTIONAL: absent → today's behavior. Node code reads
   * it directly (`ctx.scope`) or via `readScope`/`requireScope`
   * (`scope-host.ts`), which accept both this context and a tool's
   * `ToolExecutionContext`. Injected by `agent-step.ts` (from `ctx.scope`)
   * and `as-agent.ts`'s `NodeBackedRunner` (from `options.host.scope`);
   * forwarded across the agent-as-tool seam by `node-tool.ts` so scope
   * survives nested `AgentStep`s / delegated subagents.
   */
  readonly scope?: Record<string, unknown>;
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
