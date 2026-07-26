/**
 * Langfuse exporter - LLM observability with traces and generations.
 *
 * Exports agent events to Langfuse for LLM-specific observability
 * including traces, generations (LLM calls), and spans (tool calls).
 *
 * Requires @langfuse/langfuse as an optional peer dependency.
 *
 * Ported from Python: systems/exporters/langfuse.py
 */

import { EventProfile } from "../events/event-profiles.js";
import type {
  ErrorEvent,
  GateDecisionEvent,
  IterationEndEvent,
  IterationStartEvent,
  LLMCallEndEvent,
  LLMCallStartEvent,
  MessageCompleteEvent,
  MessageStartEvent,
  ReasoningEvent,
  TokenUsageDetails,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "../events/types.js";
import { BaseExporter } from "./base.js";

/**
 * #388 — builds the Langfuse `usage_details` dict, applying Langfuse's own
 * ingestion contract: usage-detail keys are MUTUALLY EXCLUSIVE buckets (each
 * token counted in exactly one key); the UI/cost-inference then sums every
 * key containing "input"/"output" back into the displayed totals (verified
 * against Langfuse's `token-and-cost-tracking` docs, "Usage types are
 * mutually exclusive buckets" section, and its own worked example converting
 * inclusive provider counts into exclusive stored buckets).
 *
 * `@ai-sdk/anthropic@4` reports `inputTokens` INCLUSIVE of cache read+write
 * (verified: `total = input_tokens + cacheCreationTokens + cacheReadTokens`),
 * so sending `event.inputTokens` as `input` while ALSO sending
 * `cache_read_input_tokens`/`cache_creation_input_tokens` would double-bill —
 * this computes the true exclusive `input` (= `noCacheTokens`) instead. The
 * same exclusivity applies symmetrically on the output side: `outputTokens`
 * is inclusive of reasoning tokens, so `output` here is the exclusive
 * non-reasoning (`textTokens`) count, with `output_reasoning_tokens` as its
 * own bucket — both "input"-substring and "output"-substring keys still
 * aggregate correctly in Langfuse's UI/cost display.
 *
 * When `details` is absent, this is byte-identical to the pre-#388 shape
 * (`{ input, output }`) — non-reporting providers are untouched.
 */
export function buildLangfuseUsageDetails(
  inputTokens: number,
  outputTokens: number,
  details: TokenUsageDetails | undefined,
): Record<string, number> {
  if (!details) {
    return { input: inputTokens, output: outputTokens };
  }

  const input =
    details.noCacheTokens ??
    inputTokens - (details.cacheReadTokens ?? 0) - (details.cacheWriteTokens ?? 0);
  const output = details.textTokens ?? outputTokens - (details.reasoningTokens ?? 0);

  return {
    input,
    output,
    ...(details.cacheReadTokens !== undefined
      ? { cache_read_input_tokens: details.cacheReadTokens }
      : {}),
    ...(details.cacheWriteTokens !== undefined
      ? { cache_creation_input_tokens: details.cacheWriteTokens }
      : {}),
    ...(details.reasoningTokens !== undefined
      ? { output_reasoning_tokens: details.reasoningTokens }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Langfuse client interface (minimal shape)
// ---------------------------------------------------------------------------

/**
 * Minimal interface for Langfuse client.
 *
 * Users provide the real Langfuse client from @langfuse/langfuse.
 * We define this interface to avoid a hard dependency.
 */
export interface LangfuseClient {
  startSpan(params: Record<string, unknown>): LangfuseSpan;
  flush(): void;
}

/** Minimal Langfuse span interface. */
export interface LangfuseSpan {
  startSpan(params: Record<string, unknown>): LangfuseSpan;
  startObservation(params: Record<string, unknown>): LangfuseObservation;
  update(params: Record<string, unknown>): void;
  updateTrace(params: Record<string, unknown>): void;
  end(): void;
}

/** Minimal Langfuse observation interface. */
export interface LangfuseObservation {
  update(params: Record<string, unknown>): void;
  end(): void;
}

// ---------------------------------------------------------------------------
// LangfuseExporter
// ---------------------------------------------------------------------------

/**
 * Export agent events to Langfuse for LLM observability.
 *
 * Maps the agent event hierarchy to Langfuse concepts:
 *   - MessageStart -> Root span (creates trace implicitly)
 *   - LLM calls -> Generation (nested under root/iteration span)
 *   - Tool calls -> Generation (nested under root/iteration span)
 *   - MessageComplete -> Trace update with final output
 */
export class LangfuseExporter extends BaseExporter {
  override profile = EventProfile.OBSERVABILITY;

  private langfuse: LangfuseClient;
  private captureContent: boolean;
  private _rootSpans = new Map<string, LangfuseSpan>();
  private _iterationSpans = new Map<string, LangfuseSpan>();
  private _generations = new Map<string, LangfuseObservation>();
  private _spans = new Map<string, LangfuseObservation>();
  private _traceInputSet = new Set<string>();
  private _iterToolNames = new Map<string, string[]>();
  private _iterOutputTokens = new Map<string, number>();
  private _iterUserMessage = new Map<string, string | undefined>();
  private _prevIterToolNames = new Map<string, string[]>();

  constructor(options: {
    client: LangfuseClient;
    captureContent?: boolean;
  }) {
    super();
    this.langfuse = options.client;
    this.captureContent = options.captureContent ?? true;
  }

  private _toHexId(uuidStr: string): string {
    return uuidStr.replace(/-/g, "").toLowerCase();
  }

  /** @internal */
  async _onMessageStart(event: MessageStartEvent): Promise<void> {
    const traceName = event.agentName || "agent.run";
    const runId = event.runId;
    const parentSpanId = event.parentSpanId;

    let rootSpan: LangfuseSpan;
    if (parentSpanId) {
      const traceId = this._toHexId(event.traceId || runId);
      rootSpan = this.langfuse.startSpan({
        trace_context: {
          trace_id: traceId,
          parent_span_id: this._toHexId(parentSpanId),
        },
        name: "agent.run",
        metadata: { run_id: runId },
      });
    } else {
      rootSpan = this.langfuse.startSpan({
        name: "agent.run",
        metadata: { run_id: runId },
      });
    }

    rootSpan.updateTrace({ name: traceName });

    if (event.agentConfig) {
      rootSpan.update({ input: event.agentConfig });
    }

    this._rootSpans.set(runId, rootSpan);
  }

  /** @internal */
  async _onIterationStart(event: IterationStartEvent): Promise<void> {
    const rootSpan = this._rootSpans.get(event.runId);
    if (rootSpan) {
      const iterSpan = rootSpan.startSpan({
        name: `iteration.${event.iteration}`,
        metadata: {
          iteration: event.iteration,
          max_iterations: event.maxIterations,
        },
      });
      this._iterationSpans.set(event.runId, iterSpan);
      this._iterToolNames.set(event.runId, []);
      this._iterOutputTokens.set(event.runId, 0);
    }
  }

  /** @internal */
  async _onIterationEnd(event: IterationEndEvent): Promise<void> {
    const iterSpan = this._iterationSpans.get(event.runId);
    this._iterationSpans.delete(event.runId);

    if (iterSpan) {
      let iterInput: string | undefined;
      let iterOutput: string | undefined;

      if (this.captureContent) {
        const prevTools = this._prevIterToolNames.get(event.runId);
        if (prevTools && prevTools.length > 0) {
          iterInput = `Tool results from: ${prevTools.join(", ")}`;
        } else {
          iterInput = this._iterUserMessage.get(event.runId) ?? undefined;
        }

        const toolNames = this._iterToolNames.get(event.runId) ?? [];
        const outputTokens = this._iterOutputTokens.get(event.runId) ?? 0;
        if (toolNames.length > 0) {
          iterOutput = `Called tools: ${toolNames.join(", ")}`;
        } else {
          iterOutput = `Final response (${outputTokens} tokens)`;
        }
      }

      const toolNames = this._iterToolNames.get(event.runId) ?? [];
      this._iterToolNames.delete(event.runId);
      if (toolNames.length > 0) {
        this._prevIterToolNames.set(event.runId, toolNames);
      } else {
        this._prevIterToolNames.delete(event.runId);
      }
      this._iterOutputTokens.delete(event.runId);

      iterSpan.update({
        input: iterInput,
        output: iterOutput,
        metadata: {
          iteration: event.iteration,
          tool_calls_count: event.toolCallsCount,
          has_more: event.hasMore,
        },
      });
      iterSpan.end();
    }
  }

  /** @internal */
  async _onLlmStart(event: LLMCallStartEvent): Promise<void> {
    const parent = this._iterationSpans.get(event.runId) ?? this._rootSpans.get(event.runId);
    if (parent) {
      const generation = parent.startObservation({
        as_type: "generation",
        name: "llm.call",
        model: event.model,
      });
      this._generations.set(event.spanId, generation);
    }
  }

  /** @internal */
  async _onLlmEnd(event: LLMCallEndEvent): Promise<void> {
    const generation = this._generations.get(event.spanId);
    this._generations.delete(event.spanId);

    if (generation) {
      generation.update({
        usage_details: buildLangfuseUsageDetails(
          event.inputTokens,
          event.outputTokens,
          event.usageDetails,
        ),
        metadata: { finish_reason: event.finishReason },
      });
      generation.end();

      if (this._iterOutputTokens.has(event.runId)) {
        this._iterOutputTokens.set(event.runId, event.outputTokens);
      }
    }
  }

  /** @internal */
  async _onToolStart(event: ToolCallStartEvent): Promise<void> {
    const toolNames = this._iterToolNames.get(event.runId);
    if (toolNames) {
      toolNames.push(event.toolName);
    }

    const parent = this._iterationSpans.get(event.runId) ?? this._rootSpans.get(event.runId);
    if (parent) {
      const observation = parent.startObservation({
        as_type: "generation",
        name: `tool.${event.toolName}`,
        input: this.captureContent ? event.arguments : undefined,
      });
      this._spans.set(event.spanId, observation);
    }
  }

  /** @internal */
  async _onToolEnd(event: ToolCallEndEvent): Promise<void> {
    const observation = this._spans.get(event.spanId);
    this._spans.delete(event.spanId);

    if (observation) {
      const metadata: Record<string, unknown> = {
        duration_ms: event.durationMs,
      };
      if (event.resultTokens) {
        metadata.result_tokens = event.resultTokens;
      }

      const updateKwargs: Record<string, unknown> = {
        output: this.captureContent ? event.result : undefined,
        metadata,
      };
      if (event.resultTokens) {
        updateKwargs.usage_details = {
          output: event.resultTokens,
          total: event.resultTokens,
        };
      }

      observation.update(updateKwargs);
      observation.end();
    }
  }

  /** @internal */
  async _onReasoning(event: ReasoningEvent): Promise<void> {
    if (!event.isComplete) return;

    const parent = this._iterationSpans.get(event.runId) ?? this._rootSpans.get(event.runId);
    if (parent) {
      const reasoningSpan = parent.startSpan({
        name: "reasoning",
        output: this.captureContent ? event.content : undefined,
      });
      reasoningSpan.end();
    }
  }

  /** @internal */
  async _onError(event: ErrorEvent): Promise<void> {
    const parent = this._iterationSpans.get(event.runId) ?? this._rootSpans.get(event.runId);
    if (parent) {
      const errorSpan = parent.startSpan({
        name: "error",
        input: { error_type: event.errorType, message: event.message },
        level: "ERROR",
      });
      errorSpan.end();
    }
  }

  /** @internal */
  async _onMessageComplete(event: MessageCompleteEvent): Promise<void> {
    this._traceInputSet.delete(event.runId);
    this._iterUserMessage.delete(event.runId);
    this._prevIterToolNames.delete(event.runId);
    this._iterToolNames.delete(event.runId);
    this._iterOutputTokens.delete(event.runId);

    const rootSpan = this._rootSpans.get(event.runId);
    this._rootSpans.delete(event.runId);

    if (rootSpan) {
      const update: Record<string, unknown> = {
        output: this.captureContent ? event.content : undefined,
      };
      // #324: map the harness-reported run cost to Langfuse's cost attribute
      // (`cost_details.total`) when the runner supplied one. Absent-cost runners
      // (e.g. AgentRunner) leave the field off — Langfuse then infers from usage.
      if (event.costUsd !== undefined) {
        update.cost_details = { total: event.costUsd };
      }
      rootSpan.update(update);
      const d = event.usageDetails;
      rootSpan.updateTrace({
        output: this.captureContent ? event.content : undefined,
        metadata: {
          input_tokens: event.inputTokens,
          output_tokens: event.outputTokens,
          model: event.model,
          ...(event.costUsd !== undefined ? { cost_usd: event.costUsd } : {}),
          // #388: run-total detail — plain informational trace metadata (not
          // the `usage_details` cost-inference bucket, so no exclusivity
          // arithmetic needed here, unlike `_onLlmEnd` above).
          ...(d?.noCacheTokens !== undefined ? { no_cache_tokens: d.noCacheTokens } : {}),
          ...(d?.cacheReadTokens !== undefined
            ? { cache_read_input_tokens: d.cacheReadTokens }
            : {}),
          ...(d?.cacheWriteTokens !== undefined
            ? { cache_creation_input_tokens: d.cacheWriteTokens }
            : {}),
          ...(d?.textTokens !== undefined ? { text_tokens: d.textTokens } : {}),
          ...(d?.reasoningTokens !== undefined
            ? { output_reasoning_tokens: d.reasoningTokens }
            : {}),
        },
      });
      rootSpan.end();
    }
  }

  /**
   * @internal
   * Gate-decision audit signal (F-2, #324) — surfaced as a short span under the
   * run's root/iteration parent so a Langfuse trace shows every allow/block
   * decision, its provenance, and the evaluation trail. Requires
   * `agent.gate.decision` in the OBSERVABILITY profile (event-profiles.ts).
   */
  async _onGateDecision(event: GateDecisionEvent): Promise<void> {
    const parent = this._iterationSpans.get(event.runId) ?? this._rootSpans.get(event.runId);
    if (parent) {
      const gateSpan = parent.startSpan({
        name: "gate.decision",
        input: { tool_name: event.toolName },
        metadata: {
          outcome: event.outcome,
          settled_by: event.settledBy,
          decision_kind: event.decisionKind,
          blocked_by: event.blockedBy,
          reason: event.reason,
          trail: event.trail,
        },
        level: event.outcome === "block" ? "WARNING" : "DEFAULT",
      });
      gateSpan.end();
    }
  }

  /** Flush pending events to Langfuse. */
  flush(): void {
    this.langfuse.flush();
  }
}
