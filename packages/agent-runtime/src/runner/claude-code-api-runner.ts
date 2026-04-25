/**
 * ClaudeCodeAPIRunner — Claude Agent SDK in plain-API mode.
 *
 * The agent runs through the Claude Code subprocess but in a sandboxed
 * configuration that strips everything CC-flavored:
 *
 *   - System prompt: framework's, fully replacing CC's.
 *   - Built-in tools (Read/Bash/Edit/...): disabled via `tools: []`.
 *   - claude.ai connector MCP servers (Gmail/Calendar/Drive/...):
 *     disabled by isolating CLAUDE_CONFIG_DIR to an ephemeral tmpdir.
 *   - User/project settings, plugins, skills, hooks: not loaded
 *     (settingSources defaults to []; new CLAUDE_CONFIG_DIR is empty).
 *   - MCP servers from agent capabilities: still wired up.
 *
 * Auth: reads the Max-subscription OAuth token from the OS credential
 * store and injects it via `CLAUDE_CODE_OAUTH_TOKEN`. This bypasses
 * the binary's path-bound Keychain lookup (which would otherwise fail
 * when CLAUDE_CONFIG_DIR is redirected) while preserving Max-sub auth.
 *
 * Currently macOS-only — credential lookup uses the `security` CLI.
 * On other platforms, falls back to the parent ClaudeCodeRunner
 * behavior (auth works, connectors leak — see ClaudeCodeRunner docs).
 *
 * Mirrors Python: agentic_patterns/core/systems/runners/claude_api.py
 */

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeCodeRunner, type ClaudeCodeRunnerOptions } from "./claude-code-runner.js";
import type { AgentLikeForBridge } from "./sdk-bridge.js";
import type { RunOptions } from "./types.js";

// ---------------------------------------------------------------------------
// OAuth loading
// ---------------------------------------------------------------------------

interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

/**
 * Read the Max-subscription OAuth token from the OS credential store.
 * Returns null if unavailable (non-macOS, not logged in, etc.) — caller
 * falls back to letting the CC binary do its own auth lookup.
 */
function loadMaxSubOAuth(): OAuthCredential | null {
  if (process.platform !== "darwin") return null;
  const user = process.env.USER;
  if (!user) return null;
  try {
    const raw = execSync(
      `security find-generic-password -a "${user}" -s "Claude Code-credentials" -w`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const parsed = JSON.parse(raw) as { claudeAiOauth?: OAuthCredential };
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return oauth;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ClaudeCodeAPIRunnerOptions extends ClaudeCodeRunnerOptions {
  /**
   * Disable the OAuth-injection sandboxing path. When true, behaves
   * like a stripped ClaudeCodeRunner with `tools: []` only — auth and
   * connectors fall through to the binary's defaults.
   *
   * Useful for debugging or for environments where the OS credential
   * store is unavailable.
   */
  disableSandbox?: boolean;

  /**
   * Tool names or `mcp__<server>` server-prefixes to additionally
   * block via SDK `disallowedTools`. Rarely needed when sandboxing
   * is enabled (connectors are already stripped via config isolation).
   */
  extraDisallowedTools?: string[];
}

/**
 * Runner that uses the Claude Agent SDK as a plain Claude API call,
 * sandboxed away from the user's Claude Code environment.
 *
 * Drops in for AgentRunner — both implement RunnerProtocol identically.
 */
export class ClaudeCodeAPIRunner extends ClaudeCodeRunner {
  private readonly _disableSandbox: boolean;
  private readonly _extraDisallowed: readonly string[];
  private readonly _isolatedConfigDir: string | null;

  constructor(opts?: ClaudeCodeAPIRunnerOptions) {
    super(opts);
    this._disableSandbox = opts?.disableSandbox ?? false;
    this._extraDisallowed = opts?.extraDisallowedTools ?? [];
    this._isolatedConfigDir = this._disableSandbox
      ? null
      : mkdtempSync(join(tmpdir(), "ap-cc-api-"));
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

    // Disable every built-in CC tool. MCP servers from agent capabilities
    // were already added by the parent and remain available.
    (sdkOpts as SDKOptions & { tools?: string[] }).tools = [];

    if (this._extraDisallowed.length > 0) {
      sdkOpts.disallowedTools = [
        ...(sdkOpts.disallowedTools ?? []),
        ...this._extraDisallowed,
      ];
    }

    // Sandbox: redirect CLAUDE_CONFIG_DIR + inject OAuth token via env.
    // Strips connectors, settings, plugins, skills, hooks — without
    // breaking Max-sub auth.
    if (!this._disableSandbox && this._isolatedConfigDir) {
      const oauth = loadMaxSubOAuth();
      if (oauth) {
        const baseEnv: Record<string, string> = Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => typeof v === "string") as [string, string][],
        );
        sdkOpts.env = {
          ...baseEnv,
          ...(sdkOpts.env ?? {}),
          CLAUDE_CONFIG_DIR: this._isolatedConfigDir,
          CLAUDE_CODE_OAUTH_TOKEN: oauth.accessToken,
        };
      }
      // If oauth load failed (non-macOS, not logged in), fall through
      // to the parent's behavior — auth still works, connectors leak.
    }

    return sdkOpts;
  }
}
