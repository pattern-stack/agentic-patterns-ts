/**
 * OpenTelemetry exporter - spans to OTLP collector.
 *
 * Exports agent events as OpenTelemetry spans following Gen AI
 * semantic conventions for LLM observability.
 *
 * Requires @opentelemetry/api as an optional peer dependency.
 *
 * Ported from Python: systems/exporters/otel.py
 */

import { EventProfile } from "../events/event-profiles.js";
import type {
  ErrorEvent,
  IterationEndEvent,
  IterationStartEvent,
  LLMCallEndEvent,
  LLMCallStartEvent,
  MessageCompleteEvent,
  MessageStartEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "../events/types.js";
import { BaseExporter } from "./base.js";

// ---------------------------------------------------------------------------
// OTel interfaces (minimal shape to avoid hard dependency)
// ---------------------------------------------------------------------------

/** Minimal OTel Span interface. */
export interface OTelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(error: Error): void;
  end(): void;
}

/** Minimal OTel Tracer interface. */
export interface OTelTracer {
  startSpan(name: string, options?: Record<string, unknown>): OTelSpan;
}

/** OTel StatusCode constants. */
export const OTelStatusCode = {
  OK: 1,
  ERROR: 2,
} as const;

// ---------------------------------------------------------------------------
// OTelExporter
// ---------------------------------------------------------------------------

/**
 * Export agent events as OpenTelemetry spans.
 *
 * Maps the agent event hierarchy to OTel spans:
 *   agent.run (root) -> iteration -> llm_call / tool_call
 *
 * Follows Gen AI semantic conventions:
 *   - gen_ai.system = "vercel-ai-sdk"
 *   - gen_ai.request.model = model name
 *   - gen_ai.usage.input_tokens / output_tokens
 */
export class OTelExporter extends BaseExporter {
  override profile = EventProfile.OBSERVABILITY;

  private tracer: OTelTracer;
  /** Whether to capture prompt/completion content in spans. */
  readonly captureContent: boolean;
  private _spans = new Map<string, OTelSpan>();

  constructor(options: {
    tracer: OTelTracer;
    captureContent?: boolean;
  }) {
    super();
    this.tracer = options.tracer;
    this.captureContent = options.captureContent ?? false;
  }

  /** @internal */
  async _onMessageStart(event: MessageStartEvent): Promise<void> {
    const span = this.tracer.startSpan("agent.run");
    span.setAttribute("agent.run_id", event.runId);
    if (event.traceId) {
      span.setAttribute("agent.trace_id", event.traceId);
    }
    this._spans.set(event.spanId, span);
  }

  /** @internal */
  async _onIterationStart(event: IterationStartEvent): Promise<void> {
    const span = this.tracer.startSpan(`agent.iteration.${event.iteration}`);
    span.setAttribute("agent.iteration", event.iteration);
    span.setAttribute("agent.max_iterations", event.maxIterations);
    this._spans.set(event.spanId, span);
  }

  /** @internal */
  async _onIterationEnd(event: IterationEndEvent): Promise<void> {
    const span = this._spans.get(event.spanId);
    this._spans.delete(event.spanId);
    if (span) {
      span.setAttribute("agent.tool_calls_count", event.toolCallsCount);
      span.setAttribute("agent.has_more", event.hasMore);
      span.end();
    }
  }

  /** @internal */
  async _onLlmStart(event: LLMCallStartEvent): Promise<void> {
    const span = this.tracer.startSpan("gen_ai.chat");
    span.setAttribute("gen_ai.system", "vercel-ai-sdk");
    span.setAttribute("gen_ai.request.model", event.model);
    span.setAttribute("gen_ai.request.message_count", event.messageCount);
    if (this.captureContent) {
      span.setAttribute("gen_ai.request.has_tools", event.hasTools);
    }
    this._spans.set(event.spanId, span);
  }

  /** @internal */
  async _onLlmEnd(event: LLMCallEndEvent): Promise<void> {
    const span = this._spans.get(event.spanId);
    this._spans.delete(event.spanId);
    if (span) {
      span.setAttribute("gen_ai.usage.input_tokens", event.inputTokens);
      span.setAttribute("gen_ai.usage.output_tokens", event.outputTokens);
      span.setAttribute("gen_ai.response.finish_reason", event.finishReason);
      span.setAttribute("gen_ai.response.duration_ms", event.durationMs);
      span.end();
    }
  }

  /** @internal */
  async _onToolStart(event: ToolCallStartEvent): Promise<void> {
    const span = this.tracer.startSpan(`tool.${event.toolName}`);
    span.setAttribute("tool.name", event.toolName);
    span.setAttribute("tool.call_id", event.toolCallId);
    if (event.arguments) {
      span.setAttribute("tool.arguments", JSON.stringify(event.arguments));
    }
    this._spans.set(event.spanId, span);
  }

  /** @internal */
  async _onToolEnd(event: ToolCallEndEvent): Promise<void> {
    const span = this._spans.get(event.spanId);
    this._spans.delete(event.spanId);
    if (span) {
      span.setAttribute("tool.duration_ms", event.durationMs);
      if (event.error) {
        span.setStatus({ code: OTelStatusCode.ERROR, message: event.error });
      } else {
        span.setStatus({ code: OTelStatusCode.OK });
      }
      span.end();
    }
  }

  /** @internal */
  async _onError(event: ErrorEvent): Promise<void> {
    const parentSpanId = event.parentSpanId;
    if (parentSpanId) {
      const span = this._spans.get(parentSpanId);
      if (span) {
        span.setStatus({
          code: OTelStatusCode.ERROR,
          message: event.message,
        });
        span.recordException(new Error(event.message));
        span.setAttribute("error.type", event.errorType);
      }
    }
  }

  /** @internal */
  async _onMessageComplete(event: MessageCompleteEvent): Promise<void> {
    const span = this._spans.get(event.spanId);
    this._spans.delete(event.spanId);
    if (span) {
      span.setAttribute("agent.model", event.model);
      span.setAttribute("agent.input_tokens", event.inputTokens);
      span.setAttribute("agent.output_tokens", event.outputTokens);
      span.end();
    }
  }
}
