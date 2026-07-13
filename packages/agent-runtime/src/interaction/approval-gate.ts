/**
 * `createHumanInputApprovalGate` — wire the runtime's {@link HumanApprovalGate}
 * to a live human, via the {@link PendingInputRegistry} round-trip.
 *
 * The gate blocks a guarded tool call synchronously inside `AgentEventBus.
 * publish`. This helper's `approvalFn`:
 *   1. publishes an `agent.input.request` event on the bus — a per-conversation
 *      transport subscription delivers it into the live chat stream WHILE the
 *      run is blocked (the runner generator is parked, but the bus keeps
 *      firing);
 *   2. registers the pending request and awaits the human's answer;
 *   3. maps `approve → allow`, everything else → block.
 *
 * DEDUPE: the streaming runner gate-checks each intent TWICE (an observability
 * `emit` then the block-detecting `emitIntent`), so `approvalFn` fires twice
 * per `toolCallId`. We memoize the in-flight decision by `toolCallId` so
 * exactly ONE request event is published and ONE human answer resolves both
 * checks. (The two checks are sequential — the first fully settles before the
 * second runs — so the memo is always populated by the time the second asks.)
 */

import type { AgentEventBus } from "../events/agent-event-bus.js";
import type { ToolCallIntent } from "../events/types.js";
import { createEvent } from "../events/types.js";
import type { ApprovalCallback } from "../gates/approval.js";
import { HumanApprovalGate } from "../gates/approval.js";
import type { PendingInputRegistry } from "./pending-input-registry.js";

export interface HumanInputApprovalGateOptions {
  /** The bus the gate is attached to — used to publish the request event. */
  readonly bus: AgentEventBus;
  /** Where pending decisions are parked until the human answers. */
  readonly registry: PendingInputRegistry;
  /** Tool names that require approval. A call to any other tool passes freely. */
  readonly tools: Set<string>;
  /** Auto-deny after this many ms with no answer (fail closed). Omit for no timeout. */
  readonly timeoutMs?: number;
  /** Override the human-facing prompt for a given intent. */
  readonly prompt?: (intent: ToolCallIntent) => string;
}

/** Default prompt: name the tool the agent wants to run. */
function defaultPrompt(intent: ToolCallIntent): string {
  return `The agent wants to run "${intent.toolName}". Approve?`;
}

/**
 * Build a {@link HumanApprovalGate} whose decision comes from a live human via
 * the {@link PendingInputRegistry}. Attach the returned gate to `options.bus`
 * with `bus.addGate(...)`.
 */
export function createHumanInputApprovalGate(
  options: HumanInputApprovalGateOptions,
): HumanApprovalGate {
  const { bus, registry, tools, timeoutMs } = options;
  const inflight = new Map<string, Promise<boolean>>();

  const approvalFn: ApprovalCallback = (intent) => {
    const correlationId = intent.toolCallId;
    const memoized = inflight.get(correlationId);
    if (memoized) return memoized;

    // Register the pending answer BEFORE publishing so a resolve that races in
    // the instant the browser sees the prompt still finds the correlationId.
    const answer = registry.create(correlationId, {
      kind: "approval",
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

    const requestEvent = createEvent("agent.input.request", {
      traceId: intent.traceId,
      runId: intent.runId,
      parentSpanId: intent.spanId,
      correlationId,
      kind: "approval",
      prompt: (options.prompt ?? defaultPrompt)(intent),
      toolName: intent.toolName,
      toolCallId: intent.toolCallId,
      arguments: intent.arguments,
    });
    // Fire-and-forget: the transport subscription delivers it; a publish
    // failure must not turn into an approval (the registry still gates).
    void bus.publish(requestEvent);

    const decision = answer.then((r) => r.decision === "approve");
    inflight.set(correlationId, decision);
    return decision;
  };

  return new HumanApprovalGate({ approvalFn, tools });
}
