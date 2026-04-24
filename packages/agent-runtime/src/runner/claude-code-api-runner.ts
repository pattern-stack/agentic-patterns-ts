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
 *
 * Session continuity: when used as a per-conversation instance (see
 * `RunnerFactory` in @agentic-patterns/server), this runner captures the
 * SDK `session_id` on turn 1 and passes `resume` on turn 2+. The child
 * `claude` subprocess's PreToolUse/PostToolUse hooks are forwarded to the
 * server via the `AP_RUNNER_CORRELATION_ID` env var set by the base
 * runner; see `packages/agent-server/src/routes/hooks.ts` for how that
 * correlation id is attached to `claude_code.hook` events so tool calls
 * appear on the same conversation's SSE stream without extra glue.
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
  #sessionId: string | undefined;

  protected override _onSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  /** Currently captured SDK session id, if any. Exposed for tests. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

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
    if (this.#sessionId !== undefined) {
      sdkOpts.resume = this.#sessionId;
    }
    return sdkOpts;
  }
}
