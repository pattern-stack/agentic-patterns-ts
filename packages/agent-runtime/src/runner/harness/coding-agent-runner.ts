/**
 * `CodingAgentRunner` — the harness-agnostic base for coding-agent runners
 * (design.md §5.1, B-2 / #326).
 *
 * The AP half of the two-seam architecture (D1): it implements `RunnerProtocol`
 * and owns everything that is NOT harness-specific —
 *  - run/stream lifecycle: `agent.message.start`/`complete`, `agent.error`;
 *  - run accounting (tokens, iterations, cost) sourced from the adapter's
 *    `terminal` event via {@link HarnessEventTranslator};
 *  - the gate-evaluation seam (`evaluateIntent`) handed to the adapter so its
 *    native inspection hook can gate synchronously — the adapter never touches
 *    the bus;
 *  - span correlation + AP-event construction from the normalized stream (one
 *    place builds AP events);
 *  - per-run correlation-id injection (via the session env, never `process.env`);
 *  - the run-start GateRequirements compatibility check (§5.2);
 *  - the D4/C1 decision-validation helper;
 *  - `RunOptions.abortSignal` (#368): an entry guard that never launches the
 *    harness subprocess for an already-fired signal, plus a mid-stream watch
 *    that terminates it promptly via {@link HarnessSession.close} — see
 *    {@link CodingAgentRunner._drainSession}.
 *
 * A concrete runner supplies a {@link HarnessAdapter} via {@link createAdapter}.
 * PROVISIONAL until B-4 (D3): the seam is validated against one live adapter (CC)
 * here; Codex (#330) will break it deliberately.
 */

import { generateId } from "ai";

import { type AgentEventBus, getAgentEventBus } from "../../events/agent-event-bus.js";
import { type AgentEvent, createEvent } from "../../events/types.js";
import type { HarnessDecision, NativeProposal, OperationClass } from "../../gates/decisions.js";
import type { AgentLike, RunOptions, RunResult, RunnerProtocol } from "../types.js";
import { type DecisionValidation, validateDecision } from "./decision-validation.js";
import { assertGateRequirements } from "./gate-requirements.js";
import { HarnessEventTranslator, type HarnessRunAccounting } from "./harness-event-translator.js";
import type {
  AskRequestType,
  HarnessAdapter,
  HarnessEvent,
  HarnessRunRequest,
  HarnessSession,
  ProbeContext,
} from "./types.js";

// ---------------------------------------------------------------------------
// `_startRun` result (#368: cancelled-at-entry vs launched, discriminated on
// `cancelled` so `run()`/`stream()` narrow without an extra type guard).
// ---------------------------------------------------------------------------

type MessageStartEvent = AgentEvent & { type: "agent.message.start" };

interface StartRunCommon {
  readonly startEvent: MessageStartEvent;
  readonly model: string;
  readonly traceId: string;
  readonly runId: string;
  readonly parentSpanId?: string;
}

type StartRunPrep =
  | (StartRunCommon & { readonly cancelled: true })
  | (StartRunCommon & {
      readonly cancelled: false;
      readonly session: HarnessSession;
      readonly translator: HarnessEventTranslator;
    });

export abstract class CodingAgentRunner<TAgent extends AgentLike = AgentLike>
  implements RunnerProtocol
{
  protected _eventBus: AgentEventBus | undefined;

  constructor(eventBus?: AgentEventBus) {
    this._eventBus = eventBus;
  }

  /** Construct the per-CLI adapter this runner drives. */
  protected abstract createAdapter(): HarnessAdapter<TAgent>;

  /** Context for the run-start `probe()`. Override to feed cwd / hints. */
  protected probeContext(_agent: TAgent, _options?: RunOptions): ProbeContext {
    return {};
  }

  protected get eventBus(): AgentEventBus {
    if (!this._eventBus) {
      this._eventBus = getAgentEventBus();
    }
    return this._eventBus;
  }

  protected async emit(event: AgentEvent): Promise<void> {
    await this.eventBus.publish(event);
  }

  /**
   * The gate-evaluation seam handed to the adapter. Delegates to
   * {@link AgentEventBus.evaluateIntent}, which returns a definitive per-intent
   * {@link GateEvaluation} (the runner reads THIS intent's own outcome instead of
   * inferring block-vs-allow from a bus-wide subscription — #288). The rejection
   * event and the guaranteed audit phase are driven by `evaluateIntent`.
   */
  protected get intentEvaluator() {
    return this.eventBus.evaluateIntent.bind(this.eventBus);
  }

  /**
   * Validate a decision against a native ask before `respond()` (D4 / C1). The
   * decision-kind vocabulary comes from the ADAPTER (per request type), never the
   * wire's `availableDecisions` (presentation metadata). B-3 wires this into the
   * live respond path.
   */
  protected validateDecision(input: {
    decision: HarnessDecision;
    requestType: AskRequestType;
    proposals: readonly NativeProposal[];
    operation: OperationClass;
    durableEnabled: boolean;
  }): DecisionValidation {
    const adapter = this.createAdapter();
    return validateDecision({ ...input, vocabulary: adapter.decisionVocabulary });
  }

  // -------------------------------------------------------------------------
  // RunnerProtocol
  // -------------------------------------------------------------------------

  async run(agent: TAgent, message: string, options?: RunOptions): Promise<RunResult> {
    const prep = await this._startRun(agent, message, options, /* streaming */ false);
    const { startEvent, model, traceId, runId, parentSpanId } = prep;

    // #368 entry guard: an already-fired abortSignal never launches the
    // harness subprocess — `_startRun` skipped `adapter.start()` entirely.
    if (prep.cancelled) {
      return this._emitCancelledRun(startEvent, model);
    }
    const { session, translator } = prep;

    const cancelledRef = { value: false };
    try {
      for await (const hEvent of this._drainSession(session, options, cancelledRef)) {
        for (const apEvent of translator.translate(hEvent)) {
          await this.emit(apEvent);
        }
      }
    } catch (err) {
      await this._emitError(err, traceId, runId, parentSpanId);
      throw err;
    } finally {
      // Idempotent (a no-op if `_drainSession` already tore the session down
      // on abort) — also the ONLY teardown on the normal/error paths, unchanged.
      await session.close();
    }

    if (cancelledRef.value) {
      return this._emitCancelledRun(startEvent, model, translator);
    }

    const acc = translator.finalize();
    await this.emit(this._completeEvent(startEvent, acc, model));
    return this._result(acc);
  }

  async *stream(agent: TAgent, message: string, options?: RunOptions): AsyncGenerator<AgentEvent> {
    const prep = await this._startRun(agent, message, options, /* streaming */ true);
    const { startEvent, traceId, runId, parentSpanId } = prep;

    yield startEvent;

    // #368 entry guard — mirrors run()'s above. `message.start` still fired
    // (parity with AgentRunner.stream()'s posture), but nothing past it did.
    if (prep.cancelled) {
      yield* this._emitCancelSignal(traceId, runId, startEvent.spanId);
      return;
    }
    const { session, translator, model } = prep;

    const cancelledRef = { value: false };
    try {
      for await (const hEvent of this._drainSession(session, options, cancelledRef)) {
        for (const apEvent of translator.translate(hEvent)) {
          await this.emit(apEvent);
          yield apEvent;
        }
      }
    } catch (err) {
      await this._emitError(err, traceId, runId, parentSpanId);
      throw err;
    } finally {
      await session.close();
    }

    if (cancelledRef.value) {
      // #368: mirrors AgentRunner.stream()'s `emitCancellation` — emit
      // `agent.message.cancel` and skip `message.complete` for this turn (the
      // same accepted RunStoreExporter posture: a cancelled run's row stays
      // 'running' until `RunStore.sweepRunning()`, exactly as it already does
      // for AgentRunner's own cancel path). No `agent.conversation.end` here —
      // this base never emits conversation events on ANY path; that pairing
      // is `Conversation.stream()`'s job, one layer up, and it derives
      // "cancelled" from `options.signal.aborted` independent of what this
      // runner emits.
      yield* this._emitCancelSignal(traceId, runId, startEvent.spanId);
      return;
    }

    const acc = translator.finalize();
    const complete = this._completeEvent(startEvent, acc, model);
    await this.emit(complete);
    yield complete;
  }

  // -------------------------------------------------------------------------
  // #368 — abort plumbing
  // -------------------------------------------------------------------------

  /**
   * Drain `session`'s normalized `HarnessEvent` stream, racing every read
   * against `options.abortSignal` (#368). Sets `cancelledRef.value = true`
   * and ends (no throw) the moment the signal fires — either at the top of
   * the loop (a signal that fired between events) or mid-await (a signal that
   * fires while we're blocked waiting on the harness, which for CC can be an
   * arbitrarily long wait: Claude Code owns its own multi-turn tool loop
   * inside ONE subprocess, so unlike `AgentRunner` there is no per-LLM-call
   * boundary at this layer to check between).
   *
   * Actual subprocess termination is NOT this method's job: it only stops
   * pulling from `session`. The caller's existing `finally { await
   * session.close(); }` (unchanged on every exit path) does the real
   * teardown — `HarnessSession.close()` interrupts the harness's in-flight
   * turn and forcibly ends the session (for CC: SDK `interrupt()` then
   * `return()`, which closes the subprocess's stdin and — if it hasn't exited
   * within the SDK's own grace window — SIGTERMs then SIGKILLs it). Reusing
   * that single, already-idempotent teardown path (rather than calling
   * `close()` from here too) keeps there being exactly one place that decides
   * when the session is done.
   *
   * A rejection from the harness itself (a genuine error, not an abort) is
   * never swallowed: `guardedNext` converts it to a same-shaped resolved
   * value so it can safely lose a race against `abortWatch` with no
   * unhandled-rejection risk, then this method re-throws it once it wins —
   * propagating exactly as it did before this method existed, into the
   * caller's existing `catch`.
   */
  private async *_drainSession(
    session: HarnessSession,
    options: RunOptions | undefined,
    cancelledRef: { value: boolean },
  ): AsyncGenerator<HarnessEvent> {
    const signal = options?.abortSignal;
    // Resolves exactly once — reused across every race below, so a long
    // batch of events registers at most one `abort` listener regardless of
    // how many events stream through before (or instead of) it firing.
    // `undefined` when there's no signal to honor, so the loop below just
    // awaits each read directly (byte-identical to the pre-#368 behavior).
    const abortWatch: Promise<"aborted"> | undefined = !signal
      ? undefined
      : signal.aborted
        ? Promise.resolve("aborted" as const)
        : new Promise<"aborted">((resolve) => {
            signal.addEventListener("abort", () => resolve("aborted"), { once: true });
          });

    const iterator = session[Symbol.asyncIterator]();
    for (;;) {
      // Cheap top-of-loop guard (mirrors #341's amendment): never start
      // another wait on the harness once the signal has already fired.
      if (signal?.aborted) {
        cancelledRef.value = true;
        return;
      }

      const next = iterator.next();
      // Never rejects — a harness error becomes a same-shaped resolved value
      // so it's safe to lose the race below with no unhandled rejection.
      const guardedNext = next.then(
        (r) => ({ kind: "event" as const, r }),
        (err: unknown) => ({ kind: "error" as const, err }),
      );

      const winner = abortWatch
        ? await Promise.race([guardedNext, abortWatch.then(() => ({ kind: "abort" as const }))])
        : await guardedNext;

      if (winner.kind === "abort") {
        cancelledRef.value = true;
        return;
      }
      if (winner.kind === "error") {
        throw winner.err;
      }
      if (winner.r.done) return;
      yield winner.r.value;
    }
  }

  /** `run()`'s cancelled-`RunResult` path — entry guard AND mid-stream abort. */
  private async _emitCancelledRun(
    startEvent: MessageStartEvent,
    model: string,
    translator?: HarnessEventTranslator,
  ): Promise<RunResult> {
    // A mid-stream abort keeps whatever partial content/tokens the translator
    // already accrued (D5 posture: partial output the user already saw is
    // real, not discarded) rather than reporting a blanket empty result. An
    // entry-guard abort never launched a translator, so there's nothing to
    // accrue — content is honestly "".
    const acc: HarnessRunAccounting = translator
      ? { ...translator.finalize(), finishReason: "cancelled" }
      : {
          content: "",
          inputTokens: 0,
          outputTokens: 0,
          toolCallsCount: 0,
          iterations: 0,
          finishReason: "cancelled",
        };
    await this.emit(this._completeEvent(startEvent, acc, model));
    return this._result(acc);
  }

  /** `stream()`'s cancel signal — mirrors `AgentRunner`'s `agent.message.cancel`. */
  private async *_emitCancelSignal(
    traceId: string,
    runId: string,
    parentSpanId: string,
  ): AsyncGenerator<AgentEvent> {
    const cancelEvent = createEvent("agent.message.cancel", {
      traceId,
      runId,
      parentSpanId,
      reason: "cancelled by client",
    });
    await this.emit(cancelEvent);
    yield cancelEvent;
  }

  // -------------------------------------------------------------------------
  // Shared run setup
  // -------------------------------------------------------------------------

  private async _startRun(
    agent: TAgent,
    message: string,
    options: RunOptions | undefined,
    streaming: boolean,
  ): Promise<StartRunPrep> {
    if (options?.eventBus) {
      this._eventBus = options.eventBus;
    }

    const runId = options?.runId ?? generateId();
    const traceId = options?.traceId ?? runId;
    const correlationId = newCorrelationId();
    const parentSpanId = options?.parentSpanId;
    const model = agent.getModel() ?? "";

    const adapter = this.createAdapter();

    // Run-start GateRequirements compatibility check (§5.2): fail LOUD before the
    // session starts if a configured gate needs an interception/rewrite the
    // harness can't provide.
    const probe = await adapter.probe(this.probeContext(agent, options));
    assertGateRequirements(this.eventBus.gates, probe, adapter.name);

    const startEvent = createEvent("agent.message.start", {
      traceId,
      runId,
      parentSpanId,
      agentName: agent.role.name,
      agentConfig: {
        role: agent.role.name,
        model: agent.getModel(),
        tools: agent.getTools().map((t) => (t as { name?: string }).name ?? ""),
        runnerCorrelationId: correlationId,
      },
    }) as AgentEvent & { type: "agent.message.start" };
    await this.emit(startEvent);

    // #368 entry guard: an already-fired abortSignal must never be silently
    // ignored, and must never launch the harness subprocess in the first
    // place (mirrors AgentRunner's D1 posture, generalized to a harness that
    // has no cheap "top of iteration" boundary before its FIRST call — this
    // IS that boundary). `message.start` above still fires unconditionally —
    // parity with AgentRunner.run()/stream(), which do the same; only
    // `runStructured()` (not implemented by this base) skips it.
    if (options?.abortSignal?.aborted) {
      return { cancelled: true, startEvent, model, traceId, runId, parentSpanId };
    }

    const req: HarnessRunRequest<TAgent> = {
      agent,
      message,
      options,
      runId,
      traceId,
      parentSpanId,
      correlationId,
      streaming,
      evaluateIntent: this.intentEvaluator,
    };
    const session = await adapter.start(req);

    const translator = new HarnessEventTranslator({
      traceId,
      runId,
      parentSpanId,
      harnessName: adapter.name,
      fallbackModel: model,
      hasTools: agent.getTools().length > 0,
      maxIterations: options?.maxIterations ?? 10,
      streaming,
    });

    return {
      cancelled: false,
      session,
      translator,
      startEvent,
      model,
      traceId,
      runId,
      parentSpanId,
    };
  }

  private _completeEvent(
    startEvent: AgentEvent & { type: "agent.message.start" },
    acc: ReturnType<HarnessEventTranslator["finalize"]>,
    model: string,
  ): AgentEvent {
    return createEvent("agent.message.complete", {
      traceId: startEvent.traceId,
      runId: startEvent.runId,
      spanId: startEvent.spanId,
      parentSpanId: startEvent.spanId,
      content: acc.content,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      model,
      finishReason: acc.finishReason,
      ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
    });
  }

  private _result(acc: ReturnType<HarnessEventTranslator["finalize"]>): RunResult {
    return {
      response: acc.content,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      toolCallsCount: acc.toolCallsCount,
      iterations: acc.iterations,
      finishReason: acc.finishReason,
      ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
    };
  }

  private async _emitError(
    err: unknown,
    traceId: string,
    runId: string,
    parentSpanId: string | undefined,
  ): Promise<void> {
    const error = err instanceof Error ? err : new Error(String(err));
    await this.emit(
      createEvent("agent.error", {
        traceId,
        runId,
        parentSpanId,
        errorType: error.name,
        message: error.message,
        recoverable: false,
        context: {},
      }),
    );
  }
}

/** Mint a per-run correlation id (crypto.randomUUID where available). */
export function newCorrelationId(): string {
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
