/**
 * Fail-closed (D11) tests for the two isolated-config surfaces.
 *
 * Isolated config mode must NEVER silently fall through to the host config
 * when no OAuth token resolves — that would leak the developer's connectors /
 * plugins into a run that asked for isolation. Both surfaces throw instead:
 *
 *   - the `claudeCode()` provider throws at CONSTRUCTION;
 *   - `ClaudeCodeRunner._buildOptions` throws when it assembles SDK options.
 *
 * `resolveOAuthToken` is mocked to return `undefined` so "no token" is
 * deterministic on every platform (the real resolver would otherwise find a
 * token in the macOS Keychain on a logged-in dev machine, masking the throw).
 */

import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

// Force "no resolvable token" regardless of host env / Keychain. The real
// createIsolatedConfigDir / applyIsolatedEnv are kept so the runner still
// creates (and can dispose) its tmpdir.
vi.mock("../../runner/cc-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runner/cc-config.js")>();
  return { ...actual, resolveOAuthToken: () => undefined };
});

import { ClaudeCodeRunner } from "../../runner/claude-code-runner.js";
import type { AgentLikeForBridge } from "../../runner/sdk-bridge.js";
import { ClaudeCodeLanguageModel, claudeCode } from "../claude-code.js";

class RunnerProbe extends ClaudeCodeRunner {
  build(agent: AgentLikeForBridge): SDKOptions {
    return this._buildOptions(agent, undefined, { runId: "r", traceId: "t" });
  }
}

function makeAgent(): AgentLikeForBridge {
  return {
    role: { name: "test-agent", capabilities: [] },
    getModel: () => "claude-sonnet-4-6",
    getTools: () => [],
    renderInitialPrompt: () => "Custom framework prompt.",
  };
}

// The error message names all three token sources + the host opt-out.
function expectNamesTokenSources(fn: () => unknown): void {
  expect(fn).toThrow(/oauthToken/);
  expect(fn).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  expect(fn).toThrow(/Keychain/);
  expect(fn).toThrow(/mode: "host"/);
}

describe("fail-closed: claudeCode() provider (isolated default)", () => {
  it("throws at construction when no token resolves", () => {
    expectNamesTokenSources(() => claudeCode("sonnet"));
    expectNamesTokenSources(() => new ClaudeCodeLanguageModel("sonnet"));
  });

  it("throws for an explicitly isolated config with no token", () => {
    expectNamesTokenSources(() => claudeCode("sonnet", { config: { mode: "isolated" } }));
  });

  it("does NOT throw in host mode (explicit opt-out)", () => {
    expect(() => claudeCode("sonnet", { config: { mode: "host" } })).not.toThrow();
  });
});

describe("fail-closed: ClaudeCodeRunner._buildOptions (isolated)", () => {
  it("throws when isolated but no token resolves — no silent host fall-through", () => {
    const runner = new RunnerProbe({ config: { mode: "isolated" } });
    try {
      expectNamesTokenSources(() => runner.build(makeAgent()));
    } finally {
      runner.dispose();
    }
  });

  it("does NOT throw in host mode", () => {
    const runner = new RunnerProbe({ config: { mode: "host" } });
    try {
      expect(() => runner.build(makeAgent())).not.toThrow();
    } finally {
      runner.dispose();
    }
  });
});
