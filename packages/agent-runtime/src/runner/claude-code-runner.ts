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
 * - PostToolUse hook → ToolCallEndEvent with result
 * - SDKAssistantMessage → MessageStart/Complete, Reasoning
 * - SDKResultMessage → MessageComplete with usage stats
 * - SDKPartialAssistantMessage → MessageChunk (streaming)
 */

import type { ToolSchema } from "@agentic-patterns/core";
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
   * Publish a ToolCallIntent through the gate chain.
   * Returns true if the intent was allowed, false if blocked.
   */
  protected async emitIntent(intent: AgentEvent & { type: "agent.tool.intent" }): Promise<boolean> {
    // Track whether a gate blocked the intent by listening for rejection events.
    // We can't use publish()'s return value because an empty array means either
    // "blocked by gate" or "no subscribers" — both return [].
    let blocked = false;
    const onRejected = () => {
      blocked = true;
    };
    this.eventBus.subscribe("agent.tool.rejected", onRejected);
    try {
      await this.eventBus.publish(intent);
    } finally {
      this.eventBus.unsubscribe("agent.tool.rejected", onRejected);
    }
    return !blocked;
  }

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

    const contentParts: string[] = [];
    let toolCallsMade = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const model = agent.getModel() ?? "";

    const restoreCorrelation = setCorrelationEnv(correlationId);

    try {
      for await (const msg of query({ prompt: message, options: sdkOptions })) {
        if (msg.type === "assistant" && "message" in msg) {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if ("text" in block && typeof block.text === "string") {
                contentParts.push(block.text);
              } else if ("thinking" in block && typeof block.thinking === "string") {
                await this.emit(
                  createEvent("agent.reasoning", {
                    traceId,
                    runId,
                    parentSpanId: options?.parentSpanId,
                    content: block.thinking,
                    isComplete: true,
                  }),
                );
              } else if ("name" in block) {
                // ToolUseBlock — count only; event emission handled by hooks
                toolCallsMade++;
              }
            }
          }
        } else if (msg.type === "result") {
          if ("usage" in msg && msg.usage) {
            const usage = msg.usage as unknown as Record<string, number>;
            inputTokens = usage.input_tokens ?? 0;
            outputTokens = usage.output_tokens ?? 0;
          }
          if ("result" in msg && typeof msg.result === "string" && contentParts.length === 0) {
            contentParts.push(msg.result);
          }
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

    const content = contentParts.join("");

    await this.emit(
      createEvent("agent.message.complete", {
        traceId,
        runId,
        spanId: startEvent.spanId,
        parentSpanId: startEvent.spanId,
        content,
        inputTokens,
        outputTokens,
        model,
      }),
    );

    return {
      response: content,
      inputTokens,
      outputTokens,
      toolCallsCount: toolCallsMade,
      iterations: 1, // Claude Code manages its own loop
      finishReason: "stop",
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

    const contentParts: string[] = [];
    let chunkIndex = 0;
    let gotChunks = false;
    let toolCallsMade = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const model = agent.getModel() ?? "";

    const restoreCorrelation = setCorrelationEnv(correlationId);

    try {
      for await (const msg of query({ prompt: message, options: sdkOptions })) {
        // Partial/streaming messages → MessageChunk events
        const msgType = msg.type as string;
        if (msgType === "stream_event" && "event" in msg) {
          const streamMsg = msg as unknown as { event?: { delta?: { text?: string } } };
          const text = streamMsg.event?.delta?.text;
          if (text) {
            const chunkEvent = createEvent("agent.message.chunk", {
              traceId,
              runId,
              parentSpanId: options?.parentSpanId,
              delta: text,
              chunkIndex,
            });
            await this.emit(chunkEvent);
            yield chunkEvent;
            contentParts.push(text);
            chunkIndex++;
            gotChunks = true;
          }
        } else if (msg.type === "assistant" && "message" in msg) {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if ("text" in block && typeof block.text === "string") {
                // Skip if chunks already captured this text
                if (!gotChunks) {
                  contentParts.push(block.text);
                }
              } else if ("thinking" in block && typeof block.thinking === "string") {
                const reasoningEvent = createEvent("agent.reasoning", {
                  traceId,
                  runId,
                  parentSpanId: options?.parentSpanId,
                  content: block.thinking,
                  isComplete: true,
                });
                await this.emit(reasoningEvent);
                yield reasoningEvent;
              } else if ("name" in block) {
                // Count only; events emitted by hooks
                toolCallsMade++;
              }
            }
          }
        } else if (msg.type === "result") {
          if ("usage" in msg && msg.usage) {
            const usage = msg.usage as unknown as Record<string, number>;
            inputTokens = usage.input_tokens ?? 0;
            outputTokens = usage.output_tokens ?? 0;
          }
          if ("result" in msg && typeof msg.result === "string" && contentParts.length === 0) {
            contentParts.push(msg.result);
          }
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

    const finalContent = contentParts.join("");
    const completeEvent = createEvent("agent.message.complete", {
      traceId,
      runId,
      spanId: startEvent.spanId,
      parentSpanId: startEvent.spanId,
      content: finalContent,
      inputTokens,
      outputTokens,
      model,
    });
    await this.emit(completeEvent);
    yield completeEvent;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

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
      systemPrompt: agent.renderInitialPrompt(),
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
    // breaking auth. If no token resolves (e.g. off macOS with none passed)
    // fall through to the binary's own auth — connectors may leak.
    if (this._isolatedConfigDir) {
      const token = resolveOAuthToken(this._oauthToken);
      if (token) {
        applyIsolatedEnv(sdkOpts, this._isolatedConfigDir, token);
      }
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
    // Map tool_use_id → span_id so start/end events share the same
    // span_id (required by exporters like Langfuse to correlate them).
    const tcSpanIds = new Map<string, string>();

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
      tcSpanIds.set(tcId, startEvent.spanId);
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

      // Reuse span_id from the matching start event so exporters
      // can correlate the pair.
      const spanId = tcSpanIds.get(tcId);
      tcSpanIds.delete(tcId);

      const endEvent = createEvent("agent.tool.end", {
        runId,
        traceId,
        parentSpanId,
        toolCallId: tcId,
        toolName,
        arguments: args,
        result: toolResponse,
        durationMs: 0,
        resultTokens: 0,
        ...(spanId ? { spanId } : {}),
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
