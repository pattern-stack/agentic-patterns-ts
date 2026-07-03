/**
 * RunStoreExporter — the general bus-finish hook: one `runs` row per run.
 *
 * Sibling of {@link SQLiteExporter} but dispatches via `BaseExporter`'s
 * `_on<Suffix>` (not a generic `handleEvent` override) — it reacts to the
 * bus's run-lifecycle events specifically, not every event on the profile.
 * `profile = EventProfile.OBSERVABILITY`: everything needed to fold a run
 * aggregate, no `message.chunk` deltas.
 *
 * Per-run state machine keyed by `runId` (every event carries it — nested
 * sub-agent runs on the same bus each get their own row for free; `traceId`
 * ties a multi-agent trace together):
 *   - `message.start`            → open the row (status 'running') + an
 *                                   in-memory accumulator.
 *   - `llm.end` / `tool.end`     → fold into the accumulator's current
 *                                   iteration.
 *   - `iteration.end`            → push one step-metrics entry, reset the
 *                                   current-iteration accumulator.
 *   - `message.complete`         → finalize status 'ok'.
 *   - `error` (recoverable: false) → finalize status 'error'. Recoverable
 *                                   errors fold into nothing and don't
 *                                   finalize.
 *
 * First terminal event wins — a later terminal for the same `runId` is
 * ignored (the accumulator is already deleted). `maxOpenRuns` (default 1000,
 * evict-oldest) bounds orphan growth in long-lived processes; rows left
 * 'running' (evicted, or the process died) are swept by `RunStore.sweepRunning()`.
 *
 * Best-effort like SQLiteExporter: every handler body is try/caught into an
 * `onError` callback (default stderr) — a misbehaving store must never break
 * the bus.
 */

import { EventProfile } from "../events/event-profiles.js";
import type {
  BaseEvent,
  ErrorEvent,
  IterationEndEvent,
  LLMCallEndEvent,
  MessageCompleteEvent,
  MessageStartEvent,
  ToolCallEndEvent,
} from "../events/types.js";
import type { RunStore } from "../storage/run-store.js";
import { BaseExporter } from "./base.js";

// ---------------------------------------------------------------------------
// Per-run accumulator
// ---------------------------------------------------------------------------

interface IterationAccumulator {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  llmDurationMs: number;
}

interface StepMetric extends IterationAccumulator {
  readonly iteration: number;
  readonly hasMore: boolean;
}

interface RunAccumulator {
  /** Event-clock start (not wall-clock) — elapsedMs is deterministic in tests. */
  readonly tsStart: Date;
  toolCalls: number;
  currentIteration: IterationAccumulator;
  stepMetrics: StepMetric[];
  lastFinishReason?: string;
}

function emptyIteration(): IterationAccumulator {
  return { inputTokens: 0, outputTokens: 0, toolCalls: 0, llmDurationMs: 0 };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class RunStoreExporter extends BaseExporter {
  override profile = EventProfile.OBSERVABILITY;

  private readonly _store: RunStore;
  // Named _reportError (not _onError): BaseExporter's dispatch would resolve
  // "agent.error" to a handler method literally named `_onError` — a field
  // of that name would collide with it.
  private readonly _reportError: (err: unknown, event: BaseEvent) => void;
  private readonly _maxOpenRuns: number;
  private readonly _open = new Map<string, RunAccumulator>();

  constructor(opts: {
    store: RunStore;
    onError?: (err: unknown, event: BaseEvent) => void;
    /** Bound on concurrently-open run accumulators (evict-oldest). Default 1000. */
    maxOpenRuns?: number;
  }) {
    super();
    this._store = opts.store;
    this._maxOpenRuns = opts.maxOpenRuns ?? 1000;
    this._reportError =
      opts.onError ??
      ((err, event) => {
        const msg = (err as Error)?.message ?? String(err);
        process.stderr.write(`[run-store-exporter] failed to persist ${event.type}: ${msg}\n`);
      });
  }

  /** @internal */
  async _onMessageStart(event: MessageStartEvent): Promise<void> {
    try {
      this._evictOldestIfFull();
      const model =
        typeof event.agentConfig?.model === "string" ? event.agentConfig.model : undefined;
      this._store.startRun({
        runId: event.runId,
        traceId: event.traceId,
        tsStart: event.timestamp,
        agentName: event.agentName,
        model,
        systemPrompt: event.systemPrompt,
        agentConfig: event.agentConfig,
      });
      this._open.set(event.runId, {
        tsStart: event.timestamp,
        toolCalls: 0,
        currentIteration: emptyIteration(),
        stepMetrics: [],
      });
    } catch (err) {
      this._reportError(err, event);
    }
  }

  /** @internal */
  async _onLlmEnd(event: LLMCallEndEvent): Promise<void> {
    try {
      const acc = this._open.get(event.runId);
      if (!acc) return;
      acc.currentIteration.inputTokens += event.inputTokens;
      acc.currentIteration.outputTokens += event.outputTokens;
      acc.currentIteration.llmDurationMs += event.durationMs;
      acc.lastFinishReason = event.finishReason;
    } catch (err) {
      this._reportError(err, event);
    }
  }

  /** @internal */
  async _onToolEnd(event: ToolCallEndEvent): Promise<void> {
    try {
      const acc = this._open.get(event.runId);
      if (!acc) return;
      acc.toolCalls++;
      acc.currentIteration.toolCalls++;
    } catch (err) {
      this._reportError(err, event);
    }
  }

  /** @internal */
  async _onIterationEnd(event: IterationEndEvent): Promise<void> {
    try {
      const acc = this._open.get(event.runId);
      if (!acc) return;
      acc.stepMetrics.push({
        iteration: event.iteration,
        hasMore: event.hasMore,
        ...acc.currentIteration,
      });
      acc.currentIteration = emptyIteration();
    } catch (err) {
      this._reportError(err, event);
    }
  }

  /** @internal */
  async _onMessageComplete(event: MessageCompleteEvent): Promise<void> {
    try {
      const acc = this._open.get(event.runId);
      if (!acc) return; // first-terminal-wins guard (evicted or already finalized)
      this._open.delete(event.runId);
      this._store.finishRun(event.runId, {
        finalAnswer: event.content,
        toolCalls: acc.toolCalls,
        iterations: acc.stepMetrics.length,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        finishReason: event.finishReason ?? acc.lastFinishReason ?? "stop",
        elapsedMs: event.timestamp.getTime() - acc.tsStart.getTime(),
        status: "ok",
        stepMetrics: acc.stepMetrics,
      });
    } catch (err) {
      this._reportError(err, event);
    }
  }

  /** @internal */
  async _onError(event: ErrorEvent): Promise<void> {
    try {
      if (event.recoverable) return; // recoverable errors don't finalize
      const acc = this._open.get(event.runId);
      if (!acc) return; // first-terminal-wins guard
      this._open.delete(event.runId);
      this._store.finishRun(event.runId, {
        finalAnswer: "",
        toolCalls: acc.toolCalls,
        iterations: acc.stepMetrics.length,
        inputTokens: acc.currentIteration.inputTokens,
        outputTokens: acc.currentIteration.outputTokens,
        finishReason: acc.lastFinishReason ?? "error",
        elapsedMs: event.timestamp.getTime() - acc.tsStart.getTime(),
        status: "error",
        error: event.message,
        stepMetrics: acc.stepMetrics,
      });
    } catch (err) {
      this._reportError(err, event);
    }
  }

  private _evictOldestIfFull(): void {
    if (this._open.size < this._maxOpenRuns) return;
    const oldest = this._open.keys().next().value; // Map iterates in insertion order
    if (oldest !== undefined) this._open.delete(oldest);
  }
}
