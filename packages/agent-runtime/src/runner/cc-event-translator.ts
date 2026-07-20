/**
 * CC SDK-message translator (#323, B-1 / design.md §5.3, §2 D2/D12).
 *
 * ONE shared translation path from the Claude Agent SDK's native message
 * stream to the canonical AgentEvent stream, consumed by BOTH
 * `ClaudeCodeRunner.run()` and `.stream()`. Keeping it single-sourced is the
 * point: the two surfaces previously duplicated (and drifted on) their message
 * handling. Each `translate(msg)` returns the AgentEvents that message yields
 * (the runner emits them, and `stream()` additionally yields them); mutable
 * run accounting accrues on the instance and is read back via `finalize()`.
 *
 * What the harness side can and cannot give us (design §2/D2):
 *  - RECOVERABLE by translation — per-LLM-call tokens/model/stop_reason
 *    (`agent.llm.end` from each `SDKAssistantMessage`'s embedded `BetaMessage`),
 *    iteration boundaries (synthesized at turn boundaries, reconciled against
 *    the result's `num_turns`), true finish reason (result subtype), run cost
 *    (`total_cost_usd`), and compaction/subagent/rate-limit visibility
 *    (`harness.native` envelope events).
 *  - NOT recoverable — causal mid-loop control, and true `llm.start`
 *    timing/input-size for a *synthesized* boundary. Events we reconstruct
 *    rather than observe carry `meta.synthetic: true` (D12).
 *
 * `agent.llm.start` provenance is the key asymmetry: in `stream()` mode the SDK
 * emits a real `message_start` partial we can time against, so llm.start is
 * observed (no `synthetic` marker). In `run()` mode there is no such signal, so
 * llm.start is synthesized at the same boundary as its llm.end and marked.
 *
 * Tool events (`agent.tool.start`/`end`, with `durationMs`) do NOT flow through
 * here — they are emitted by the runner's PreToolUse/PostToolUse SDK hooks,
 * out of band from this message stream. This translator only counts tool_use
 * blocks for run accounting.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { type AgentEvent, createEvent } from "../events/types.js";

// ---------------------------------------------------------------------------
// finishReason mapping (result subtype → canonical run finishReason)
// ---------------------------------------------------------------------------

/**
 * Map an `SDKResultMessage` subtype to a canonical run `finishReason`. Kept a
 * pure function so the mapping is table-testable in isolation. Unknown/new
 * subtypes (e.g. `error_max_structured_output_retries`) fall through to
 * `"unknown"` rather than being silently coerced to `"stop"` — an honest gap
 * beats a false success.
 */
export function mapFinishReason(subtype: string | undefined): string {
  switch (subtype) {
    case "success":
      return "stop";
    case "error_max_turns":
      return "max-turns";
    case "error_during_execution":
      return "error";
    case "error_max_budget_usd":
      return "budget";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// harness.native surfacing
// ---------------------------------------------------------------------------

/**
 * `system`-typed SDK message subtypes surfaced as `harness.native` envelope
 * events: compaction boundaries and task/subagent progress. Rate-limit notices
 * arrive under their own top-level `type` (`rate_limit_event`) and are handled
 * separately. Everything else on `type: "system"` (init, config changes, …) is
 * currently dropped — promote by adding the subtype here when a consumer needs
 * it.
 */
const HARNESS_NATIVE_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  "compact_boundary",
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
  "api_retry",
]);

// ---------------------------------------------------------------------------
// Translator context + accounting
// ---------------------------------------------------------------------------

export interface CCTranslatorContext {
  readonly traceId: string;
  readonly runId: string;
  readonly parentSpanId?: string;
  /** Fallback model label (`agent.getModel()`) when a message carries none. */
  readonly fallbackModel: string;
  /** Whether the agent exposes tools — feeds `agent.llm.start.hasTools`. */
  readonly hasTools: boolean;
  /** Cap for `agent.iteration.start.maxIterations`. */
  readonly maxIterations: number;
  /**
   * True when the SDK is emitting partial (`stream_event`) messages. Governs
   * llm.start provenance: streaming observes a real `message_start`, run mode
   * synthesizes the boundary.
   */
  readonly streaming: boolean;
}

/** Run-level accounting accrued across the message stream. */
export interface CCRunAccounting {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
  readonly toolCallsCount: number;
  readonly iterations: number;
  readonly finishReason: string;
}

// ---------------------------------------------------------------------------
// CCMessageTranslator
// ---------------------------------------------------------------------------

/**
 * TRANSITIONAL (#323 → #326): this translator lives inline in the runner layer.
 * #326 extracts the per-harness adapter and relocates this logic (and its test
 * suite) behind the adapter seam. Until then it is a private, single-file
 * concern shared by `run()`/`stream()`.
 */
export class CCMessageTranslator {
  private readonly ctx: CCTranslatorContext;

  // Content accumulation
  private readonly contentParts: string[] = [];
  private chunkIndex = 0;
  private gotChunks = false;

  // Run accounting
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd: number | undefined;
  private toolCallsMade = 0;
  private finishReason = "unknown";
  private reportedTurns: number | undefined;

  // Iteration / llm.start synthesis state
  private syntheticIterations = 0;
  private iterationOpen = false;
  private llmStartedAt = 0;

  constructor(ctx: CCTranslatorContext) {
    this.ctx = ctx;
  }

  /** Translate one SDK message into the AgentEvents it produces. */
  translate(msg: SDKMessage): AgentEvent[] {
    switch (msg.type) {
      case "stream_event":
        return this.onPartial(msg);
      case "assistant":
        return this.onAssistant(msg);
      case "result":
        this.onResult(msg);
        return [];
      case "rate_limit_event":
        return [this.harnessNative("rate_limit_event", msg)];
      case "system": {
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype && HARNESS_NATIVE_SYSTEM_SUBTYPES.has(subtype)) {
          return [this.harnessNative(subtype, msg)];
        }
        return [];
      }
      default:
        return [];
    }
  }

  /**
   * Final run accounting, and the one-shot iteration↔`num_turns` reconciliation
   * (D2: mismatch LOGS, never throws — a wrong count is a telemetry nit, not a
   * run failure). Call once after the message loop drains.
   */
  finalize(): CCRunAccounting {
    if (this.reportedTurns !== undefined && this.reportedTurns !== this.syntheticIterations) {
      const detail = `synthesized ${this.syntheticIterations} iteration boundary(ies) but the SDK result reported num_turns=${this.reportedTurns}`;
      console.warn(
        `[agentic-patterns] ClaudeCodeRunner: ${detail}. Iteration events are best-effort (meta.synthetic); RunResult.iterations follows num_turns.`,
      );
    }
    return {
      content: this.contentParts.join(""),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      toolCallsCount: this.toolCallsMade,
      iterations: this.reportedTurns ?? this.syntheticIterations,
      finishReason: this.finishReason,
    };
  }

  // -------------------------------------------------------------------------
  // Per-message-kind handlers
  // -------------------------------------------------------------------------

  /**
   * Partial (`stream_event`) messages — streaming only. `message_start` opens
   * the turn with a REAL (observed, non-synthetic) `agent.llm.start`;
   * `content_block_delta` text becomes `agent.message.chunk`.
   */
  private onPartial(msg: SDKPartialAssistantMessage): AgentEvent[] {
    const event = msg.event;
    if (event.type === "message_start") {
      const model = event.message.model || this.ctx.fallbackModel;
      return this.openIteration(model, /* synthetic */ false);
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta;
      const text = "text" in delta ? delta.text : undefined;
      if (text) {
        this.contentParts.push(text);
        this.gotChunks = true;
        const chunk = createEvent("agent.message.chunk", {
          traceId: this.ctx.traceId,
          runId: this.ctx.runId,
          parentSpanId: this.ctx.parentSpanId,
          delta: text,
          chunkIndex: this.chunkIndex,
        });
        this.chunkIndex++;
        return [chunk];
      }
    }
    return [];
  }

  /**
   * A full `SDKAssistantMessage` — one LLM call. Closes out the turn:
   * `agent.llm.start` (synthesized here in run mode, already opened in stream
   * mode), any `agent.reasoning`, then `agent.llm.end` (usage/model/stop_reason
   * from the embedded `BetaMessage`) and the synthesized `agent.iteration.end`.
   */
  private onAssistant(msg: SDKAssistantMessage): AgentEvent[] {
    const events: AgentEvent[] = [];
    const beta = msg.message;
    const model = beta.model || this.ctx.fallbackModel;

    // Open the iteration/llm.start now if streaming didn't already
    // (run mode has no message_start — synthesize the boundary here).
    if (!this.iterationOpen) {
      events.push(...this.openIteration(model, /* synthetic */ true));
    }

    let hasToolCalls = false;
    const content = beta.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if ("text" in block && typeof block.text === "string") {
          // Streamed chunks already captured the text — don't double-count.
          if (!this.gotChunks) {
            this.contentParts.push(block.text);
          }
        } else if ("thinking" in block && typeof block.thinking === "string") {
          events.push(
            createEvent("agent.reasoning", {
              traceId: this.ctx.traceId,
              runId: this.ctx.runId,
              parentSpanId: this.ctx.parentSpanId,
              content: block.thinking,
              isComplete: true,
            }),
          );
        } else if (block.type === "tool_use") {
          this.toolCallsMade++;
          hasToolCalls = true;
        }
      }
    }

    const usage = beta.usage;
    events.push(
      createEvent("agent.llm.end", {
        traceId: this.ctx.traceId,
        runId: this.ctx.runId,
        parentSpanId: this.ctx.parentSpanId,
        model,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        durationMs: Math.max(0, Date.now() - this.llmStartedAt),
        hasToolCalls,
        finishReason: beta.stop_reason ?? "unknown",
      }),
    );

    // Close the synthesized iteration. `hasMore` reflects the model's intent to
    // continue (a tool_use stop precedes another turn); the authoritative turn
    // count is reconciled against num_turns at finalize().
    events.push(
      createEvent("agent.iteration.end", {
        traceId: this.ctx.traceId,
        runId: this.ctx.runId,
        parentSpanId: this.ctx.parentSpanId,
        iteration: this.syntheticIterations,
        toolCallsCount: hasToolCalls ? 1 : 0,
        hasMore: beta.stop_reason === "tool_use",
        meta: { synthetic: true },
      }),
    );
    this.iterationOpen = false;

    return events;
  }

  /**
   * The terminal `SDKResultMessage` — pure accounting, emits no AgentEvent of
   * its own (the runner emits `agent.message.complete` after the loop). Records
   * run totals, cost, finishReason, and the reported turn count for
   * reconciliation.
   */
  private onResult(msg: SDKResultMessage): void {
    const usage = msg.usage as unknown as { input_tokens?: number; output_tokens?: number } | null;
    if (usage) {
      this.inputTokens = usage.input_tokens ?? 0;
      this.outputTokens = usage.output_tokens ?? 0;
    }
    this.costUsd = msg.total_cost_usd;
    this.reportedTurns = msg.num_turns;
    this.finishReason = mapFinishReason(msg.subtype);

    // `success` results carry the final text; use it only as a fallback when
    // no assistant/streamed content was captured.
    if (
      msg.subtype === "success" &&
      typeof msg.result === "string" &&
      this.contentParts.length === 0
    ) {
      this.contentParts.push(msg.result);
    }
  }

  // -------------------------------------------------------------------------
  // Shared boundary helpers
  // -------------------------------------------------------------------------

  /**
   * Open a turn: bump the synthesized iteration counter and emit
   * `agent.iteration.start` (always synthetic) + `agent.llm.start`. The
   * llm.start `synthetic` flag is caller-driven — false when opened from an
   * observed `message_start`, true when synthesized in run mode.
   */
  private openIteration(model: string, syntheticLlmStart: boolean): AgentEvent[] {
    this.syntheticIterations++;
    this.iterationOpen = true;
    this.llmStartedAt = Date.now();

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
        ...(syntheticLlmStart ? { meta: { synthetic: true } } : {}),
      }),
    ];
  }

  private harnessNative(name: string, raw: unknown): AgentEvent {
    return createEvent("harness.native", {
      traceId: this.ctx.traceId,
      runId: this.ctx.runId,
      parentSpanId: this.ctx.parentSpanId,
      harness: "claude-code",
      name,
      payload: raw as Record<string, unknown>,
    });
  }
}
