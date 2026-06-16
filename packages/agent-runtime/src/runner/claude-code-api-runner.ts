/**
 * ClaudeCodeAPIRunner — Claude Agent SDK in plain-API mode.
 *
 * A thin PRESET over `ClaudeCodeRunner`: it's just the base runner with the
 * two seams pinned to `config: { mode: "isolated" }` + `nativeTools: "none"`.
 * That combination strips everything CC-flavored — built-in tools, claude.ai
 * connectors, user/project settings, plugins, skills, hooks — so the agent
 * runs through the Claude Code subprocess as if it were a plain Claude API
 * call, while still authenticating with the Max-subscription OAuth token.
 *
 * MCP servers from agent capabilities are still wired up by the base runner.
 *
 * All the machinery now lives on `ClaudeCodeRunner` (see `cc-config.ts`);
 * this class only fixes the preset values. To reach other cells of the
 * config × native-tools matrix — e.g. an isolated-but-curated coding agent
 * (`config: { mode: "isolated", profile }, nativeTools: "all"`) — construct
 * `ClaudeCodeRunner` directly with the desired seams.
 *
 * Mirrors Python: agentic_patterns/core/systems/runners/claude_api.py
 */

import { ClaudeCodeRunner, type ClaudeCodeRunnerOptions } from "./claude-code-runner.js";

export interface ClaudeCodeAPIRunnerOptions extends ClaudeCodeRunnerOptions {
  /**
   * Disable the isolated-config sandbox. When true, runs in `host` config
   * mode (auth and connectors fall through to the binary's defaults) while
   * still disabling native tools. Equivalent to
   * `config: { mode: "host" }`.
   *
   * Useful for debugging or where the OS credential store is unavailable.
   */
  disableSandbox?: boolean;
}

/**
 * Runner that uses the Claude Agent SDK as a plain Claude API call,
 * sandboxed away from the user's Claude Code environment.
 *
 * Drops in for AgentRunner — both implement RunnerProtocol identically.
 */
export class ClaudeCodeAPIRunner extends ClaudeCodeRunner {
  constructor(opts?: ClaudeCodeAPIRunnerOptions) {
    super({
      ...opts,
      // Preset: stripped + isolated, unless explicitly overridden.
      config: opts?.config ?? (opts?.disableSandbox ? { mode: "host" } : { mode: "isolated" }),
      nativeTools: opts?.nativeTools ?? "none",
    });
  }
}
