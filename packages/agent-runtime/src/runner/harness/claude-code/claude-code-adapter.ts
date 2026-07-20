/**
 * Claude Code harness adapter (design §5.1/§5.2/§5.4, B-2 / #326).
 *
 * The CC realization of {@link HarnessAdapter}: it probes the harness's
 * capabilities, launches the Claude Agent SDK's `query()` as a
 * {@link HarnessSession}, and translates the SDK message stream into normalized
 * {@link HarnessEvent}s via {@link CCHarnessTranslator}.
 *
 * Gate enforcement on CC is SYNCHRONOUS via the SDK's PreToolUse hooks (attached
 * by `ClaudeCodeRunner._buildOptions` → `_makeHooks`), which consult the base's
 * `evaluateIntent` and return `permissionDecision: "deny"` before a tool runs.
 * That is why CC tool events do NOT ride the `HarnessEvent` stream (unlike Codex,
 * B-4): the hooks emit `agent.tool.start`/`end` directly through the base. The
 * bidirectional ask→decision→respond bridge (App-Server-style) is B-3 (#328); the
 * session here provides the exactly-once LOCAL settlement contract those asks
 * will settle against.
 */

import { type Query, type Options as SDKOptions, query } from "@anthropic-ai/claude-agent-sdk";

import type { HarnessDecision } from "../../../gates/decisions.js";
import type { AgentLikeForBridge } from "../../sdk-bridge.js";
import type { RunOptions } from "../../types.js";
import type {
  DecisionVocabulary,
  Enforcement,
  HarnessAdapter,
  HarnessEvent,
  HarnessProbeResult,
  HarnessRunRequest,
  HarnessSession,
  OperationClass,
  ProbeContext,
} from "../types.js";
import { CCHarnessTranslator } from "./cc-harness-translator.js";

/** How the runner builds SDK options for a run (bound to `_buildOptions`). */
export type BuildSDKOptions = (
  agent: AgentLikeForBridge,
  options: RunOptions | undefined,
  context: {
    runId: string;
    traceId: string;
    parentSpanId?: string;
    correlationId?: string;
    includePartialMessages?: boolean;
  },
) => SDKOptions;

export interface ClaudeCodeAdapterOptions {
  /** Builds per-run SDK options (with gate hooks + isolated env). */
  readonly buildOptions: BuildSDKOptions;
  /** Auth posture to report in the probe (derived from the runner's config). */
  readonly authMode?: HarnessProbeResult["authMode"];
}

// ---------------------------------------------------------------------------
// Static CC capability declaration (§5.2) — CONTRACT-TESTED, not asserted.
// `contract-tests/cc/` establishes these empirically; keep this table in sync
// with the matrix those tests produce.
// ---------------------------------------------------------------------------

const CC_ENFORCEMENT: Record<OperationClass, Enforcement> = {
  // canUseTool + PreToolUse deny fire before execution for these classes.
  shell: "enforcing",
  "file-change": "enforcing",
  "mcp-tool": "enforcing",
  "local-tool": "enforcing",
  subagent: "enforcing",
  // C3-style skepticism: hosted tools (web search/fetch) are observe-only —
  // never promise blocking. The contract suite verifies this posture.
  "hosted-tool": "advisory",
};

/**
 * CC decision vocabulary (§5.4 mapping table). CC raises a single
 * `tool-permission` ask (`canUseTool`). It has NO rule-free session cache, so
 * `allowSession` is absent; it has no separate permission-request, so
 * `grantPermissions` is absent. `allowWithRules` echoes the request's own
 * `updatedPermissions` suggestions (session or durable).
 */
const CC_DECISION_VOCABULARY: DecisionVocabulary = {
  "tool-permission": ["allowOnce", "allowWithRules", "deny", "cancel", "rewriteInput"],
};

export class ClaudeCodeAdapter implements HarnessAdapter<AgentLikeForBridge> {
  readonly name = "claude-code";
  readonly decisionVocabulary = CC_DECISION_VOCABULARY;

  private readonly buildOptions: BuildSDKOptions;
  private readonly authMode: HarnessProbeResult["authMode"];

  constructor(opts: ClaudeCodeAdapterOptions) {
    this.buildOptions = opts.buildOptions;
    this.authMode = opts.authMode ?? "subscription";
  }

  /**
   * Structured capability probe (§5.2). PROVISIONAL: the SDK-launch/auth-readiness
   * probe is A-3's slice; here we report CC's static enforcement matrix +
   * features. The runner already fails closed on an unresolvable isolated token
   * (`_buildOptions`), so the probe reports readiness rather than re-checking auth.
   */
  async probe(_ctx: ProbeContext): Promise<HarnessProbeResult> {
    return {
      ok: true,
      issues: [],
      authMode: this.authMode,
      enforcement: { ...CC_ENFORCEMENT },
      sandbox: { networkPolicy: "none" },
      features: {
        interactiveAsk: true,
        resume: true,
        partialStreaming: true,
        inputRewrite: true,
        durableRules: true,
      },
    };
  }

  async start(req: HarnessRunRequest<AgentLikeForBridge>): Promise<HarnessSession> {
    const sdkOptions = this.buildOptions(req.agent, req.options, {
      runId: req.runId,
      traceId: req.traceId,
      parentSpanId: req.parentSpanId,
      correlationId: req.correlationId,
      includePartialMessages: req.streaming,
    });
    const translator = new CCHarnessTranslator({
      fallbackModel: req.agent.getModel() ?? "",
      streaming: req.streaming,
    });
    const q = query({ prompt: req.message, options: sdkOptions });
    return new ClaudeCodeSession(q, translator);
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * A launched CC session over the SDK `Query`. Yields normalized HarnessEvents;
 * provides the §5.1 reply semantics (exactly-once LOCAL settlement, idempotent
 * close). CC raises no stream asks in B-2, so the pending registry stays empty —
 * the machinery is real so B-3 can settle against it.
 */
export class ClaudeCodeSession implements HarnessSession {
  private readonly q: Query;
  private readonly translator: CCHarnessTranslator;
  private closed = false;
  private terminalDelivered = false;
  private readonly pending = new Set<string>();

  constructor(q: Query, translator: CCHarnessTranslator) {
    this.q = q;
    this.translator = translator;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    try {
      for await (const msg of this.q) {
        if (this.closed) break;
        for (const event of this.translator.translate(msg)) {
          if (event.kind === "terminal") this.terminalDelivered = true;
          yield event;
        }
      }
    } finally {
      // Iteration ended (drain, throw, or break) — settle anything outstanding.
      this.settleAllPending();
    }
  }

  /**
   * Settle a native ask by request id. Idempotent per id (at-most-once wire
   * response). CC raises no stream asks in B-2; B-3 wires the native reply.
   */
  async respond(requestId: string, _decision: HarnessDecision): Promise<void> {
    this.pending.delete(requestId);
  }

  async interrupt(_reason?: string): Promise<void> {
    if (this.closed || this.terminalDelivered) return;
    this.settleAllPending();
    try {
      await this.q.interrupt();
    } catch {
      // best-effort — the turn may already be settling
    }
  }

  /**
   * Idempotent, legal any time: before terminal it interrupts + settles pending
   * fail-closed; after terminal delivery it is a no-op.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.terminalDelivered) return;
    this.settleAllPending();
    try {
      await this.q.interrupt();
    } catch {
      // best-effort
    }
    try {
      await this.q.return(undefined);
    } catch {
      // best-effort — generator may already be done
    }
  }

  private settleAllPending(): void {
    // Fail-closed local settlement — pending asks resolve as denied/cancelled.
    this.pending.clear();
  }
}
