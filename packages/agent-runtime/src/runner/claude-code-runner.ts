/**
 * ClaudeCodeRunner — the Claude Code adapter of the {@link CodingAgentRunner}
 * base (design §5.1, B-2 / #326; was a standalone RunnerProtocol impl through B-1).
 *
 * The base owns the harness-agnostic half — run/stream lifecycle, AP-event
 * construction from the normalized stream, `evaluateIntent` wiring, span
 * correlation, run accounting, the GateRequirements run-start check. This class
 * supplies the CC specifics:
 *  - `createAdapter()` → a {@link ClaudeCodeAdapter} that launches the Claude
 *    Agent SDK `query()` as a HarnessSession and translates SDK messages to
 *    normalized events (relocated {@link CCHarnessTranslator});
 *  - `_buildOptions()` — the SDK Options (system prompt, model map, isolated
 *    config env, native-tool axis) plus the PreToolUse/PostToolUse gate hooks;
 *  - per-run correlation id injected via the session's `options.env` (NO
 *    `process.env` mutation — the old `setCorrelationEnv` race is gone).
 *
 * Gate enforcement stays synchronous via the SDK hooks: a blocked
 * `ToolCallIntent` returns `permissionDecision: "deny"` so the tool never runs.
 * Claude Code manages its own tool loop; `toolExecutor` is unused.
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { RenderContext } from "@pattern-stack/agentic-core";
import { generateId } from "ai";

import type { AgentEventBus } from "../events/agent-event-bus.js";
import { type AgentEvent, createEvent } from "../events/types.js";
import {
  type CCConfigSource,
  type NativeToolsSetting,
  type OAuthTokenSource,
  applyIsolatedEnv,
  applyNativeTools,
  createIsolatedConfigDir,
  removeIsolatedConfigDir,
  resolveOAuthToken,
} from "./cc-config.js";
import {
  type BuildSDKOptions,
  ClaudeCodeAdapter,
} from "./harness/claude-code/claude-code-adapter.js";
import { CodingAgentRunner } from "./harness/coding-agent-runner.js";
import type { HarnessAdapter, ProbeContext } from "./harness/types.js";
import { narrowRenderCtx } from "./render-ctx.js";
import { type AgentLikeForBridge, buildAgentServers } from "./sdk-bridge.js";
import type { RunOptions } from "./types.js";

export type { CCConfigSource, NativeToolsSetting, OAuthTokenSource } from "./cc-config.js";

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

const MODEL_MAP: Record<string, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
};

function mapModel(modelName: string | undefined): string | undefined {
  if (!modelName) return undefined;
  const lower = modelName.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_MAP)) {
    if (lower.includes(key)) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Correlation id plumbing
//
// When the runner invokes the Claude Agent SDK, the SDK spawns a Claude Code
// CLI subprocess whose hooks POST back to our server. We tag those hooks with a
// correlation id via the `AP_RUNNER_CORRELATION_ID` env var so the server knows
// the runner is already observing the session — the raw `claude_code.hook` event
// is still kept (PreCompact, PermissionRequest, …) but the derived
// tool.start/tool.end events are SUPPRESSED to avoid double-counting.
//
// The id travels via the SESSION's `options.env` (B-2) — never a `process.env`
// mutation. Concurrent runs no longer race a shared global.
// ---------------------------------------------------------------------------

export const AP_RUNNER_CORRELATION_ENV = "AP_RUNNER_CORRELATION_ID";

/** `process.env` narrowed to string entries (subprocess env base). */
function processEnvStrings(): Record<string, string> {
  if (typeof process === "undefined" || !process.env) return {};
  return Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === "string") as [string, string][],
  );
}

// ---------------------------------------------------------------------------
// ClaudeCodeRunner
// ---------------------------------------------------------------------------

/**
 * Thrown from `_buildOptions` when the runner is in isolated config mode but no
 * OAuth token resolves from any of the three sources. Failing closed here (rather
 * than silently falling through to the binary's own auth) guarantees an isolated
 * run never leaks the host's connectors/config.
 */
const ISOLATED_NO_TOKEN_MESSAGE =
  "ClaudeCodeRunner: isolated config mode requires an OAuth token, but none " +
  "resolved. Provide one via the `oauthToken` option, the CLAUDE_CODE_OAUTH_TOKEN " +
  "environment variable, or a Claude Max login in the macOS Keychain. To use the " +
  'host ~/.claude config instead, pass `config: { mode: "host" }`.';

export interface ClaudeCodeRunnerOptions {
  /** Default SDK options applied before per-run overrides. */
  defaults?: Partial<SDKOptions>;
  /** Optional event bus for emitting agent events. */
  eventBus?: AgentEventBus;
  /**
   * Config source (Axis B). `{ mode: "host" }` (default) inherits the
   * developer's ~/.claude. `{ mode: "isolated" }` runs in a fresh
   * CLAUDE_CONFIG_DIR — empty, or seeded from `profile` for a reproducible
   * curated setup. Isolated mode injects an OAuth token (see `oauthToken`).
   */
  config?: CCConfigSource;
  /**
   * Native Claude Code tools (Axis C): "all" (default) | "none" | an
   * explicit allow-list. Orthogonal to `config`.
   */
  nativeTools?: NativeToolsSetting;
  /**
   * Extra tool names or `mcp__<server>` prefixes to block via SDK
   * `disallowedTools`. Useful to strip specific connectors.
   */
  extraDisallowedTools?: readonly string[];
  /**
   * OAuth token source for isolated mode. Falls back to the
   * CLAUDE_CODE_OAUTH_TOKEN env var, then the macOS Keychain. Set this to
   * use isolated mode off macOS, where the Keychain lookup is unavailable.
   */
  oauthToken?: OAuthTokenSource;
}

/**
 * Runner that delegates execution to Claude Code via the Agent SDK.
 *
 * Claude Code manages its own tool loop, permissions, and file access. The
 * {@link CodingAgentRunner} base translates the adapter's normalized event
 * stream into the AgentEvent stream so gates, exporters, and UX work
 * transparently. Gate enforcement is handled via PreToolUse hooks — a blocked
 * ToolCallIntent returns `permissionDecision: 'deny'` so the tool never runs.
 */
export class ClaudeCodeRunner extends CodingAgentRunner<AgentLikeForBridge> {
  protected readonly _defaults: Partial<SDKOptions>;
  private readonly _config: CCConfigSource;
  private readonly _nativeTools: NativeToolsSetting;
  private readonly _extraDisallowed: readonly string[];
  private readonly _oauthToken: OAuthTokenSource | undefined;
  /** Isolated CLAUDE_CONFIG_DIR created at construction; null in host mode. */
  private readonly _isolatedConfigDir: string | null;
  private _disposed = false;

  constructor(opts?: ClaudeCodeRunnerOptions) {
    super(opts?.eventBus);
    this._defaults = opts?.defaults ?? {};
    this._config = opts?.config ?? { mode: "host" };
    this._nativeTools = opts?.nativeTools ?? "all";
    this._extraDisallowed = opts?.extraDisallowedTools ?? [];
    this._oauthToken = opts?.oauthToken;
    this._isolatedConfigDir =
      this._config.mode === "isolated" ? createIsolatedConfigDir(this._config.profile) : null;
  }

  /**
   * Remove the isolated CLAUDE_CONFIG_DIR created for this runner, if any.
   * Idempotent, and a no-op for host-mode runners. Pair with a
   * `try { … } finally { runner.dispose() }`.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._isolatedConfigDir) {
      removeIsolatedConfigDir(this._isolatedConfigDir);
    }
  }

  // -------------------------------------------------------------------------
  // Adapter wiring (base contract)
  // -------------------------------------------------------------------------

  protected createAdapter(): HarnessAdapter<AgentLikeForBridge> {
    const buildOptions: BuildSDKOptions = (agent, options, context) =>
      this._buildOptions(agent, options, context);
    return new ClaudeCodeAdapter({ buildOptions, authMode: "subscription" });
  }

  protected override probeContext(_agent: AgentLikeForBridge, _options?: RunOptions): ProbeContext {
    return {};
  }

  /**
   * Publish a ToolCallIntent through the gate chain and report whether it was
   * allowed. Delegates to the base's `evaluateIntent` seam, which returns a
   * definitive per-intent evaluation (per-call, so a concurrent sibling's
   * rejection can't cross-contaminate — #288).
   */
  protected async emitIntent(intent: AgentEvent & { type: "agent.tool.intent" }): Promise<boolean> {
    const evaluation = await this.eventBus.evaluateIntent(intent);
    return evaluation.outcome === "allow";
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Shared host-bag narrowing — see `runner/render-ctx.ts` (#308/#444). */
  private _renderCtx(options?: RunOptions): RenderContext | undefined {
    return narrowRenderCtx(options);
  }

  // TODO(#308): `options.host` (and therefore `host.scope`) is NOT relayed to
  // tool execution on this runner — Claude Code manages its own tool loop via
  // SDK MCP servers, which call `toolbox.execute(name, args)` with no
  // `ToolExecutionContext`. PROMPT rendering IS scope-aware (`_renderCtx` feeds
  // `renderInitialPrompt`); only TOOL execution stays scope-less until revisited.
  protected _buildOptions(
    agent: AgentLikeForBridge,
    options: RunOptions | undefined,
    context: {
      runId: string;
      traceId: string;
      parentSpanId?: string;
      correlationId?: string;
      includePartialMessages?: boolean;
    },
  ): SDKOptions {
    const sdkOpts: SDKOptions = {
      ...this._defaults,
      systemPrompt: agent.renderInitialPrompt(this._renderCtx(options)),
      model: mapModel(agent.getModel()) ?? this._defaults.model,
      maxTurns: options?.maxIterations ?? 10,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      hooks: this._makeHooks(context.runId, context.traceId, context.parentSpanId),
    };

    if (context.includePartialMessages) {
      sdkOpts.includePartialMessages = true;
    }

    // Per-run correlation id → subprocess env (never a process.env mutation).
    // Seed it here; isolated mode's applyIsolatedEnv layers process.env + config
    // over this, host mode merges process.env in the else-branch below.
    if (context.correlationId) {
      sdkOpts.env = { ...(sdkOpts.env ?? {}), [AP_RUNNER_CORRELATION_ENV]: context.correlationId };
    }

    // Wire agent capabilities as SDK MCP servers
    if (agent.role.capabilities.length > 0) {
      const { mcpServers, allowedTools } = buildAgentServers(agent);
      if (Object.keys(mcpServers).length > 0) {
        sdkOpts.mcpServers = mcpServers as SDKOptions["mcpServers"];
        sdkOpts.allowedTools = [...(sdkOpts.allowedTools ?? []), ...allowedTools];
      }
    }

    // Axis C — native built-in tools.
    applyNativeTools(sdkOpts, this._nativeTools);

    // Additional connector/tool blocks.
    if (this._extraDisallowed.length > 0) {
      sdkOpts.disallowedTools = [...(sdkOpts.disallowedTools ?? []), ...this._extraDisallowed];
    }

    // Axis B — isolated config dir + injected OAuth. Fails closed (D11) when no
    // token resolves — never a silent fall-through to the binary's own auth.
    if (this._isolatedConfigDir) {
      const token = resolveOAuthToken(this._oauthToken);
      if (!token) {
        throw new Error(ISOLATED_NO_TOKEN_MESSAGE);
      }
      applyIsolatedEnv(sdkOpts, this._isolatedConfigDir, token);
    } else if (context.correlationId) {
      // Host mode: setting options.env REPLACES the subprocess env, so merge
      // process.env to avoid clobbering PATH etc. alongside the correlation id.
      sdkOpts.env = { ...processEnvStrings(), ...sdkOpts.env };
    }

    return sdkOpts;
  }

  /**
   * SDK hook definitions bridging to AgentEvent emissions.
   *
   * PreToolUse: emits ToolCallIntent through the gate chain. On block, returns
   * `permissionDecision: 'deny'`; otherwise emits ToolCallStartEvent.
   * PostToolUse: emits ToolCallEndEvent with the result + measured durationMs.
   */
  private _makeHooks(
    runId: string,
    traceId: string,
    parentSpanId: string | undefined,
  ): Partial<Record<string, HookCallbackMatcher[]>> {
    // Map tool_use_id → { span_id, startedAt } so start/end share a span_id
    // (exporters correlate the pair) and PostToolUse can diff durationMs (#323).
    const tcSpanIds = new Map<string, { spanId: string; startedAt: number }>();

    const onPreToolUse: HookCallback = async (input, toolUseId, _opts) => {
      const toolName = ((input as Record<string, unknown>).tool_name as string) ?? "";
      const toolInput = (input as Record<string, unknown>).tool_input;
      const tcId = toolUseId ?? generateId();
      const args =
        typeof toolInput === "object" && toolInput !== null
          ? (toolInput as Record<string, unknown>)
          : {};

      const intent = createEvent("agent.tool.intent", {
        runId,
        traceId,
        toolCallId: tcId,
        toolName,
        arguments: args,
      });

      const allowed = await this.emitIntent(intent);

      if (!allowed) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: "Blocked by gate",
          },
        };
      }

      const startEvent = createEvent("agent.tool.start", {
        runId,
        traceId,
        parentSpanId,
        toolCallId: tcId,
        toolName,
        arguments: args,
      });
      tcSpanIds.set(tcId, { spanId: startEvent.spanId, startedAt: Date.now() });
      await this.emit(startEvent);
      return {};
    };

    const onPostToolUse: HookCallback = async (input, toolUseId, _opts) => {
      const toolName = ((input as Record<string, unknown>).tool_name as string) ?? "";
      const toolInput = (input as Record<string, unknown>).tool_input;
      const toolResponse = (input as Record<string, unknown>).tool_response;
      const tcId = toolUseId ?? generateId();
      const args =
        typeof toolInput === "object" && toolInput !== null
          ? (toolInput as Record<string, unknown>)
          : {};

      const span = tcSpanIds.get(tcId);
      tcSpanIds.delete(tcId);
      const durationMs = span ? Math.max(0, Date.now() - span.startedAt) : 0;

      const endEvent = createEvent("agent.tool.end", {
        runId,
        traceId,
        parentSpanId,
        toolCallId: tcId,
        toolName,
        arguments: args,
        result: toolResponse,
        durationMs,
        resultTokens: 0,
        ...(span ? { spanId: span.spanId } : {}),
      });
      await this.emit(endEvent);
      return {};
    };

    return {
      PreToolUse: [{ hooks: [onPreToolUse] }],
      PostToolUse: [{ hooks: [onPostToolUse] }],
    };
  }
}
