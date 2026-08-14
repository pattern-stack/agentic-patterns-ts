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

import type { Role } from "@pattern-stack/agentic-core";
import { generateId } from "ai";
import { AgentEventBus } from "../events/agent-event-bus.js";
import type { AgentEvent, AgentEventType, BaseEvent } from "../events/types.js";
import { createEvent } from "../events/types.js";
import type { AgentLike } from "../runner/agent-runner.js";
import type { RunOptions, RunResult, RunnerProtocol } from "../runner/types.js";
import type { DepReader } from "./deps.js";
import type { Node, NodeRunContext } from "./node.js";
import { ObservedScratchpad } from "./observed-scratchpad.js";
import { type Scratchpad, createScratchpad } from "./slot.js";
import { createStateEmitter } from "./state-events.js";

// ---------------------------------------------------------------------------
// Role identity
// ---------------------------------------------------------------------------

/** A full core `Role`, or just a name (+ optional description). */
export type RoleInput = Role | { readonly name: string; readonly description?: string };

function isFullRole(role: RoleInput): role is Role {
  // A full core Role has a toPrompt() render; a minimal {name, description}
  // role input does not. instanceof is unreliable across the dist boundary.
  return typeof (role as Role).toPrompt === "function";
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
   * chat turn via `RunOptions`) stays deferred at THIS layer (mirrors #97) —
   * #268 un-defers the capability one level up instead: a registration's
   * `instantiate(context)` hook rebuilds the promoted instance via
   * `asAgent(node, { deps })` per conversation (`agent-server/src/config.ts`
   * `AgentRegistration.instantiate`), so per-conversation scope is available
   * today without a `RunOptions.deps` channel. See `docs/adr/
   * 0004-instantiate-as-execution-seam.md`.
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
  /**
   * The full core `Role` this pipeline was promoted with — DISPLAY ONLY, and
   * `undefined` when `opts.role` was a bare `{name, description}` shell.
   *
   * WHY THIS EXISTS AS A SECOND FIELD (do not "simplify" it away by widening
   * `role`): display richness and execution semantics are two different
   * concerns that happened to share one field, and merging them re-opens a
   * shipped bug.
   *
   * - DISPLAY wants the real Role: the server's introspection routes
   *   (`GET /agents`, `/agents/:id/capabilities`, `/agents/:id/composition`,
   *   `/roles`, `/capabilities`) read a registration's role to render the
   *   playground's Build pages. Reading the narrow `{name}` role renders every
   *   promoted pipeline as an EMPTY agent — no capabilities, no tools, no
   *   role slots.
   * - EXECUTION needs `role` to stay NARROW. `AgentStep` arms a nested agent's
   *   tools via `ctx.toolExecutor ?? deriveToolboxExecutor(agent)`, and
   *   `deriveToolboxExecutor` keys off `role.capabilities`. The server derives
   *   a conversation's executor from the REGISTERED agent: a capability-less
   *   promoted agent yields `undefined`, so each nested `AgentStep` derives its
   *   OWN executor. If `role` carried the pipeline's capabilities, the server
   *   would arm an OUTER executor that rides `RunOptions.toolExecutor` →
   *   `NodeBackedRunner` → `ctx.toolExecutor` and SHADOWS that per-agent
   *   fallback — silently disarming the inner agents' real tools while traces
   *   still look healthy. That is exactly the #13 class of bug #241 fixed.
   *
   * So: `role` stays `{ name }` and `getTools()` stays `() => []` (execution
   * honesty); `displayRole` carries the truth for anything that only RENDERS.
   * Server display reads use `(agent.displayRole ?? agent.role)`; execution
   * paths (`deriveToolboxExecutor`) deliberately never look at `displayRole`.
   */
  readonly displayRole?: Role;
}

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
  // No framework model default (#179/#222): an unset model stays `undefined` and
  // the runner resolves it (tier/env/gateway) or fails loud — the framework never
  // silently pins a vendor's model onto a promoted pipeline.
  const model = opts.model;
  const coerceIn = (opts.coerceIn as ((message: string) => TIn) | undefined) ?? defaultCoerceIn;
  const renderOut = opts.renderOut ?? defaultRenderOut;

  const systemPrompt = isFullRole(role) ? role.toPrompt() : minimalRoleDescriptor(node, role);

  const promoted: PromotedAgent<TIn, TOut> = {
    // NARROW by design — `deriveToolboxExecutor` keys off `role.capabilities`,
    // and a promoted pipeline must NOT arm an outer executor (see
    // {@link PromotedAgent.displayRole} for the full rationale).
    role: { name: roleName },
    getModel: () => model,
    getTools: () => [],
    renderInitialPrompt: () => systemPrompt,
    __promotedNode: node,
    coerceIn,
    renderOut,
    deps: opts.deps,
    // The full Role, kept for DISPLAY only (undefined for a `{name}` shell).
    ...(isFullRole(role) ? { displayRole: role } : {}),
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
 *
 * `eventBus` (optional, S5 follow-up): the SHARED/admin bus this runner's
 * `stream()` lifecycle publishes to — mirrors `AgentRunner`'s constructor-
 * bound bus (`runner/agent-runner.ts`). Without it, `AgentRunner`-backed
 * conversations already publish their own `message.start`/`.complete` (it
 * emits-and-yields internally); a `NodeBackedRunner`-backed (promoted-agent)
 * conversation historically only YIELDED those same event types to its
 * caller and never published them anywhere else, so `RunStoreExporter`
 * (subscribed on the shared bus) never saw a `message.start` to open a `runs`
 * row. Threading the shared bus in here (see `agent-cli/commands/playground.ts`
 * and `commands/run.ts`) closes that gap without touching what gets yielded.
 */
export class NodeBackedRunner implements RunnerProtocol {
  constructor(
    private readonly inner: RunnerProtocol,
    private readonly eventBus?: AgentEventBus,
  ) {}

  async run(agent: AgentLike, message: string, options?: RunOptions): Promise<RunResult> {
    if (!isPromotedAgent(agent)) {
      throw new Error(
        `NodeBackedRunner.run() requires a PromotedAgent (see asAgent()); got agent "${agent.role.name}".`,
      );
    }

    // Run identity (#226): honor caller-supplied ids (stream() threads its
    // minted pair down through RunOptions); mint only what emission needs —
    // a traceId is minted ONLY when a bus is present (state-delta events must
    // carry concrete ids), so bus-less callers see today's ctx byte-for-byte
    // (modulo the new runId field).
    const bus = options?.eventBus;
    const runId = options?.runId ?? generateId();
    let traceId = options?.traceId;

    // The Scratchpad: OBSERVED when the run has a bus (every slot write/read/
    // fork/join and — via the observed accessors — every backpack drop/absorb/
    // read publishes a state-delta event), plain otherwise (today's zero-emit
    // behavior, byte-identical).
    let scratchpad: Scratchpad;
    if (bus) {
      traceId = traceId ?? generateId();
      scratchpad = new ObservedScratchpad(
        createStateEmitter(bus, {
          traceId,
          runId,
          ...(options?.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
        }),
      );
    } else {
      scratchpad = createScratchpad();
    }

    // Scope rides RunOptions.host as a sibling key (decisions.md D1) — narrow
    // it exactly as `nodeTool` does (`node-tool.ts:58`). `run()` otherwise
    // ignores `options.host` entirely, so without this a promoted-agent
    // (`asAgent`) conversation never sees a Conversation-level scope.
    const hostScope = (options?.host as { scope?: Record<string, unknown> } | undefined)?.scope;

    const ctx: NodeRunContext = {
      runner: this.inner,
      toolExecutor: options?.toolExecutor,
      traceId,
      runId,
      parentSpanId: options?.parentSpanId,
      scratchpad,
      deps: agent.deps,
      // Thread the run's event bus onto the ctx so a promoted node can publish
      // its lifecycle events (`stream()` supplies a per-run bus it relays; a
      // direct `run()` forwards the caller's bus, or none). OPTIONAL → absent
      // when no bus is provided, preserving today's no-emit behavior.
      ...(bus ? { eventBus: bus } : {}),
      ...(hostScope ? { scope: hostScope } : {}),
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
    const runId = options?.runId ?? generateId();

    // The bus this run's lifecycle is made VISIBLE on for persistence/admin
    // purposes (RunStoreExporter, SQLiteExporter, the admin Live Run relay):
    // a per-call override, else the constructor-bound default. Distinct from
    // `bus` below — the FRESH per-run relay bus that only exists to drain a
    // promoted node's OWN intra-run publishes into this generator's yields;
    // publishing there would never reach an exporter.
    const externalBus = options?.eventBus ?? this.eventBus;
    const publish = async (event: AgentEvent): Promise<void> => {
      if (externalBus) await externalBus.publish(event);
    };

    const startEvent = createEvent("agent.message.start", {
      traceId,
      runId,
      parentSpanId: options?.parentSpanId,
      agentName: agent.role.name,
    });
    const rootSpanId = startEvent.spanId;
    await publish(startEvent);
    yield startEvent;

    // Live step relay. A FRESH per-run bus (never the caller's shared bus —
    // subscribing to that would leak concurrent conversations' events into this
    // stream) is threaded onto the node's ctx; the node runs concurrently while
    // we forward the lifecycle events it publishes AS THEY HAPPEN. A promoted
    // pipeline that emits `agent.tool.start`/`agent.tool.end` per stage (via
    // `ctx.eventBus`) therefore reports each step live instead of collapsing to
    // one terminal chunk. Back-compat: a node that publishes nothing leaves the
    // queue empty, so only start → chunk → complete are yielded, exactly as
    // before. We relay only the tool-lifecycle span events; iteration/llm noise
    // stays internal and the answer text still arrives once, in the terminal
    // chunk below (streaming the answer body as deltas is a deliberate later step).
    const bus = new AgentEventBus();
    const queue: AgentEvent[] = [];
    // One-shot parked-consumer resolver, held on an object so the cross-closure
    // assignment (set in the Promise executor, cleared here) doesn't get
    // control-flow-narrowed to `null` at these reads.
    const waiter: { resolve: (() => void) | null } = { resolve: null };
    const wake = (): void => {
      const r = waiter.resolve;
      waiter.resolve = null;
      r?.();
    };
    const onEvent = (event: BaseEvent): void => {
      if (RELAYED_STREAM_EVENTS.has(event.type as AgentEventType)) {
        queue.push(event as AgentEvent);
        wake();
      }
    };
    bus.subscribeAll(onEvent);

    let settled = false;
    let runResult: RunResult | undefined;
    let runError: unknown;
    const runPromise = (async () => {
      try {
        // Thread the stream's minted traceId/runId down (#226) so the node's
        // intra-run events — steps, tools, state deltas — correlate with the
        // message lifecycle events yielded above instead of minting their own.
        runResult = await this.run(agent, message, { ...options, traceId, runId, eventBus: bus });
      } catch (err) {
        runError = err;
      } finally {
        settled = true;
        wake();
      }
    })();

    try {
      while (!settled || queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) {
          await publish(next);
          yield next;
          continue;
        }
        // Nothing buffered and the run is still going — park until an event
        // arrives or the run settles. The synchronous guard closes the wakeup
        // race: anything enqueued between the drain above and installing the
        // resolver resolves us immediately (no missed wakeups, single-threaded).
        await new Promise<void>((resolve) => {
          waiter.resolve = resolve;
          if (settled || queue.length > 0) {
            waiter.resolve = null;
            resolve();
          }
        });
      }
    } finally {
      bus.unsubscribeAll(onEvent);
    }

    await runPromise;
    if (runError !== undefined) {
      const err = runError instanceof Error ? runError : new Error(String(runError));
      // Publish-only (never yielded) — no `agent.error` was ever part of the
      // yielded sequence on this path (the generator has always just thrown),
      // so adding one to the SSE/consumer stream now would be a behavior
      // change. RunStoreExporter still needs SOMETHING to finalize the open
      // `runs` row as 'error' (otherwise it lingers 'running' until the next
      // boot's `sweepRunning()`), so it goes to the bus only.
      await publish(
        createEvent("agent.error", {
          traceId,
          runId,
          parentSpanId: rootSpanId,
          errorType: err.name,
          message: err.message,
          recoverable: false,
          context: {},
        }),
      );
      throw err;
    }
    const result = runResult as RunResult;

    const chunkEvent = createEvent("agent.message.chunk", {
      traceId,
      runId,
      parentSpanId: rootSpanId,
      delta: result.response,
      chunkIndex: 0,
    });
    await publish(chunkEvent);
    yield chunkEvent;

    const completeEvent = createEvent("agent.message.complete", {
      traceId,
      runId,
      spanId: rootSpanId,
      parentSpanId: rootSpanId,
      content: result.response,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: agent.getModel() ?? "",
    });
    await publish(completeEvent);
    yield completeEvent;
  }
}

/**
 * The intra-run events {@link NodeBackedRunner.stream} forwards live to the
 * transport: the tool-lifecycle span events a promoted pipeline emits per stage.
 * Iteration/LLM events stay internal (transport already filters them), and the
 * answer body is delivered once via the terminal `agent.message.chunk`, so it is
 * intentionally NOT relayed here (no duplicate text).
 */
const RELAYED_STREAM_EVENTS: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  // Step / delegation spans a promoted multi-step node emits per stage — the
  // transport renders these as AGENT delegations (distinct from tool calls).
  "agent.step.start",
  "agent.step.end",
  // Tool-lifecycle spans a delegated agent makes — nested under their step.
  "agent.tool.intent",
  "agent.tool.start",
  "agent.tool.progress",
  "agent.tool.end",
  "agent.tool.rejected",
  // Tool-approval SDK-framing pair (#389) — a delegated/promoted sub-agent's
  // capable-path approval must reach the parent conversation SSE; this relay
  // is its ONLY route there (events not listed here die silently).
  "agent.tool.approval.request",
  "agent.tool.approval.response",
  // Bifrost gateway guardrail events (#407) — a delegated/promoted sub-agent's
  // guardrail hit must reach the parent conversation SSE; this relay is its
  // ONLY route there (events not listed here die silently).
  "agent.guardrail.violation",
  "agent.guardrail.redaction",
  // State-delta events (#226) — Backpack/Scratchpad mutations the observed
  // emission layer publishes. Relayed so the playground chat can render Delta
  // Frames + the Scratchpad rail live; the conversation SSE is this path's
  // ONLY route to the client (events not listed here die silently).
  "agent.backpack.drop",
  "agent.backpack.read",
  "agent.backpack.absorb",
  "agent.scratchpad.write",
  "agent.scratchpad.read",
  "agent.scratchpad.fork",
  "agent.scratchpad.join",
]);
