/**
 * `@anthropic-ai/claude-agent-sdk` contract tests (design.md §3 / D7, F-1).
 *
 * Two kinds of assertion protect the harness runners from silent upstream drift:
 *
 *   1. Executable/packaging contract — the SDK bundles a platform-specific
 *      Claude Code executable (`optionalDependencies`, one per platform, pinned
 *      to the SDK's own version) and uses it when `pathToClaudeCodeExecutable`
 *      is unset. The SDK<->CC pair is therefore lockfile-pinned. This suite reads
 *      the *installed* package.json and asserts it still matches the committed
 *      fixture (`__fixtures__/claude-agent-sdk-contract.json`) — so a lockfile
 *      refresh that moves either version, drops the bundled executables, or
 *      changes the peer-dep ranges agent-runtime absorbs fails loud here.
 *
 *   2. Message-union type contract — a type-level pin (`expectTypeOf`) on the
 *      exact SDK message/hook members the CC translator consumes (design §5.3 /
 *      B-1). If a future SDK removes or reshapes one of these, typecheck breaks
 *      at this file instead of surfacing as a runtime translation bug.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type {
  PostToolUseHookInput,
  PreToolUseHookInput,
  SDKAssistantMessage,
  SDKDeferredToolUse,
  SDKResultMessage,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, expectTypeOf, it } from "vitest";

// ---------------------------------------------------------------------------
// Executable / packaging contract
// ---------------------------------------------------------------------------

interface SdkContract {
  sdkVersion: string;
  claudeCodeVersion: string;
  peerDependencies: Record<string, string>;
  platformExecutablePackages: string[];
}

interface SdkPackageJson {
  version: string;
  claudeCodeVersion: string;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

const contract = JSON.parse(
  readFileSync(new URL("../__fixtures__/claude-agent-sdk-contract.json", import.meta.url), "utf8"),
) as SdkContract;

// Resolve the installed SDK's package.json via its module entry, since the
// package's `exports` map does not expose `./package.json` directly.
const require = createRequire(import.meta.url);
const installed = JSON.parse(
  readFileSync(
    join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"),
    "utf8",
  ),
) as SdkPackageJson;

describe("claude-agent-sdk executable/packaging contract", () => {
  it("installed SDK version matches the committed fixture", () => {
    expect(installed.version).toBe(contract.sdkVersion);
  });

  it("installed claudeCodeVersion (bundled executable) matches the committed pair", () => {
    expect(installed.claudeCodeVersion).toBe(contract.claudeCodeVersion);
  });

  it("still ships platform-specific executable packages, each pinned to the SDK version", () => {
    expect(Object.keys(installed.optionalDependencies).sort()).toEqual(
      [...contract.platformExecutablePackages].sort(),
    );
    for (const version of Object.values(installed.optionalDependencies)) {
      expect(version).toBe(contract.sdkVersion);
    }
  });

  it("peer-dependency ranges (absorbed as agent-runtime direct deps) are unchanged", () => {
    expect(installed.peerDependencies).toEqual(contract.peerDependencies);
  });
});

// ---------------------------------------------------------------------------
// Message-union type contract (members the CC translator consumes)
// ---------------------------------------------------------------------------

describe("claude-agent-sdk message-union type contract", () => {
  it("SDKAssistantMessage.message is an API message carrying usage/model/stop_reason", () => {
    expectTypeOf<SDKAssistantMessage>().toHaveProperty("message");
    expectTypeOf<SDKAssistantMessage["message"]>().toHaveProperty("usage");
    expectTypeOf<SDKAssistantMessage["message"]>().toHaveProperty("model");
    expectTypeOf<SDKAssistantMessage["message"]>().toHaveProperty("stop_reason");
    expectTypeOf<SDKAssistantMessage["parent_tool_use_id"]>().toEqualTypeOf<string | null>();
  });

  it("SDKResultMessage carries the run-accounting fields the translator reads", () => {
    expectTypeOf<SDKResultMessage>().toHaveProperty("num_turns").toEqualTypeOf<number>();
    expectTypeOf<SDKResultMessage>().toHaveProperty("total_cost_usd").toEqualTypeOf<number>();
    expectTypeOf<SDKResultMessage>().toHaveProperty("duration_ms").toEqualTypeOf<number>();
    expectTypeOf<SDKResultMessage>().toHaveProperty("modelUsage");
    expectTypeOf<SDKResultMessage>().toHaveProperty("permission_denials");
    expectTypeOf<SDKResultMessage>().toHaveProperty("usage");
  });

  it("SDKResultSuccess exposes deferred_tool_use as an optional {id,name,input}", () => {
    expectTypeOf<SDKResultSuccess["deferred_tool_use"]>().toEqualTypeOf<
      SDKDeferredToolUse | undefined
    >();
    expectTypeOf<SDKDeferredToolUse>().toEqualTypeOf<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>();
  });

  it("PreToolUse/PostToolUse hook inputs carry tool identity for the gate chain", () => {
    expectTypeOf<PreToolUseHookInput["hook_event_name"]>().toEqualTypeOf<"PreToolUse">();
    expectTypeOf<PreToolUseHookInput>().toHaveProperty("tool_name").toEqualTypeOf<string>();
    expectTypeOf<PreToolUseHookInput>().toHaveProperty("tool_input").toEqualTypeOf<unknown>();
    expectTypeOf<PreToolUseHookInput>().toHaveProperty("tool_use_id").toEqualTypeOf<string>();
    expectTypeOf<PostToolUseHookInput["hook_event_name"]>().toEqualTypeOf<"PostToolUse">();
    expectTypeOf<PostToolUseHookInput>().toHaveProperty("tool_response").toEqualTypeOf<unknown>();
    expectTypeOf<PostToolUseHookInput>().toHaveProperty("tool_use_id").toEqualTypeOf<string>();
  });
});
