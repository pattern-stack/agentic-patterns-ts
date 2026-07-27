/**
 * Typed client-side view of the canonical SSE vocabulary emitted by
 * `@agentic-patterns/server` on `POST /conversations/:id/messages`.
 *
 * Mirrors the runtime's `SSEEventName` + `toSSEMapping` so the dashboard
 * can stay standalone (no workspace dep on runtime/server) while still
 * pattern-matching on typed event names and payloads. If a new event is
 * added to the runtime vocabulary, update the union here to match.
 */

/**
 * #388 — cache/reasoning token detail, snake_case wire shape (mirrors the
 * runtime's `TokenUsageDetails` via `toSnakeUsageDetails`). Every member is
 * independently optional; present only when the provider reported it —
 * absent means unreported, never zero.
 */
export type UsageDetailsWire = {
  no_cache_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  text_tokens?: number;
  reasoning_tokens?: number;
};

export type ClientEvent =
  | { name: "conversation.start"; data: { conversation_id: string; agent_name: string } }
  | { name: "conversation.end"; data: { conversation_id: string; reason: string } }
  | { name: "message.start"; data: { agent_name: string } }
  | { name: "message.delta"; data: { delta: string; chunk_index: number } }
  | {
      name: "message.complete";
      data: {
        content: string;
        input_tokens: number;
        output_tokens: number;
        model: string;
        /** #324: total run cost in USD when the harness reports it (CC only). */
        cost_usd?: number;
        finish_reason?: string;
        /** #388: run-total cache/reasoning detail — absent ≠ zero. */
        usage_details?: UsageDetailsWire;
      };
    }
  | { name: "message.cancel"; data: { reason: string } }
  | {
      name: "input.request";
      data: {
        correlation_id: string;
        kind: "approval" | "select" | "text";
        prompt: string;
        options?: string[];
        tool_name?: string;
        tool_call_id?: string;
        arguments?: unknown;
      };
    }
  | { name: "thinking.start"; data: Record<string, never> }
  | { name: "thinking"; data: { content: string } }
  | { name: "thinking.complete"; data: { content: string } }
  | {
      name: "tool.intent";
      data: { tool_call_id: string; tool_name: string; arguments: unknown };
    }
  | {
      name: "tool.start";
      data: { tool_call_id: string; tool_name: string; arguments: unknown };
    }
  | {
      name: "tool.progress";
      data: { tool_call_id: string; progress: number; status_text?: string };
    }
  | {
      name: "tool.end";
      data: {
        tool_call_id: string;
        tool_name: string;
        result: unknown;
        duration_ms: number;
        error?: string;
      };
    }
  | {
      name: "tool.rejected";
      data: { tool_name: string; reason: string; gate_name: string };
    }
  // Tool-approval SDK-framing pair (#389) — the `toolApproval` bridge's own
  // requested/granted/denied events on the capable path. Layered ON TOP OF
  // `gate.decision` below (unchanged), not a replacement for it.
  | {
      name: "tool.approval.request";
      data: { tool_call_id: string; tool_name: string; arguments: unknown };
    }
  | {
      name: "tool.approval.response";
      data: {
        tool_call_id: string;
        tool_name: string;
        approved: boolean;
        settled_by: "gate" | "human" | "timeout";
        reason?: string;
        decision_kind?: string;
      };
    }
  | {
      name: "step.start";
      data: {
        span_id: string;
        parent_span_id?: string;
        step_name: string;
        agent_name?: string;
        arguments: unknown;
      };
    }
  | {
      name: "step.end";
      data: {
        span_id: string;
        parent_span_id?: string;
        step_name: string;
        agent_name?: string;
        arguments: unknown;
        result: unknown;
        duration_ms: number;
        error?: string;
      };
    }
  // State-delta events (#226) — Backpack/Scratchpad mutations, snake_case per
  // the runtime's `toSSEMapping`. Byte-capped previews carry an explicit
  // "(preview only)" marker when truncated — never silently clipped.
  | {
      name: "backpack.drop";
      data: {
        key: string;
        origin: "innate" | "explicit";
        ordinal: number;
        accepted: number;
        merged: number;
        skipped: number;
        indexes: number[];
        size_before: number;
        size_after: number;
        previews: { index: number; op: "added" | "merged"; preview: string }[];
        previews_omitted: number;
        tool_call_id?: string;
        tag?: string;
        display?: { caption?: string; attribution?: string };
      };
    }
  | {
      name: "backpack.read";
      data: {
        key: string;
        origin: "innate" | "explicit";
        ordinal: number;
        memo_hit: boolean;
        size: number;
        preview: string;
        tool_call_id?: string;
        display?: { caption?: string; attribution?: string };
      };
    }
  | {
      name: "backpack.absorb";
      data: {
        key: string;
        origin: "innate" | "explicit";
        ordinal: number;
        child_size: number;
        accepted: number;
        merged: number;
        size_before: number;
        size_after: number;
        appended_indexes: number[];
        tool_call_id?: string;
        display?: { caption?: string; attribution?: string };
      };
    }
  | {
      name: "scratchpad.write";
      data: {
        key: string;
        origin: "innate" | "explicit";
        ordinal: number;
        op: "set" | "update";
        had_value: boolean;
        after: string;
        before?: string;
        tool_call_id?: string;
      };
    }
  | {
      name: "scratchpad.read";
      data: {
        key: string;
        origin: "innate" | "explicit";
        ordinal: number;
        preview: string;
        tool_call_id?: string;
      };
    }
  | {
      name: "scratchpad.fork";
      data: { origin: "innate" | "explicit"; ordinal: number; shared_keys: string[] };
    }
  | {
      name: "scratchpad.join";
      data: {
        origin: "innate" | "explicit";
        ordinal: number;
        merged_keys: string[];
        discarded_keys: string[];
      };
    }
  // Gate-decision audit signal (F-2, #324) — one post-decision record per intent
  // (allow or block), carrying provenance + the evaluation trail.
  | {
      name: "gate.decision";
      data: {
        tool_name: string;
        outcome: "allow" | "block";
        settled_by: "gate" | "human" | "timeout";
        decision_kind?: string;
        blocked_by?: string;
        reason?: string;
        trail: { gate: string; result: "allow" | "block" | "modified" }[];
      };
    }
  // Loop / model-call lifecycle (#286 — previously drifted, dashboard-blind).
  // `synthetic: true` marks a boundary the CC translator RECONSTRUCTED rather
  // than observed (D12) — badge it and NEVER treat it as a causal latency anchor.
  | {
      name: "iteration.start";
      data: { iteration: number; max_iterations: number; synthetic?: boolean };
    }
  | {
      name: "iteration.end";
      data: {
        iteration: number;
        tool_calls_count: number;
        has_more: boolean;
        synthetic?: boolean;
      };
    }
  | {
      name: "llm.start";
      data: { model: string; message_count: number; has_tools: boolean; synthetic?: boolean };
    }
  | {
      name: "llm.end";
      data: {
        model: string;
        input_tokens: number;
        output_tokens: number;
        duration_ms: number;
        finish_reason: string;
        /** #388: per-call cache/reasoning detail — absent ≠ zero. */
        usage_details?: UsageDetailsWire;
      };
    }
  // Claude Code hook passthrough (#286) — SDK hook fired during a CC run.
  | {
      name: "claude_code.hook";
      data: {
        hook_name: string;
        session_id?: string;
        cwd?: string;
        tool_name?: string;
        tool_input?: unknown;
        tool_response?: unknown;
        tool_use_id?: string;
        permission_mode?: string;
        transcript_path?: string;
        runner_correlation_id?: string;
        payload?: unknown;
      };
    }
  // Harness-native passthrough envelope (#323/#324) — a harness-specific event
  // (compaction boundary, subagent progress, rate-limit notice) preserved verbatim.
  | {
      name: "harness.native";
      data: { harness: string; name: string; payload: Record<string, unknown> };
    }
  | {
      name: "error";
      data: { error_type: string; message: string; recoverable: boolean };
    }
  | { name: "done"; data: Record<string, never> };

export type ClientEventName = ClientEvent["name"];

/**
 * The runtime-enumerable list of every KNOWN wire event name — the value-level
 * twin of the `ClientEventName` type union (a type can't be iterated). The
 * drift-check test (`__tests__/sse-events.drift.test.ts`) asserts this set
 * covers every name in the runtime's committed manifest (#286/#324), so a wire
 * event the runtime emits can never again silently lack a typed client view.
 *
 * The `satisfies` clause proves every entry is a real `ClientEventName`; the
 * `_MissingClientName` guard below proves none is omitted — together pinning
 * this array to be EXACTLY the union. Add a name to `ClientEvent` and this file
 * fails to compile until the array is updated.
 */
export const CLIENT_EVENT_NAMES = [
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
  "tool.approval.request",
  "tool.approval.response",
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
  "claude_code.hook",
  "harness.native",
  "error",
  "done",
] as const satisfies readonly ClientEventName[];

// Exhaustiveness guard — see the doc comment above.
type _MissingClientName = Exclude<ClientEventName, (typeof CLIENT_EVENT_NAMES)[number]>;
const _clientNamesAreExhaustive: _MissingClientName extends never
  ? true
  : ["missing client names"] = true;
void _clientNamesAreExhaustive;

/**
 * A decoded SSE frame: an event `name` + its JSON `data`, with NO name allowlist.
 *
 * Deliberately permissive. The transport (`chat-client.parseFrame`) is a dumb
 * decoder — it never drops a frame by name; the reducer (`applyParts` in
 * chat/model.ts) is the SINGLE authority on what renders, folding the events it
 * knows and ignoring the rest. An allowlist HERE was the footgun that silently
 * ate `agent.step.*` (steps ran server-side but never reached the chat). Keeping
 * the parser dumb means a new server event can never again vanish in transit —
 * it flows to the reducer, which renders it or ignores it, but never drops it
 * invisibly. `ClientEvent` above remains the typed documentation of KNOWN
 * payload shapes; it is not a gate.
 */
export interface WireFrame {
  name: string;
  data: Record<string, unknown>;
}
