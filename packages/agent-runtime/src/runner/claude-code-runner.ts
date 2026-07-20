/**
 * ClaudeCodeRunner — Runner backed by the Claude Agent SDK.
 *
 * Mirrors Python: agentic_patterns/core/systems/runners/claude_code.py
 *
 * Wraps the Claude Agent SDK's query() function to execute agents through
 * Claude Code's subprocess-based architecture. Claude Code manages its own
 * tool loop, so toolExecutor is accepted for interface compatibility but
 * not used.
 *
 * Event bridging:
 * - PreToolUse hook  → ToolCallIntent (gate chain) + ToolCallStartEvent
 *                      (start timestamp stamped for durationMs)
 * - PostToolUse hook → ToolCallEndEvent with result + measured durationMs
 * - SDK message stream → one shared {@link CCMessageTranslator} consumed by
 *   both run() and stream() (#323): per-call agent.llm.start/end, synthesized
 *   iteration.start/end, agent.reasoning, message.chunk, run cost, and
 *   harness.native envelope events for compaction/subagent/rate-limit richness.
 */

import type { RenderContext, ToolSchema } from "@agentic-patterns/core";
import {
  type HookCallback,
  type HookCallbackMatcher,
  type Options as SDKOptions,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { generateId } from "ai";

import { type AgentEventBus, getAgentEventBus } from "../events/agent-event-bus.js";
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
import { CCMessageTranslator } from "./cc-event-translator.js";
import { type AgentLikeForBridge, buildAgentServers } from "./sdk-bridge.js";
import type { RunOptions, RunResult, RunnerProtocol } from "./types.js";

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
// CLI subprocess whose hooks POST back to our server. We tag those hooks
// with a correlation id via the `AP_RUNNER_CORRELATION_ID` env var so the
// server knows the runner is already observing the session — the raw
// `claude_code.hook` event is still kept (PreCompact, PermissionRequest,
// etc. give value the runner doesn't emit) but the derived
// `agent.tool.start`/`agent.tool.end` events are SUPPRESSED to avoid
// double-counting alongside the runner's own tool events.
// ---------------------------------------------------------------------------

export const AP_RUNNER_CORRELATION_ENV = "AP_RUNNER_CORRELATION_ID";

function newCorrelationId(): string {
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Set `AP_RUNNER_CORRELATION_ID` on `process.env` for the duration of an
 * SDK invocation. Returns a restore function that puts the previous value
 * back (or deletes the key if it wasn't set). Safe to call in environments
 * without `process` — becomes a no-op.
 *
 * Child processes spawned transitively by the SDK inherit this env var,
 * which is what `hooks/emit.mjs` reads to tag its POSTs.
 */
function setCorrelationEnv(id: string): () => void {
  if (typeof process === "undefined" || !process.env) {
    return () => {
      /* no-op */
    };
  }
  const prior = process.env[AP_RUNNER_CORRELATION_ENV];
  process.env[AP_RUNNER_CORRELATION_ENV] = id;
  return () => {
    if (prior === undefined) {
      delete process.env[AP_RUNNER_CORRELATION_ENV];
    } else {
      process.env[AP_RUNNER_CORRELATION_ENV] = prior;
    }
  };
}

// ---------------------------------------------------------------------------
// ClaudeCodeRunner
// ---------------------------------------------------------------------------

/**
 * Thrown from `_buildOptions` when the runner is in isolated config mode but
 * no OAuth token resolves from any of the three sources. Failing closed here
 * (rather than silently falling through to the binary's own auth) guarantees
 * an isolated run never leaks the host's connectors/config.
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
 * Claude Code manages its own tool loop, permissions, and file access.
 * This runner translates SDK messages into the AgentEvent stream so that
 * the rest of the framework (gates, exporters, UX) works transparently.
 *
 * Gate enforcement is handled via PreToolUse hooks — if a gate blocks a
 * ToolCallIntent, the hook returns `permissionDecision: 'deny'` to the
 * SDK so the tool is never executed.
 */
export class ClaudeCodeRunner implements RunnerProtocol {
  protected _eventBus: AgentEventBus | undefined;
  protected readonly _defaults: Partial<SDKOptions>;
  private readonly _config: CCConfigSource;
  private readonly _nativeTools: NativeToolsSetting;
  private readonly _extraDisallowed: readonly string[];
  private readonly _oauthToken: OAuthTokenSource | undefined;
  /** Isolated CLAUDE_CONFIG_DIR created at construction; null in host mode. */
  private readonly _isolatedConfigDir: string | null;
  private _disposed = false;

  constructor(opts?: ClaudeCodeRunnerOptions) {
    this._eventBus = opts?.eventBus;
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
   * Isolated dirs are created once per instance and reused across every
   * run — they are NOT cleaned up between runs — so a runner you no longer
   * need should be disposed to avoid leaking tmpdirs. Idempotent, and a
   * no-op for host-mode runners. Pair with a `try { … } finally { runner.dispose() }`.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._isolatedConfigDir) {
      removeIsolatedConfigDir(this._isolatedConfigDir);
    }
  }

  protected get eventBus(): AgentEventBus {
    if (!this._eventBus) {
      this._eventBus = getAgentEventBus();
    }
    return this._eventBus;
  }

  protected async emit(event: AgentEvent): Promise<void> {
    await this.eventBus.publish(event);
  }

  /**
   * Publish a ToolCallIntent through the gate chain and report whether it was
   * allowed. Delegates to {@link AgentEventBus.evaluateIntent}, which returns a
   * definitive per-intent {@link GateEvaluation} — the runner reads THIS
   * intent's own `outcome` instead of inferring block-vs-allow from a bus-wide
   * `agent.tool.rejected` subscription. That inference misattributed a
   * concurrent sibling's rejection to this call (#288); `evaluateIntent` is
   * per-call, so there is nothing to cross-contaminate. The rejection event and
   * the guaranteed audit phase are still driven by `evaluateIntent`.
   */
  protected async emitIntent(intent: AgentEvent & { type: "agent.tool.intent" }): Promise<boolean> {
    const evaluation = await this.eventBus.evaluateIntent(intent);
    return evaluation.outcome === "allow";
  }

  // TODO(#308): `options.host` (and therefore `host.scope`, see
  // `workflows/scope-host.ts`) is NOT relayed to tool execution on this
  // runner — Claude Code manages its own tool loop via SDK MCP servers
  // (`sdk-bridge.ts`'s `buildAgentServers`/`toolsFromToolbox`), which call
  // `toolbox.execute(name, args)` with NO `ToolExecutionContext` at all, and
  // `Playbook.execute(name, args)` (core `molecules/playbook.ts`) has no
  // `ctx` parameter to carry one through even if the toolbox leg were wired.
  // Threading scope through only the toolbox half would silently leave
  // playbook-backed CC tools scope-less with no signal, which is worse than
  // the current uniform absence — so this was left undone rather than forced
  // (decisions.md D13). NOTE the asymmetry since #308 PR-3: PROMPT rendering
  // IS scope-aware on this runner (`_buildOptions` passes `_renderCtx` into
  // `renderInitialPrompt`), so `host.scope` reaches the CC system prompt —
  // it is only TOOL execution that stays scope-less until this is revisited.
  async run(agent: AgentLikeForBridge, message: string, options?: RunOptions): Promise<RunResult> {
    if (options?.eventBus) {
      this._eventBus = options.eventBus;
    }

    const runId = generateId();
    const traceId = options?.traceId ?? runId;
    const correlationId = newCorrelationId();

    // Build SDK options with hooks for gate enforcement
    const sdkOptions = this._buildOptions(agent, options, {
      runId,
      traceId,
      parentSpanId: options?.parentSpanId,
    });

    // Emit message start
    const startEvent = createEvent("agent.message.start", {
      traceId,
      runId,
      parentSpanId: options?.parentSpanId,
      agentName: agent.role.name,
      agentConfig: {
        role: agent.role.name,
        model: agent.getModel(),
        tools: agent.getTools().map((t: ToolSchema) => t.name),
        runnerCorrelationId: correlationId,
      },
    });
    await this.emit(startEvent);

    const model = agent.getModel() ?? "";
    const translator = new CCMessageTranslator({
      traceId,
      runId,
      parentSpanId: options?.parentSpanId,
      fallbackModel: model,
      hasTools: agent.getTools().length > 0,
      maxIterations: options?.maxIterations ?? 10,
      streaming: false,
    });

    const restoreCorrelation = setCorrelationEnv(correlationId);

    try {
      for await (const msg of query({ prompt: message, options: sdkOptions })) {
        for (const event of translator.translate(msg)) {
          await this.emit(event);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.emit(
        createEvent("agent.error", {
          traceId,
          runId,
          parentSpanId: options?.parentSpanId,
          errorType: error.name,
          message: error.message,
          recoverable: false,
          context: {},
        }),
      );
      throw err;
    } finally {
      restoreCorrelation();
    }

    const acc = translator.finalize();

    await this.emit(
      createEvent("agent.message.complete", {
        traceId,
        runId,
        spanId: startEvent.spanId,
        parentSpanId: startEvent.spanId,
        content: acc.content,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        model,
        finishReason: acc.finishReason,
        ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
      }),
    );

    return {
      response: acc.content,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      toolCallsCount: acc.toolCallsCount,
      iterations: acc.iterations,
      finishReason: acc.finishReason,
      ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // stream() — streaming mode with MessageChunk events
  // ---------------------------------------------------------------------------

  async *stream(
    agent: AgentLikeForBridge,
    message: string,
    options?: RunOptions,
  ): AsyncGenerator<AgentEvent> {
    if (options?.eventBus) {
      this._eventBus = options.eventBus;
    }

    const runId = generateId();
    const traceId = options?.traceId ?? runId;
    const correlationId = newCorrelationId();

    const sdkOptions = this._buildOptions(agent, options, {
      runId,
      traceId,
      parentSpanId: options?.parentSpanId,
      includePartialMessages: true,
    });

    // Emit and yield message start
    const startEvent = createEvent("agent.message.start", {
      traceId,
      runId,
      parentSpanId: options?.parentSpanId,
      agentName: agent.role.name,
      agentConfig: {
        role: agent.role.name,
        model: agent.getModel(),
        tools: agent.getTools().map((t: ToolSchema) => t.name),
        runnerCorrelationId: correlationId,
      },
    });
    await this.emit(startEvent);
    yield startEvent;

    const model = agent.getModel() ?? "";
    const translator = new CCMessageTranslator({
      traceId,
      runId,
      parentSpanId: options?.parentSpanId,
      fallbackModel: model,
      hasTools: agent.getTools().length > 0,
      maxIterations: options?.maxIterations ?? 10,
      streaming: true,
    });

    const restoreCorrelation = setCorrelationEnv(correlationId);

    try {
      for await (const msg of query({ prompt: message, options: sdkOptions })) {
        for (const event of translator.translate(msg)) {
          await this.emit(event);
          yield event;
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const errorEvent = createEvent("agent.error", {
        traceId,
        runId,
        parentSpanId: options?.parentSpanId,
        errorType: error.name,
        message: error.message,
        recoverable: false,
        context: {},
      });
      await this.emit(errorEvent);
      throw err;
    } finally {
      restoreCorrelation();
    }

    const acc = translator.finalize();
    const completeEvent = createEvent("agent.message.complete", {
      traceId,
      runId,
      spanId: startEvent.spanId,
      parentSpanId: startEvent.spanId,
      content: acc.content,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      model,
      finishReason: acc.finishReason,
      ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
    });
    await this.emit(completeEvent);
    yield completeEvent;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Narrow `RunOptions.host` down to `host.scope` (#308) — same inline
   * structural narrow as `AgentRunner._renderCtx`; cannot import
   * `workflows/scope-host.ts` here either (reverse layering).
   */
  private _renderCtx(options?: RunOptions): RenderContext | undefined {
    const scope = (options?.host as { scope?: Record<string, unknown> } | undefined)?.scope;
    return scope ? { scope } : undefined;
  }

  protected _buildOptions(
    agent: AgentLikeForBridge,
    options: RunOptions | undefined,
    context: {
      runId: string;
      traceId: string;
      parentSpanId?: string;
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

    // Wire agent capabilities as SDK MCP servers
    if (agent.role.capabilities.length > 0) {
      const { mcpServers, allowedTools } = buildAgentServers(agent);
      if (Object.keys(mcpServers).length > 0) {
        sdkOpts.mcpServers = mcpServers as SDKOptions["mcpServers"];
        sdkOpts.allowedTools = [...(sdkOpts.allowedTools ?? []), ...allowedTools];
      }
    }

    // Axis C — native built-in tools. "all" leaves any `defaults.tools`
    // untouched; "none"/list override it.
    applyNativeTools(sdkOpts, this._nativeTools);

    // Additional connector/tool blocks.
    if (this._extraDisallowed.length > 0) {
      sdkOpts.disallowedTools = [...(sdkOpts.disallowedTools ?? []), ...this._extraDisallowed];
    }

    // Axis B — isolated config dir + injected OAuth. Strips connectors,
    // settings, plugins, skills, hooks (or seeds a curated profile) without
    // breaking auth.
    if (this._isolatedConfigDir) {
      // Fail closed (D11): isolated mode with no resolvable token is an error,
      // never a silent fall-through to the binary's own auth — that would leak
      // the host's connectors/config into a run that asked for isolation.
      const token = resolveOAuthToken(this._oauthToken);
      if (!token) {
        throw new Error(ISOLATED_NO_TOKEN_MESSAGE);
      }
      applyIsolatedEnv(sdkOpts, this._isolatedConfigDir, token);
    }

    return sdkOpts;
  }

  /**
   * Create SDK hook definitions that bridge to AgentEvent emissions.
   *
   * PreToolUse: emits ToolCallIntent through the gate chain. If gates
   * block the intent, returns `permissionDecision: 'deny'` to the SDK
   * so the tool is never executed. Otherwise emits ToolCallStartEvent.
   *
   * PostToolUse: emits ToolCallEndEvent with the tool result.
   */
  private _makeHooks(
    runId: string,
    traceId: string,
    parentSpanId: string | undefined,
  ): Partial<Record<string, HookCallbackMatcher[]>> {
    // Map tool_use_id → { span_id, startedAt } so start/end events share the
    // same span_id (required by exporters like Langfuse to correlate them) and
    // PostToolUse can diff the wall-clock start stamp into `durationMs` (#323).
    const tcSpanIds = new Map<string, { spanId: string; startedAt: number }>();

    const onPreToolUse: HookCallback = async (input, toolUseId, _opts) => {
      const toolName = ((input as Record<string, unknown>).tool_name as string) ?? "";
      const toolInput = (input as Record<string, unknown>).tool_input;
      const tcId = toolUseId ?? generateId();
      const args =
        typeof toolInput === "object" && toolInput !== null
          ? (toolInput as Record<string, unknown>)
          : {};

      // Run intent through gate chain
      const intent = createEvent("agent.tool.intent", {
        runId,
        traceId,
        toolCallId: tcId,
        toolName,
        arguments: args,
      });

      const allowed = await this.emitIntent(intent);

      if (!allowed) {
        // Gate blocked — tell the SDK to deny this tool call
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: "Blocked by gate",
          },
        };
      }

      // Allowed — emit start event and remember its span_id
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

      // Reuse span_id from the matching start event so exporters can correlate
      // the pair, and diff its start stamp for durationMs. `resultTokens` stays
      // 0 — the SDK hook payload carries no per-tool token count (honest gap).
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
