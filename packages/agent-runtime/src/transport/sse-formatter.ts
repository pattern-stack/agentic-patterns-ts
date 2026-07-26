/**
 * SSE (Server-Sent Events) formatter for agent events.
 *
 * Converts internal AgentEvent types to SSE-formatted strings for streaming
 * to clients over HTTP. Maps every canonical event via a single typed
 * discriminated-union switch (`toSSEMapping`) so event name, payload, and
 * exhaustiveness live in one place.
 */

import {
  DEFAULT_ARTIFACT_BYTE_CEILING,
  type RenderArtifact,
  artifactMarker,
} from "@agentic-patterns/core";
import type { AgentEvent, AgentEventType } from "../events/types.js";

// ---------------------------------------------------------------------------
// Render-artifact wire mapping (ADR-0006)
// ---------------------------------------------------------------------------

/** Config accepted by every SSE formatting entry point. */
export interface SSEFormatterOptions {
  /**
   * Override the per-artifact transport ceiling (bytes). Defaults to core's
   * {@link DEFAULT_ARTIFACT_BYTE_CEILING} — a sanity bound, not a tuning
   * knob (ADR-0006 §4). Exposed here purely so a deployment with unusual
   * needs can override it without forking the formatter.
   */
  readonly artifactByteCeiling?: number;
}

const artifactEncoder = new TextEncoder();

/**
 * UTF-8 byte size of an artifact's serialized wire form. A `JSON.stringify`
 * throw (circular reference, BigInt, …) is treated as an automatic ceiling
 * breach (`Infinity`) — the same "hard drop over guesswork" posture as the
 * rest of this ADR, rather than risking a partial/invalid frame.
 */
function artifactByteSize(artifact: RenderArtifact): number {
  try {
    return artifactEncoder.encode(JSON.stringify(artifact)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Map a `RenderArtifact` to its pinned wire shape (snake_case `display_type`). */
function toWireArtifact(artifact: RenderArtifact): Record<string, unknown> {
  const wire: Record<string, unknown> = { id: artifact.id, display_type: artifact.displayType };
  if (artifact.data !== undefined) wire.data = artifact.data;
  if (artifact.title !== undefined) wire.title = artifact.title;
  if (artifact.truncated !== undefined) wire.truncated = artifact.truncated;
  return wire;
}

/**
 * Enforce the transport ceiling (ADR-0006 §4) on a batch of artifacts before
 * they hit the wire. An artifact whose serialized form breaches
 * `ceilingBytes` is replaced by `artifactMarker(...)` — identity + type, no
 * `data`, `truncated: true` — and the breach is logged loudly via
 * `console.error`. This is a hard drop, never a silent shrink or a partial
 * reshape: the framework cannot safely reshape a payload whose `displayType`
 * is an opaque, open string.
 */
function sanitizeArtifacts(
  artifacts: readonly RenderArtifact[],
  ceilingBytes: number,
): Array<Record<string, unknown>> {
  return artifacts.map((artifact) => {
    const size = artifactByteSize(artifact);
    if (size > ceilingBytes) {
      console.error(
        `[agentic-patterns] render artifact "${artifact.id}" (displayType "${artifact.displayType}") is ${size} bytes, exceeding the ${ceilingBytes}-byte transport ceiling (ADR-0006 §4). Shipping a marker (no data) instead of a truncated payload.`,
      );
      return toWireArtifact(artifactMarker(artifact));
    }
    return toWireArtifact(artifact);
  });
}

// ---------------------------------------------------------------------------
// Canonical wire event names (string union)
// ---------------------------------------------------------------------------

/**
 * Client-facing SSE event name. Matches the canonical events defined in
 * the admin-observability spec. Used anywhere an SSE frame is produced so
 * the compiler catches typos like `"thinking.complete"` vs `"thinking"`.
 */
export type SSEEventName =
  | "conversation.start"
  | "conversation.end"
  | "message.start"
  | "message.delta"
  | "message.complete"
  | "message.cancel"
  | "input.request"
  | "thinking.start"
  | "thinking"
  | "thinking.complete"
  | "tool.intent"
  | "tool.start"
  | "tool.progress"
  | "tool.end"
  | "tool.rejected"
  | "gate.decision"
  | "step.start"
  | "step.end"
  | "iteration.start"
  | "iteration.end"
  | "llm.start"
  | "llm.end"
  | "backpack.drop"
  | "backpack.read"
  | "backpack.absorb"
  | "scratchpad.write"
  | "scratchpad.read"
  | "scratchpad.fork"
  | "scratchpad.join"
  | "error"
  | "claude_code.hook"
  | "harness.native"
  | "done";

/** Result of mapping an AgentEvent to its canonical SSE shape. */
export interface SSEMapping {
  readonly name: SSEEventName;
  readonly payload: Record<string, unknown>;
}

/**
 * The COMPLETE, runtime-enumerable wire vocabulary — every `SSEEventName` a
 * client can receive, as a value array (the type union alone can't be iterated).
 *
 * Unlike `SSE_EVENT_NAMES` (an `AgentEventType → SSEEventName` map that misses
 * wire-only names like `thinking.complete` and `done`), this is the authoritative
 * FULL list. It is the source of truth for the dashboard union drift-check
 * (#286/#324): a committed manifest is generated from it (see
 * `tools/gen-sse-manifest.ts`), and the dashboard asserts its own client union
 * covers every name here.
 *
 * The `satisfies` clause proves every entry is a valid `SSEEventName` (no typos);
 * the `_Missing` exhaustiveness guard below proves NO name is omitted. Together
 * they pin this array to be EXACTLY the `SSEEventName` union — add a name to the
 * type and this file fails to compile until the array is updated.
 */
export const SSE_WIRE_EVENT_NAMES = [
  "conversation.start",
  "conversation.end",
  "message.start",
  "message.delta",
  "message.complete",
  "message.cancel",
  "input.request",
  "thinking.start",
  "thinking",
  "thinking.complete",
  "tool.intent",
  "tool.start",
  "tool.progress",
  "tool.end",
  "tool.rejected",
  "gate.decision",
  "step.start",
  "step.end",
  "iteration.start",
  "iteration.end",
  "llm.start",
  "llm.end",
  "backpack.drop",
  "backpack.read",
  "backpack.absorb",
  "scratchpad.write",
  "scratchpad.read",
  "scratchpad.fork",
  "scratchpad.join",
  "error",
  "claude_code.hook",
  "harness.native",
  "done",
] as const satisfies readonly SSEEventName[];

// Exhaustiveness guard: any `SSEEventName` NOT present in the array above makes
// `_MissingWireName` a non-`never` type, which fails this assignment at compile
// time. This is what keeps the manifest — and the dashboard drift-check — honest.
type _MissingWireName = Exclude<SSEEventName, (typeof SSE_WIRE_EVENT_NAMES)[number]>;
const _wireNamesAreExhaustive: _MissingWireName extends never ? true : ["missing wire names"] =
  true;
void _wireNamesAreExhaustive;

// ---------------------------------------------------------------------------
// Single source of truth — event -> wire name + payload
// ---------------------------------------------------------------------------

/**
 * Map an `AgentEvent` to its canonical SSE wire name and payload. The
 * discriminated-union switch narrows `event` automatically so field access
 * is fully typed without casts. The `never` default is a compile-time
 * exhaustiveness check — adding a new variant to `AgentEvent` fails
 * typechecking here until a branch is added.
 *
 * Returns `null` only when a non-AgentEvent slips through at runtime
 * (e.g., a hand-constructed event with an unrecognised `type`).
 *
 * Synthetic provenance (D12, #324): when an event carries `meta.synthetic`
 * (a boundary the CC translator RECONSTRUCTED rather than observed — e.g. a
 * run-mode `llm.start`), the wrapper stamps `synthetic: true` onto the wire
 * payload. Consumers (the dashboard) badge such rows and MUST exclude them from
 * any latency computation — a synthesized boundary is never a causal anchor.
 *
 * `opts.artifactByteCeiling` (ADR-0006 §4) overrides the render-artifact
 * transport ceiling for `tool.end`/`message.complete` payloads; omit it to
 * use core's `DEFAULT_ARTIFACT_BYTE_CEILING`. Purely additive — every
 * existing single-argument call site keeps compiling and gets the default.
 */
export function toSSEMapping(event: AgentEvent, opts?: SSEFormatterOptions): SSEMapping | null {
  const ceilingBytes = opts?.artifactByteCeiling ?? DEFAULT_ARTIFACT_BYTE_CEILING;
  const mapping = mapEventToSSE(event, ceilingBytes);
  if (!mapping) return null;
  if (event.meta?.synthetic) {
    return { name: mapping.name, payload: { ...mapping.payload, synthetic: true } };
  }
  return mapping;
}

/** Core event→wire mapping. Wrapped by {@link toSSEMapping}, which layers on the
 *  cross-cutting `synthetic` provenance marker. Kept private so the marker can
 *  never be forgotten by a caller reaching for the raw switch. */
function mapEventToSSE(event: AgentEvent, artifactByteCeiling: number): SSEMapping | null {
  switch (event.type) {
    case "agent.conversation.start":
      return {
        name: "conversation.start",
        payload: { conversation_id: event.conversationId, agent_name: event.agentName },
      };
    case "agent.conversation.end":
      return {
        name: "conversation.end",
        payload: { conversation_id: event.conversationId, reason: event.reason },
      };
    case "agent.message.start":
      return { name: "message.start", payload: { agent_name: event.agentName } };
    case "agent.message.chunk":
      return {
        name: "message.delta",
        payload: { delta: event.delta, chunk_index: event.chunkIndex },
      };
    case "agent.message.complete": {
      const payload: Record<string, unknown> = {
        content: event.content,
        input_tokens: event.inputTokens,
        output_tokens: event.outputTokens,
        model: event.model,
      };
      // #324 (B-1): forward the harness-reported total run cost + finish reason so
      // the dashboard run summary can display them. Both absent for runners with
      // no cost/finish signal (e.g. `AgentRunner`) — additive, non-breaking.
      if (event.costUsd !== undefined) payload.cost_usd = event.costUsd;
      if (event.finishReason !== undefined) payload.finish_reason = event.finishReason;
      // ADR-0006: §9 preserves a structured terminal result alongside the
      // (unchanged) stringified `content`; §3/§4 attach render artifacts
      // under the ceiling. Both additive — absent on every run with neither.
      if (event.structuredContent !== undefined) {
        payload.structured_content = event.structuredContent;
      }
      if (event.artifacts !== undefined && event.artifacts.length > 0) {
        payload.artifacts = sanitizeArtifacts(event.artifacts, artifactByteCeiling);
      }
      return { name: "message.complete", payload };
    }
    case "agent.message.cancel":
      return { name: "message.cancel", payload: { reason: event.reason } };
    case "agent.input.request": {
      const payload: Record<string, unknown> = {
        correlation_id: event.correlationId,
        kind: event.kind,
        prompt: event.prompt,
      };
      if (event.options !== undefined) payload.options = event.options;
      if (event.toolName !== undefined) payload.tool_name = event.toolName;
      if (event.toolCallId !== undefined) payload.tool_call_id = event.toolCallId;
      if (event.arguments !== undefined) payload.arguments = event.arguments;
      return { name: "input.request", payload };
    }
    case "agent.thinking.start":
      return { name: "thinking.start", payload: {} };
    case "agent.reasoning":
      return {
        name: event.isComplete ? "thinking.complete" : "thinking",
        payload: { content: event.content },
      };
    case "agent.tool.intent":
      return {
        name: "tool.intent",
        payload: {
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          arguments: event.arguments,
        },
      };
    case "agent.tool.start": {
      const payload: Record<string, unknown> = {
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        arguments: event.arguments,
      };
      if (event.displayType !== undefined) payload.display_type = event.displayType;
      return { name: "tool.start", payload };
    }
    case "agent.tool.progress":
      return {
        name: "tool.progress",
        payload: {
          tool_call_id: event.toolCallId,
          progress: event.progress,
          status_text: event.statusText,
        },
      };
    case "agent.tool.end": {
      const payload: Record<string, unknown> = {
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        result: event.result,
        duration_ms: event.durationMs,
      };
      if (event.error !== undefined) payload.error = event.error;
      if (event.displayType !== undefined) payload.display_type = event.displayType;
      // ADR-0006 §1-2, §4: render artifacts this call published, under the ceiling.
      if (event.artifacts !== undefined && event.artifacts.length > 0) {
        payload.artifacts = sanitizeArtifacts(event.artifacts, artifactByteCeiling);
      }
      return { name: "tool.end", payload };
    }
    case "agent.tool.rejected":
      return {
        name: "tool.rejected",
        payload: {
          tool_name: event.toolName,
          reason: event.reason,
          gate_name: event.gateName,
        },
      };
    case "agent.gate.decision":
      return {
        name: "gate.decision",
        payload: {
          tool_name: event.toolName,
          outcome: event.outcome,
          settled_by: event.settledBy,
          decision_kind: event.decisionKind,
          blocked_by: event.blockedBy,
          reason: event.reason,
          trail: event.trail,
        },
      };
    case "agent.iteration.start":
      return {
        name: "iteration.start",
        payload: { iteration: event.iteration, max_iterations: event.maxIterations },
      };
    case "agent.iteration.end":
      return {
        name: "iteration.end",
        payload: {
          iteration: event.iteration,
          tool_calls_count: event.toolCallsCount,
          has_more: event.hasMore,
        },
      };
    case "agent.llm.start":
      return {
        name: "llm.start",
        payload: {
          model: event.model,
          message_count: event.messageCount,
          has_tools: event.hasTools,
        },
      };
    case "agent.llm.end":
      return {
        name: "llm.end",
        payload: {
          model: event.model,
          input_tokens: event.inputTokens,
          output_tokens: event.outputTokens,
          duration_ms: event.durationMs,
          finish_reason: event.finishReason,
        },
      };
    case "agent.error":
      return {
        name: "error",
        payload: {
          error_type: event.errorType,
          message: event.message,
          recoverable: event.recoverable,
        },
      };
    case "claude_code.hook":
      return {
        name: "claude_code.hook",
        payload: {
          hook_name: event.hookName,
          session_id: event.sessionId,
          cwd: event.cwd,
          tool_name: event.toolName,
          tool_input: event.toolInput,
          tool_response: event.toolResponse,
          tool_use_id: event.toolUseId,
          permission_mode: event.permissionMode,
          transcript_path: event.transcriptPath,
          runner_correlation_id: event.runnerCorrelationId,
          payload: event.payload,
        },
      };
    case "harness.native":
      // #323: pass the harness-native envelope through verbatim. Canonical
      // rendering (per-name UI) is #324's concern; the wire keeps full fidelity.
      return {
        name: "harness.native",
        payload: {
          harness: event.harness,
          name: event.name,
          payload: event.payload,
        },
      };
    case "agent.step.start":
      return {
        name: "step.start",
        payload: {
          span_id: event.spanId,
          parent_span_id: event.parentSpanId,
          step_name: event.stepName,
          agent_name: event.agentName,
          arguments: event.arguments,
        },
      };
    case "agent.step.end": {
      const payload: Record<string, unknown> = {
        span_id: event.spanId,
        parent_span_id: event.parentSpanId,
        step_name: event.stepName,
        agent_name: event.agentName,
        arguments: event.arguments,
        result: event.result,
        duration_ms: event.durationMs,
      };
      if (event.error !== undefined) payload.error = event.error;
      return { name: "step.end", payload };
    }
    case "agent.backpack.drop": {
      const payload: Record<string, unknown> = {
        key: event.key,
        origin: event.origin,
        ordinal: event.ordinal,
        accepted: event.accepted,
        merged: event.merged,
        skipped: event.skipped,
        indexes: event.indexes,
        size_before: event.sizeBefore,
        size_after: event.sizeAfter,
        previews: event.previews,
        previews_omitted: event.previewsOmitted,
      };
      if (event.toolCallId !== undefined) payload.tool_call_id = event.toolCallId;
      if (event.tag !== undefined) payload.tag = event.tag;
      if (event.display !== undefined) payload.display = event.display;
      return { name: "backpack.drop", payload };
    }
    case "agent.backpack.read": {
      const payload: Record<string, unknown> = {
        key: event.key,
        origin: event.origin,
        ordinal: event.ordinal,
        memo_hit: event.memoHit,
        size: event.size,
        preview: event.preview,
      };
      if (event.toolCallId !== undefined) payload.tool_call_id = event.toolCallId;
      if (event.display !== undefined) payload.display = event.display;
      return { name: "backpack.read", payload };
    }
    case "agent.backpack.absorb": {
      const payload: Record<string, unknown> = {
        key: event.key,
        origin: event.origin,
        ordinal: event.ordinal,
        child_size: event.childSize,
        accepted: event.accepted,
        merged: event.merged,
        size_before: event.sizeBefore,
        size_after: event.sizeAfter,
        appended_indexes: event.appendedIndexes,
      };
      if (event.toolCallId !== undefined) payload.tool_call_id = event.toolCallId;
      if (event.display !== undefined) payload.display = event.display;
      return { name: "backpack.absorb", payload };
    }
    case "agent.scratchpad.write": {
      const payload: Record<string, unknown> = {
        key: event.key,
        origin: event.origin,
        ordinal: event.ordinal,
        op: event.op,
        had_value: event.hadValue,
        after: event.after,
      };
      if (event.toolCallId !== undefined) payload.tool_call_id = event.toolCallId;
      if (event.before !== undefined) payload.before = event.before;
      return { name: "scratchpad.write", payload };
    }
    case "agent.scratchpad.read": {
      const payload: Record<string, unknown> = {
        key: event.key,
        origin: event.origin,
        ordinal: event.ordinal,
        preview: event.preview,
      };
      if (event.toolCallId !== undefined) payload.tool_call_id = event.toolCallId;
      return { name: "scratchpad.read", payload };
    }
    case "agent.scratchpad.fork":
      return {
        name: "scratchpad.fork",
        payload: {
          origin: event.origin,
          ordinal: event.ordinal,
          shared_keys: event.sharedKeys,
        },
      };
    case "agent.scratchpad.join":
      return {
        name: "scratchpad.join",
        payload: {
          origin: event.origin,
          ordinal: event.ordinal,
          merged_keys: event.mergedKeys,
          discarded_keys: event.discardedKeys,
        },
      };
    default: {
      // Exhaustiveness check — a new AgentEvent variant without a branch here
      // is a compile-time error.
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Derived: name map and payload extractor (thin wrappers around toSSEMapping)
// ---------------------------------------------------------------------------

/**
 * Map from internal `AgentEvent.type` to canonical SSE wire name. Useful
 * when a consumer only needs the name (routing, logging) and not the
 * payload. For `agent.reasoning` the default entry is `"thinking"`; the
 * `isComplete=true` variant produces `"thinking.complete"` via
 * `toSSEMapping` — consumers that care should use that directly.
 */
export const SSE_EVENT_NAMES: Readonly<Record<AgentEventType, SSEEventName>> = {
  "agent.conversation.start": "conversation.start",
  "agent.conversation.end": "conversation.end",
  "agent.message.start": "message.start",
  "agent.message.chunk": "message.delta",
  "agent.message.complete": "message.complete",
  "agent.message.cancel": "message.cancel",
  "agent.input.request": "input.request",
  "agent.thinking.start": "thinking.start",
  "agent.reasoning": "thinking",
  "agent.tool.intent": "tool.intent",
  "agent.tool.start": "tool.start",
  "agent.tool.progress": "tool.progress",
  "agent.tool.end": "tool.end",
  "agent.tool.rejected": "tool.rejected",
  "agent.gate.decision": "gate.decision",
  "agent.step.start": "step.start",
  "agent.step.end": "step.end",
  "agent.iteration.start": "iteration.start",
  "agent.iteration.end": "iteration.end",
  "agent.llm.start": "llm.start",
  "agent.llm.end": "llm.end",
  "agent.backpack.drop": "backpack.drop",
  "agent.backpack.read": "backpack.read",
  "agent.backpack.absorb": "backpack.absorb",
  "agent.scratchpad.write": "scratchpad.write",
  "agent.scratchpad.read": "scratchpad.read",
  "agent.scratchpad.fork": "scratchpad.fork",
  "agent.scratchpad.join": "scratchpad.join",
  "agent.error": "error",
  "claude_code.hook": "claude_code.hook",
  "harness.native": "harness.native",
} as const;

// ---------------------------------------------------------------------------
// SSEFormatter class
// ---------------------------------------------------------------------------

/**
 * Formats `AgentEvent`s as SSE frames with canonical event names.
 *
 * Delegates all mapping to `toSSEMapping`; this class exists to carry the
 * trace-context enrichment (traceId + timestamp) onto the payload so the
 * runtime's admin SSE broadcast stays self-describing.
 */
export class SSEFormatter {
  /**
   * @param options Optional formatter config (ADR-0006 §4:
   *   `artifactByteCeiling` override). Omit for the default ceiling.
   */
  constructor(private readonly options?: SSEFormatterOptions) {}

  /** Format an AgentEvent as an SSE frame string, or `null` if unmappable. */
  format(event: AgentEvent): string | null {
    const mapping = toSSEMapping(event, this.options);
    if (!mapping) return null;
    const enriched = {
      ...mapping.payload,
      traceId: event.traceId,
      timestamp: event.timestamp.toISOString(),
    };
    return `event: ${mapping.name}\ndata: ${JSON.stringify(enriched)}\n\n`;
  }

  /**
   * Extract the payload from an event using canonical snake_case field
   * names. Static so StdioAdapter and other consumers can reuse it without
   * instantiating a formatter. Returns `null` if the event has no mapping.
   */
  static extractPayload(
    event: AgentEvent,
    options?: SSEFormatterOptions,
  ): Record<string, unknown> | null {
    return toSSEMapping(event, options)?.payload ?? null;
  }

  /** Format a stream-terminator "done" event. */
  static formatDone(): string {
    return "event: done\ndata: {}\n\n";
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible function API
// ---------------------------------------------------------------------------

const _defaultFormatter = new SSEFormatter();

/**
 * Format an AgentEvent as an SSE frame string.
 *
 * @deprecated Use `new SSEFormatter().format(event)` instead.
 */
export function formatSSE(event: AgentEvent): string | null {
  return _defaultFormatter.format(event);
}
