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
 *  - the D4/C1 decision-validation helper.
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
import { HarnessEventTranslator } from "./harness-event-translator.js";
import type {
  AskRequestType,
  HarnessAdapter,
  HarnessRunRequest,
  HarnessSession,
  ProbeContext,
} from "./types.js";

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
    const { session, translator, startEvent, model, traceId, runId, parentSpanId } = prep;

    try {
      for await (const hEvent of session) {
        for (const apEvent of translator.translate(hEvent)) {
          await this.emit(apEvent);
        }
      }
    } catch (err) {
      await this._emitError(err, traceId, runId, parentSpanId);
      throw err;
    } finally {
      await session.close();
    }

    const acc = translator.finalize();
    await this.emit(this._completeEvent(startEvent, acc, model));
    return this._result(acc);
  }

  async *stream(agent: TAgent, message: string, options?: RunOptions): AsyncGenerator<AgentEvent> {
    const prep = await this._startRun(agent, message, options, /* streaming */ true);
    const { session, translator, startEvent, model, traceId, runId, parentSpanId } = prep;

    yield startEvent;

    try {
      for await (const hEvent of session) {
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

    const acc = translator.finalize();
    const complete = this._completeEvent(startEvent, acc, model);
    await this.emit(complete);
    yield complete;
  }

  // -------------------------------------------------------------------------
  // Shared run setup
  // -------------------------------------------------------------------------

  private async _startRun(
    agent: TAgent,
    message: string,
    options: RunOptions | undefined,
    streaming: boolean,
  ): Promise<{
    session: HarnessSession;
    translator: HarnessEventTranslator;
    startEvent: AgentEvent & { type: "agent.message.start" };
    model: string;
    traceId: string;
    runId: string;
    parentSpanId?: string;
  }> {
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

    return { session, translator, startEvent, model, traceId, runId, parentSpanId };
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
