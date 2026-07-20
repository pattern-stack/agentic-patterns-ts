/**
 * Claude Code SDK-message → normalized {@link HarnessEvent} translator
 * (design §5.3; relocated from `runner/cc-event-translator.ts` in B-2 / #326).
 *
 * This is the CC-specific half of the two-layer translation seam: the harness's
 * native `SDKMessage` stream in, normalized `HarnessEvent`s out. The
 * harness-agnostic `HarnessEventTranslator` (base) turns those into AP events —
 * this file knows only about the Claude Agent SDK, never the event bus.
 *
 * What the harness gives us (design §2/D2):
 *  - RECOVERABLE by translation — per-call tokens/model/stop_reason (`llm-response`
 *    from each `SDKAssistantMessage`'s embedded `BetaMessage`), turn boundaries
 *    (`turn-start`/`turn-end`, reconciled against the result `num_turns` by the
 *    base), true finish reason (result subtype), run cost, and
 *    compaction/subagent/rate-limit visibility (`harness-native`).
 *  - NOT recoverable — causal mid-loop control, and true per-call start timing for
 *    a SYNTHESIZED boundary. `turn-start` carries `meta.observed: true` only when
 *    the SDK emitted a real `message_start` (streaming); the base marks the
 *    derived `llm.start` synthetic otherwise.
 *
 * Multi-assistant-message turn de-dup (routed from PR #358 B-1 review): the SDK
 * can emit MULTIPLE `SDKAssistantMessage`s sharing one `message.id` for a single
 * logical turn (e.g. `resumed_from_incomplete_thinking`). Emitting a turn
 * boundary per message over-counts iterations against `num_turns`. We key turn
 * boundaries on `message.id`: a second message with the id of an already-closed
 * turn is a CONTINUATION — its content/usage still flow, but it opens NO new
 * iteration.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { NativeIds } from "../../../gates/decisions.js";
import type { HarnessEvent } from "../types.js";

// ---------------------------------------------------------------------------
// finishReason mapping (result subtype → canonical run finishReason)
// ---------------------------------------------------------------------------

/**
 * Map an `SDKResultMessage` subtype to a canonical run `finishReason`. Pure so
 * the mapping is table-testable. Unknown/new subtypes fall through to
 * `"unknown"` rather than a false `"stop"` — an honest gap beats a false success.
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
// harness-native surfacing
// ---------------------------------------------------------------------------

/**
 * `system`-typed SDK message subtypes surfaced as `harness-native` events:
 * compaction boundaries and task/subagent progress. Rate-limit notices arrive
 * under their own top-level `type` and are handled separately. Everything else
 * on `type: "system"` (init, config changes, …) is dropped — promote by adding
 * the subtype here when a consumer needs it.
 */
const HARNESS_NATIVE_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  "compact_boundary",
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
  "api_retry",
]);

export interface CCHarnessTranslatorContext {
  /** Fallback model label (`agent.getModel()`) when a message carries none. */
  readonly fallbackModel: string;
  /**
   * True when the SDK is emitting partial (`stream_event`) messages. Governs
   * llm.start provenance and whether assistant text blocks re-emit as text.
   */
  readonly streaming: boolean;
}

export class CCHarnessTranslator {
  private readonly ctx: CCHarnessTranslatorContext;

  private sessionId: string | undefined;
  private gotChunks = false;

  // Turn-boundary state, keyed on message.id for multi-message de-dup.
  private turnOpen = false;
  private openMessageId: string | undefined;

  constructor(ctx: CCHarnessTranslatorContext) {
    this.ctx = ctx;
  }

  /** Translate one SDK message into the HarnessEvents it produces. */
  translate(msg: SDKMessage): HarnessEvent[] {
    switch (msg.type) {
      case "stream_event":
        return this.onPartial(msg);
      case "assistant":
        return this.onAssistant(msg);
      case "result":
        return [this.onResult(msg)];
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

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /**
   * Partial (`stream_event`) messages — streaming only. `message_start` opens the
   * turn with an OBSERVED boundary; `content_block_delta` text becomes a
   * `text-delta`.
   */
  private onPartial(msg: SDKPartialAssistantMessage): HarnessEvent[] {
    const event = msg.event;
    this.captureSession(msg);
    if (event.type === "message_start") {
      const id = event.message.id;
      // Resumed message_start for an id we've already opened → de-dup.
      if (this.openMessageId === id) return [];
      const model = event.message.model || this.ctx.fallbackModel;
      this.turnOpen = true;
      this.openMessageId = id;
      return [
        { kind: "turn-start", ids: this.ids(id), meta: { observed: true, model } } as HarnessEvent,
      ];
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta;
      const text = "text" in delta ? delta.text : undefined;
      if (text) {
        this.gotChunks = true;
        return [{ kind: "text-delta", ids: this.ids(), text } as HarnessEvent];
      }
    }
    return [];
  }

  /**
   * A full `SDKAssistantMessage` — one LLM call. Closes out the turn unless it is
   * a same-`message.id` continuation of an already-closed turn (see file header).
   */
  private onAssistant(msg: SDKAssistantMessage): HarnessEvent[] {
    this.captureSession(msg);
    const beta = msg.message;
    const id = beta.id;
    const model = beta.model || this.ctx.fallbackModel;
    const events: HarnessEvent[] = [];

    // A second message sharing a closed turn's id is a continuation: no new
    // iteration boundary, but its content/usage still flow.
    const continuation = this.openMessageId === id && !this.turnOpen;

    // A brand-new turn with no observed message_start (run mode) synthesizes its
    // open here.
    if (this.openMessageId !== id && !this.turnOpen) {
      events.push({ kind: "turn-start", ids: this.ids(id), meta: { model } } as HarnessEvent);
      this.turnOpen = true;
      this.openMessageId = id;
    }

    let toolBlocks = 0;
    const content = beta.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if ("text" in block && typeof block.text === "string") {
          // Streamed chunks already carried the text — don't double-count.
          if (!this.gotChunks) {
            events.push({
              kind: "text-delta",
              ids: this.ids(id),
              text: block.text,
            } as HarnessEvent);
          }
        } else if ("thinking" in block && typeof block.thinking === "string") {
          events.push({
            kind: "reasoning",
            ids: this.ids(id),
            text: block.thinking,
          } as HarnessEvent);
        } else if (block.type === "tool_use") {
          toolBlocks++;
        }
      }
    }

    const usage = beta.usage;
    events.push({
      kind: "llm-response",
      ids: this.ids(id),
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      },
      model,
      stopReason: beta.stop_reason ?? "unknown",
      meta: { toolCallsCount: toolBlocks },
    } as HarnessEvent);

    if (continuation) {
      // Fold into the prior iteration — emit no turn-end. `turnOpen` stays false.
      return events;
    }

    events.push({
      kind: "turn-end",
      ids: this.ids(id),
      meta: { hasMore: beta.stop_reason === "tool_use", toolCallsCount: toolBlocks },
    } as HarnessEvent);
    this.turnOpen = false;
    // Keep openMessageId so a later same-id assistant is detected as continuation.

    return events;
  }

  /** The terminal `SDKResultMessage` → a `terminal` HarnessEvent (accounting). */
  private onResult(msg: SDKResultMessage): HarnessEvent {
    const usage = msg.usage as unknown as { input_tokens?: number; output_tokens?: number } | null;
    const finalText =
      msg.subtype === "success" && typeof msg.result === "string" ? msg.result : undefined;
    return {
      kind: "terminal",
      ids: this.ids(),
      numTurns: msg.num_turns,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      },
      ...(msg.total_cost_usd !== undefined ? { costUsd: msg.total_cost_usd } : {}),
      finishReason: mapFinishReason(msg.subtype),
      ...(finalText !== undefined ? { meta: { finalText } } : {}),
    } as HarnessEvent;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private captureSession(msg: { session_id?: string }): void {
    if (msg.session_id && !this.sessionId) this.sessionId = msg.session_id;
  }

  private ids(itemId?: string): NativeIds {
    return {
      ...(this.sessionId ? { threadId: this.sessionId } : {}),
      ...(itemId ? { itemId } : {}),
    };
  }

  private harnessNative(name: string, raw: unknown): HarnessEvent {
    return { kind: "harness-native", ids: this.ids(), name, payload: raw } as HarnessEvent;
  }
}
