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
 * - SDKAssistantMessage → MessageStart/Complete, Reasoning
 * - SDKResultMessage → MessageComplete with usage stats
 * - MCP tools → wired from agent capabilities via sdk-bridge
 */

import type { ToolSchema } from "@agentic-patterns/core";
import { type Options as SDKOptions, query } from "@anthropic-ai/claude-agent-sdk";
import { generateId } from "ai";

import { type AgentEventBus, getAgentEventBus } from "../events/agent-event-bus.js";
import { type AgentEvent, createEvent } from "../events/types.js";
import { type AgentLikeForBridge, buildAgentServers } from "./sdk-bridge.js";
import type { RunOptions, RunResult, RunnerProtocol } from "./types.js";

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

const MODEL_MAP: Record<string, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
};

function mapModel(modelName: string): string | undefined {
  const lower = modelName.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_MAP)) {
    if (lower.includes(key)) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ClaudeCodeRunner
// ---------------------------------------------------------------------------

export interface ClaudeCodeRunnerOptions {
  /** Default SDK options applied before per-run overrides. */
  defaults?: Partial<SDKOptions>;
  /** Optional event bus for emitting agent events. */
  eventBus?: AgentEventBus;
}

/**
 * Runner that delegates execution to Claude Code via the Agent SDK.
 *
 * Claude Code manages its own tool loop, permissions, and file access.
 * This runner translates SDK messages into the AgentEvent stream so that
 * the rest of the framework (gates, exporters, UX) works transparently.
 */
export class ClaudeCodeRunner implements RunnerProtocol {
  private _eventBus: AgentEventBus | undefined;
  private readonly _defaults: Partial<SDKOptions>;

  constructor(opts?: ClaudeCodeRunnerOptions) {
    this._eventBus = opts?.eventBus;
    this._defaults = opts?.defaults ?? {};
  }

  private get eventBus(): AgentEventBus {
    if (!this._eventBus) {
      this._eventBus = getAgentEventBus();
    }
    return this._eventBus;
  }

  private async emit(event: AgentEvent): Promise<void> {
    await this.eventBus.publish(event);
  }

  async run(agent: AgentLikeForBridge, message: string, options?: RunOptions): Promise<RunResult> {
    if (options?.eventBus) {
      this._eventBus = options.eventBus;
    }

    const runId = generateId();
    const traceId = options?.traceId ?? runId;

    // Build SDK options
    const sdkOptions = this._buildOptions(agent, options);

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
      },
    });
    await this.emit(startEvent);

    const contentParts: string[] = [];
    let toolCallsMade = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const model = agent.getModel();

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
                // ToolUseBlock — count but don't execute (SDK handles it)
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

  private _buildOptions(agent: AgentLikeForBridge, options?: RunOptions): SDKOptions {
    const sdkOpts: SDKOptions = {
      ...this._defaults,
      systemPrompt: agent.getSystemPrompt(),
      model: mapModel(agent.getModel()) ?? this._defaults.model,
      maxTurns: options?.maxIterations ?? 10,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };

    // Wire agent capabilities as SDK MCP servers
    if (agent.role.capabilities.length > 0) {
      const { mcpServers, allowedTools } = buildAgentServers(agent);
      if (Object.keys(mcpServers).length > 0) {
        sdkOpts.mcpServers = mcpServers as SDKOptions["mcpServers"];
        sdkOpts.allowedTools = [...(sdkOpts.allowedTools ?? []), ...allowedTools];
      }
    }

    return sdkOpts;
  }
}
