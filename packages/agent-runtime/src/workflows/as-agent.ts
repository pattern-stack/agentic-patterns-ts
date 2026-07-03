/**
 * `asAgent()` — promote any `Node<TIn, TOut>` to an `AgentLike` (DESIGN §3, keystone).
 *
 * `AgentStep` (`agent-step.ts`) already turns an `Agent` into a `Node`. This is
 * the reverse: `asAgent(node, opts)` wraps a `Node` so the runner, server,
 * playground, and `ap` CLI treat it exactly like an agent — a pipeline becomes
 * discoverable, chattable, and runnable with no new machinery.
 *
 * `PromotedAgent` is an HONEST `AgentLike` — it carries no fabricated
 * `mission`/`awareness`/`background`. Discoverability comes from teaching
 * `ap`'s discovery the `AgentLike` surface (`agent-cli/src/helpers/discover.ts`
 * `isAgentLikeShape`), not from stub atoms. See spec `.ai-docs/stacks/
 * closed-composition/specs/97.md` § Key finding for the two-surfaces rationale.
 *
 * ADDITIVE: new file. Does not touch `Node`, `AgentStep`, discovery's
 * `isAgentShape`, or the server routes.
 */

import type { Role } from "@agentic-patterns/core";
import { generateId } from "ai";
import type { AgentEvent } from "../events/types.js";
import { createEvent } from "../events/types.js";
import type { AgentLike } from "../runner/agent-runner.js";
import type { RunOptions, RunResult, RunnerProtocol } from "../runner/types.js";
import type { DepReader } from "./deps.js";
import type { Node, NodeRunContext } from "./node.js";
import { createScratchpad } from "./slot.js";

// ---------------------------------------------------------------------------
// Role identity
// ---------------------------------------------------------------------------

/** A full core `Role`, or just a name (+ optional description). */
export type RoleInput = Role | { readonly name: string; readonly description?: string };

function isFullRole(role: RoleInput): role is Role {
  return typeof (role as Role).renderSystemPrompt === "function";
}

/** One-line descriptor for a minimal (non-`Role`) `RoleInput`, folding in `description` when given. */
function minimalRoleDescriptor(
  node: Node<unknown, unknown>,
  role: { description?: string },
): string {
  const base = `Promoted pipeline: ${node.name ?? "pipeline"}`;
  return role.description ? `${base} — ${role.description}` : base;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Promotion options. `coerceIn` is optional when `TIn extends string` (identity
 * default is correct), required otherwise — the compiler forces a coercer for a
 * non-string pipeline.
 */
export type PromoteOptions<TIn, TOut> = {
  readonly role: RoleInput;
  readonly model?: string;
  readonly renderOut?: (out: TOut) => string;
  /**
   * Deps bound at promotion time — `NodeBackedRunner.run()` sets these on the
   * `NodeRunContext` it builds, so every nested leaf in the promoted pipeline
   * reads them with no closures. Per-request deps (a different registry per
   * chat turn via `RunOptions`) is deliberately deferred (mirrors #97).
   */
  readonly deps?: DepReader;
} & (TIn extends string
  ? { readonly coerceIn?: (message: string) => TIn }
  : { readonly coerceIn: (message: string) => TIn });

// ---------------------------------------------------------------------------
// PromotedAgent
// ---------------------------------------------------------------------------

/** Honest `AgentLike` + node payload. NO `mission`/`awareness`/`background` stubs. */
export interface PromotedAgent<TIn, TOut> extends AgentLike {
  /** Brand + payload for {@link isPromotedAgent}. */
  readonly __promotedNode: Node<TIn, TOut>;
  readonly coerceIn: (message: string) => TIn;
  readonly renderOut: (out: TOut) => string;
  /** Deps bound at promotion time (see {@link PromoteOptions.deps}). */
  readonly deps?: DepReader;
}

const DEFAULT_MODEL = "sonnet";

function defaultRenderOut<TOut>(out: TOut): string {
  if (typeof out === "string") return out;
  // JSON.stringify(undefined) returns the JS value `undefined`, not a string
  // (e.g. a failed node's `output`) — always fall back to String() so this
  // never violates RunResult.response's `string` contract.
  return JSON.stringify(out, null, 2) ?? String(out);
}

function defaultCoerceIn<TIn>(message: string): TIn {
  return message as unknown as TIn;
}

/**
 * Promote a `Node<TIn, TOut>` to a `PromotedAgent<TIn, TOut>` — a frozen,
 * honest `AgentLike` carrying the node + coercion seams. Run it via a
 * {@link NodeBackedRunner}.
 */
export function asAgent<TIn, TOut>(
  node: Node<TIn, TOut>,
  opts: PromoteOptions<TIn, TOut>,
): PromotedAgent<TIn, TOut> {
  const role = opts.role;
  const roleName = role.name;
  const model = opts.model ?? DEFAULT_MODEL;
  const coerceIn = (opts.coerceIn as ((message: string) => TIn) | undefined) ?? defaultCoerceIn;
  const renderOut = opts.renderOut ?? defaultRenderOut;

  const systemPrompt = isFullRole(role)
    ? role.renderSystemPrompt()
    : minimalRoleDescriptor(node, role);

  const promoted: PromotedAgent<TIn, TOut> = {
    role: { name: roleName },
    getModel: () => model,
    getTools: () => [],
    getSystemPrompt: () => systemPrompt,
    // A promoted pipeline has no separate "initial prompt" render (unlike a
    // core Agent, whose renderInitialPrompt() can differ from its system
    // prompt) — deliberately alias getSystemPrompt() here.
    renderInitialPrompt: () => systemPrompt,
    __promotedNode: node,
    coerceIn,
    renderOut,
    deps: opts.deps,
  };

  return Object.freeze(promoted);
}

/**
 * Structural check for a {@link PromotedAgent} — `__promotedNode` must itself
 * look like a `Node` (a `run` function), not merely be present, plus the
 * `AgentLike` surface.
 */
export function isPromotedAgent(x: unknown): x is PromotedAgent<unknown, unknown> {
  if (!x || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  const node = a.__promotedNode as Record<string, unknown> | undefined;
  return (
    !!node &&
    typeof node === "object" &&
    typeof node.run === "function" &&
    typeof a.coerceIn === "function" &&
    typeof a.renderOut === "function" &&
    typeof a.getModel === "function" &&
    typeof a.getSystemPrompt === "function" &&
    typeof a.renderInitialPrompt === "function"
  );
}

// ---------------------------------------------------------------------------
// NodeBackedRunner
// ---------------------------------------------------------------------------

/**
 * `RunnerProtocol` that executes a {@link PromotedAgent}'s node instead of
 * LLM-looping it. The injected `inner` runner becomes the `ctx.runner` seen by
 * any nested `AgentStep`s in the pipeline — so they still call the real model.
 */
export class NodeBackedRunner implements RunnerProtocol {
  constructor(private readonly inner: RunnerProtocol) {}

  async run(agent: AgentLike, message: string, options?: RunOptions): Promise<RunResult> {
    if (!isPromotedAgent(agent)) {
      throw new Error(
        `NodeBackedRunner.run() requires a PromotedAgent (see asAgent()); got agent "${agent.role.name}".`,
      );
    }

    const ctx: NodeRunContext = {
      runner: this.inner,
      toolExecutor: options?.toolExecutor,
      traceId: options?.traceId,
      scratchpad: createScratchpad(),
      deps: agent.deps,
    };

    const input = agent.coerceIn(message);
    const result = await agent.__promotedNode.run(input, ctx);

    // A failed node's `output` is typically `undefined` (the AgentStep/
    // FunctionStep failure shape) — rendering that would silently violate
    // RunResult.response's `string` contract and drop the error from the
    // visible response (SSE chat would show an empty message). Surface the
    // error message instead; fall back to the rendered output only if the
    // node somehow failed without one.
    const response = result.succeeded
      ? agent.renderOut(result.output)
      : (result.error?.message ?? agent.renderOut(result.output));

    return {
      response,
      inputTokens: result.totalInputTokens,
      outputTokens: result.totalOutputTokens,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: result.succeeded ? "stop" : "error",
    };
  }

  async *stream(
    agent: AgentLike,
    message: string,
    options?: RunOptions,
  ): AsyncGenerator<AgentEvent> {
    const traceId = options?.traceId ?? generateId();
    const runId = generateId();

    const startEvent = createEvent("agent.message.start", {
      traceId,
      runId,
      parentSpanId: options?.parentSpanId,
      agentName: agent.role.name,
    });
    const rootSpanId = startEvent.spanId;
    yield startEvent;

    const result = await this.run(agent, message, options);

    const chunkEvent = createEvent("agent.message.chunk", {
      traceId,
      runId,
      parentSpanId: rootSpanId,
      delta: result.response,
      chunkIndex: 0,
    });
    yield chunkEvent;

    const completeEvent = createEvent("agent.message.complete", {
      traceId,
      runId,
      spanId: rootSpanId,
      parentSpanId: rootSpanId,
      content: result.response,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: agent.getModel(),
    });
    yield completeEvent;
  }
}
