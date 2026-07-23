/**
 * Harness decision & gate-evaluation contract (design.md §5.4, F-2 / D4 / D12).
 *
 * These are the *type declarations* threaded through the permission bridge:
 * adapter → `evaluateIntent` → approval callback → transport → audit. F-2 lands
 * the types only; the harness adapters (Track B) consume them in later slices
 * (B-1/B-2/B-3, issues #326/#328 and the CC/Codex adapters).
 *
 * A `ToolCallIntent` alone (tool id/name/args) cannot carry native proposals or
 * available decisions, so the native ask context ({@link AskContext}) is a
 * first-class input that travels the whole path.
 *
 * Layer note: this module lives in `gates/` (layer 6) and imports only
 * `events/` types (layer 5) — never the reverse.
 */

import type { ToolCallIntent } from "../events/types.js";

// ---------------------------------------------------------------------------
// Foundational native types (fuller definitions land with the Track B adapters —
// §5.1/§5.2; declared minimally here because AskContext/HarnessDecision need them)
// ---------------------------------------------------------------------------

/**
 * The operation classes a harness can intercept (§5.2). Network egress is NOT
 * an operation class — it is an effect governed by sandbox/network policy.
 */
export type OperationClass =
  | "shell"
  | "file-change"
  | "mcp-tool"
  | "local-tool"
  | "hosted-tool"
  | "subagent";

/** Native id triple carried on every harness event (§5.1). */
export interface NativeIds {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
}

/**
 * An authenticated actor identity. Present on an {@link AskContext} only once
 * the server auth seam (#307) authenticates the transport (D13); absent today.
 */
export interface ActorRef {
  readonly id: string;
  readonly kind?: "user" | "service" | "agent";
  readonly displayName?: string;
}

/**
 * The normalized, frontend-renderable shape of a native ask. Adapters normalize
 * per-operation native payloads (shell → command string; file-change →
 * NormalizedDiff; MCP tool → schema'd args) into this so the dashboard renders
 * N harnesses with one component set (§5.4). Expanded per-operation in B-2.
 */
export interface NormalizedAskPayload {
  /** One-line human summary the frontend renders as the ask headline. */
  readonly summary: string;
  /** Operation-specific structured detail (command, diff, args, …). */
  readonly detail?: unknown;
}

// ---------------------------------------------------------------------------
// Native proposals & permissions (§5.4, D4)
// ---------------------------------------------------------------------------

/**
 * A native rule/amendment suggestion carried on an ask. Decisions reference
 * these by id rather than inventing free-form policy.
 */
export interface NativeProposal {
  /** Referenced by {@link ProposalRef}. */
  readonly id: string;
  readonly nativeKind:
    | "cc-permission-update"
    | "codex-execpolicy-amendment"
    | "codex-networkpolicy-amendment";
  /**
   * CC `destination:"session"` → `["session"]`; CC settings destinations →
   * `["durable"]`; Codex amendments → per R-1's persistence findings.
   */
  readonly allowedScopes: ReadonlyArray<"session" | "durable">;
  /** The native suggestion, passed through opaquely. */
  readonly payload: unknown;
}

/** Reference to a {@link NativeProposal} on the same request. */
export interface ProposalRef {
  readonly proposalId: string;
}

/**
 * Normalized permission set. Subset checks compare by permission id.
 */
export type PermissionSet = ReadonlyArray<{ permission: string; detail?: unknown }>;

// ---------------------------------------------------------------------------
// The decision contract (§5.4, D4 v4)
// ---------------------------------------------------------------------------

/**
 * A human/policy decision on a native ask. `allowSession` (proposal-free native
 * session cache) and `allowWithRules` (references the request's proposals) are
 * SEPARATE kinds: Codex has a proposal-free session cache; Claude Code does not
 * (its session rules must echo the request's own `updatedPermissions`
 * suggestions), and conflating them made the CC mapping unimplementable.
 */
export type HarnessDecision =
  | { kind: "allowOnce" }
  | { kind: "allowSession" }
  | {
      kind: "allowWithRules";
      /** ≥1, must reference the request's proposals. */
      ruleRefs: [ProposalRef, ...ProposalRef[]];
      scope: "session" | "durable";
    }
  | { kind: "deny"; reason?: string }
  | { kind: "cancel" }
  | { kind: "rewriteInput"; updatedInput: unknown }
  | { kind: "grantPermissions"; granted: PermissionSet; scope: "turn" | "session" };

/** The discriminant set of {@link HarnessDecision}. */
export type DecisionKind = HarnessDecision["kind"];

// ---------------------------------------------------------------------------
// Gate requirements (§5.2) — a gate's declared adapter requirements
// ---------------------------------------------------------------------------

/**
 * Optional adapter requirements a gate declares (§5.2, design D-B2). A gate that
 * must synchronously inspect (block/ask before execution) certain operation
 * classes, or rewrite tool input, declares it here. At run start the
 * `CodingAgentRunner` base collects these across the configured chain and
 * compares them against the harness probe's `enforcement` matrix +
 * `features.inputRewrite`; any gap fails loud, naming the gate and the class.
 *
 * Absent (the default for every existing gate) → the gate imposes NO adapter
 * requirements and is unaffected by the run-start check. Network policy is
 * explicitly NOT expressible here — it is a run-configuration concern set at
 * session start against the probe's `sandbox` record, not a gate-compatibility
 * one (§5.2).
 */
export interface GateRequirements {
  /**
   * Operation classes this gate must be able to intercept — i.e. the harness
   * must declare `enforcement: "enforcing"` for each. `"advisory"` or
   * `"unsupported"` for any listed class fails the run at start.
   */
  readonly interceptClasses?: OperationClass[];
  /**
   * True when the gate rewrites tool input (modified-intent passthrough). The
   * harness must declare `features.inputRewrite: true` or the run fails at start.
   */
  readonly rewrite?: boolean;
}

// ---------------------------------------------------------------------------
// Ask context — the native ask threaded through evaluation (§5.4, F-2)
// ---------------------------------------------------------------------------

/**
 * The native ask context, a first-class input to {@link AgentEventBus.evaluateIntent}.
 * Optional there because `AgentRunner`'s own loop evaluates plain intents with
 * no native ask.
 */
export interface AskContext {
  /** Mandatory local settlement key (the harness `respond()` keys on it). */
  readonly requestId: string;
  readonly operation: OperationClass;
  /** What the frontend renders. */
  readonly payload: NormalizedAskPayload;
  readonly proposals: NativeProposal[];
  readonly availableDecisions: DecisionKind[];
  /** Permission-requests only. */
  readonly requested?: PermissionSet;
  readonly nativeIds: NativeIds;
  /** D13 flag state — the UI greys durable options when false. */
  readonly durableEnabled: boolean;
  /** Present once #307 authenticates the transport. */
  readonly actor?: ActorRef;
}

// ---------------------------------------------------------------------------
// Gate evaluation result (§5.4, F-2)
// ---------------------------------------------------------------------------

/** One step of the gate chain, for the audit trail. */
export interface GateTrailEntry {
  readonly gate: string;
  readonly result: "allow" | "block" | "modified";
}

/**
 * The result of running an intent through the gate chain. `intent` is the
 * POST-modification intent — what actually executes.
 */
export interface GateEvaluation {
  readonly outcome: "allow" | "block";
  /** Post-modification intent — what executes. */
  readonly intent: ToolCallIntent;
  /** Present when an approval gate decided (vs a plain allow/block). */
  readonly decision?: HarnessDecision;
  /** Audit + UI distinguish declined vs expired vs mechanical. */
  readonly settledBy: "gate" | "human" | "timeout";
  readonly blockedBy?: string;
  readonly reason?: string;
  readonly trail: readonly GateTrailEntry[];
}
