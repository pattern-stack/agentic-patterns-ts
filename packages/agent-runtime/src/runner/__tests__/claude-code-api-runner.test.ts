/**
 * Tests for ClaudeCodeAPIRunner — verifies it configures the SDK to
 * behave like a plain Claude API call (no Claude Code built-ins, custom
 * system prompt, MCP tools from capabilities still wired up).
 *
 * These are unit tests on the SDK options object — we don't spawn the
 * Claude Code subprocess. End-to-end verification requires a Max
 * subscription and is out of scope for unit tests.
 *
 * Since the API runner defaults to isolated config mode, and isolated mode
 * now FAILS CLOSED on an unresolvable OAuth token (D11), every isolated
 * probe here is constructed with an explicit token so `_buildOptions` is
 * deterministic across platforms (no macOS Keychain dependency, no CI skip).
 */

import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeAPIRunner, type ClaudeCodeAPIRunnerOptions } from "../claude-code-api-runner.js";
import { ClaudeCodeRunner, type ClaudeCodeRunnerOptions } from "../claude-code-runner.js";
import type { AgentLikeForBridge } from "../sdk-bridge.js";

// Subclasses that expose the protected _buildOptions for inspection.
class APIRunnerProbe extends ClaudeCodeAPIRunner {
  publicBuildOptions(agent: AgentLikeForBridge): SDKOptions {
    return this._buildOptions(agent, undefined, {
      runId: "r",
      traceId: "t",
    });
  }
}

class CCRunnerProbe extends ClaudeCodeRunner {
  publicBuildOptions(agent: AgentLikeForBridge): SDKOptions {
    return this._buildOptions(agent, undefined, {
      runId: "r",
      traceId: "t",
    });
  }
}

const TOKEN = "test-oauth-token-1234567890";

// Track isolated runners so their tmpdirs are cleaned up after each test.
const tracked: ClaudeCodeRunner[] = [];
function track<T extends ClaudeCodeRunner>(r: T): T {
  tracked.push(r);
  return r;
}
afterEach(() => {
  for (const r of tracked) r.dispose();
  tracked.length = 0;
});

/** Isolated API-runner probe with an explicit token (fail-closed safe). */
function apiProbe(opts: ClaudeCodeAPIRunnerOptions = {}): APIRunnerProbe {
  return track(new APIRunnerProbe({ oauthToken: TOKEN, ...opts }));
}

/** Base runner probe — host config mode by default (no token needed). */
function ccProbe(opts: ClaudeCodeRunnerOptions = {}): CCRunnerProbe {
  return track(new CCRunnerProbe(opts));
}

function makeAgent(overrides: Partial<AgentLikeForBridge> = {}): AgentLikeForBridge {
  return {
    role: { name: "test-agent", capabilities: [] },
    getModel: () => "claude-sonnet-4-6",
    getTools: () => [],
    renderInitialPrompt: () => "You are a helpful assistant. Custom framework prompt.",
    ...overrides,
  };
}

describe("ClaudeCodeAPIRunner", () => {
  it("replaces Claude Code's system prompt with the framework prompt", () => {
    const opts = apiProbe().publicBuildOptions(makeAgent());

    // Passing a string fully replaces the SDK default (per @anthropic-ai/
    // claude-agent-sdk type docs). If we wanted CC's prompt we'd pass
    // { type: 'preset', preset: 'claude_code' }.
    expect(typeof opts.systemPrompt).toBe("string");
    expect(opts.systemPrompt).toBe("You are a helpful assistant. Custom framework prompt.");
  });

  it("disables all Claude Code built-in tools via tools: []", () => {
    const opts = apiProbe().publicBuildOptions(makeAgent()) as SDKOptions & { tools?: string[] };

    expect(opts.tools).toEqual([]);
  });

  it("differs from base ClaudeCodeRunner only by tools: []", () => {
    const apiOpts = apiProbe().publicBuildOptions(makeAgent()) as SDKOptions & {
      tools?: unknown;
    };
    const ccOpts = ccProbe().publicBuildOptions(makeAgent()) as SDKOptions & {
      tools?: unknown;
    };

    expect(ccOpts.tools).toBeUndefined();
    expect(apiOpts.tools).toEqual([]);

    expect(apiOpts.systemPrompt).toBe(ccOpts.systemPrompt);
    expect(apiOpts.model).toBe(ccOpts.model);
    expect(Object.keys(apiOpts.hooks ?? {})).toEqual(Object.keys(ccOpts.hooks ?? {}));
  });

  it("does not impose a default disallowedTools list", () => {
    // Connectors are stripped via CLAUDE_CONFIG_DIR isolation, not
    // a disallowedTools enumeration.
    const opts = apiProbe().publicBuildOptions(makeAgent());
    expect(opts.disallowedTools).toBeUndefined();
  });

  it("sandboxes by setting CLAUDE_CONFIG_DIR to an isolated tmpdir with the injected token", () => {
    // With an explicit token this is deterministic on every platform — the
    // fail-closed contract guarantees isolated env is always fully applied.
    const opts = apiProbe().publicBuildOptions(makeAgent());
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBeDefined();
    expect(opts.env?.CLAUDE_CONFIG_DIR).toContain("ap-cc-cfg-");
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it("disables sandboxing when disableSandbox: true", () => {
    // host config mode — no isolated dir, no token required.
    const opts = track(new APIRunnerProbe({ disableSandbox: true })).publicBuildOptions(
      makeAgent(),
    );
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // tools: [] still applies even without sandbox.
    expect((opts as SDKOptions & { tools?: unknown }).tools).toEqual([]);
  });

  it("forwards extraDisallowedTools when provided", () => {
    const opts = apiProbe({
      extraDisallowedTools: ["mcp__claude_ai_Gmail", "mcp__weather__forecast"],
    }).publicBuildOptions(makeAgent());
    expect(opts.disallowedTools).toEqual(["mcp__claude_ai_Gmail", "mcp__weather__forecast"]);
  });

  it("maps Claude model names to the SDK model alias", () => {
    const runner = apiProbe();
    expect(runner.publicBuildOptions(makeAgent({ getModel: () => "claude-opus-4-7" })).model).toBe(
      "opus",
    );
    expect(
      runner.publicBuildOptions(makeAgent({ getModel: () => "claude-sonnet-4-6" })).model,
    ).toBe("sonnet");
    expect(runner.publicBuildOptions(makeAgent({ getModel: () => "claude-haiku-4-5" })).model).toBe(
      "haiku",
    );
  });

  it("uses bypassPermissions mode (built-ins disabled, MCP tools allow-listed)", () => {
    const opts = apiProbe().publicBuildOptions(makeAgent());
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
  });

  it("wires PreToolUse / PostToolUse hooks for the gate chain", () => {
    const opts = apiProbe().publicBuildOptions(makeAgent());
    expect(opts.hooks?.PreToolUse).toBeDefined();
    expect(opts.hooks?.PostToolUse).toBeDefined();
  });
});
