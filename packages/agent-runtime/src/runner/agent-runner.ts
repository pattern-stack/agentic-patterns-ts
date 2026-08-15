/**
 * AgentRunner — The standard agentic execution loop on Vercel AI SDK.
 *
 * Ported from Python: systems/runners/agent.py
 *
 * Key differences from Python:
 * - Parallel tool execution via Promise.all (Python is sequential)
 * - Vercel AI SDK handles tool schema conversion (Python manually builds OpenAI JSON)
 * - One generateText/streamText call per iteration (v7 single-step default) for
 *   gate interception control (see GATE-CHAIN INVARIANT below)
 * - MockLanguageModelV3 for testing (replaces Python's MockRunner)
 *
 * GATE-CHAIN INVARIANT (do not break): the SDK must NOT auto-run or loop tools.
 * We deliberately (a) pass tools WITHOUT an `execute` function and (b) rely on
 * v7's single-step default (we removed v4's `maxSteps: 1`). Tool dispatch goes
 * through the gate chain + `toolExecutor` here, NOT the SDK. If you ever give a
 * tool an `execute`, or add `stopWhen` / `maxSteps`/`isStepCount(>1)`, the SDK
 * will run and loop tools itself and the gate interception (and the T0-1
 * gate-allow regression test in agent-runner.test.ts) will be bypassed.
 *
 * SCOPE NOTE (#389, D0/Option C): the invariant above governs `run()` and
 * `stream()` only. `runStructured()`'s CAPABLE path is the one place the SDK
 * already drives a multi-step loop with execute-bearing tools (§9.4) — there,
 * gate interception is preserved via `toolApproval` (see
 * `tool-approval-bridge.ts`), which awaits `AgentEventBus.evaluateIntent`
 * before the SDK ever calls `execute`. That path is a deliberate, scoped
 * exception to this invariant, not a violation of it.
 */

import type { Context, InferToolSetContext, ProviderOptions } from "@ai-sdk/provider-utils";
import type {
  RenderArtifact,
  RenderContext,
  ToolExecutionContext,
  ToolSchema,
} from "@pattern-stack/agentic-core";
import {
  type GenericToolApprovalFunction,
  type LanguageModelUsage,
  type ModelMessage,
  Output,
  type ToolSet,
  generateId,
  generateText,
  isStepCount,
  streamText,
  tool,
} from "ai";
import type { ZodType } from "zod";

import { type AgentEventBus, getAgentEventBus } from "../events/agent-event-bus.js";
import {
  type AgentEvent,
  type ErrorEvent,
  type GuardrailRedactionEvent,
  type GuardrailViolationEvent,
  type TokenUsageDetails,
  type ToolCallIntent,
  createEvent,
} from "../events/types.js";
import {
  BifrostGuardrailViolationError,
  type GatewayAttribution,
  attributionFromProviderMetadata,
  classifyBifrostError,
  hasBifrostRedactionMetadata,
  scanRedactionPlaceholders,
  truncateMessage,
  violationSummaryMessage,
} from "../providers/bifrost.js";
import {
  type ReasoningEffortLevel,
  adviseReasoningEffort,
  adviseStructuredRun,
  bareModelId,
  getModelCapabilities,
} from "../providers/capabilities.js";
import {
  type ModelResolver,
  constantModelResolver,
  isModelResolver,
} from "../providers/model-resolver.js";
import type { ResolvedLanguageModel } from "../providers/types.js";
import { convertHistory, sanitizeResponseMessages, toJsonValue } from "./message-utils.js";
import { narrowRenderCtx } from "./render-ctx.js";
import { guardOpenObjectSchemas } from "./schema-guard.js";
import { type ToolArgsOverlay, createGateToolApproval } from "./tool-approval-bridge.js";
import type {
  AgentLike,
  RunOptions,
  RunResult,
  RunnerProtocol,
  StructuredRunResult,
  ToolExecutor,
} from "./types.js";
import { detailsFromUsage, mergeUsageDetails } from "./usage-details.js";

// Re-export AgentLike here so existing consumers importing from "./agent-runner"
// (including the public barrel and workflow modules) continue to work.
export type { AgentLike };

// ---------------------------------------------------------------------------
// ToolCallBlocked error
// ---------------------------------------------------------------------------

export class ToolCallBlocked extends Error {
  readonly toolName: string;
  readonly reason: string;

  constructor(toolName: string, reason: string) {
    super(`Tool call '${toolName}' blocked: ${reason}`);
    this.name = "ToolCallBlocked";
    this.toolName = toolName;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// RunCancelledError (#341 amendment)
// ---------------------------------------------------------------------------

/**
 * Thrown by `runStructured()` when `RunOptions.abortSignal` fires before a
 * schema-valid `object` exists to return. Unlike `stream()`/`run()` — whose
 * result shapes have no required "output" field, so they can return an
 * honest empty/cancelled result — `StructuredRunResult<T>` REQUIRES a
 * schema-valid `object: T`; there is no honest value to fabricate on abort.
 * Throwing (rather than the D1 return-never-throw posture) is the only
 * type-safe option here. `err.name === "RunCancelledError"` (or
 * `instanceof`) distinguishes this from a genuine schema/model failure.
 */
export class RunCancelledError extends Error {
  constructor(message = "runStructured aborted before a result was available") {
    super(message);
    this.name = "RunCancelledError";
  }
}

/**
 * Abort-shaped rejection names, mirroring the SDK's own `isAbortError`
 * (`AbortError` | `TimeoutError` | `ResponseAborted`). `TimeoutError` is what
 * `AbortSignal.timeout(ms)`'s reason carries — the most common way a caller
 * hands a signal to an LLM call.
 */
const ABORT_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "ResponseAborted"]);

/**
 * #504: an abort-shaped rejection that our own forwarded signal explains.
 * The `signal.aborted` conjunct is deliberate — a shape check alone would
 * misclassify a provider's unrelated abort-shaped failure as our cancel.
 * Given the signal HAS fired, two routes prove causality: identity with the
 * signal's own `reason` (what `fetch` actually rejects in-flight requests
 * with — covers `controller.abort(customReason)` verbatim), or an
 * abort-shaped error name. Never string-matches messages.
 */
function isAbortRejection(e: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted !== true) return false;
  if (e === signal.reason) return true;
  return e instanceof Error && ABORT_ERROR_NAMES.has(e.name);
}

// ---------------------------------------------------------------------------
// withToolTimeout (#521)
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link withToolTimeout} on expiry — a NAMED error so call sites
 * and tests can distinguish a timeout from a genuine tool failure. Every one
 * of `AgentRunner`'s three dispatch sites already `catch`es a rejection into
 * a structured `{error: message}` tool result (+ `errorMsg` for the
 * `agent.tool.end` event and the terminal-tool-exit keying), so a rejecting
 * timeout composes at zero call-site change.
 */
class ToolTimeoutError extends Error {
  readonly toolName: string;
  readonly ms: number;

  constructor(toolName: string, ms: number) {
    super(`Tool '${toolName}' timed out after ${ms}ms`);
    this.name = "ToolTimeoutError";
    this.toolName = toolName;
    this.ms = ms;
  }
}

/**
 * Race `p` against `ms` milliseconds. Expiry REJECTS with
 * {@link ToolTimeoutError} — never resolves (a resolve-shaped expiry would
 * make `stream()`'s terminal-tool exit, keyed on `errorMsg === undefined`,
 * treat a timed-out TERMINAL tool's timeout message as the run's clean final
 * response — see #521's Spec Review B5). The LOSING promise is ABANDONED,
 * never killed — `p` keeps running to completion or rejection in the
 * background; `ToolExecutionContext.signal` is the only cooperative
 * cancellation channel a tool can opt into. The timer is cleared on either
 * settle path, so a fast `p` leaves no open handle.
 */
function withToolTimeout<T>(p: Promise<T>, ms: number, toolName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ToolTimeoutError(toolName, ms));
    }, ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Structured-output capability table (DESIGN §9.4 / §9.5)
// ---------------------------------------------------------------------------

/**
 * Does this model support a SINGLE-CALL tools + structured-output round-trip
 * (`experimental_output` while a tool loop runs)?
 *
 * @deprecated Superseded by the capability map in `providers/capabilities.ts`
 * (`getModelCapabilities(id)?.toolsWithStructuredOutput`), which additionally
 * carries provenance (`verifiedBy`/`lastVerified`) and answers more questions
 * than this one boolean (native structured output, `strict` mode,
 * `inputExamples`, reasoning-effort levels — see #390). Kept as a public
 * export (`runner/index.ts`) for back-compat; delegates to the map.
 *
 * Conservative, additive, empirically seeded (DESIGN §9.5). CAPABLE iff the
 * resolved model id matches one of the verified-good families in the map;
 * EVERY other id — including unknown ids and untested providers (anthropic,
 * gemini ≤3.1 / 2.5) — returns `false`, routing to the model-safe 2-tier
 * path.
 *
 * Correctness never depends on this flag (the 2-tier fallback is always
 * correct); it only decides whether a round-trip can be saved.
 *
 * PARITY NOTE (Gate 1.5 review note 5): the pre-#390 implementation checked
 * gemini-3.5-flash with `bare.includes(...)` — a SUBSTRING check, not a
 * prefix match — so an adversarial id like "x-gemini-3.5-flash" historically
 * returned `true` even though it doesn't start with the family prefix. The
 * capability map itself uses longest-PREFIX matching
 * ({@link getModelCapabilities}); the substring fallback below preserves the
 * exact historical (looser) gemini behavior so this delegate's truth table
 * stays byte-for-byte identical to the pre-#390 function, not merely
 * equivalent on real dispatched ids.
 */
export function modelSupportsToolsWithStructuredOutput(modelId: string): boolean {
  if (getModelCapabilities(modelId)?.toolsWithStructuredOutput.support === "yes") {
    return true;
  }
  return bareModelId(modelId).includes("gemini-3.5-flash");
}

// ---------------------------------------------------------------------------
// Per-run request headers (#406 — gateway correlation / guardrail seam)
// ---------------------------------------------------------------------------

/**
 * Per-run context handed to an {@link AgentRunnerOptions.requestHeaders}
 * factory. `runId` is minted INSIDE `run()`/`stream()`/`runStructured()`
 * (`generateId()`) and is therefore unknowable to the caller ahead of time —
 * this is why the seam is a factory (called once the runId exists) rather
 * than a static value passed at construction.
 */
export interface RunHeadersContext {
  runId: string;
  traceId: string;
  agentName: string;
  modelId: string | undefined;
  modelProvider: string;
}

// ---------------------------------------------------------------------------
// Per-call generation-control params (#514)
// ---------------------------------------------------------------------------

/**
 * The subset of `CallSettings`/call-options keys `_resolveCallParams` may
 * produce, spread directly into `generateText`/`streamText` — a resolved
 * projection of {@link ModelParams} (`reasoningEffort` renamed to
 * `reasoning`, everything else name-preserving). Every member optional: only
 * the keys the caller actually set via `RunOptions.modelParams` appear.
 */
interface CallParams {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  reasoning?: ReasoningEffortLevel;
  providerOptions?: ProviderOptions;
}

/** Constructor options for {@link AgentRunner}. */
export interface AgentRunnerOptions {
  /**
   * Generic, gateway-agnostic seam: computes per-run HTTP headers to forward
   * to every provider call this run makes, given {@link RunHeadersContext}.
   * `createRunner` wires `bifrostCorrelationHeaders` (`providers/bifrost.ts`)
   * automatically whenever a gateway is configured; that factory self-gates on
   * `ctx.modelProvider` so non-gateway/profile-escape-hatch models are
   * unaffected. Merged UNDER `RunOptions.requestHeaders` (per-run beats
   * per-runner-instance).
   */
  requestHeaders?: (ctx: RunHeadersContext) => Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

/**
 * The standard agentic execution loop.
 *
 * Executes agents using a tool loop pattern with the Vercel AI SDK.
 *
 * The runner implements an agentic tool loop:
 * 1. Send message to LLM with system prompt and tools
 * 2. If LLM returns tool_calls, execute them via toolExecutor (parallel)
 * 3. Feed tool results back to LLM
 * 4. Repeat until LLM returns final response or maxIterations reached
 */
export class AgentRunner implements RunnerProtocol {
  // #496: readonly — the bus is resolved per public call (see busFor), never
  // rebound mid-life. `run({eventBus})` used to mutate this field, so with a
  // singleton runner two concurrent calls with different buses interleaved and
  // a gate registered for one bus could adjudicate the other's tool calls.
  private readonly _eventBus: AgentEventBus | undefined;
  private readonly _resolver: ModelResolver;
  private readonly _requestHeaders: AgentRunnerOptions["requestHeaders"];

  /**
   * @param model A {@link ModelResolver} — the runner resolves `agent.getModel()`
   *   per run, so the model belongs to the agent (overridable per-agent). OR a
   *   concrete {@link ResolvedLanguageModel}, which is wrapped in a
   *   {@link constantModelResolver} so the model is pinned regardless of what the
   *   agent declares (back-compat; the path tests use with `MockLanguageModelV3`).
   * @param opts Optional runner-level configuration (#406: `requestHeaders`
   *   factory). Backwards-compatible — existing 2-arg callers are unaffected.
   */
  constructor(
    model: ResolvedLanguageModel | ModelResolver,
    eventBus?: AgentEventBus,
    opts?: AgentRunnerOptions,
  ) {
    this._resolver = isModelResolver(model) ? model : constantModelResolver(model);
    this._eventBus = eventBus;
    this._requestHeaders = opts?.requestHeaders;
  }

  /**
   * Computed per-call HTTP headers for this run: `RunOptions.requestHeaders`
   * merged OVER the runner-level `requestHeaders` factory's output. Returns
   * `undefined` when neither source is configured, so the no-config path
   * passes no `headers` key to `generateText`/`streamText` at all — existing
   * callers (and their `MockLanguageModelV3` assertions) see no change.
   */
  private _callHeaders(
    ctx: RunHeadersContext,
    options?: RunOptions,
  ): Record<string, string | undefined> | undefined {
    const factoryHeaders = this._requestHeaders?.(ctx);
    const perRunHeaders = options?.requestHeaders;
    if (!factoryHeaders && !perRunHeaders) return undefined;
    return { ...factoryHeaders, ...perRunHeaders };
  }

  /**
   * Builds the {@link RunHeadersContext} for this run/call from the already-
   * resolved `agent`/`model`/`runId`/`traceId`, then delegates to
   * {@link _callHeaders}. Shared by `run()`, `runStructured()`, and `stream()`
   * (each computes this once per run, right after model resolution, and
   * reuses it across their own iteration/tier loops).
   */
  private _resolveCallHeaders(
    agent: AgentLike,
    model: ResolvedLanguageModel,
    runId: string,
    traceId: string,
    options?: RunOptions,
  ): Record<string, string | undefined> | undefined {
    return this._callHeaders(
      {
        runId,
        traceId,
        agentName: agent.role.name,
        modelId: model.modelId,
        modelProvider: model.provider,
      },
      options,
    );
  }

  /**
   * Computed per-call generation-control params for this run (#514),
   * mirroring {@link _resolveCallHeaders}: returns `undefined` when
   * `options?.modelParams` is absent, else an object built with per-key
   * conditional spreads (the event-payload idiom) so only keys the caller
   * actually set appear — `reasoningEffort` renamed to `reasoning` (the
   * SDK's top-level call setting), everything else name-preserving,
   * `providerOptions` passed through verbatim. Spread `undefined` adds no
   * keys, so the no-config call object is byte-identical to pre-#514
   * behavior at the `generateText`/`streamText` argument level.
   *
   * Called once per public call, right next to `_resolveCallHeaders` — `run()`,
   * `runStructured()`, and `stream()` each compute this once and reuse it
   * across their own iteration/tier loops. When `reasoningEffort` is set,
   * this also fires the {@link adviseReasoningEffort} advisory (once per
   * (model x condition), never blocking or altering the call).
   */
  private _resolveCallParams(modelName: string, options?: RunOptions): CallParams | undefined {
    const params = options?.modelParams;
    if (!params) return undefined;
    if (params.reasoningEffort !== undefined) {
      adviseReasoningEffort(modelName, params.reasoningEffort);
    }
    return {
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.maxOutputTokens !== undefined ? { maxOutputTokens: params.maxOutputTokens } : {}),
      ...(params.topP !== undefined ? { topP: params.topP } : {}),
      ...(params.topK !== undefined ? { topK: params.topK } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(params.stopSequences !== undefined ? { stopSequences: params.stopSequences } : {}),
      ...(params.reasoningEffort !== undefined ? { reasoning: params.reasoningEffort } : {}),
      ...(params.providerOptions !== undefined ? { providerOptions: params.providerOptions } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // RunOptions.timeout resolution (#521)
  // ---------------------------------------------------------------------------

  /**
   * Per-run SDK `timeout` config for `RunTimeouts.modelMs` — uniform
   * `{ stepMs: modelMs }` on all five provider calls (never `{totalMs}`,
   * which would meter the whole multi-step loop on `runStructured()`'s
   * capable path instead of resetting per step; Spec Review B3, probed).
   * Computed once per run, reused across iterations/tiers below (parity
   * with `_resolveCallParams`/`_resolveCallHeaders`). `undefined` when
   * `timeout.modelMs` is absent, so no `timeout` key reaches the call —
   * though this is not independently observable at the mock either way: the
   * SDK consumes `timeout` into the merged abort signal before `doGenerate`
   * ever sees its options (Spec Review B6).
   */
  private _resolveModelTimeout(options?: RunOptions): { stepMs: number } | undefined {
    const modelMs = options?.timeout?.modelMs;
    return modelMs !== undefined ? { stepMs: modelMs } : undefined;
  }

  /**
   * The per-run effective abort signal (#521): `options.abortSignal`
   * composed with a derived `AbortSignal.timeout(runMs)` when
   * `RunOptions.timeout.runMs` is set. This is the ONE signal forwarded to
   * every provider call and checked by every cooperative guard — all
   * existing #504 machinery (`isAbortRejection`, the boundary guards)
   * applies to it unchanged. `runSignal` is kept as its own reference
   * purely so reason discrimination (see `_cancelReason`) can test identity
   * rather than comparing clocks. `deadlineAt` exists ONLY for
   * `runStructured()`'s tier-1 remaining-budget arithmetic — never for
   * discrimination (a `deadlineAt <= Date.now()` check misreports a
   * measured ~2.5% of expiries; Spec Review, probed).
   *
   * Absent `runMs` → `effectiveSignal === options?.abortSignal` byte-
   * identical to pre-#521 behavior, `runSignal`/`deadlineAt` both
   * `undefined`.
   */
  private _resolveEffectiveSignal(options?: RunOptions): {
    effectiveSignal: AbortSignal | undefined;
    runSignal: AbortSignal | undefined;
    deadlineAt: number | undefined;
  } {
    const runMs = options?.timeout?.runMs;
    if (runMs === undefined) {
      return { effectiveSignal: options?.abortSignal, runSignal: undefined, deadlineAt: undefined };
    }
    const runSignal = AbortSignal.timeout(runMs);
    const callerSignal = options?.abortSignal;
    const effectiveSignal = callerSignal ? AbortSignal.any([callerSignal, runSignal]) : runSignal;
    return { effectiveSignal, runSignal, deadlineAt: Date.now() + runMs };
  }

  /**
   * §4's reason discrimination, BY SIGNAL IDENTITY, never by clock: an
   * explicit caller cancel always wins when both the caller's signal and
   * the derived `runSignal` have fired. Only meaningful once the effective
   * signal is known to have fired (i.e. inside a guard/catch that already
   * checked `effectiveSignal?.aborted` or `isAbortRejection`) — callers
   * don't need to re-check that here.
   */
  private _cancelReason(
    options: RunOptions | undefined,
    runSignal: AbortSignal | undefined,
  ): "cancelled" | "timeout" {
    if (options?.abortSignal?.aborted) return "cancelled";
    if (runSignal?.aborted) return "timeout";
    return "cancelled";
  }

  /**
   * `RunCancelledError`'s message, reason-discriminated (§4: "message text
   * gains a timeout variant"). `when` names the site (kept close to the
   * pre-#521 wording at each throw site).
   */
  private _cancelledRunMessage(reason: "cancelled" | "timeout", when: string): string {
    return reason === "timeout"
      ? `runStructured: timed out ${when} (RunOptions.timeout.runMs elapsed)`
      : `runStructured: aborted ${when} (abortSignal fired)`;
  }

  /**
   * §5: the per-dispatch tool signal — `AbortSignal.timeout(toolMs)`
   * composed with the run's effective signal, so a timed-out (or
   * run-aborted) dispatch observes `ctx.signal.aborted === true`. Freshly
   * minted PER DISPATCH (each tool call gets its own `toolMs` budget, not a
   * shared per-run timer) — callers must call this at each dispatch site,
   * not hoist it. `undefined` when `toolMs` is unset: DELIBERATE — under
   * `runMs` alone a blocked tool is not interrupted (the deadline is
   * honored at the next boundary instead); wiring the run signal into
   * `ctx.signal` without `toolMs` would expand the acceptance surface and
   * is deferred (Spec Review note 4, re-run 0).
   */
  private _toolDispatchSignal(
    toolMs: number | undefined,
    effectiveSignal: AbortSignal | undefined,
  ): AbortSignal | undefined {
    if (toolMs === undefined) return undefined;
    const toolSignal = AbortSignal.timeout(toolMs);
    return effectiveSignal ? AbortSignal.any([effectiveSignal, toolSignal]) : toolSignal;
  }

  /**
   * Resolve the event bus for ONE public call (#496): the per-call override,
   * then the constructor bus, then the global singleton — lazily, never
   * memoized onto the field. Each of `run()`/`runStructured()`/`stream()`
   * calls this exactly once at entry and threads the result (as a local
   * `emit`/`emitIntent` closure, or as `bus` on a helper's ctx/scope object)
   * for the whole call. BEHAVIOUR CHANGE vs the old sticky rebind: a call
   * that omits `eventBus` now always falls back to the constructor/global
   * bus — it no longer inherits whatever bus a PREVIOUS call passed.
   *
   * Intent evaluation (the per-call `emitIntent` closures) delegates to
   * {@link AgentEventBus.evaluateIntent}, which returns THIS intent's own
   * {@link GateEvaluation} — no inference from publish()'s ambiguous `[]`
   * return, and no bus-wide `agent.tool.rejected` subscription. The AI SDK
   * runs a step's tool calls concurrently, and the old subscription-based
   * inference had to hand-correlate each rejection back to its
   * `originalIntent.toolCallId` to avoid a concurrent sibling's rejection
   * flipping this call's verdict (#288). `evaluateIntent` is per-call and
   * definitive, so that correlation is no longer needed and the class of bug
   * is gone. `evaluateIntent` still emits the rejection event and runs the
   * guaranteed audit phase, so subscriber and audit semantics are unchanged.
   */
  private busFor(options?: RunOptions): AgentEventBus {
    return options?.eventBus ?? this._eventBus ?? getAgentEventBus();
  }

  /**
   * Cancel-and-return block (#341, locked D1) — the SINGLE emission path for
   * every abort guard in `stream()` (top-of-iteration, mid-fullStream-drain,
   * pre-tool-dispatch). The runner OWNS cancel emission: `agent.message.
   * cancel` + `agent.conversation.end {reason:"cancelled"}`, so bus,
   * exporters, and the collector observe it on every transport regardless of
   * which guard fired. Callers `yield* this.emitCancellation(...); return;`
   * immediately after — the generator ends here, it never throws. Skips
   * `agent.iteration.end`/`agent.message.complete` for the aborted iteration
   * by design (accepted per the human gate's Q2 answer — mirrors the
   * existing error path's posture).
   */
  private async *emitCancellation(params: {
    bus: AgentEventBus;
    traceId: string;
    runId: string;
    parentSpanId: string;
    conversationId: string;
  }): AsyncGenerator<AgentEvent> {
    const cancelEv = createEvent("agent.message.cancel", {
      traceId: params.traceId,
      runId: params.runId,
      parentSpanId: params.parentSpanId,
      reason: "cancelled by client",
    });
    await params.bus.publish(cancelEv);
    yield cancelEv;

    const convEnd = createEvent("agent.conversation.end", {
      traceId: params.traceId,
      runId: params.runId,
      conversationId: params.conversationId,
      reason: "cancelled" as const,
    });
    await params.bus.publish(convEnd);
    yield convEnd;
  }

  /**
   * Build the bus-bound {@link ToolExecutionContext} handed to `toolExecutor.execute`
   * at each dispatch site (#102). Single adapter so the three call sites don't drift.
   *
   * `parentSpanId` reuses the invoking tool call's own span id (`tcSpanId`, the
   * `spanId` stamped on that call's `agent.tool.start`) as the nesting anchor —
   * NOT a separate field. A tool call's span IS the parent span for anything it
   * spawns (a nested sub-agent's events, or this ctx's own `emit` progress
   * pings); do not "fix" this into a distinct `parentToolCallId`-derived span.
   *
   * INVARIANT (deliberate, load-bearing): `agent.tool.start` is stamped with
   * `spanId: toolCallId` at every dispatch site — NOT a freshly-generated id.
   * `node-tool.ts` anchors a nested sub-agent's root span at `parentSpanId ===
   * parentToolCallId` (this ctx's `parentToolCallId`, above), and real span
   * consumers (`exporters/otel.ts`, `exporters/langfuse.ts`) resolve parentage
   * strictly by matching `parentSpanId` against a KNOWN `event.spanId`. Unless
   * `tcSpanId === toolCallId` holds, the child resolves to no such span and
   * becomes an orphan root in every exporter. Do not "fix" this back to a
   * generated spanId — `toolCallId` IS the tool call's span id by design.
   */
  private buildToolCtx(a: {
    bus: AgentEventBus;
    traceId: string;
    runId: string;
    parentToolCallId: string;
    parentSpanId: string;
    host?: unknown;
    /**
     * Render-artifact publish sink for THIS tool call (ADR-0006 §2). Passed
     * only when the run opted in (`RunOptions.publishArtifacts`); when
     * `undefined`, `publishArtifact` is omitted from the returned ctx
     * entirely (not wired as a no-op) so a tool can cheaply skip building an
     * artifact it isn't allowed to publish.
     */
    onArtifact?: (artifact: RenderArtifact) => void;
    /**
     * §5 (#521): the per-dispatch cooperative cancellation channel — see
     * `_toolDispatchSignal`. Forwarded onto `ToolExecutionContext.signal`
     * only when present (own-property check, not a key valued `undefined`)
     * so `Object.hasOwn(ctx, "signal")` is `false` whenever `toolMs` is
     * unset for this run.
     */
    signal?: AbortSignal;
  }): ToolExecutionContext {
    return {
      runId: a.runId,
      traceId: a.traceId,
      parentToolCallId: a.parentToolCallId,
      host: a.host, // #124 — the single copy site
      ...(a.onArtifact ? { publishArtifact: a.onArtifact } : {}),
      ...(a.signal ? { signal: a.signal } : {}),
      // Channel B (secondary): a non-agent tool's only progress-reporting path.
      // Fire-and-forget — never let a tool author await bus/gate plumbing, and
      // never let a publish failure (sync OR async) surface into the tool's
      // own execution; the whole body is guarded, not just the promise, since
      // `createEvent`/`publish` could throw synchronously before returning a
      // promise to `.catch()`. NOTE: because it's fire-and-forget, a progress
      // event may settle AFTER the tool's own `agent.tool.end` — there is no
      // ordering guarantee between Channel B and the tool's own lifecycle.
      emit: (e) => {
        try {
          // #421 memory-event passthrough: the #420 write/search vocabulary
          // reaches the bus TYPED instead of being coerced to progress.
          // Correlation fields are spread LAST, and spanId is forced undefined,
          // so `e.data` can never override them.
          // The `as never` is the one localized cast this requires —
          // `ToolEvent.data` is `Record<string, unknown>`, but the sole
          // producer is MemoryToolbox, whose payloads are constructed against
          // the typed event interfaces (and pinned by its tests). No runtime
          // validation here — `emit` is the fire-and-forget sink (#99
          // non-throw contract). `agent.memory.recall` is deliberately NOT
          // bridged: it is host-side (#422), never tool-side.
          if (e.type === "agent.memory.write" || e.type === "agent.memory.search") {
            void a.bus
              .publish(
                createEvent(e.type, {
                  ...(e.data ?? {}),
                  traceId: a.traceId,
                  runId: a.runId,
                  parentSpanId: a.parentSpanId,
                  toolCallId: a.parentToolCallId,
                  // spanId is this event's own identity, never the tool's to
                  // set — forcing it undefined makes createEvent generate a
                  // fresh one (`data.spanId ?? generateId()`).
                  spanId: undefined,
                } as never),
              )
              .catch(() => {});
            return;
          }
          void a.bus
            .publish(
              createEvent("agent.tool.progress", {
                traceId: a.traceId,
                runId: a.runId,
                parentSpanId: a.parentSpanId,
                toolCallId: a.parentToolCallId,
                statusText: typeof e.data?.statusText === "string" ? e.data.statusText : e.type,
                progress: typeof e.data?.progress === "number" ? e.data.progress : undefined,
              }),
            )
            .catch(() => {
              // Swallow — emit is a best-effort sink (#99's non-throw contract).
            });
        } catch {
          // Swallow a SYNCHRONOUS throw too (e.g. from createEvent) — same
          // non-throw contract as the async catch above.
        }
      },
    };
  }

  /** Shared host-bag narrowing — see `runner/render-ctx.ts` (#308/#444). */
  private _renderCtx(options?: RunOptions): RenderContext | undefined {
    return narrowRenderCtx(options);
  }

  /**
   * Bifrost gateway awareness (#407), part 1: classify a thrown error and
   * emit the (possibly enriched) `agent.error` — and, when it's a
   * {@link BifrostGuardrailViolationError}, an `agent.guardrail.violation`
   * FIRST. Both events are emitted here (not just constructed) so every
   * caller — generator or not — gets identical emission; generator callers
   * (`stream()`) additionally `yield` the returned event objects themselves
   * (never re-`createEvent` them) to keep the emitted and yielded instances
   * identical.
   *
   * Returns the typed error to rethrow when classification hit, or the
   * original `e` otherwise — classification never changes control flow, only
   * what gets thrown and what the `agent.error` context carries.
   */
  private async _gatewayAwareError(
    e: unknown,
    scope: { bus: AgentEventBus; traceId: string; runId: string; parentSpanId?: string },
  ): Promise<{ error: unknown; violationEvent?: GuardrailViolationEvent; errorEvent: ErrorEvent }> {
    const classified = classifyBifrostError(e);

    let violationEvent: GuardrailViolationEvent | undefined;
    if (classified instanceof BifrostGuardrailViolationError) {
      // TRUST BOUNDARY (Gate 2.5 quality note): prefer a structured summary
      // over Bifrost's free-text message on this widely-surfaced event —
      // the free text is provider-authored prose, not guaranteed
      // redaction-safe the way the counts-only redaction channel is. Falls
      // back to the (capped) raw message only when no structured field is
      // available to summarize from. See providers/bifrost.ts's
      // MAX_ERROR_MESSAGE_LENGTH doc comment.
      violationEvent = createEvent("agent.guardrail.violation", {
        traceId: scope.traceId,
        runId: scope.runId,
        parentSpanId: scope.parentSpanId,
        action: "blocked",
        message: violationSummaryMessage(classified) ?? truncateMessage(classified.message),
        ...(classified.statusCode !== undefined ? { statusCode: classified.statusCode } : {}),
        ...(classified.bifrostType !== undefined ? { bifrostType: classified.bifrostType } : {}),
        ...(classified.guardrailId !== undefined ? { guardrailId: classified.guardrailId } : {}),
        ...(classified.category !== undefined ? { category: classified.category } : {}),
        ...(classified.severity !== undefined ? { severity: classified.severity } : {}),
        ...(classified.provider !== undefined ? { provider: classified.provider } : {}),
      });
      await scope.bus.publish(violationEvent);
    }

    const err: Error = classified ?? (e instanceof Error ? e : new Error(String(e)));
    const errorEvent = createEvent("agent.error", {
      traceId: scope.traceId,
      runId: scope.runId,
      parentSpanId: scope.parentSpanId,
      errorType: err.name,
      // TRUST BOUNDARY (Gate 2.5 quality note): capped defensively — this is
      // the lower-level, less widely-surfaced sibling of the violation event
      // above, which prefers a structured summary instead. Surfacing the
      // provider's raw error message here is pre-existing generic-error
      // behavior (unchanged for non-Bifrost errors); the cap is new.
      message: truncateMessage(err.message),
      recoverable: false,
      context: classified
        ? {
            ...(classified.statusCode !== undefined ? { statusCode: classified.statusCode } : {}),
            ...(classified.bifrostType !== undefined
              ? { bifrostType: classified.bifrostType }
              : {}),
            ...(classified.provider !== undefined ? { provider: classified.provider } : {}),
            ...(classified instanceof BifrostGuardrailViolationError
              ? {
                  ...(classified.guardrailId !== undefined
                    ? { guardrailId: classified.guardrailId }
                    : {}),
                  ...(classified.category !== undefined ? { category: classified.category } : {}),
                  ...(classified.severity !== undefined ? { severity: classified.severity } : {}),
                  ...(classified.action !== undefined ? { action: classified.action } : {}),
                }
              : {}),
          }
        : {},
    });
    await scope.bus.publish(errorEvent);

    return { error: classified ?? e, violationEvent, errorEvent };
  }

  /**
   * Bifrost gateway awareness (#407), part 2: detect in-band redaction on a
   * gateway response and emit ONE `agent.guardrail.redaction` when either
   * signal fires. No-ops for any non-gateway model (same gate as
   * `bifrostCorrelationHeaders`: `modelProvider.startsWith("gateway.")`).
   *
   * Two independent signals: {@link scanRedactionPlaceholders} (permissive —
   * see its doc comment's false-positive caveat) and
   * {@link hasBifrostRedactionMetadata} (PROVISIONAL, docs-derived
   * confirmation via `bifrostMetadataExtractor`'s output). `source` records
   * which fired — dashboard consumers should prefer gating any user-visible
   * "redacted" badge on `source !== "placeholders"` (metadata-confirmed)
   * rather than trusting a placeholder-only hit at face value.
   */
  private async _maybeEmitRedaction(
    text: string,
    providerMetadata: unknown,
    scope: {
      bus: AgentEventBus;
      traceId: string;
      runId: string;
      parentSpanId?: string;
      modelProvider: string;
    },
  ): Promise<GuardrailRedactionEvent | undefined> {
    if (!scope.modelProvider.startsWith("gateway.")) return undefined;

    const placeholderCounts = scanRedactionPlaceholders(text);
    const metadataConfirmed = hasBifrostRedactionMetadata(providerMetadata);
    if (!placeholderCounts && !metadataConfirmed) return undefined;

    const source: "placeholders" | "metadata" | "both" = placeholderCounts
      ? metadataConfirmed
        ? "both"
        : "placeholders"
      : "metadata";
    const entities = placeholderCounts ?? {};
    const totalEntities = Object.values(entities).reduce((n, c) => n + c, 0);
    const attribution = attributionFromProviderMetadata(providerMetadata);

    const event = createEvent("agent.guardrail.redaction", {
      traceId: scope.traceId,
      runId: scope.runId,
      parentSpanId: scope.parentSpanId,
      entities,
      totalEntities,
      source,
      ...(attribution?.provider !== undefined ? { provider: attribution.provider } : {}),
    });
    await scope.bus.publish(event);
    return event;
  }

  /**
   * Convert agent tools to the Vercel AI SDK tool format.
   *
   * The SDK's tool schema field is `inputSchema` (renamed from `parameters` at
   * v5; unchanged through v7). Core's `ToolSchema.toVercelAI()` still returns
   * `{ description, parameters }`, so we do the rename here at the runner
   * boundary (core stays `ai`-free).
   *
   * NOTE (gate-chain invariant): tools are intentionally `execute`-less — the
   * SDK never runs them; dispatch goes through the gate chain + `toolExecutor`.
   */
  private convertTools(agent: AgentLike, _executor?: ToolExecutor): ToolSet {
    // AgentLike.getTools() returns unknown[] at the protocol boundary;
    // AgentRunner knows real agents produce ToolSchema[] and narrows here.
    const agentTools = agent.getTools() as ToolSchema[];
    if (agentTools.length === 0) return {};

    const tools: ToolSet = {};
    for (const t of agentTools) {
      const vercel = t.toVercelAI();
      // Build via `tool()` WITHOUT an `execute` (gate-chain invariant): the SDK
      // exposes the schema to the model but never runs the tool. core's
      // `toVercelAI().parameters` is a Zod schema → a valid `inputSchema`.
      tools[t.name] = tool({
        description: vercel.description,
        inputSchema: vercel.parameters,
      });
    }
    return tools;
  }

  async run(agent: AgentLike, message: string, options?: RunOptions): Promise<RunResult> {
    // #496: resolved once for THIS call, closed over below — never rebinds
    // the runner. See busFor for the fallback order and the #288 semantics
    // of emitIntent.
    const bus = this.busFor(options);
    const emit = (event: AgentEvent) => bus.publish(event);
    const emitIntent = async (event: AgentEvent) =>
      (await bus.evaluateIntent(event as ToolCallIntent)).outcome === "allow";

    // #437: honor a caller-provided correlation id (AP-29 F1) — parity with
    // NodeBackedRunner and CodingAgentRunner. Minted only when absent.
    const runId = options?.runId ?? generateId();
    const effectiveTraceId = options?.traceId ?? runId;
    const maxIterations = options?.maxIterations ?? 10;
    const toolExecutor = options?.toolExecutor;

    // Resolve the agent's declared model to a live model for this run. With a
    // resolver-backed runner this honours agent.getModel() (the model belongs to
    // the agent); with the back-compat constant resolver it returns the pinned
    // model and ignores the id. Event attribution uses the *resolved* model's
    // modelId — the id actually dispatched.
    const model = await this._resolver.resolve(agent.getModel());
    const modelName = model.modelId;
    // #406: computed once per run (context is stable within a run), reused
    // across iterations below.
    const callHeaders = this._resolveCallHeaders(agent, model, runId, effectiveTraceId, options);
    // #514: computed once per run, reused across iterations below (parity
    // with callHeaders).
    const callParams = this._resolveCallParams(modelName, options);
    // #521: computed once per run, reused across iterations below (parity
    // with callParams/callHeaders).
    const modelTimeout = this._resolveModelTimeout(options);
    // #521: `options.abortSignal` composed with a derived `runMs` deadline —
    // see `_resolveEffectiveSignal`'s doc. `runSignal` feeds the reason
    // discrimination at the shared cancelled return below; absent `runMs`
    // makes `effectiveSignal` byte-identical to `options?.abortSignal`.
    const { effectiveSignal, runSignal } = this._resolveEffectiveSignal(options);
    const agentTools = agent.getTools() as ToolSchema[];
    const tools = this.convertTools(agent, toolExecutor);
    const hasTools = agentTools.length > 0;
    // Terminal tools (ToolDefinition.terminal): a successful call ends the loop —
    // the explicit exit for a raw tool-loop agent (vs the implicit "reply with
    // no tool call"). Resolved once; checked after each iteration's dispatch.
    const terminalTools = new Set(agentTools.filter((t) => t.terminal === true).map((t) => t.name));
    // #352: name -> declared render hint (ToolSchema.displayType), for the
    // tool.start/tool.end stamp below. Same resolve-once-by-name precedent as
    // terminalTools.
    const displayTypes = new Map(
      agentTools.flatMap((t) =>
        t.displayType !== undefined ? [[t.name, t.displayType] as const] : [],
      ),
    );

    // #117: hoisted above the start event (was after it) so message.start can
    // stamp systemPrompt — renderInitialPrompt() is a pure render, hoisting is safe.
    const instructions = agent.renderInitialPrompt(this._renderCtx(options));

    // Emit message start event (root of the trace)
    const startEvent = createEvent("agent.message.start", {
      traceId: effectiveTraceId,
      runId,
      parentSpanId: options?.parentSpanId,
      agentName: agent.role.name,
      agentConfig: {
        role: agent.role.name,
        model: modelName,
        tools: agentTools.map((t) => t.name),
      },
      systemPrompt: instructions,
      trigger: options?.trigger,
    });
    const rootSpanId = startEvent.spanId;
    await emit(startEvent);

    // Build initial messages from history
    const messages: ModelMessage[] = [];
    if (options?.messageHistory) {
      messages.push(...convertHistory(options.messageHistory));
    }
    messages.push({ role: "user" as const, content: message });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    // #388: run-level cache/reasoning detail accumulator — absent ≠ zero,
    // see mergeUsageDetails.
    let totalUsageDetails: TokenUsageDetails | undefined;
    let totalToolCalls = 0;
    // BOUNDED COMPLETION: how many iterations have ended with an ERRORED
    // terminal call. The first one CONTINUES (the model sees the error and
    // gets one chance to correct — see the exit check below); the second ends
    // the run as `terminal_tool_error` instead of burning to max_iterations.
    let terminalErrorCount = 0;
    // #341 amendment: which iteration (if any) observed an already-fired
    // abortSignal at its top, before this run() bothered to describe it any
    // further below.
    let cancelledAtIteration: number | undefined;
    // #521: which reason the cancellation above discriminates to — set
    // alongside `cancelledAtIteration` at every guard/catch site that can
    // trigger it; defaulted to "cancelled" (the pre-#521 constant) so a run
    // with no `runMs` is byte-identical. See `_cancelReason`'s doc.
    let cancelledReason: "cancelled" | "timeout" = "cancelled";
    // #407: the most recently observed gateway attribution (last LLM call
    // that reported one) — threaded onto every `RunResult` return below.
    let lastGatewayAttribution: GatewayAttribution | undefined;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Cheap cooperative-abort guard (#341 amendment): `run()` shares
      // `RunOptions` with `stream()` but has no generator to yield a cancel
      // event through — abortSignal must still never be silently ignored.
      // Checked at the TOP of every iteration (never mid-iteration) so a
      // signal that fires between iterations stops the loop before a
      // redundant `agent.llm.start`, without interrupting an in-flight
      // `generateText` call. Falls through to the shared post-loop return
      // below (finishReason: discriminated reason, #521) — never throws.
      // #521: checks the EFFECTIVE signal (caller's `abortSignal` composed
      // with a derived `runMs` deadline) — see `_resolveEffectiveSignal`.
      if (effectiveSignal?.aborted) {
        cancelledAtIteration = iteration;
        cancelledReason = this._cancelReason(options, runSignal);
        break;
      }

      // Emit iteration start
      const iterStart = createEvent("agent.iteration.start", {
        traceId: effectiveTraceId,
        runId,
        parentSpanId: rootSpanId,
        iteration,
        maxIterations,
      });
      const iterSpanId = iterStart.spanId;
      await emit(iterStart);

      // Emit LLM call start
      const llmStart = createEvent("agent.llm.start", {
        traceId: effectiveTraceId,
        runId,
        parentSpanId: iterSpanId,
        model: modelName,
        messageCount: messages.length + 1, // +1 for instructions
        hasTools,
      });
      const llmSpanId = llmStart.spanId;
      await emit(llmStart);

      const llmStartTime = Date.now();

      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        // GATE-CHAIN INVARIANT: no `maxSteps`/`stopWhen` — v7 single-step is the
        // default. Tools are `execute`-less so the SDK can't run/loop them; we
        // dispatch through the gate chain + toolExecutor below.
        result = await generateText({
          model,
          instructions,
          messages,
          tools: hasTools ? tools : undefined,
          // #504/#521: forwarded so an abort (explicit OR a runMs-derived
          // deadline) actually interrupts the in-flight provider call (stops
          // token burn) instead of waiting for the top-of-iteration check
          // above.
          abortSignal: effectiveSignal,
          headers: callHeaders,
          ...callParams,
          // #521: native SDK timeout — `{stepMs}` uniformly (§2); absent
          // when `timeout.modelMs` is unset, so no `timeout` key reaches the
          // call.
          ...(modelTimeout ? { timeout: modelTimeout } : {}),
        });
      } catch (e: unknown) {
        const llmDuration = Date.now() - llmStartTime;
        // #504/#521: our own forwarded (possibly composed) signal aborted the
        // call mid-flight — a cancel, not a failure. Close the LLM span
        // honestly and fall into the shared cancelled return below (D1
        // posture: run() never throws on abort). No `agent.error`, no
        // gateway classification. `agent.llm.end.finishReason` stays the
        // literal "cancelled" here (§4: pinned, no new event vocabulary) —
        // only the RunResult/terminal message.complete carry the
        // discriminated reason, below.
        if (isAbortRejection(e, effectiveSignal)) {
          await emit(
            createEvent("agent.llm.end", {
              traceId: effectiveTraceId,
              runId,
              spanId: llmSpanId,
              parentSpanId: iterSpanId,
              model: modelName,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: llmDuration,
              hasToolCalls: false,
              finishReason: "cancelled",
            }),
          );
          cancelledAtIteration = iteration;
          cancelledReason = this._cancelReason(options, runSignal);
          break;
        }
        await emit(
          createEvent("agent.llm.end", {
            traceId: effectiveTraceId,
            runId,
            spanId: llmSpanId,
            parentSpanId: iterSpanId,
            model: modelName,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: llmDuration,
            hasToolCalls: false,
            finishReason: "error",
          }),
        );
        const { error } = await this._gatewayAwareError(e, {
          bus,
          traceId: effectiveTraceId,
          runId,
          parentSpanId: iterSpanId,
        });
        throw error;
      }

      const llmDuration = Date.now() - llmStartTime;

      // Track token usage. Usage fields are `inputTokens`/`outputTokens` (renamed
      // from promptTokens/completionTokens at v5; unchanged through v7), each
      // `number | undefined`. Each iteration is a single step, so `result.usage`
      // (last-step usage) is this iteration's usage; the run-level total the
      // events report is the accumulation below (equivalent to summing
      // result.usage per step).
      const iterInputTokens = result.usage?.inputTokens ?? 0;
      const iterOutputTokens = result.usage?.outputTokens ?? 0;
      totalInputTokens += iterInputTokens;
      totalOutputTokens += iterOutputTokens;
      // #388: absent ≠ zero — omit the field entirely when the provider
      // reported no detail members this iteration.
      const iterUsageDetails = detailsFromUsage(result.usage);
      totalUsageDetails = mergeUsageDetails(totalUsageDetails, iterUsageDetails);

      const resultToolCalls = result.toolCalls ?? [];
      const hasToolCalls = resultToolCalls.length > 0;

      // If the model produced reasoning (extended-thinking, o-series, etc.),
      // emit a single thinking.start + completed agent.reasoning pair. The
      // non-streaming path can't expose per-delta events, so one summary is
      // the faithful best-effort mapping. The SDK exposes the joined reasoning
      // as `result.reasoningText` (renamed from `result.reasoning` at v5;
      // unchanged through v7).
      const reasoningContent = result.reasoningText;
      if (reasoningContent && reasoningContent.length > 0) {
        await emit(
          createEvent("agent.thinking.start", {
            traceId: effectiveTraceId,
            runId,
            parentSpanId: llmSpanId,
          }),
        );
        await emit(
          createEvent("agent.reasoning", {
            traceId: effectiveTraceId,
            runId,
            content: reasoningContent,
            isComplete: true,
          }),
        );
      }

      // #407: which provider actually served this call, when the gateway's
      // metadataExtractor reported one — threaded onto llm.end below and the
      // run-level RunResult return.
      const iterGatewayAttribution = attributionFromProviderMetadata(result.providerMetadata);
      if (iterGatewayAttribution) lastGatewayAttribution = iterGatewayAttribution;

      // Emit LLM call end
      await emit(
        createEvent("agent.llm.end", {
          traceId: effectiveTraceId,
          runId,
          spanId: llmSpanId,
          parentSpanId: iterSpanId,
          model: modelName,
          inputTokens: iterInputTokens,
          outputTokens: iterOutputTokens,
          durationMs: llmDuration,
          hasToolCalls,
          finishReason: hasToolCalls ? "tool_calls" : (result.finishReason ?? "stop"),
          ...(iterUsageDetails ? { usageDetails: iterUsageDetails } : {}),
          ...(iterGatewayAttribution ? { gateway: iterGatewayAttribution } : {}),
        }),
      );

      // #407: one redaction scan per LLM call — no-ops for non-gateway models.
      await this._maybeEmitRedaction(result.text ?? "", result.providerMetadata, {
        bus,
        traceId: effectiveTraceId,
        runId,
        parentSpanId: iterSpanId,
        modelProvider: model.provider,
      });

      // No tool calls = done
      if (!hasToolCalls) {
        const content = result.text ?? "";

        // Emit iteration end
        await emit(
          createEvent("agent.iteration.end", {
            traceId: effectiveTraceId,
            runId,
            spanId: iterSpanId,
            parentSpanId: rootSpanId,
            iteration,
            toolCallsCount: 0,
            hasMore: false,
          }),
        );

        // Emit message complete
        await emit(
          createEvent("agent.message.complete", {
            traceId: effectiveTraceId,
            runId,
            spanId: rootSpanId,
            parentSpanId: rootSpanId,
            content,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            model: modelName,
            finishReason: result.finishReason ?? "stop",
            ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
          }),
        );

        return {
          response: content,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          toolCallsCount: totalToolCalls,
          iterations: iteration + 1,
          finishReason: result.finishReason ?? "stop",
          ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
          ...(lastGatewayAttribution ? { gateway: lastGatewayAttribution } : {}),
        };
      }

      // Has tool calls — execute them in parallel. TypedToolCall carries the
      // call payload under `.input` (renamed from `.args` at v5; unchanged
      // through v7).
      for (const tc of resultToolCalls) {
        const intent = createEvent("agent.tool.intent", {
          traceId: effectiveTraceId,
          runId,
          parentSpanId: iterSpanId,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          arguments: tc.input as Record<string, unknown>,
        });
        const allowed = await emitIntent(intent);
        if (!allowed) {
          throw new ToolCallBlocked(tc.toolName, "Blocked by gate");
        }
      }

      // Parallel tool execution
      const toolResults = await Promise.all(
        resultToolCalls.map(async (tc) => {
          const tcStart = createEvent("agent.tool.start", {
            // #102 fix (Gate 2.5 blocker): stamp the tool call's OWN spanId
            // with its toolCallId (not a fresh generateId()). node-tool.ts
            // anchors a nested sub-agent's root at `parentSpanId ===
            // parentToolCallId`; span exporters (otel.ts, langfuse.ts) key
            // strictly by `event.spanId`, so unless `tcSpanId === toolCallId`
            // the child resolves to no known span and becomes an orphan root.
            spanId: tc.toolCallId,
            traceId: effectiveTraceId,
            runId,
            parentSpanId: iterSpanId,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            arguments: tc.input as Record<string, unknown>,
            ...(displayTypes.has(tc.toolName)
              ? { displayType: displayTypes.get(tc.toolName) }
              : {}),
          });
          const tcSpanId = tcStart.spanId;
          await emit(tcStart);

          const startTime = Date.now();
          let toolResult: unknown;
          let errorMsg: string | undefined;
          // ADR-0006 §2: collected only when this run opted in
          // (`RunOptions.publishArtifacts`) — see `onArtifact` below.
          const publishedArtifacts: RenderArtifact[] = [];

          try {
            if (toolExecutor) {
              // #521 §5: freshly minted PER DISPATCH — each tool call gets
              // its own `toolMs` budget, never a shared per-run timer.
              const toolMs = options?.timeout?.toolMs;
              const dispatchSignal = this._toolDispatchSignal(toolMs, effectiveSignal);
              const execPromise = toolExecutor.execute(
                tc.toolName,
                tc.input as Record<string, unknown>,
                this.buildToolCtx({
                  bus,
                  traceId: effectiveTraceId,
                  runId,
                  parentToolCallId: tc.toolCallId,
                  parentSpanId: tcSpanId,
                  host: options?.host,
                  onArtifact: options?.publishArtifacts
                    ? (a) => publishedArtifacts.push(a)
                    : undefined,
                  signal: dispatchSignal,
                }),
              );
              // #521 §3: hand-rolled race, REJECTS on expiry (never
              // resolves) so the existing catch below produces the
              // structured `{error}` + `errorMsg` shape at zero further
              // change.
              toolResult =
                toolMs !== undefined
                  ? await withToolTimeout(execPromise, toolMs, tc.toolName)
                  : await execPromise;
            } else {
              toolResult = { error: "No tool executor configured" };
              errorMsg = "No tool executor configured";
            }
          } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            toolResult = { error: err.message };
            errorMsg = err.message;
          }

          const durationMs = Date.now() - startTime;
          totalToolCalls++;

          await emit(
            createEvent("agent.tool.end", {
              traceId: effectiveTraceId,
              runId,
              spanId: tcSpanId,
              parentSpanId: iterSpanId,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              arguments: tc.input as Record<string, unknown>,
              result: toolResult,
              error: errorMsg,
              durationMs,
              resultTokens: 0,
              ...(displayTypes.has(tc.toolName)
                ? { displayType: displayTypes.get(tc.toolName) }
                : {}),
              ...(publishedArtifacts.length > 0 ? { artifacts: publishedArtifacts } : {}),
            }),
          );

          return {
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: toolResult,
            error: errorMsg,
          };
        }),
      );

      // TERMINAL-TOOL EXIT: a successful terminal call ends the loop — the
      // tool's result IS the run's final response (the explicit "I'm done"
      // verb; no structured emission needed). Every call in this iteration's
      // batch has already executed (side effects landed). An ERRORED terminal
      // call does not terminate: the model must see the error and correct.
      // First successful terminal call wins if a batch carries several.
      const terminalHit = toolResults.find(
        (tr) => terminalTools.has(tr.toolName) && tr.error === undefined,
      );
      if (terminalHit) {
        // ADR-0006 §9: `content` stays byte-identical to before this ADR — a
        // string result passes through unchanged; a structured result is
        // still flattened to JSON for `content`/`response` (untouched
        // consumers keep working). `structuredContent` additionally carries
        // the un-flattened value so a client can render prose + data instead
        // of a stringified blob; absent entirely when the result was already
        // a string.
        const content =
          typeof terminalHit.result === "string"
            ? terminalHit.result
            : JSON.stringify(terminalHit.result ?? "");
        const structuredContent =
          terminalHit.result !== undefined && typeof terminalHit.result !== "string"
            ? terminalHit.result
            : undefined;

        await emit(
          createEvent("agent.iteration.end", {
            traceId: effectiveTraceId,
            runId,
            spanId: iterSpanId,
            parentSpanId: rootSpanId,
            iteration,
            toolCallsCount: resultToolCalls.length,
            hasMore: false,
          }),
        );

        await emit(
          createEvent("agent.message.complete", {
            traceId: effectiveTraceId,
            runId,
            spanId: rootSpanId,
            parentSpanId: rootSpanId,
            content,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            model: modelName,
            finishReason: "terminal_tool",
            ...(structuredContent !== undefined ? { structuredContent } : {}),
            ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
          }),
        );

        return {
          response: content,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          toolCallsCount: totalToolCalls,
          iterations: iteration + 1,
          finishReason: "terminal_tool",
          ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
        };
      }

      // BOUNDED COMPLETION: no terminal call SUCCEEDED this iteration — but did
      // one ERROR? The pinned design keeps the first errored terminal call
      // going (the model sees the error and corrects; the fall-through below
      // appends the error into the transcript). But an errored terminal that
      // recurs must not silently burn every remaining iteration and return an
      // empty "max_iterations" response — a lost summary + a wasted budget that
      // reads as a hang at high maxIterations. On the SECOND errored terminal
      // attempt we end the run cleanly as `terminal_tool_error`, surfacing the
      // error text as the response.
      const terminalError = toolResults.find(
        (tr) => terminalTools.has(tr.toolName) && tr.error !== undefined,
      );
      if (terminalError) {
        terminalErrorCount++;
        if (terminalErrorCount >= 2) {
          const errText = terminalError.error ?? "unknown error";

          await emit(
            createEvent("agent.iteration.end", {
              traceId: effectiveTraceId,
              runId,
              spanId: iterSpanId,
              parentSpanId: rootSpanId,
              iteration,
              toolCallsCount: resultToolCalls.length,
              hasMore: false,
            }),
          );

          await emit(
            createEvent("agent.message.complete", {
              traceId: effectiveTraceId,
              runId,
              spanId: rootSpanId,
              parentSpanId: rootSpanId,
              content: errText,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              model: modelName,
              finishReason: "terminal_tool_error",
              ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
            }),
          );

          return {
            response: `terminal tool "${terminalError.toolName}" failed: ${errText}`,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            toolCallsCount: totalToolCalls,
            iterations: iteration + 1,
            finishReason: "terminal_tool_error",
            ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
          };
        }
      }

      // Append messages for next iteration.
      //
      // ★ THOUGHT-SIGNATURE / REASONING ROUND-TRIP: append the SDK's own
      // assistant message(s) VERBATIM via `result.response.messages` instead of
      // hand-rebuilding `{ role: "assistant", content: [...] }`. Those messages
      // carry `providerOptions`/`providerMetadata` (Gemini's `thoughtSignature`,
      // Anthropic thinking blocks). Dropping them — as the old hand-rebuild did —
      // breaks Gemini 3.x multi-turn tool loops with "function call is missing a
      // thought_signature". This is the whole point of the v5 migration.
      messages.push(...sanitizeResponseMessages(result.response.messages));

      // Our own tool results (we ran the tools, not the SDK). ToolResultPart
      // carries the result under `output` as a typed union (since v5;
      // unchanged through v7).
      messages.push({
        role: "tool" as const,
        content: toolResults.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          output: { type: "json" as const, value: toJsonValue(tr.result) },
        })),
      });

      // Emit iteration end
      await emit(
        createEvent("agent.iteration.end", {
          traceId: effectiveTraceId,
          runId,
          spanId: iterSpanId,
          parentSpanId: rootSpanId,
          iteration,
          toolCallsCount: resultToolCalls.length,
          hasMore: true,
        }),
      );
    }

    // #341 amendment: the loop above broke early on an already-fired
    // abortSignal — return (never throw), matching D1's posture generalized
    // to run(). No message.cancel/conversation.end pair here (run() has no
    // conversationId — that pairing is Conversation.stream's / stream()'s
    // concern) — a `message.complete` with an honest finishReason is enough
    // for every existing collector/exporter to finalize the run cleanly.
    // #521 §4: BOTH the terminal `message.complete.finishReason` and the
    // returned `RunResult.finishReason` carry `cancelledReason` — "cancelled"
    // (explicit abort, or no `runMs`) or "timeout" (`runMs` deadline, caller
    // didn't also fire) — so `RunStoreExporter`'s persisted row and the
    // caller's return value always agree.
    if (cancelledAtIteration !== undefined) {
      await emit(
        createEvent("agent.message.complete", {
          traceId: effectiveTraceId,
          runId,
          spanId: rootSpanId,
          parentSpanId: rootSpanId,
          content: "",
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          model: modelName,
          finishReason: cancelledReason,
          ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
        }),
      );

      return {
        response: "",
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolCallsCount: totalToolCalls,
        iterations: cancelledAtIteration,
        finishReason: cancelledReason,
        ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
        ...(lastGatewayAttribution ? { gateway: lastGatewayAttribution } : {}),
      };
    }

    // Max iterations exceeded — #117: emit a terminal message.complete (the
    // loop above only ever emits it on the !hasToolCalls early return; without
    // this, a bus-finish hook like RunStoreExporter has no terminal event to
    // finalize on and the run row stays 'running' forever).
    await emit(
      createEvent("agent.message.complete", {
        traceId: effectiveTraceId,
        runId,
        spanId: rootSpanId,
        parentSpanId: rootSpanId,
        content: "",
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        model: modelName,
        finishReason: "max_iterations",
        ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
      }),
    );

    return {
      response: "",
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolCallsCount: totalToolCalls,
      iterations: maxIterations,
      finishReason: "max_iterations",
      ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
      ...(lastGatewayAttribution ? { gateway: lastGatewayAttribution } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // runStructured() — capability-gated structured output (DESIGN §9.4)
  // ---------------------------------------------------------------------------

  /**
   * Build the agent's tools WITH an `execute` function for the single-call
   * capable path. Unlike {@link convertTools} (execute-less, gate-chain
   * invariant), here the SDK DOES drive the tool loop — so gate interception
   * is preserved via `toolApproval` (see `tool-approval-bridge.ts`), NOT a
   * pre-check inside `execute`: the `toolApproval` callback passed alongside
   * these tools is where `AgentEventBus.evaluateIntent` runs, once, before
   * the SDK ever calls `execute` for a given call (#389, D0/Option C — moving
   * the evaluation out of `execute` is what keeps the gate chain from running
   * TWICE per call). `execute` here only dispatches — via `toolExecutor` +
   * event emission — a call `toolApproval` has already cleared.
   *
   * `overlay` is the rewrite overlay `toolApproval` populates on a `modify`
   * gate decision (a NEW capability on this path — the SDK's `toolApproval`
   * API has no rewrite affordance of its own); `execute` consults it via
   * `overlay.take(toolCallId)` so a rewritten call actually EXECUTES with the
   * gate's rewritten args, even though the model's message history (and the
   * SDK's own `input`) still shows the original ones.
   */
  private convertExecutableTools(
    agent: AgentLike,
    toolExecutor: ToolExecutor | undefined,
    overlay: ToolArgsOverlay,
    ctx: {
      bus: AgentEventBus;
      traceId: string;
      runId: string;
      parentSpanId: string;
      host?: unknown;
      publishArtifacts?: boolean;
      /**
       * #521 §5: per-tool-dispatch budget for THIS run — threaded through so
       * the in-closure `execute` below (the one dispatch site the SDK itself
       * invokes) composes `ctx.signal` + `withToolTimeout` identically to
       * `run()`/`stream()`'s hand-rolled dispatch sites.
       */
      toolMs?: number;
      /** #521 §4/§5: this run's effective abort signal — composed with a
       * fresh per-dispatch `AbortSignal.timeout(toolMs)` via
       * `_toolDispatchSignal` below. */
      effectiveSignal?: AbortSignal;
    },
  ): ToolSet {
    const agentTools = agent.getTools() as ToolSchema[];
    if (agentTools.length === 0) return {};

    const tools: ToolSet = {};
    for (const t of agentTools) {
      const vercel = t.toVercelAI();
      const toolName = t.name;
      tools[toolName] = tool({
        description: vercel.description,
        inputSchema: vercel.parameters,
        execute: async (input: unknown, toolOpts: { toolCallId: string }) => {
          // The SDK's OWN toolCallId (not a freshly generated one) — matches
          // what `toolApproval` already evaluated against, so span anchoring
          // (#102) and the rewrite overlay both key on the same id.
          const toolCallId = toolOpts.toolCallId;
          // Rewritten args win when a `modify` gate decision produced them
          // (the overlay carries byte-identical args back when nothing
          // rewrote the call — see tool-approval-bridge.ts); the SDK's own
          // `input` is the fallback for the (unreachable in practice) case
          // where `toolApproval` wasn't reached for this call.
          const args = overlay.take(toolCallId) ?? ((input ?? {}) as Record<string, unknown>);

          const tcStart = createEvent("agent.tool.start", {
            // #102 fix: see the sibling dispatch site's comment — stamp
            // spanId with the toolCallId so span exporters can resolve a
            // nested sub-agent's `parentSpanId === parentToolCallId` anchor.
            spanId: toolCallId,
            traceId: ctx.traceId,
            runId: ctx.runId,
            parentSpanId: ctx.parentSpanId,
            toolCallId,
            toolName,
            arguments: args,
            ...(t.displayType !== undefined ? { displayType: t.displayType } : {}),
          });
          const tcSpanId = tcStart.spanId;
          await ctx.bus.publish(tcStart);

          const startTime = Date.now();
          let toolResult: unknown;
          let errorMsg: string | undefined;
          // ADR-0006 §2: collected only when this run opted in.
          const publishedArtifacts: RenderArtifact[] = [];
          try {
            if (toolExecutor) {
              // #521 §5: freshly minted PER DISPATCH, same as the other two
              // sites.
              const dispatchSignal = this._toolDispatchSignal(ctx.toolMs, ctx.effectiveSignal);
              const execPromise = toolExecutor.execute(
                toolName,
                args,
                this.buildToolCtx({
                  bus: ctx.bus,
                  traceId: ctx.traceId,
                  runId: ctx.runId,
                  parentToolCallId: toolCallId,
                  parentSpanId: tcSpanId,
                  host: ctx.host,
                  onArtifact: ctx.publishArtifacts ? (a) => publishedArtifacts.push(a) : undefined,
                  signal: dispatchSignal,
                }),
              );
              // #521 §3: one consistent hand-rolled expiry surface across all
              // three dispatch sites — deliberately NOT the SDK's native
              // `timeout.toolMs` here (that would only cover this one path,
              // with SDK-owned rejection semantics — divergence for no gain).
              toolResult =
                ctx.toolMs !== undefined
                  ? await withToolTimeout(execPromise, ctx.toolMs, toolName)
                  : await execPromise;
            } else {
              toolResult = { error: "No tool executor configured" };
              errorMsg = "No tool executor configured";
            }
          } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            toolResult = { error: err.message };
            errorMsg = err.message;
          }

          await ctx.bus.publish(
            createEvent("agent.tool.end", {
              traceId: ctx.traceId,
              runId: ctx.runId,
              spanId: tcSpanId,
              parentSpanId: ctx.parentSpanId,
              toolCallId,
              toolName,
              arguments: args,
              result: toolResult,
              error: errorMsg,
              durationMs: Date.now() - startTime,
              resultTokens: 0,
              ...(t.displayType !== undefined ? { displayType: t.displayType } : {}),
              ...(publishedArtifacts.length > 0 ? { artifacts: publishedArtifacts } : {}),
            }),
          );

          return toJsonValue(toolResult);
        },
      });
    }
    return tools;
  }

  async runStructured<T>(
    agent: AgentLike,
    message: string,
    schema: ZodType<T>,
    options?: RunOptions,
  ): Promise<StructuredRunResult<T>> {
    // Fail LOUD before any LLM call: open-object schemas (z.record /
    // .passthrough() / .catchall() / z.map) silently decode to {} on
    // schema-subset providers (Gemini responseSchema, OpenAI strict).
    // See schema-guard.ts; RunOptions.allowOpenObjectSchemas downgrades
    // the error to a once-per-schema warning.
    guardOpenObjectSchemas(schema, options?.allowOpenObjectSchemas);

    // #521: computed once per call, reused across the single-call / capable /
    // 2-tier paths below (parity with `callParams`/`callHeaders`, resolved
    // further down). `effectiveSignal` is what every guard/provider-call
    // below observes; `runSignal`/`deadlineAt` feed reason discrimination and
    // the tier-1 remaining-budget arithmetic respectively.
    const modelTimeout = this._resolveModelTimeout(options);
    const { effectiveSignal, runSignal, deadlineAt } = this._resolveEffectiveSignal(options);

    // Cheap cooperative-abort guard (#341 amendment): checked before any LLM
    // call — abortSignal must never be silently ignored on any RunOptions
    // path. runStructured() has no iteration loop of its own outside the
    // 2-tier fallback's delegate to run() (guarded below, where tier1 can
    // itself come back cancelled); this is the "top of iteration" check for
    // everything before that delegate. Unlike run()/stream(), there is no
    // schema-valid `object` to fabricate on abort, so this throws rather
    // than returning (see RunCancelledError's doc comment). #521: checks the
    // effective signal so an already-elapsed `runMs` (e.g. `runMs: 0`) is
    // caught here too.
    if (effectiveSignal?.aborted) {
      const reason = this._cancelReason(options, runSignal);
      throw new RunCancelledError(this._cancelledRunMessage(reason, "before the run started"));
    }

    // #496: resolved once for THIS call, closed over below — never rebinds
    // the runner. (No emitIntent here: gate evaluation on this path runs
    // inside the createGateToolApproval bridge, handed the same bus below.)
    const bus = this.busFor(options);
    const emit = (event: AgentEvent) => bus.publish(event);

    // #437: honor a caller-provided correlation id (AP-29 F1) — parity with run().
    const runId = options?.runId ?? generateId();
    const effectiveTraceId = options?.traceId ?? runId;
    const toolExecutor = options?.toolExecutor;

    const model = await this._resolver.resolve(agent.getModel());
    const modelName = model.modelId;
    // #406: computed once per run, reused across the single-call / capable /
    // 2-tier paths below.
    const callHeaders = this._resolveCallHeaders(agent, model, runId, effectiveTraceId, options);
    // #514: computed once per run (parity with callHeaders); also fires the
    // reasoningEffort advisory (once per run — see _resolveCallParams doc).
    const callParams = this._resolveCallParams(modelName, options);
    const agentTools = agent.getTools() as ToolSchema[];
    const hasTools = agentTools.length > 0;
    // Advisory-only (#390): warns once per (model x capability) when the map
    // knows something about the capability that actually governs THIS run's
    // path (toolsWithStructuredOutput when tools are present — the
    // single-call-vs-2-tier decision below; structuredOutput otherwise).
    // Never affects control flow — path selection below is unchanged and the
    // 2-tier fallback stays the always-correct path.
    adviseStructuredRun(modelName, hasTools);
    const instructions = agent.renderInitialPrompt(this._renderCtx(options));

    // Emit message start event (root of the trace), mirroring run().
    const startEvent = createEvent("agent.message.start", {
      traceId: effectiveTraceId,
      runId,
      parentSpanId: options?.parentSpanId,
      agentName: agent.role.name,
      agentConfig: {
        role: agent.role.name,
        model: modelName,
        tools: agentTools.map((t) => t.name),
      },
      systemPrompt: instructions,
      trigger: options?.trigger,
    });
    const rootSpanId = startEvent.spanId;
    await emit(startEvent);

    const messages: ModelMessage[] = [];
    if (options?.messageHistory) {
      messages.push(...convertHistory(options.messageHistory));
    }
    messages.push({ role: "user" as const, content: message });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    // #388: run-level cache/reasoning detail accumulator — absent ≠ zero.
    let totalUsageDetails: TokenUsageDetails | undefined;
    let toolCallsCount = 0;
    let iterations = 1;
    let finishReason = "stop";
    let rawObject: unknown;
    // #407: providerMetadata off whichever branch actually calls the
    // provider directly (no-tools / capable / 2-tier's tier-2 finish) — the
    // 2-tier's tier-1 delegates to `run()`, which already scans its own LLM
    // calls; this feeds the ONE post-validation scan below.
    let structuredProviderMetadata: unknown;

    // #504 (Gate 2.5): a cancelled structured run must still FINALIZE — the
    // terminal event is what lets a bus-finish hook like RunStoreExporter
    // close the run row (#495 posture: a row stuck 'running' is never what an
    // operator wants). Emitted with whatever accrued before each
    // RunCancelledError throw below; reads the accumulators at call time.
    const emitCancelledTerminal = async (): Promise<void> => {
      await emit(
        createEvent("agent.message.complete", {
          traceId: effectiveTraceId,
          runId,
          spanId: rootSpanId,
          parentSpanId: rootSpanId,
          content: "",
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          model: modelName,
          finishReason: "cancelled",
          ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
        }),
      );
    };

    if (!hasTools) {
      // No tools → single Output.object call. Works on every model.
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model,
          instructions,
          messages,
          output: Output.object({ schema }),
          // #504/#521: forwarded — an abort (explicit or runMs-derived)
          // interrupts the in-flight call.
          abortSignal: effectiveSignal,
          headers: callHeaders,
          ...callParams,
          // #521: native SDK `{stepMs}` timeout — true per-call bound here
          // (no tools on this path). Absent when `modelMs` is unset.
          ...(modelTimeout ? { timeout: modelTimeout } : {}),
        });
      } catch (e: unknown) {
        // #504/#521: a deliberate cancel (or runMs deadline) surfaces as
        // RunCancelledError (see the class doc — there is no schema-valid
        // object to fabricate), never a raw AbortError, and emits no
        // `agent.error`. A bare `modelMs` expiry with the effective signal
        // still unfired is NOT this branch (§2) — it falls through to the
        // gateway-aware error path below, unchanged.
        if (isAbortRejection(e, effectiveSignal)) {
          await emitCancelledTerminal();
          const reason = this._cancelReason(options, runSignal);
          throw new RunCancelledError(
            this._cancelledRunMessage(
              reason,
              "during the provider call (no structured output available)",
            ),
          );
        }
        const { error } = await this._gatewayAwareError(e, {
          bus,
          traceId: effectiveTraceId,
          runId,
          parentSpanId: rootSpanId,
        });
        throw error;
      }
      totalInputTokens = result.usage?.inputTokens ?? 0;
      totalOutputTokens = result.usage?.outputTokens ?? 0;
      totalUsageDetails = detailsFromUsage(result.usage);
      finishReason = result.finishReason ?? "stop";
      rawObject = result.output;
      structuredProviderMetadata = result.providerMetadata;
    } else if (modelSupportsToolsWithStructuredOutput(modelName)) {
      // Tools + capable model → single experimental_output + tools call. The
      // SDK drives the loop; execute-bearing tools keep gate interception via
      // `toolApproval` (#389, D0/Option C) — the bridge below is where
      // `AgentEventBus.evaluateIntent` runs, once per call, before `execute`.
      const bridge = createGateToolApproval({
        bus,
        traceId: effectiveTraceId,
        runId,
        parentSpanId: rootSpanId,
        // #389/#521 fix-round: forwarded so the bridge can fail-closed
        // (deny) promptly on abort — including a `runMs` deadline — instead
        // of hanging on a pending gate evaluation (see
        // tool-approval-bridge.ts's "FAIL-CLOSED POSTURE" note).
        abortSignal: effectiveSignal,
        pendingInputRegistry: options?.pendingInputRegistry,
      });
      const tools = this.convertExecutableTools(agent, toolExecutor, bridge.overlay, {
        bus,
        traceId: effectiveTraceId,
        runId,
        parentSpanId: rootSpanId,
        host: options?.host,
        publishArtifacts: options?.publishArtifacts,
        // #521 §5: threaded through so this path's in-closure dispatch
        // (convertExecutableTools' `execute`, the ONE tool-dispatch site the
        // SDK itself invokes) composes `ctx.signal` + `withToolTimeout`
        // identically to the other two sites.
        toolMs: options?.timeout?.toolMs,
        effectiveSignal,
      });
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model,
          instructions,
          messages,
          tools,
          stopWhen: isStepCount(options?.maxIterations ?? 10),
          // #389 fix-round (nit): `satisfies` locks the hand-rolled
          // `GateToolApprovalFn` (tool-approval-bridge.ts) against ai@7's own
          // `toolApproval` callback shape AT THIS CALL SITE — an SDK release
          // that changes the callback contract now fails typecheck here
          // instead of silently drifting.
          toolApproval: bridge.toolApproval satisfies GenericToolApprovalFunction<
            ToolSet,
            InferToolSetContext<ToolSet>,
            Context
          >,
          output: Output.object({ schema }),
          // #389/#521 fix-round: the capable path previously omitted this
          // (contrast stream()'s forward below) — the SDK's own abort checks
          // (model-call timeouts, tool-execution abort merge) now see it,
          // composed with any `runMs` deadline too.
          abortSignal: effectiveSignal,
          headers: callHeaders,
          ...callParams,
          // #521 §2: native SDK `{stepMs}` timeout. CAVEAT (documented,
          // Spec Review B1): on THIS path a "step" = one model call PLUS the
          // SDK-run tool executions it triggered, so here `modelMs` bounds
          // model-call-plus-tools per step, not the model call alone — see
          // `RunTimeouts.modelMs`'s doc. `toolMs > modelMs` is silently
          // capped by this same step timer on this one path.
          ...(modelTimeout ? { timeout: modelTimeout } : {}),
        });
      } catch (e: unknown) {
        // #504/#521: parity with the no-tools path — this call already
        // forwarded the signal (#389), but its abort used to escape as a raw
        // AbortError plus a spurious `agent.error`. Normalized to
        // RunCancelledError.
        if (isAbortRejection(e, effectiveSignal)) {
          await emitCancelledTerminal();
          const reason = this._cancelReason(options, runSignal);
          throw new RunCancelledError(
            this._cancelledRunMessage(
              reason,
              "during the provider call (no structured output available)",
            ),
          );
        }
        const { error } = await this._gatewayAwareError(e, {
          bus,
          traceId: effectiveTraceId,
          runId,
          parentSpanId: rootSpanId,
        });
        throw error;
      }
      structuredProviderMetadata = result.providerMetadata;
      const steps = result.steps ?? [];
      // v7: result.usage aggregates ALL steps (totalUsage is now a deprecated
      // alias for the same value), so on this multi-step capable path it IS the
      // loop total. Keep the per-step reduce fallback belt-and-braces — it
      // guards providers that omit usage entirely.
      const usage =
        result.usage ??
        steps.reduce(
          (a, s) => ({
            inputTokens: (a.inputTokens ?? 0) + (s.usage?.inputTokens ?? 0),
            outputTokens: (a.outputTokens ?? 0) + (s.usage?.outputTokens ?? 0),
          }),
          { inputTokens: 0, outputTokens: 0 },
        );
      totalInputTokens = usage?.inputTokens ?? 0;
      totalOutputTokens = usage?.outputTokens ?? 0;
      // #388: mirror the belt-and-braces fallback above — when result.usage is
      // present, take detail straight from it; otherwise fold detail across
      // steps the same way the flat reduce does.
      totalUsageDetails = result.usage
        ? detailsFromUsage(result.usage)
        : steps.reduce<TokenUsageDetails | undefined>(
            (acc, s) => mergeUsageDetails(acc, detailsFromUsage(s.usage)),
            undefined,
          );
      finishReason = result.finishReason ?? "stop";
      toolCallsCount = steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);
      iterations = Math.max(1, steps.length);
      rawObject = result.output;
    } else {
      // Tools + incapable/UNKNOWN model → 2-tier (model-safe). Tier 1: the
      // normal gate-respecting tool loop to text. Tier 2: a no-tools
      // Output.object finish over that text.
      // Thread the runStructured root's trace + span so tier-1's events nest
      // under it instead of forming a fresh, disjoint trace.
      // #521 §4: the delegate must NOT re-derive a fresh full `runMs` — that
      // would let the wall clock reach (time already spent before tier-1) +
      // `runMs`. When THIS call has a deadline in scope (`deadlineAt` set),
      // override `timeout.runMs` with the REMAINING budget computed once
      // here (`max(1, deadlineAt - Date.now())` — the one permissible
      // `Date.now()` use in this area: budget arithmetic, never reason
      // discrimination). `run()` then derives its OWN fresh
      // `AbortSignal.timeout(remaining)` from that — expiring at the correct
      // absolute time — and can return `finishReason: "timeout"` on it.
      const tier1 = await this.run(agent, message, {
        ...options,
        traceId: effectiveTraceId,
        parentSpanId: rootSpanId,
        ...(deadlineAt !== undefined
          ? { timeout: { ...options?.timeout, runMs: Math.max(1, deadlineAt - Date.now()) } }
          : {}),
      });
      totalInputTokens += tier1.inputTokens;
      totalOutputTokens += tier1.outputTokens;
      totalUsageDetails = mergeUsageDetails(totalUsageDetails, tier1.usageDetails);
      toolCallsCount = tier1.toolCallsCount;
      iterations = tier1.iterations;

      // #341 amendment: tier1 delegates to run(), which honors the effective
      // signal itself (top-of-iteration guard) and comes back with
      // `finishReason: "cancelled"` OR (#521) `"timeout"` rather than
      // throwing. runStructured() has no schema-valid object to hand back in
      // either case — surface it as a RunCancelledError instead of feeding
      // an empty/partial tier1.response into tier 2. Widened from an
      // exact-match `"cancelled"` check (Spec Review B2, re-run 1): a
      // `"timeout"` tier1 result also has `response: ""`, and left
      // unhandled it would fall through into the empty-tier-1 guard below
      // and throw a bare, misleading `Error` pointing at `maxIterations`
      // instead of `RunCancelledError` — skipping `emitCancelledTerminal()`,
      // the exact finalization gap #504 closed.
      if (tier1.finishReason === "cancelled" || tier1.finishReason === "timeout") {
        // #504 (Gate 2.5): same finalization requirement as the catch sites —
        // without a terminal event this runId's row stays 'running' forever.
        // Emitted with the literal "cancelled" (unchanged — Spec Review
        // note, harmless: `run-store.ts` is first-terminal-wins, so when a
        // shared `runId` is passed tier1's own discriminated terminal
        // — already emitted inside the `run()` delegate above, carrying
        // "timeout" when that's what happened — wins over this one).
        await emitCancelledTerminal();
        const reason = tier1.finishReason === "timeout" ? "timeout" : "cancelled";
        throw new RunCancelledError(
          this._cancelledRunMessage(
            reason,
            "during its tier-1 tool loop (no structured output available)",
          ),
        );
      }

      let acceptedTerminalResult = false;
      if (tier1.finishReason === "terminal_tool") {
        // A schema-valid terminal result IS the structured output; tier 2 is
        // the fallback, not a re-normalizer. Try the JSON-parsed candidate
        // first, then the raw string if parsing succeeded but validation fails.
        let candidate: unknown = tier1.response;
        try {
          candidate = JSON.parse(tier1.response);
        } catch {
          // The terminal result was a plain string; validate it verbatim.
        }
        let candidateResult = schema.safeParse(candidate);
        if (!candidateResult.success && candidate !== tier1.response) {
          candidate = tier1.response;
          candidateResult = schema.safeParse(candidate);
        }
        if (candidateResult.success) {
          rawObject = candidate;
          finishReason = "terminal_tool";
          acceptedTerminalResult = true;
        }
      }

      if (!acceptedTerminalResult) {
        // Guard: if tier 1 produced no text (e.g. its tool loop hit maxIterations),
        // the structured finish would get an empty body and throw an opaque schema
        // error. Surface the real cause instead.
        if (!tier1.response || tier1.response.trim() === "") {
          throw new Error(
            `runStructured: 2-tier fallback got empty tier-1 output (finishReason="${tier1.finishReason}") — the tool loop likely hit maxIterations before producing an answer. Raise maxIterations or simplify the step.`,
          );
        }

        let tier2: Awaited<ReturnType<typeof generateText>>;
        try {
          tier2 = await generateText({
            model,
            instructions,
            messages: [
              {
                role: "user" as const,
                content: `From the following, produce the structured object.\n\n${tier1.response}`,
              },
            ],
            output: Output.object({ schema }),
            // #504/#521: forwarded — an abort (explicit or runMs-derived)
            // interrupts the in-flight call. `effectiveSignal` is THIS
            // call's own (its `runMs` deadline was set once at entry, so it
            // fires at the correct absolute time regardless of how long
            // tier-1 already ran).
            abortSignal: effectiveSignal,
            headers: callHeaders,
            ...callParams,
            // #521: native SDK `{stepMs}` timeout — true per-call bound here
            // (no tools on this tier-2 finish).
            ...(modelTimeout ? { timeout: modelTimeout } : {}),
          });
        } catch (e: unknown) {
          // #504/#521: same normalization as the paths above.
          if (isAbortRejection(e, effectiveSignal)) {
            await emitCancelledTerminal();
            const reason = this._cancelReason(options, runSignal);
            throw new RunCancelledError(
              this._cancelledRunMessage(
                reason,
                "during the provider call (no structured output available)",
              ),
            );
          }
          const { error } = await this._gatewayAwareError(e, {
            bus,
            traceId: effectiveTraceId,
            runId,
            parentSpanId: rootSpanId,
          });
          throw error;
        }
        totalInputTokens += tier2.usage?.inputTokens ?? 0;
        totalOutputTokens += tier2.usage?.outputTokens ?? 0;
        totalUsageDetails = mergeUsageDetails(totalUsageDetails, detailsFromUsage(tier2.usage));
        iterations += 1;
        finishReason = tier2.finishReason ?? "stop";
        rawObject = tier2.output;
        structuredProviderMetadata = tier2.providerMetadata;
      }
    }

    // Validate against the caller's schema — never trust the model's shape.
    const parsed = schema.safeParse(rawObject);
    if (!parsed.success) {
      const err = new Error(
        `runStructured: model output failed schema validation — ${parsed.error.message}`,
      );
      await emit(
        createEvent("agent.error", {
          traceId: effectiveTraceId,
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

    await emit(
      createEvent("agent.message.complete", {
        traceId: effectiveTraceId,
        runId,
        spanId: rootSpanId,
        parentSpanId: rootSpanId,
        content: JSON.stringify(parsed.data),
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        model: modelName,
        finishReason,
        ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
      }),
    );

    // #407: ONE post-validation scan of the finalized structured output.
    // Advisory — `JSON.stringify` can double-count an entity echoed in
    // multiple fields (spec 407 § Open question 4, accepted).
    await this._maybeEmitRedaction(JSON.stringify(parsed.data), structuredProviderMetadata, {
      bus,
      traceId: effectiveTraceId,
      runId,
      parentSpanId: rootSpanId,
      modelProvider: model.provider,
    });
    const structuredGatewayAttribution = attributionFromProviderMetadata(
      structuredProviderMetadata,
    );

    return {
      response: JSON.stringify(parsed.data),
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolCallsCount,
      iterations,
      finishReason,
      object: parsed.data,
      ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
      ...(structuredGatewayAttribution ? { gateway: structuredGatewayAttribution } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // stream() — Streaming execution loop using fullStream
  // ---------------------------------------------------------------------------

  async *stream(
    agent: AgentLike,
    message: string,
    options?: RunOptions,
  ): AsyncGenerator<AgentEvent> {
    // #496: resolved once for THIS call, closed over below — never rebinds
    // the runner. See busFor for the fallback order and the #288 semantics
    // of emitIntent.
    const bus = this.busFor(options);
    const emit = (event: AgentEvent) => bus.publish(event);
    const emitIntent = async (event: AgentEvent) =>
      (await bus.evaluateIntent(event as ToolCallIntent)).outcome === "allow";

    // #437: honor a caller-provided correlation id (AP-29 F1) — parity with run().
    const runId = options?.runId ?? generateId();
    const effectiveTraceId = options?.traceId ?? runId;
    const maxIterations = options?.maxIterations ?? 10;
    const toolExecutor = options?.toolExecutor;
    const conversationId = generateId();

    const model = await this._resolver.resolve(agent.getModel());
    const modelName = model.modelId;
    // #406: computed once per run (parity with run()/runStructured()), reused
    // across iterations below.
    const callHeaders = this._resolveCallHeaders(agent, model, runId, effectiveTraceId, options);
    // #514: computed once per run (parity with callHeaders).
    const callParams = this._resolveCallParams(modelName, options);
    // #521: computed once per run (parity with run()/runStructured()),
    // reused across iterations below. `stream()`'s cancel mapping is
    // UNCHANGED by `runMs` (§4: always `conversation.end
    // {reason:"cancelled"}`, no new vocabulary) — `runSignal` is unused
    // here, kept only for call-site symmetry with the other two methods.
    const modelTimeout = this._resolveModelTimeout(options);
    const { effectiveSignal } = this._resolveEffectiveSignal(options);
    // AgentLike.getTools() returns unknown[] at the protocol boundary; cast
    // per the run()/runStructured() precedent — #117 needs `.name` for
    // agentConfig.tools (parity with the other two paths).
    const agentTools = agent.getTools() as ToolSchema[];
    const tools = this.convertTools(agent, toolExecutor);
    const hasTools = agentTools.length > 0;
    // Terminal tools — parity with run(): a successful call ends the loop.
    const terminalTools = new Set(agentTools.filter((t) => t.terminal === true).map((t) => t.name));
    // #352: parity with run() — name -> declared render hint, for the
    // tool.start/tool.end stamp below.
    const displayTypes = new Map(
      agentTools.flatMap((t) =>
        t.displayType !== undefined ? [[t.name, t.displayType] as const] : [],
      ),
    );

    const instructions = agent.renderInitialPrompt(this._renderCtx(options));
    const messages: ModelMessage[] = [];
    if (options?.messageHistory) {
      messages.push(...convertHistory(options.messageHistory));
    }
    messages.push({ role: "user" as const, content: message });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    // #388: stream-scope cache/reasoning detail accumulator — absent ≠ zero.
    let totalUsageDetails: TokenUsageDetails | undefined;
    let totalToolCalls = 0;
    let fullText = "";
    // BOUNDED COMPLETION (parity with run()): errored-terminal attempt tally.
    // First error continues; second ends the run as `terminal_tool_error`.
    let terminalErrorCount = 0;
    // #407: providerMetadata off the most recent `finish-step` part — read at
    // the redaction scan before `message.complete` below, and for each
    // iteration's `agent.llm.end.gateway` attribution.
    let lastStepProviderMetadata: unknown;

    // Conversation start
    const convStart = createEvent("agent.conversation.start", {
      traceId: effectiveTraceId,
      runId,
      conversationId,
      agentName: agent.role.name,
    });
    await emit(convStart);
    yield convStart;

    // Message start
    const msgStart = createEvent("agent.message.start", {
      traceId: effectiveTraceId,
      runId,
      parentSpanId: options?.parentSpanId,
      agentName: agent.role.name,
      // #117: parity with run()/runStructured(), which already carry agentConfig.
      agentConfig: {
        role: agent.role.name,
        model: modelName,
        tools: agentTools.map((t) => t.name),
      },
      systemPrompt: instructions,
      trigger: options?.trigger,
    });
    const rootSpanId = msgStart.spanId;
    await emit(msgStart);
    yield msgStart;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Top-of-iteration abort guard (#341): prevents a second `llm.start`
      // after an abort landed between iterations (e.g. while tool results
      // were being appended to `messages` below, or while the previous
      // iteration's tool loop was draining). Runner owns cancel emission —
      // locked D1 — so bus/exporters/collector see it on every transport.
      // #521: checks the effective signal (caller's `abortSignal` composed
      // with a derived `runMs` deadline); the mapping stays "cancelled"
      // either way (§4 — no new event vocabulary on this method).
      if (effectiveSignal?.aborted) {
        yield* this.emitCancellation({
          bus,
          traceId: effectiveTraceId,
          runId,
          parentSpanId: rootSpanId,
          conversationId,
        });
        return;
      }

      // Iteration start
      const iterStart = createEvent("agent.iteration.start", {
        traceId: effectiveTraceId,
        runId,
        parentSpanId: rootSpanId,
        iteration,
        maxIterations,
      });
      const iterSpanId = iterStart.spanId;
      await emit(iterStart);
      yield iterStart;

      // LLM start
      const llmStart = createEvent("agent.llm.start", {
        traceId: effectiveTraceId,
        runId,
        parentSpanId: iterSpanId,
        model: modelName,
        messageCount: messages.length + 1,
        hasTools,
      });
      const llmSpanId = llmStart.spanId;
      await emit(llmStart);
      yield llmStart;

      const llmStartTime = Date.now();

      // Use .stream to get text + tool calls + errors in one pass.
      // GATE-CHAIN INVARIANT: no `maxSteps`/`stopWhen` (v7 single-step default),
      // tools `execute`-less — the SDK won't run/loop tools; we dispatch below.
      const streamResult = streamText({
        model,
        instructions,
        messages,
        tools: hasTools ? tools : undefined,
        // #341/#521: forwarded cooperatively to the provider call. ai@7
        // either emits a `type: "abort"` stream part (handled below) or, for
        // providers that don't support that, rejects the in-flight call with
        // an `AbortError` (caught around the drain loop below) — both routes
        // land in the same cancel-and-return block. `effectiveSignal`
        // composes a `runMs` deadline in too.
        abortSignal: effectiveSignal,
        headers: callHeaders,
        ...callParams,
        // #521: native SDK `{stepMs}` timeout. Expiry here surfaces as the
        // SDK's `abort` stream part (§2, corrected per Spec Review B2) — NOT
        // the `generateText` error path — and lands on the existing cancel
        // route below unchanged.
        ...(modelTimeout ? { timeout: modelTimeout } : {}),
      });

      let iterText = "";
      let chunkIndex = 0;
      const pendingToolCalls: Array<{
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        result?: unknown;
      }> = [];
      // #388: widened to the full v7 LanguageModelUsage (was a narrow
      // hand-written {inputTokens?, outputTokens?} type that silently
      // discarded the detail members already arriving on `part.usage`).
      let stepUsage: LanguageModelUsage | undefined;
      let stepFinishReason = "stop";
      let hadError = false;
      let aborted = false;

      // Reasoning-block tracking. Some models (Claude extended thinking,
      // o-series, Gemini 2.5 thinking, DeepSeek Reasoner) emit one or more
      // reasoning deltas before switching back to text/tool-calls. We emit
      // exactly one `agent.thinking.start` per block, stream per-delta
      // `agent.reasoning` events with `isComplete: false`, then one final
      // `agent.reasoning` with `isComplete: true` carrying the full
      // accumulated text when the block ends.
      let reasoningActive = false;
      let reasoningText = "";

      // #341 belt-and-braces: some providers reject the in-flight call with
      // an `AbortError` instead of emitting a `.stream` `type: "abort"`
      // part (handled in the switch's `case "abort"` below). Either route
      // sets `aborted` and falls through to the same cancel-and-return block
      // after the loop — never the error path.
      try {
        for await (const part of streamResult.stream) {
          switch (part.type) {
            case "text-delta": {
              // Transition reasoning -> text: close the reasoning block first.
              if (reasoningActive) {
                const reasoningCompleteEvent = createEvent("agent.reasoning", {
                  traceId: effectiveTraceId,
                  runId,
                  content: reasoningText,
                  isComplete: true,
                });
                await emit(reasoningCompleteEvent);
                yield reasoningCompleteEvent;
                reasoningActive = false;
                reasoningText = "";
              }
              iterText += part.text;
              const chunkEvent = createEvent("agent.message.chunk", {
                traceId: effectiveTraceId,
                runId,
                delta: part.text,
                chunkIndex: chunkIndex++,
              });
              await emit(chunkEvent);
              yield chunkEvent;
              break;
            }
            case "reasoning-delta": {
              if (!reasoningActive) {
                reasoningActive = true;
                reasoningText = "";
                const startEvent = createEvent("agent.thinking.start", {
                  traceId: effectiveTraceId,
                  runId,
                  parentSpanId: llmSpanId,
                });
                await emit(startEvent);
                yield startEvent;
              }
              reasoningText += part.text;
              const deltaEvent = createEvent("agent.reasoning", {
                traceId: effectiveTraceId,
                runId,
                content: part.text,
                isComplete: false,
              });
              await emit(deltaEvent);
              yield deltaEvent;
              break;
            }
            case "tool-call": {
              // Transition reasoning -> tool-call: close the reasoning block.
              if (reasoningActive) {
                const reasoningCompleteEvent = createEvent("agent.reasoning", {
                  traceId: effectiveTraceId,
                  runId,
                  content: reasoningText,
                  isComplete: true,
                });
                await emit(reasoningCompleteEvent);
                yield reasoningCompleteEvent;
                reasoningActive = false;
                reasoningText = "";
              }
              pendingToolCalls.push({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                args: part.input as Record<string, unknown>,
              });
              break;
            }
            case "finish-step": {
              stepUsage = part.usage;
              stepFinishReason = part.finishReason;
              // #407: captured for the redaction scan + gateway attribution
              // below (fact 6: the finish-step part carries `providerMetadata`).
              lastStepProviderMetadata = part.providerMetadata;
              break;
            }
            // #389: KEEP — spec-mandated defensive cases (Approach step 7),
            // deliberately unreachable until a streaming `toolApproval` path
            // exists (Gate 2.5 quality flagged this as YAGNI; adherence
            // confirmed it's what the spec requires — kept per spec).
            // `stream()` never sets `toolApproval` (the GATE-CHAIN INVARIANT
            // keeps this path execute-less and gate-checked via `emitIntent`
            // above), so these parts are unreachable today. Mapped explicitly
            // so a future SDK-driven streaming path (should one ever pass
            // `toolApproval` here) surfaces the tool-approval events rather
            // than silently falling through the `default` skip below.
            case "tool-approval-request": {
              const reqEvent = createEvent("agent.tool.approval.request", {
                traceId: effectiveTraceId,
                runId,
                parentSpanId: iterSpanId,
                toolCallId: part.toolCall.toolCallId,
                toolName: part.toolCall.toolName,
                arguments: (part.toolCall.input ?? {}) as Record<string, unknown>,
              });
              await emit(reqEvent);
              yield reqEvent;
              break;
            }
            case "tool-approval-response": {
              const respEvent = createEvent("agent.tool.approval.response", {
                traceId: effectiveTraceId,
                runId,
                parentSpanId: iterSpanId,
                toolCallId: part.toolCall.toolCallId,
                toolName: part.toolCall.toolName,
                approved: part.approved,
                settledBy: "gate" as const,
                ...(part.reason !== undefined ? { reason: part.reason } : {}),
              });
              await emit(respEvent);
              yield respEvent;
              break;
            }
            case "tool-output-denied": {
              const rejEvent = createEvent("agent.tool.rejected", {
                traceId: effectiveTraceId,
                runId,
                parentSpanId: iterSpanId,
                toolName: part.toolName,
                reason: "Denied by gate (toolApproval)",
                gateName: "toolApproval",
                gateCategory: "APPROVAL",
                originalIntent: createEvent("agent.tool.intent", {
                  traceId: effectiveTraceId,
                  runId,
                  parentSpanId: iterSpanId,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  arguments: {},
                }),
              });
              await emit(rejEvent);
              yield rejEvent;
              break;
            }
            case "abort": {
              // #341: the SDK's `.stream` abort signal — the provider call
              // observed `options.abortSignal` firing. Set the local flag and
              // break out of the switch; the stream drain itself ends
              // shortly after (the SDK closes the stream on abort), then the
              // post-loop `aborted` check below routes into the shared
              // cancel-and-return block.
              aborted = true;
              break;
            }
            case "error": {
              hadError = true;
              const llmDuration = Date.now() - llmStartTime;
              const llmEndErr = createEvent("agent.llm.end", {
                traceId: effectiveTraceId,
                runId,
                spanId: llmSpanId,
                parentSpanId: iterSpanId,
                model: modelName,
                inputTokens: 0,
                outputTokens: 0,
                durationMs: llmDuration,
                hasToolCalls: false,
                finishReason: "error",
              });
              await emit(llmEndErr);
              yield llmEndErr;

              // #407: classify before falling back to the generic error path.
              // `_gatewayAwareError` already performed the emit(s) above; only
              // yield the SAME event instances here (never re-`createEvent`).
              const { violationEvent, errorEvent } = await this._gatewayAwareError(part.error, {
                bus,
                traceId: effectiveTraceId,
                runId,
                parentSpanId: iterSpanId,
              });
              if (violationEvent) yield violationEvent;
              yield errorEvent;
              break;
            }
            default:
              // start, start-step, text-start/end, reasoning-start/end,
              // tool-input-start/delta/end, finish, source, file, raw, etc. — skip
              break;
          }
        }
      } catch (e: unknown) {
        // Belt-and-braces (#341): a provider that throws `AbortError` instead
        // of emitting the `abort` stream part routes here — anything else
        // is a genuine failure and must keep going through the normal error
        // path (rethrown, unhandled by design; nothing upstream of stream()
        // wraps this in a way that would silently swallow it).
        if (e instanceof Error && e.name === "AbortError") {
          aborted = true;
        } else {
          throw e;
        }
      }

      // Stream ended while a reasoning block is still open — close it out.
      if (reasoningActive) {
        const reasoningCompleteEvent = createEvent("agent.reasoning", {
          traceId: effectiveTraceId,
          runId,
          content: reasoningText,
          isComplete: true,
        });
        await emit(reasoningCompleteEvent);
        yield reasoningCompleteEvent;
        reasoningActive = false;
        reasoningText = "";
      }

      if (hadError) {
        const convEnd = createEvent("agent.conversation.end", {
          traceId: effectiveTraceId,
          runId,
          conversationId,
          reason: "error" as const,
        });
        await emit(convEnd);
        yield convEnd;
        return;
      }

      // #341: the fullStream drain observed an abort (either the `abort`
      // part or an `AbortError` caught above) — runner owns cancel emission
      // (locked D1), skipping this iteration's `iteration.end`/
      // `message.complete` (accepted per the human gate's Q2 answer).
      if (aborted) {
        yield* this.emitCancellation({
          bus,
          traceId: effectiveTraceId,
          runId,
          parentSpanId: rootSpanId,
          conversationId,
        });
        return;
      }

      fullText += iterText;

      // Update token tracking (usage field names since v5; each is number|undefined).
      const iterInputTokens = stepUsage?.inputTokens ?? 0;
      const iterOutputTokens = stepUsage?.outputTokens ?? 0;
      totalInputTokens += iterInputTokens;
      totalOutputTokens += iterOutputTokens;
      // #388: absent ≠ zero — omit the field entirely when the provider
      // reported no detail members this step.
      const iterUsageDetails = detailsFromUsage(stepUsage);
      totalUsageDetails = mergeUsageDetails(totalUsageDetails, iterUsageDetails);

      const hasToolCalls = pendingToolCalls.length > 0;
      const llmDuration = Date.now() - llmStartTime;

      // #407: which provider actually served this step, when the gateway's
      // metadataExtractor reported one.
      const iterGatewayAttribution = attributionFromProviderMetadata(lastStepProviderMetadata);

      // LLM end
      const llmEnd = createEvent("agent.llm.end", {
        traceId: effectiveTraceId,
        runId,
        spanId: llmSpanId,
        parentSpanId: iterSpanId,
        model: modelName,
        inputTokens: iterInputTokens,
        outputTokens: iterOutputTokens,
        durationMs: llmDuration,
        hasToolCalls,
        finishReason: hasToolCalls ? "tool_calls" : stepFinishReason,
        ...(iterUsageDetails ? { usageDetails: iterUsageDetails } : {}),
        ...(iterGatewayAttribution ? { gateway: iterGatewayAttribution } : {}),
      });
      await emit(llmEnd);
      yield llmEnd;

      // No tool calls = done
      if (!hasToolCalls) {
        const iterEnd = createEvent("agent.iteration.end", {
          traceId: effectiveTraceId,
          runId,
          spanId: iterSpanId,
          parentSpanId: rootSpanId,
          iteration,
          toolCallsCount: 0,
          hasMore: false,
        });
        await emit(iterEnd);
        yield iterEnd;

        // #407: one redaction scan on the FULL accumulated text, right before
        // the terminal `message.complete` — no-ops for non-gateway models.
        const redactionEvent = await this._maybeEmitRedaction(fullText, lastStepProviderMetadata, {
          bus,
          traceId: effectiveTraceId,
          runId,
          parentSpanId: rootSpanId,
          modelProvider: model.provider,
        });
        if (redactionEvent) yield redactionEvent;

        const msgComplete = createEvent("agent.message.complete", {
          traceId: effectiveTraceId,
          runId,
          spanId: rootSpanId,
          parentSpanId: rootSpanId,
          content: fullText,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          model: modelName,
          finishReason: stepFinishReason,
          ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
        });
        await emit(msgComplete);
        yield msgComplete;

        const convEnd = createEvent("agent.conversation.end", {
          traceId: effectiveTraceId,
          runId,
          conversationId,
          reason: "completed" as const,
        });
        await emit(convEnd);
        yield convEnd;
        return;
      }

      // Process tool calls
      let terminalFired = false;
      let terminalResult: unknown;
      // BOUNDED COMPLETION: first errored terminal call in this batch (if any).
      let terminalErrorName: string | undefined;
      let terminalErrorMsg: string | undefined;
      for (const tc of pendingToolCalls) {
        // Pre-tool-dispatch abort guard (#341): checked at the top of every
        // per-call iteration, before even signaling intent for it — never
        // dispatch (or claim intent to dispatch) a tool for an
        // already-cancelled turn. Any calls already dispatched earlier in
        // this batch have already run; this only stops the NEXT one. #521:
        // effective signal, same mapping as the top-of-iteration guard.
        if (effectiveSignal?.aborted) {
          yield* this.emitCancellation({
            bus,
            traceId: effectiveTraceId,
            runId,
            parentSpanId: rootSpanId,
            conversationId,
          });
          return;
        }

        const intent = createEvent("agent.tool.intent", {
          traceId: effectiveTraceId,
          runId,
          parentSpanId: iterSpanId,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          arguments: tc.args,
        });
        await emit(intent);
        yield intent;

        const allowed = await emitIntent(intent);
        if (!allowed) {
          const errEvent = createEvent("agent.error", {
            traceId: effectiveTraceId,
            runId,
            parentSpanId: iterSpanId,
            errorType: "ToolCallBlocked",
            message: `Tool call '${tc.toolName}' blocked by gate`,
            recoverable: false,
            context: {},
          });
          await emit(errEvent);
          yield errEvent;

          const convEnd = createEvent("agent.conversation.end", {
            traceId: effectiveTraceId,
            runId,
            conversationId,
            reason: "error" as const,
          });
          await emit(convEnd);
          yield convEnd;
          return;
        }

        const tcStart = createEvent("agent.tool.start", {
          // #102 fix: see the first dispatch site's comment — stamp spanId
          // with the toolCallId so span exporters can resolve a nested
          // sub-agent's `parentSpanId === parentToolCallId` anchor.
          spanId: tc.toolCallId,
          traceId: effectiveTraceId,
          runId,
          parentSpanId: iterSpanId,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          arguments: tc.args,
          ...(displayTypes.has(tc.toolName) ? { displayType: displayTypes.get(tc.toolName) } : {}),
        });
        const tcSpanId = tcStart.spanId;
        await emit(tcStart);
        yield tcStart;

        const startTime = Date.now();
        let toolResult: unknown;
        let errorMsg: string | undefined;
        // ADR-0006 §2: collected only when this run opted in.
        const publishedArtifacts: RenderArtifact[] = [];

        try {
          if (toolExecutor) {
            // #521 §5: freshly minted PER DISPATCH — same as run()'s site.
            const toolMs = options?.timeout?.toolMs;
            const dispatchSignal = this._toolDispatchSignal(toolMs, effectiveSignal);
            const execPromise = toolExecutor.execute(
              tc.toolName,
              tc.args,
              this.buildToolCtx({
                bus,
                traceId: effectiveTraceId,
                runId,
                parentToolCallId: tc.toolCallId,
                parentSpanId: tcSpanId,
                host: options?.host,
                onArtifact: options?.publishArtifacts
                  ? (a) => publishedArtifacts.push(a)
                  : undefined,
                signal: dispatchSignal,
              }),
            );
            // #521 §3: rejects on expiry — the existing catch below produces
            // the structured `{error}` + `errorMsg` shape, which is
            // load-bearing here: the terminal-tool exit below keys on
            // `errorMsg === undefined`.
            toolResult =
              toolMs !== undefined
                ? await withToolTimeout(execPromise, toolMs, tc.toolName)
                : await execPromise;
          } else {
            toolResult = { error: "No tool executor configured" };
            errorMsg = "No tool executor configured";
          }
        } catch (e: unknown) {
          const err = e instanceof Error ? e : new Error(String(e));
          toolResult = { error: err.message };
          errorMsg = err.message;
        }

        const durationMs = Date.now() - startTime;
        totalToolCalls++;
        tc.result = toolResult;

        // Terminal-tool exit (parity with run()): first successful terminal
        // call wins; an errored one does not terminate immediately (bounded
        // completion below handles the second consecutive failure). Capture the
        // first errored terminal call so the post-loop check can tally it.
        if (!terminalFired && errorMsg === undefined && terminalTools.has(tc.toolName)) {
          terminalFired = true;
          terminalResult = toolResult;
        } else if (
          errorMsg !== undefined &&
          terminalTools.has(tc.toolName) &&
          terminalErrorName === undefined
        ) {
          terminalErrorName = tc.toolName;
          terminalErrorMsg = errorMsg;
        }

        const tcEnd = createEvent("agent.tool.end", {
          traceId: effectiveTraceId,
          runId,
          spanId: tcSpanId,
          parentSpanId: iterSpanId,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          arguments: tc.args,
          result: toolResult,
          error: errorMsg,
          durationMs,
          resultTokens: 0,
          ...(displayTypes.has(tc.toolName) ? { displayType: displayTypes.get(tc.toolName) } : {}),
          ...(publishedArtifacts.length > 0 ? { artifacts: publishedArtifacts } : {}),
        });
        await emit(tcEnd);
        yield tcEnd;
      }

      // TERMINAL-TOOL EXIT (parity with run()): the tool's result IS the final
      // response; every call in this iteration's batch has already executed.
      if (terminalFired) {
        // ADR-0006 §9 (parity with run()): `content` stays byte-identical;
        // `structuredContent` additionally carries the un-flattened result.
        const content =
          typeof terminalResult === "string"
            ? terminalResult
            : JSON.stringify(terminalResult ?? "");
        const structuredContent =
          terminalResult !== undefined && typeof terminalResult !== "string"
            ? terminalResult
            : undefined;

        const iterEnd = createEvent("agent.iteration.end", {
          traceId: effectiveTraceId,
          runId,
          spanId: iterSpanId,
          parentSpanId: rootSpanId,
          iteration,
          toolCallsCount: pendingToolCalls.length,
          hasMore: false,
        });
        await emit(iterEnd);
        yield iterEnd;

        const msgComplete = createEvent("agent.message.complete", {
          traceId: effectiveTraceId,
          runId,
          spanId: rootSpanId,
          parentSpanId: rootSpanId,
          content,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          model: modelName,
          finishReason: "terminal_tool",
          ...(structuredContent !== undefined ? { structuredContent } : {}),
          ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
        });
        await emit(msgComplete);
        yield msgComplete;

        const convEnd = createEvent("agent.conversation.end", {
          traceId: effectiveTraceId,
          runId,
          conversationId,
          reason: "completed" as const,
        });
        await emit(convEnd);
        yield convEnd;
        return;
      }

      // BOUNDED COMPLETION (parity with run()): no terminal call SUCCEEDED, but
      // did one ERROR? The first errored terminal call continues (the model
      // sees the error, appended below, and gets one chance to correct); the
      // second ends the run cleanly as `terminal_tool_error` rather than
      // burning to max_iterations with an empty response.
      if (terminalErrorName !== undefined) {
        terminalErrorCount++;
        if (terminalErrorCount >= 2) {
          const errText = terminalErrorMsg ?? "unknown error";

          const iterEnd = createEvent("agent.iteration.end", {
            traceId: effectiveTraceId,
            runId,
            spanId: iterSpanId,
            parentSpanId: rootSpanId,
            iteration,
            toolCallsCount: pendingToolCalls.length,
            hasMore: false,
          });
          await emit(iterEnd);
          yield iterEnd;

          const msgComplete = createEvent("agent.message.complete", {
            traceId: effectiveTraceId,
            runId,
            spanId: rootSpanId,
            parentSpanId: rootSpanId,
            content: errText,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            model: modelName,
            finishReason: "terminal_tool_error",
            ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
          });
          await emit(msgComplete);
          yield msgComplete;

          const convEnd = createEvent("agent.conversation.end", {
            traceId: effectiveTraceId,
            runId,
            conversationId,
            reason: "completed" as const,
          });
          await emit(convEnd);
          yield convEnd;
          return;
        }
      }

      // Build messages for next iteration.
      //
      // ★ THOUGHT-SIGNATURE / REASONING ROUND-TRIP: append the SDK's own
      // assistant message(s) VERBATIM. `streamResult.response` resolves (after
      // the fullStream drained above) to the response incl. `messages` that
      // carry `providerOptions`/`providerMetadata` — Gemini's `thoughtSignature`
      // and Anthropic thinking blocks. Hand-rebuilding the assistant turn drops
      // them and breaks Gemini 3.x multi-turn tool loops.
      const streamResponse = await streamResult.response;
      messages.push(...sanitizeResponseMessages(streamResponse.messages));

      // Our own tool results (we ran the tools, not the SDK). ToolResultPart
      // carries the result under `output` as a typed union (since v5;
      // unchanged through v7).
      messages.push({
        role: "tool" as const,
        content: pendingToolCalls.map((tc) => ({
          type: "tool-result" as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output: { type: "json" as const, value: toJsonValue(tc.result) },
        })),
      });

      // Iteration end
      const iterEnd = createEvent("agent.iteration.end", {
        traceId: effectiveTraceId,
        runId,
        spanId: iterSpanId,
        parentSpanId: rootSpanId,
        iteration,
        toolCallsCount: pendingToolCalls.length,
        hasMore: true,
      });
      await emit(iterEnd);
      yield iterEnd;
    }

    // Max iterations reached — #117: emit + yield a terminal message.complete
    // before conversation.end (mirrors run()'s max-iterations emission; without
    // it a bus-finish hook like RunStoreExporter never sees a terminal event
    // for this path and the run row stays 'running' forever).
    const msgComplete = createEvent("agent.message.complete", {
      traceId: effectiveTraceId,
      runId,
      spanId: rootSpanId,
      parentSpanId: rootSpanId,
      content: fullText,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      model: modelName,
      finishReason: "max_iterations",
      ...(totalUsageDetails ? { usageDetails: totalUsageDetails } : {}),
    });
    await emit(msgComplete);
    yield msgComplete;

    const convEnd = createEvent("agent.conversation.end", {
      traceId: effectiveTraceId,
      runId,
      conversationId,
      reason: "completed" as const,
    });
    await emit(convEnd);
    yield convEnd;
  }
}
