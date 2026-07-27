/**
 * `tool-approval-bridge.ts` — bridges the runtime's gate chain (layer 6,
 * `AgentEventBus.evaluateIntent`) to v7's native `toolApproval` callback on
 * the `runStructured()` capable path (spec #389, D0 Option C).
 *
 * The gate chain stays the SINGLE policy brain: {@link createGateToolApproval}
 * returns a callback that awaits `bus.evaluateIntent(...)` — the exact same
 * entry point `run()`/`stream()` use — and maps its `GateEvaluation` onto the
 * SDK's `ToolApprovalStatus` vocabulary. The gate runs exactly ONCE per tool
 * call, before execution; `agent.gate.decision` / `agent.tool.rejected` /
 * `agent.input.request` are emitted by `evaluateIntent` itself, unchanged.
 *
 * NEVER returns `'user-approval'`: the callback always resolves `'approved'`
 * or `'denied'` in-process, including awaiting a live human via the existing
 * `PendingInputRegistry` round-trip (`interaction/approval-gate.ts`). Because
 * `'user-approval'` is never returned, the SDK's pause/resume machinery and
 * `experimental_toolApprovalSecret` HMAC signing are never exercised — see
 * the spec's "HMAC verdict": that machinery authenticates a response replayed
 * across the trust boundary between two SDK calls, and under this design no
 * `ToolApprovalResponse` is ever constructed from client data. Adopt the
 * secret only if a real pause/resume shape ships later (Option B follow-up).
 *
 * `rewriteInput`/`modify` is a NEW capability on the capable path (the
 * boolean `emitIntent` this replaces could not honor it at all — it discarded
 * the `GateEvaluation` entirely). The SDK's `toolApproval` API has no rewrite
 * affordance, so a `modify` decision is mapped to `approved` and the
 * REWRITTEN args are handed to `execute` via {@link ToolArgsOverlay}, a
 * per-`toolCallId` one-shot map owned by the bridge. Consequence (documented,
 * not a bug): the model's message history shows the ORIGINAL args (the SDK
 * appended them before approval ran), while execution uses the rewritten
 * ones — the gate trail + audit phase record the modification, so the audit
 * story is intact.
 *
 * FAIL-CLOSED POSTURE (#389 fix-round, documented deliberately — both cases
 * below deny rather than let the run hang or crash):
 * - **Abort mid-decision.** `ctx.abortSignal` (threaded from `RunOptions`) is
 *   raced against `bus.evaluateIntent(...)` — if it fires before the gate
 *   chain settles (most commonly while a human decision is pending), the
 *   callback resolves `denied` immediately instead of hanging until a human
 *   answers or a gate's own `timeoutMs` elapses. Best-effort registry
 *   cleanup: if `ctx.pendingInputRegistry` was also threaded through (the
 *   SAME instance a human-approval gate uses), its entry for this
 *   `toolCallId` is settled too, so the abort never orphans a pending
 *   human-input row.
 * - **A throwing gate.** `bus.evaluateIntent(...)` has no try/catch of its
 *   own — a `Gate.check()` that throws rejects `evaluateIntent`, which would
 *   otherwise reject this callback and crash the WHOLE `generateText` run.
 *   That is asymmetric with the human-timeout fail-closed stance (a stuck
 *   human denies; a broken gate shouldn't do worse). The bridge catches it,
 *   denies, and surfaces the error message on the response event's `reason`
 *   for audit visibility — the native toolApproval loop then continues (a
 *   denial is a normal, model-visible outcome), it does not crash the run.
 */

import type { AgentEventBus } from "../events/agent-event-bus.js";
import { createEvent } from "../events/types.js";
import type { GateEvaluation } from "../gates/decisions.js";
import type { PendingInputRegistry } from "../interaction/pending-input-registry.js";

// ---------------------------------------------------------------------------
// Abort race helper
// ---------------------------------------------------------------------------

/** Sentinel distinguishing "the signal fired first" from a real `GateEvaluation`. */
const ABORTED = Symbol("tool-approval-bridge:aborted");

/**
 * Race `promise` against `signal` firing. No signal → passthrough. Rejections
 * from `promise` propagate (the caller's try/catch handles a throwing gate);
 * an abort resolves to {@link ABORTED} instead of rejecting, since aborting is
 * a normal, expected outcome here (fail-closed deny), not an error.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Rewritten-argument overlay
// ---------------------------------------------------------------------------

/**
 * Per-`toolCallId` overlay of rewritten tool arguments, populated when a
 * gate's `rewriteInput` decision recovers new args for a call `execute`
 * hasn't dispatched yet. One instance per run (owned by the bridge returned
 * from {@link createGateToolApproval}); `execute` consults it via {@link take}
 * before dispatch — a one-shot read that removes the entry so a retried
 * `toolCallId` (which cannot happen under v7's id scheme, but defensively)
 * never replays a stale rewrite.
 */
export class ToolArgsOverlay {
  private readonly _overlay = new Map<string, Record<string, unknown>>();

  set(toolCallId: string, args: Record<string, unknown>): void {
    this._overlay.set(toolCallId, args);
  }

  /** One-shot read: returns and removes the overlay entry for `toolCallId`, if any. */
  take(toolCallId: string): Record<string, unknown> | undefined {
    const args = this._overlay.get(toolCallId);
    if (args !== undefined) this._overlay.delete(toolCallId);
    return args;
  }
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

export interface ToolApprovalBridgeContext {
  /** The bus whose gate chain is the policy brain — same one `run()`/`stream()` use. */
  readonly bus: AgentEventBus;
  readonly traceId: string;
  readonly runId: string;
  /** Anchors the request/response events under the run's root span. */
  readonly parentSpanId: string;
  /**
   * #389 fix-round — `RunOptions.abortSignal`, forwarded. Raced against a
   * pending gate evaluation so an abort fails closed (deny) promptly instead
   * of hanging; see the file header's "FAIL-CLOSED POSTURE" note.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * #389 fix-round — `RunOptions.pendingInputRegistry`, forwarded. Best-effort
   * only: settles the SAME registry's pending entry for an aborted call's
   * `toolCallId`, if one exists, so an abort never orphans a pending
   * human-input row. See the file header's "FAIL-CLOSED POSTURE" note.
   */
  readonly pendingInputRegistry?: PendingInputRegistry;
}

/**
 * The narrow shape of the SDK's tool call this bridge actually reads. A
 * structural subtype of `ai`'s `TypedToolCall<TOOLS>` — every variant of that
 * union carries at least these three fields — so the callback below is
 * structurally assignable to `GenericToolApprovalFunction<TOOLS, ...>` at the
 * `generateText({ toolApproval })` call site without importing the SDK's own
 * (deeply generic) type here.
 */
interface BridgeToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/** The callback shape `generateText`/`streamText`'s `toolApproval` option expects. */
export type GateToolApprovalFn = (options: {
  toolCall: BridgeToolCall;
}) => Promise<{ type: "approved" | "denied"; reason?: string }>;

/** What {@link createGateToolApproval} hands back to the capable path. */
export interface ToolApprovalBridge {
  /** Pass directly as `generateText({ toolApproval: bridge.toolApproval, ... })`. */
  readonly toolApproval: GateToolApprovalFn;
  /** The rewrite overlay `execute` must consult before dispatch. */
  readonly overlay: ToolArgsOverlay;
}

/**
 * Build the `toolApproval` callback + rewrite overlay for one `runStructured()`
 * capable-path call. Create a fresh instance per run — the overlay is
 * run-scoped, not global.
 */
export function createGateToolApproval(ctx: ToolApprovalBridgeContext): ToolApprovalBridge {
  const overlay = new ToolArgsOverlay();

  const toolApproval: GateToolApprovalFn = async (options) => {
    const { toolCall } = options;
    const toolName = toolCall.toolName;
    const args = (toolCall.input ?? {}) as Record<string, unknown>;

    // Build the intent with the SDK's OWN toolCallId — not a freshly
    // generated one — so approval correlation isn't orphaned (the id
    // appears in the SDK's own approval parts and `ToolExecutionOptions`).
    const intent = createEvent("agent.tool.intent", {
      traceId: ctx.traceId,
      runId: ctx.runId,
      parentSpanId: ctx.parentSpanId,
      toolCallId: toolCall.toolCallId,
      toolName,
      arguments: args,
    });

    // SDK-approval framing, published BEFORE evaluation — see the spec's
    // ordering guarantee (request -> gate.decision -> response -> dispatch).
    await ctx.bus.publish(
      createEvent("agent.tool.approval.request", {
        traceId: ctx.traceId,
        runId: ctx.runId,
        parentSpanId: ctx.parentSpanId,
        toolCallId: toolCall.toolCallId,
        toolName,
        arguments: args,
      }),
    );

    /** Publish the response event + return a denied outcome (fail-closed helper). */
    const denyClosed = async (
      reason: string,
      settledBy: GateEvaluation["settledBy"],
    ): Promise<{ type: "denied"; reason: string }> => {
      await ctx.bus.publish(
        createEvent("agent.tool.approval.response", {
          traceId: ctx.traceId,
          runId: ctx.runId,
          parentSpanId: ctx.parentSpanId,
          toolCallId: toolCall.toolCallId,
          toolName,
          approved: false,
          reason,
          settledBy,
        }),
      );
      return { type: "denied", reason };
    };

    // Already aborted BEFORE the gate chain would even run: short-circuit
    // without calling `evaluateIntent` at all — a gate (e.g. the human one)
    // must never be given the chance to publish a request / register a
    // pending decision for a call that's already dead.
    if (ctx.abortSignal?.aborted) {
      return denyClosed("Run aborted", "timeout");
    }

    // The gate chain runs exactly once here — via the SAME entry point
    // run()/stream() use. This is where a live human is awaited in-process
    // (PendingInputRegistry), and where agent.gate.decision / agent.tool.rejected
    // / agent.input.request are emitted (by evaluateIntent itself, unchanged).
    let evaluation: GateEvaluation;
    try {
      const settled = await raceAbort(ctx.bus.evaluateIntent(intent), ctx.abortSignal);
      if (settled === ABORTED) {
        // Fail-closed: see the file header's "FAIL-CLOSED POSTURE" note.
        // `settledBy: "timeout"` mirrors the registry's own timeoutMs
        // fallback — both represent "no real decision arrived in time."
        ctx.pendingInputRegistry?.resolve(toolCall.toolCallId, {
          decision: "deny",
          timedOut: true,
        });
        return denyClosed("Run aborted", "timeout");
      }
      evaluation = settled;
    } catch (err) {
      // Fail-closed: see the file header's "FAIL-CLOSED POSTURE" note.
      // `settledBy: "gate"` — the gate itself is the source of this outcome,
      // just via failure rather than a clean allow/block decision.
      const message = err instanceof Error ? err.message : String(err);
      return denyClosed(`Gate evaluation failed: ${message}`, "gate");
    }

    const approved = evaluation.outcome === "allow";

    await ctx.bus.publish(
      createEvent("agent.tool.approval.response", {
        traceId: ctx.traceId,
        runId: ctx.runId,
        parentSpanId: ctx.parentSpanId,
        toolCallId: toolCall.toolCallId,
        toolName,
        approved,
        ...(evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
        settledBy: evaluation.settledBy,
        ...(evaluation.decision ? { decisionKind: evaluation.decision.kind } : {}),
      }),
    );

    if (!approved) {
      return {
        type: "denied",
        ...(evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
      };
    }

    // rewriteInput/modify (NEW capability, see file header): `evaluation.intent`
    // is the POST-modification intent — stash its args for `execute` to pick
    // up. Writing unconditionally on allow is harmless when nothing rewrote
    // the call (the overlay then just carries the same args back).
    overlay.set(toolCall.toolCallId, evaluation.intent.arguments);

    return { type: "approved" };
  };

  return { toolApproval, overlay };
}
