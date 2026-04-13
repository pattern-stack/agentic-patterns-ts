/**
 * ClaudeCodeAPIRunner — API-only mode wrapper on ClaudeCodeRunner.
 *
 * Uses Claude Code under the hood but blocks all Code-native tools
 * (file, bash, agent, etc.) so the agent behaves like a plain Claude
 * API call with a system prompt injected. MCP tools from agent
 * capabilities remain available. Uses the same Max subscription OAuth token.
 *
 * Named "ClaudeCodeAPIRunner" (not "ClaudeAPIRunner") because it still
 * runs through the Claude Code subprocess — a future ClaudeAPIRunner
 * may talk directly to the Claude API without the Code layer.
 *
 * Mirrors Python: agentic_patterns/core/systems/runners/claude_api.py
 */

import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeCodeRunner } from "./claude-code-runner.js";
import type { AgentLikeForBridge } from "./sdk-bridge.js";
import type { RunOptions } from "./types.js";

/**
 * Tools that are Claude Code-specific and should be blocked in API-only mode.
 */
const BLOCKED_TOOLS: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "Agent",
  "NotebookEdit",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

/**
 * Runner that uses Claude Code SDK in API-only mode.
 *
 * Blocks all file/bash/agent tools so the agent behaves like a plain
 * Claude API call with the framework's system prompt. MCP tools from
 * agent capabilities remain available.
 */
export class ClaudeCodeAPIRunner extends ClaudeCodeRunner {
  protected override _buildOptions(
    agent: AgentLikeForBridge,
    options: RunOptions | undefined,
    context: {
      runId: string;
      traceId: string;
      parentSpanId?: string;
      includePartialMessages?: boolean;
    },
  ): SDKOptions {
    const sdkOpts = super._buildOptions(agent, options, context);
    sdkOpts.disallowedTools = [...BLOCKED_TOOLS];
    return sdkOpts;
  }
}
