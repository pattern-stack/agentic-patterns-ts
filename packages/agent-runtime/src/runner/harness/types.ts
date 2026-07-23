/**
 * Harness adapter contract (design.md §5.1 / §5.2, B-2 / #326).
 *
 * The per-CLI native half of a coding-agent runner. `CodingAgentRunner` (the
 * harness-agnostic base) drives a `HarnessAdapter`: it `probe()`s the harness
 * for capabilities, `start()`s a `HarnessSession`, and translates the session's
 * normalized `HarnessEvent` stream into the canonical AgentEvent stream. One
 * place (the base) constructs AP events and touches the bus; adapters only
 * produce normalized events.
 *
 * PROVISIONAL (D3): these interfaces are validated against exactly one adapter
 * (Claude Code) here and one contract-tested harness (Codex, R-1). They are
 * expected to break when the Codex adapter lands (#330 / B-4) and those breaks
 * fold back deliberately. Written to be breakable, not final — no premature
 * abstraction hardening.
 *
 * Layer note: this module lives in `runner/` (layer 7) and imports `gates/`
 * (layer 6) decision types + `events/` (layer 5) — never the reverse.
 */

import type { ToolCallIntent } from "../../events/types.js";
import type { AskContext, GateEvaluation } from "../../gates/decisions.js";
import type {
  DecisionKind,
  NativeIds,
  NativeProposal,
  NormalizedAskPayload,
  OperationClass,
  PermissionSet,
} from "../../gates/decisions.js";
import type { AgentLike } from "../types.js";

export type { NativeIds, OperationClass } from "../../gates/decisions.js";

// ---------------------------------------------------------------------------
// Enforcement matrix (§5.2)
// ---------------------------------------------------------------------------

/**
 * How strongly a harness can act on an operation class BEFORE it executes.
 * - `enforcing`   — the adapter can synchronously block/ask before execution.
 * - `advisory`    — the adapter observes (telemetry) but cannot block.
 * - `unsupported` — the operation class cannot occur on this harness.
 */
export type Enforcement = "enforcing" | "advisory" | "unsupported";

// ---------------------------------------------------------------------------
// Event hierarchy (§5.1)
// ---------------------------------------------------------------------------

/**
 * Discriminated parent reference carried on a harness event. A Codex item
 * parent and a Claude Code `parent_tool_use_id` are NOT the same namespace, so
 * `kind` is mandatory — consumers must not guess which native id space applies.
 */
export type ParentRef =
  | { kind: "thread"; id: string }
  | { kind: "turn"; id: string }
  | { kind: "item"; id: string }
  | { kind: "tool-use"; id: string };

/** Per-LLM-call token usage carried on `llm-response`/`terminal`. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Normalized run finish reason (`stop` | `max-turns` | `error` | `budget` | `unknown` | …). */
export type FinishReason = string;

/** Normalized file-change diff (expanded per-harness in B-3/B-4). */
export interface NormalizedDiff {
  readonly path: string;
  readonly kind: "create" | "modify" | "delete" | "rename";
  readonly diff?: string;
}

/**
 * Provenance/hint metadata an adapter may attach to a harness event. Mirrors
 * `BaseEvent.meta` (D12). Breakable extension point over the design's verbatim
 * variant shapes — kept OFF the variant field lists so those stay faithful.
 * `observed` on a `turn-start` tells the base whether the harness saw a real
 * per-call start signal (→ non-synthetic `llm.start`) or the boundary was
 * synthesized. `finalText` on `terminal` is the fallback run content when no
 * text streamed.
 */
export interface HarnessEventMeta {
  readonly synthetic?: boolean;
  readonly observed?: boolean;
  readonly finalText?: string;
  readonly hasMore?: boolean;
  readonly toolCallsCount?: number;
  readonly [key: string]: unknown;
}

/**
 * The normalized envelope every harness session yields (§5.1). Native ids and
 * hierarchy ride EVERY event, not just approvals. The ask variants
 * (`approval-request` / `permission-request`) carry a MANDATORY `requestId` —
 * `HarnessSession.respond()` keys on it.
 *
 * `availableDecisions` is PRESENTATION metadata only (R-1 C1): it is a UI
 * ordering hint, NOT the decision-validation vocabulary. Decision-kind
 * validation uses the adapter's declared vocabulary ({@link HarnessAdapter.decisionVocabulary}),
 * never this field.
 */
export type HarnessEvent = { ids: NativeIds; parent?: ParentRef; meta?: HarnessEventMeta } & (
  | {
      kind: "approval-request";
      requestId: string;
      operation: OperationClass;
      payload: NormalizedAskPayload;
      proposals: NativeProposal[];
      /** UI ordering hint only — never the validation vocabulary (C1). */
      availableDecisions: DecisionKind[];
    }
  | {
      kind: "permission-request";
      requestId: string;
      operation: OperationClass;
      payload: NormalizedAskPayload;
      requested: PermissionSet;
      /** UI ordering hint only — never the validation vocabulary (C1). */
      availableDecisions: DecisionKind[];
    }
  | { kind: "llm-response"; usage: TokenUsage; model: string; stopReason: string }
  | { kind: "text-delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "turn-start" }
  | { kind: "turn-end" }
  | { kind: "tool-start"; name: string; operation: OperationClass; args: unknown }
  | {
      kind: "tool-end";
      name: string;
      result: unknown;
      durationMs: number;
      status: "ok" | "error" | "declined" | "cancelled";
    }
  | { kind: "file-change"; diff: NormalizedDiff }
  | { kind: "harness-native"; name: string; payload: unknown }
  | {
      kind: "terminal";
      numTurns: number;
      usage: TokenUsage;
      costUsd?: number;
      finishReason: FinishReason;
    }
);

/** The discriminant set of {@link HarnessEvent}. */
export type HarnessEventKind = HarnessEvent["kind"];

// ---------------------------------------------------------------------------
// Probe (§5.2)
// ---------------------------------------------------------------------------

export interface ProbeIssue {
  readonly code:
    | "binary-missing"
    | "auth-missing"
    | "schema-incompatible"
    | "policy-disabled"
    | "launch-failed";
  readonly detail: string;
}

/** Context passed to `probe()` — the harness config to inspect readiness for. */
export interface ProbeContext {
  /** Working directory the session will run in, when known. */
  readonly cwd?: string;
  /** Opaque adapter-specific hints (auth override, profile, …). */
  readonly hints?: Record<string, unknown>;
}

/**
 * Structured probe result (§5.2). `enforcement` carries exactly one value per
 * operation class. `cliVersion`/`protocolRevision` are optional — a probe can
 * fail (issues populated, `ok:false`) before discovering either.
 */
export interface HarnessProbeResult {
  readonly ok: boolean;
  readonly issues: ProbeIssue[];
  readonly cliVersion?: string;
  readonly authMode: "subscription" | "api-key" | "enterprise-token" | "none";
  readonly protocolRevision?: string;
  readonly enforcement: Record<OperationClass, Enforcement>;
  readonly sandbox: { networkPolicy: "configurable" | "fixed" | "none" };
  readonly features: {
    readonly interactiveAsk: boolean;
    readonly resume: boolean;
    readonly partialStreaming: boolean;
    readonly inputRewrite: boolean;
    readonly durableRules: boolean;
  };
}

// ---------------------------------------------------------------------------
// Decision vocabulary (§5.4, C1)
// ---------------------------------------------------------------------------

/**
 * The kind of native ask a harness can raise. Decision vocabularies differ per
 * request type (Codex command approvals ≠ file-change approvals ≠ permission
 * requests; §5.5). CC raises a single `tool-permission` ask via `canUseTool`.
 */
export type AskRequestType =
  | "tool-permission"
  | "command-approval"
  | "file-change-approval"
  | "permission-request";

/**
 * The adapter-declared, per-request-type table of decision kinds the harness's
 * schema legitimately accepts (C1). This — NOT the wire's `availableDecisions`
 * (presentation metadata) — is the validation vocabulary for step 1 of the D4
 * four-check validation. A request type absent from the table has an empty
 * vocabulary (every decision rejected).
 */
export type DecisionVocabulary = Readonly<Partial<Record<AskRequestType, readonly DecisionKind[]>>>;

// ---------------------------------------------------------------------------
// Adapter / session (§5.1)
// ---------------------------------------------------------------------------

/**
 * The base's gate-evaluation seam, injected into every run request. An adapter's
 * native inspection hook (CC `canUseTool`/`PreToolUse`, Codex `PreToolUse`)
 * consults this to gate an intent synchronously — the adapter never reaches into
 * the bus itself. The full ask→decision→respond bridge is B-3 (#328); B-2 wires
 * the synchronous allow/block seam CC already uses.
 */
export type IntentEvaluator = (intent: ToolCallIntent, ctx?: AskContext) => Promise<GateEvaluation>;

/**
 * Structured startup failure thrown from `HarnessAdapter.start()`. `code`
 * distinguishes the failure class so callers can act (re-auth vs re-install vs
 * schema bump) without string-matching.
 */
export class HarnessStartError extends Error {
  readonly code: "binary-missing" | "auth-missing" | "schema-incompatible" | "launch-failed";
  constructor(
    code: "binary-missing" | "auth-missing" | "schema-incompatible" | "launch-failed",
    message: string,
  ) {
    super(message);
    this.name = "HarnessStartError";
    this.code = code;
  }
}

/**
 * A launched harness session — the per-run native handle. Extends
 * `AsyncIterable<HarnessEvent>`: the base iterates the normalized stream and
 * translates it to AP events.
 *
 * Reply semantics (v3, §5.1): the session guarantees EXACTLY-ONCE LOCAL
 * settlement of every ask (by decision, timeout, interrupt, or close —
 * whichever comes first) and AT-MOST-ONCE wire response while connected. On
 * transport disconnect no wire guarantee is possible; the contract is
 * fail-closed cleanup (pending asks settle denied/cancelled locally, the run
 * errors).
 */
export interface HarnessSession extends AsyncIterable<HarnessEvent> {
  /**
   * Settle a native ask by its `requestId`. Idempotent per request: a second
   * call for an already-settled ask is a no-op (at-most-once wire response). The
   * full decision→native-reply mapping lands in B-3; B-2 provides local
   * settlement.
   */
  respond(
    requestId: string,
    decision: import("../../gates/decisions.js").HarnessDecision,
  ): Promise<void>;
  /** Interrupt the in-flight turn. Settles pending asks fail-closed. */
  interrupt(reason?: string): Promise<void>;
  /**
   * Idempotent, legal at any time: before terminal it interrupts, settles every
   * pending ask fail-closed, and drains; after terminal delivery it is a no-op.
   */
  close(): Promise<void>;
}

/**
 * Everything an adapter needs to launch a run. Generic over the agent shape so
 * the CC adapter can require its richer `AgentLikeForBridge` while the base
 * stays at `AgentLike`.
 */
export interface HarnessRunRequest<TAgent extends AgentLike = AgentLike> {
  readonly agent: TAgent;
  readonly message: string;
  readonly options: import("../types.js").RunOptions | undefined;
  readonly runId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  /**
   * Per-run correlation id, injected into the subprocess via the session's
   * env (never a `process.env` mutation). Lets the server tie the harness's
   * own hook POSTs back to this run.
   */
  readonly correlationId: string;
  /** True for `stream()`; governs partial-message emission where supported. */
  readonly streaming: boolean;
  /** The base's gate-evaluation seam (see {@link IntentEvaluator}). */
  readonly evaluateIntent: IntentEvaluator;
}

/**
 * The per-CLI native half of a coding-agent runner (§5.1). Both real permission
 * bridges are bidirectional, so `start()` returns a session, not a bare stream.
 */
export interface HarnessAdapter<TAgent extends AgentLike = AgentLike> {
  /** Stable harness id — `"claude-code"` | `"codex"` | … */
  readonly name: string;
  /**
   * The adapter-declared decision vocabulary per request type (C1). The base's
   * decision-validation helper reads THIS, never the wire's `availableDecisions`.
   */
  readonly decisionVocabulary: DecisionVocabulary;
  /** Inspect harness capabilities/readiness (§5.2). */
  probe(ctx: ProbeContext): Promise<HarnessProbeResult>;
  /**
   * Launch a session. Async — handshake/startup failures throw
   * {@link HarnessStartError}.
   */
  start(req: HarnessRunRequest<TAgent>): Promise<HarnessSession>;
}
