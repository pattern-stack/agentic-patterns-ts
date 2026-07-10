/**
 * Tests for ClaudeCodeAPIRunner — verifies it configures the SDK to
 * behave like a plain Claude API call (no Claude Code built-ins, custom
 * system prompt, MCP tools from capabilities still wired up).
 *
 * These are unit tests on the SDK options object — we don't spawn the
 * Claude Code subprocess. End-to-end verification requires a Max
 * subscription and is out of scope for unit tests.
 */

import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { ClaudeCodeAPIRunner } from "../claude-code-api-runner.js";
import { ClaudeCodeRunner } from "../claude-code-runner.js";
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
    const runner = new APIRunnerProbe();
    const opts = runner.publicBuildOptions(makeAgent());

    // Passing a string fully replaces the SDK default (per @anthropic-ai/
    // claude-agent-sdk type docs). If we wanted CC's prompt we'd pass
    // { type: 'preset', preset: 'claude_code' }.
    expect(typeof opts.systemPrompt).toBe("string");
    expect(opts.systemPrompt).toBe("You are a helpful assistant. Custom framework prompt.");
  });

  it("disables all Claude Code built-in tools via tools: []", () => {
    const runner = new APIRunnerProbe();
    const opts = runner.publicBuildOptions(makeAgent()) as SDKOptions & { tools?: string[] };

    expect(opts.tools).toEqual([]);
  });

  it("differs from base ClaudeCodeRunner only by tools: []", () => {
    const apiOpts = new APIRunnerProbe().publicBuildOptions(makeAgent()) as SDKOptions & {
      tools?: unknown;
    };
    const ccOpts = new CCRunnerProbe().publicBuildOptions(makeAgent()) as SDKOptions & {
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
    const opts = new APIRunnerProbe().publicBuildOptions(makeAgent());
    expect(opts.disallowedTools).toBeUndefined();
  });

  it("sandboxes by setting CLAUDE_CONFIG_DIR to an isolated tmpdir", () => {
    const opts = new APIRunnerProbe().publicBuildOptions(makeAgent());
    // env may be undefined on platforms where OAuth load fails — that's
    // the documented fallback. On darwin with a logged-in user it's set.
    if (process.platform === "darwin" && opts.env) {
      expect(opts.env.CLAUDE_CONFIG_DIR).toBeDefined();
      expect(opts.env.CLAUDE_CONFIG_DIR).toContain("ap-cc-cfg-");
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("disables sandboxing when disableSandbox: true", () => {
    class NoSandbox extends ClaudeCodeAPIRunner {
      publicBuildOptions(agent: AgentLikeForBridge): SDKOptions {
        return this._buildOptions(agent, undefined, { runId: "r", traceId: "t" });
      }
    }
    const runner = new NoSandbox({ disableSandbox: true });
    const opts = runner.publicBuildOptions(makeAgent());
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // tools: [] still applies even without sandbox.
    expect((opts as SDKOptions & { tools?: unknown }).tools).toEqual([]);
  });

  it("forwards extraDisallowedTools when provided", () => {
    class WithExtras extends ClaudeCodeAPIRunner {
      publicBuildOptions(agent: AgentLikeForBridge): SDKOptions {
        return this._buildOptions(agent, undefined, { runId: "r", traceId: "t" });
      }
    }
    const runner = new WithExtras({
      extraDisallowedTools: ["mcp__claude_ai_Gmail", "mcp__weather__forecast"],
    });
    const opts = runner.publicBuildOptions(makeAgent());
    expect(opts.disallowedTools).toEqual(["mcp__claude_ai_Gmail", "mcp__weather__forecast"]);
  });

  it("maps Claude model names to the SDK model alias", () => {
    const runner = new APIRunnerProbe();
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
    const runner = new APIRunnerProbe();
    const opts = runner.publicBuildOptions(makeAgent());
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
  });

  it("wires PreToolUse / PostToolUse hooks for the gate chain", () => {
    const runner = new APIRunnerProbe();
    const opts = runner.publicBuildOptions(makeAgent());
    expect(opts.hooks?.PreToolUse).toBeDefined();
    expect(opts.hooks?.PostToolUse).toBeDefined();
  });
});
