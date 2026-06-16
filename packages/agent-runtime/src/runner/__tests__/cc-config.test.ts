/**
 * Unit tests for the config × native-tools seams on ClaudeCodeRunner and
 * the cc-config helpers. Pure SDK-options inspection — no subprocess.
 *
 * Covers the consolidation contract:
 *   - host + all   → today's ClaudeCodeRunner (no tools cap, no env)
 *   - isolated+none → today's ClaudeCodeAPIRunner (tools: [], env injected)
 *   - isolated+all  → the new cell (native tools ON + isolation + profile)
 *
 * Every isolated runner constructed here is tracked and disposed in
 * afterEach so the suite doesn't leak tmpdirs (the very leak dispose() fixes).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyNativeTools,
  createIsolatedConfigDir,
  removeIsolatedConfigDir,
  resolveOAuthToken,
} from "../cc-config.js";
import { ClaudeCodeAPIRunner } from "../claude-code-api-runner.js";
import { ClaudeCodeRunner, type ClaudeCodeRunnerOptions } from "../claude-code-runner.js";
import type { AgentLikeForBridge } from "../sdk-bridge.js";

type SDKOptionsWithTools = SDKOptions & { tools?: string[] };

class RunnerProbe extends ClaudeCodeRunner {
  build(agent: AgentLikeForBridge): SDKOptions {
    return this._buildOptions(agent, undefined, { runId: "r", traceId: "t" });
  }
}

class APIProbe extends ClaudeCodeAPIRunner {
  build(agent: AgentLikeForBridge): SDKOptions {
    return this._buildOptions(agent, undefined, { runId: "r", traceId: "t" });
  }
}

// Track every runner so isolated tmpdirs are cleaned up after each test.
const tracked: ClaudeCodeRunner[] = [];
function track<T extends ClaudeCodeRunner>(r: T): T {
  tracked.push(r);
  return r;
}
afterEach(() => {
  for (const r of tracked) r.dispose();
  tracked.length = 0;
});

function makeAgent(): AgentLikeForBridge {
  return {
    role: { name: "test-agent", capabilities: [] },
    getModel: () => "claude-sonnet-4-6",
    getTools: () => [],
    getSystemPrompt: () => "Custom framework prompt.",
    renderInitialPrompt: () => "Custom framework prompt.",
  };
}

const TOKEN = "explicit-oauth-token-1234567890";

function buildWith(opts: ClaudeCodeRunnerOptions): SDKOptionsWithTools {
  return track(new RunnerProbe(opts)).build(makeAgent()) as SDKOptionsWithTools;
}

describe("ClaudeCodeRunner config seam (Axis B)", () => {
  it("host mode is the default: no isolated env injected", () => {
    expect(buildWith({}).env).toBeUndefined();
  });

  it("isolated mode injects CLAUDE_CONFIG_DIR + OAuth token (explicit, cross-platform)", () => {
    const opts = buildWith({ config: { mode: "isolated" }, oauthToken: TOKEN });
    expect(opts.env?.CLAUDE_CONFIG_DIR).toContain("ap-cc-cfg-");
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it("isolated mode seeds a curated profile dir (the B3 cell)", () => {
    const profile = mkdtempSync(join(tmpdir(), "ap-cc-profile-"));
    writeFileSync(join(profile, "settings.json"), '{"marker":true}');

    try {
      const opts = buildWith({
        config: { mode: "isolated", profile },
        nativeTools: "all",
        oauthToken: TOKEN,
      });

      const cfgDir = opts.env?.CLAUDE_CONFIG_DIR;
      expect(cfgDir).toBeDefined();
      expect(existsSync(join(cfgDir as string, "settings.json"))).toBe(true);
      expect(readFileSync(join(cfgDir as string, "settings.json"), "utf8")).toContain("marker");
      // ...and native tools stay ON — the cell neither class could express.
      expect(opts.tools).toBeUndefined();
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});

describe("ClaudeCodeRunner native-tools seam (Axis C)", () => {
  it('"all" (default) leaves tools uncapped', () => {
    expect(buildWith({}).tools).toBeUndefined();
  });

  it('"none" sets tools: []', () => {
    expect(buildWith({ nativeTools: "none" }).tools).toEqual([]);
  });

  it("an explicit list pins the available built-ins", () => {
    expect(buildWith({ nativeTools: ["Read", "Grep"] }).tools).toEqual(["Read", "Grep"]);
  });

  it("forwards extraDisallowedTools", () => {
    expect(buildWith({ extraDisallowedTools: ["mcp__claude_ai_Gmail"] }).disallowedTools).toEqual([
      "mcp__claude_ai_Gmail",
    ]);
  });
});

describe("axes are orthogonal", () => {
  it("isolated + all = isolation env with native tools still on", () => {
    const opts = buildWith({
      config: { mode: "isolated" },
      nativeTools: "all",
      oauthToken: TOKEN,
    });
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBeDefined();
    expect(opts.tools).toBeUndefined();
  });

  it("host + none = no isolation env but tools disabled", () => {
    const opts = buildWith({ config: { mode: "host" }, nativeTools: "none" });
    expect(opts.env).toBeUndefined();
    expect(opts.tools).toEqual([]);
  });
});

describe("ClaudeCodeAPIRunner is a preset over the base", () => {
  it("equals base { isolated, none }", () => {
    const apiOpts = track(new APIProbe({ oauthToken: TOKEN })).build(
      makeAgent(),
    ) as SDKOptionsWithTools;
    const baseOpts = buildWith({
      config: { mode: "isolated" },
      nativeTools: "none",
      oauthToken: TOKEN,
    });
    expect(apiOpts.tools).toEqual(baseOpts.tools);
    expect(apiOpts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(baseOpts.env?.CLAUDE_CODE_OAUTH_TOKEN);
    expect(apiOpts.env?.CLAUDE_CONFIG_DIR).toContain("ap-cc-cfg-");
  });

  it("disableSandbox: true → host config, tools still off", () => {
    const opts = track(new APIProbe({ disableSandbox: true })).build(
      makeAgent(),
    ) as SDKOptionsWithTools;
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(opts.tools).toEqual([]);
  });
});

describe("dispose() — isolated dir lifecycle", () => {
  it("removes the isolated config dir", () => {
    const runner = new RunnerProbe({ config: { mode: "isolated" }, oauthToken: TOKEN });
    const dir = (runner.build(makeAgent()) as SDKOptionsWithTools).env?.CLAUDE_CONFIG_DIR as string;
    expect(existsSync(dir)).toBe(true);
    runner.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it("is idempotent", () => {
    const runner = new RunnerProbe({ config: { mode: "isolated" }, oauthToken: TOKEN });
    const dir = (runner.build(makeAgent()) as SDKOptionsWithTools).env?.CLAUDE_CONFIG_DIR as string;
    runner.dispose();
    expect(() => runner.dispose()).not.toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  it("is a no-op on host-mode runners", () => {
    const runner = new ClaudeCodeRunner();
    expect(() => runner.dispose()).not.toThrow();
  });
});

describe("cc-config helpers", () => {
  it("resolveOAuthToken prefers explicit string over env", () => {
    expect(resolveOAuthToken("abc")).toBe("abc");
  });

  it("resolveOAuthToken accepts a thunk", () => {
    expect(resolveOAuthToken(() => "from-thunk")).toBe("from-thunk");
  });

  it("applyNativeTools all is a no-op", () => {
    const o: SDKOptionsWithTools = {};
    applyNativeTools(o, "all");
    expect(o.tools).toBeUndefined();
  });

  it("createIsolatedConfigDir throws on a missing profile", () => {
    expect(() => createIsolatedConfigDir("/no/such/profile/dir/xyz")).toThrow(/not found/);
  });

  it("removeIsolatedConfigDir deletes the dir and is safe on a missing one", () => {
    const dir = createIsolatedConfigDir();
    expect(existsSync(dir)).toBe(true);
    removeIsolatedConfigDir(dir);
    expect(existsSync(dir)).toBe(false);
    expect(() => removeIsolatedConfigDir(dir)).not.toThrow();
  });
});
