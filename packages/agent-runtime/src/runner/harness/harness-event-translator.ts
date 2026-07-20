/**
 * Harness-agnostic normalized-event → AgentEvent translation (design §5.1/§5.3).
 *
 * The base half of the two-layer translation seam: an adapter turns its native
 * message stream into normalized {@link HarnessEvent}s; THIS translator turns
 * those into the canonical AgentEvent stream and accrues run accounting. One
 * place constructs AP events — adapters never touch the bus.
 *
 * Provenance (D12): AP iteration boundaries have no native analogue on any
 * harness — they are a framework concept synthesized over the stream — so
 * `iteration.start`/`iteration.end` are ALWAYS `meta.synthetic`. `llm.start` is
 * synthetic UNLESS the adapter observed a real per-call start signal
 * (`turn-start` carrying `meta.observed: true`, e.g. CC's streaming
 * `message_start`). `llm.end` is observed testimony and never marked.
 *
 * Tool events: CC emits `agent.tool.start`/`end` out of band via its SDK hooks
 * (synchronous gating; see the CC adapter), so for CC the `tool-start`/`tool-end`
 * HarnessEvent variants do not appear. They ARE translated here for harnesses
 * that stream tool events (Codex, B-4) — span-correlated by native `itemId`.
 */

import { type AgentEvent, createEvent } from "../../events/types.js";
import type { HarnessEvent } from "./types.js";

export interface HarnessTranslatorContext {
  readonly traceId: string;
  readonly runId: string;
  readonly parentSpanId?: string;
  /** Harness id stamped on `harness.native` events (e.g. "claude-code"). */
  readonly harnessName: string;
  /** Fallback model label when an event carries none. */
  readonly fallbackModel: string;
  /** Whether the agent exposes tools — feeds `agent.llm.start.hasTools`. */
  readonly hasTools: boolean;
  /** Cap for `agent.iteration.start.maxIterations`. */
  readonly maxIterations: number;
  /** True for `stream()`: text increments additionally surface as message.chunk. */
  readonly streaming: boolean;
}

/** Run-level accounting accrued across the normalized stream. */
export interface HarnessRunAccounting {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
  readonly toolCallsCount: number;
  readonly iterations: number;
  readonly finishReason: string;
}

export class HarnessEventTranslator {
  private readonly ctx: HarnessTranslatorContext;

  // Content accumulation
  private readonly contentParts: string[] = [];
  private chunkIndex = 0;

  // Run accounting
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd: number | undefined;
  private toolCallsMade = 0;
  private finishReason = "unknown";
  private reportedTurns: number | undefined;
  private finalTextFallback: string | undefined;

  // Iteration / llm state
  private syntheticIterations = 0;
  private llmStartedAt = 0;
  private turnToolBlocks = 0;

  // Stream-sourced tool span correlation (Codex path)
  private readonly toolSpans = new Map<string, { spanId: string; startedAt: number }>();

  constructor(ctx: HarnessTranslatorContext) {
    this.ctx = ctx;
  }

  /** Translate one normalized harness event into the AgentEvents it produces. */
  translate(event: HarnessEvent): AgentEvent[] {
    switch (event.kind) {
      case "turn-start":
        return this.onTurnStart(event);
      case "text-delta":
        return this.onTextDelta(event);
      case "reasoning":
        return [this.reasoning(event.text)];
      case "llm-response":
        return this.onLlmResponse(event);
      case "turn-end":
        return this.onTurnEnd(event);
      case "tool-start":
        return this.onToolStart(event);
      case "tool-end":
        return this.onToolEnd(event);
      case "file-change":
        return [this.harnessNative("file-change", event.diff)];
      case "harness-native":
        return [this.harnessNative(event.name, event.payload)];
      case "terminal":
        this.onTerminal(event);
        return [];
      // Ask events are handled by the permission bridge (B-3), not translated to
      // AP events here. CC gates via hooks and raises none in B-2.
      case "approval-request":
      case "permission-request":
        return [];
      default:
        return [];
    }
  }

  /**
   * Final run accounting + the one-shot iteration↔`numTurns` reconciliation
   * (D2: mismatch LOGS, never throws — a wrong count is telemetry, not a run
   * failure). Call once after the stream drains.
   */
  finalize(): HarnessRunAccounting {
    if (this.reportedTurns !== undefined && this.reportedTurns !== this.syntheticIterations) {
      console.warn(
        `[agentic-patterns] CodingAgentRunner: synthesized ${this.syntheticIterations} iteration boundary(ies) but the harness reported num_turns=${this.reportedTurns}. Iteration events are best-effort (meta.synthetic); RunResult.iterations follows num_turns.`,
      );
    }
    const content =
      this.contentParts.length > 0 ? this.contentParts.join("") : (this.finalTextFallback ?? "");
    return {
      content,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      toolCallsCount: this.toolCallsMade,
      iterations: this.reportedTurns ?? this.syntheticIterations,
      finishReason: this.finishReason,
    };
  }

  // -------------------------------------------------------------------------
  // Per-kind handlers
  // -------------------------------------------------------------------------

  private onTurnStart(event: Extract<HarnessEvent, { kind: "turn-start" }>): AgentEvent[] {
    this.syntheticIterations++;
    this.llmStartedAt = Date.now();
    this.turnToolBlocks = 0;
    const observed = event.meta?.observed === true;
    const model = (event.meta?.model as string | undefined) || this.ctx.fallbackModel;

    return [
      createEvent("agent.iteration.start", {
        traceId: this.ctx.traceId,
        runId: this.ctx.runId,
        parentSpanId: this.ctx.parentSpanId,
        iteration: this.syntheticIterations,
        maxIterations: this.ctx.maxIterations,
        meta: { synthetic: true },
      }),
      createEvent("agent.llm.start", {
        traceId: this.ctx.traceId,
        runId: this.ctx.runId,
        parentSpanId: this.ctx.parentSpanId,
        model,
        // Best-effort: the real request message count isn't surfaced per call.
        messageCount: this.syntheticIterations,
        hasTools: this.ctx.hasTools,
        ...(observed ? {} : { meta: { synthetic: true } }),
      }),
    ];
  }

  private onTextDelta(event: Extract<HarnessEvent, { kind: "text-delta" }>): AgentEvent[] {
    if (!event.text) return [];
    this.contentParts.push(event.text);
    // Content always accrues; a message.chunk is a STREAMING surface only.
    if (!this.ctx.streaming) return [];
    const chunk = createEvent("agent.message.chunk", {
      traceId: this.ctx.traceId,
      runId: this.ctx.runId,
      parentSpanId: this.ctx.parentSpanId,
      delta: event.text,
      chunkIndex: this.chunkIndex,
    });
    this.chunkIndex++;
    return [chunk];
  }

  private onLlmResponse(event: Extract<HarnessEvent, { kind: "llm-response" }>): AgentEvent[] {
    const toolBlocks = (event.meta?.toolCallsCount as number | undefined) ?? 0;
    this.turnToolBlocks = toolBlocks;
    this.toolCallsMade += toolBlocks;
    return [
      createEvent("agent.llm.end", {
        traceId: this.ctx.traceId,
        runId: this.ctx.runId,
        parentSpanId: this.ctx.parentSpanId,
        model: event.model || this.ctx.fallbackModel,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        durationMs: Math.max(0, Date.now() - this.llmStartedAt),
        hasToolCalls: toolBlocks > 0,
        finishReason: event.stopReason || "unknown",
      }),
    ];
  }

  private onTurnEnd(event: Extract<HarnessEvent, { kind: "turn-end" }>): AgentEvent[] {
    const hasMore = event.meta?.hasMore === true;
    return [
      createEvent("agent.iteration.end", {
        traceId: this.ctx.traceId,
        runId: this.ctx.runId,
        parentSpanId: this.ctx.parentSpanId,
        iteration: this.syntheticIterations,
        toolCallsCount: this.turnToolBlocks > 0 ? 1 : 0,
        hasMore,
        meta: { synthetic: true },
      }),
    ];
  }

  private onToolStart(event: Extract<HarnessEvent, { kind: "tool-start" }>): AgentEvent[] {
    const itemId = event.ids.itemId ?? `${Date.now().toString(36)}-${this.toolSpans.size}`;
    const args =
      typeof event.args === "object" && event.args !== null
        ? (event.args as Record<string, unknown>)
        : {};
    const startEvent = createEvent("agent.tool.start", {
      runId: this.ctx.runId,
      traceId: this.ctx.traceId,
      parentSpanId: this.ctx.parentSpanId,
      toolCallId: itemId,
      toolName: event.name,
      arguments: args,
    });
    this.toolSpans.set(itemId, { spanId: startEvent.spanId, startedAt: Date.now() });
    return [startEvent];
  }

  private onToolEnd(event: Extract<HarnessEvent, { kind: "tool-end" }>): AgentEvent[] {
    const itemId = event.ids.itemId ?? "";
    const span = this.toolSpans.get(itemId);
    this.toolSpans.delete(itemId);
    return [
      createEvent("agent.tool.end", {
        runId: this.ctx.runId,
        traceId: this.ctx.traceId,
        parentSpanId: this.ctx.parentSpanId,
        toolCallId: itemId,
        toolName: event.name,
        arguments: {},
        result: event.result,
        durationMs: event.durationMs,
        resultTokens: 0,
        ...(span ? { spanId: span.spanId } : {}),
      }),
    ];
  }

  private onTerminal(event: Extract<HarnessEvent, { kind: "terminal" }>): void {
    this.inputTokens = event.usage.inputTokens;
    this.outputTokens = event.usage.outputTokens;
    this.costUsd = event.costUsd;
    this.reportedTurns = event.numTurns;
    this.finishReason = event.finishReason;
    const finalText = event.meta?.finalText;
    if (typeof finalText === "string") this.finalTextFallback = finalText;
  }

  // -------------------------------------------------------------------------
  // Shared constructors
  // -------------------------------------------------------------------------

  private reasoning(text: string): AgentEvent {
    return createEvent("agent.reasoning", {
      traceId: this.ctx.traceId,
      runId: this.ctx.runId,
      parentSpanId: this.ctx.parentSpanId,
      content: text,
      isComplete: true,
    });
  }

  private harnessNative(name: string, raw: unknown): AgentEvent {
    return createEvent("harness.native", {
      traceId: this.ctx.traceId,
      runId: this.ctx.runId,
      parentSpanId: this.ctx.parentSpanId,
      harness: this.ctx.harnessName,
      name,
      payload: raw as Record<string, unknown>,
    });
  }
}
