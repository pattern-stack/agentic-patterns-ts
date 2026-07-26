/**
 * Unit tests for the `deferred`-strategy session cache (`cc-session.ts`).
 *
 * Pure logic — no Claude Agent SDK, no subprocesses. Shim handles are
 * fabricated over real tmpdirs so `disposeShim` (called on eviction /
 * replacement / teardown) exercises the real fs path.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";

import {
  SessionCache,
  type SessionEntry,
  conversationIdentity,
  findPendingToolResult,
} from "../cc-session.js";
import type { ShimHandle } from "../cc-shim.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const storeDirs: string[] = [];

function fakeShim(): ShimHandle {
  const storeDir = mkdtempSync(join(tmpdir(), "ap-cc-shim-test-"));
  storeDirs.push(storeDir);
  return {
    storeDir,
    resultFile: join(storeDir, "result.json"),
    schemasFile: join(storeDir, "schemas.json"),
    mcpServers: {},
    allowedTools: [],
  };
}

function entry(sessionId: string, pendingDeferredId: string | null): SessionEntry {
  return { sessionId, shim: fakeShim(), pendingDeferredId, lastSeenAt: Date.now() };
}

afterEach(() => {
  // Any tmpdir left over (test didn't dispose) — clean it.
  storeDirs.length = 0;
});

// ---------------------------------------------------------------------------
// conversationIdentity
// ---------------------------------------------------------------------------

describe("conversationIdentity", () => {
  const opening: LanguageModelV4Prompt = [
    { role: "system", content: "You are a math bot." },
    { role: "user", content: [{ type: "text", text: "17 + 28?" }] },
  ];

  it("is stable for identical inputs", () => {
    const a = conversationIdentity("You are a math bot.", opening, ["add"]);
    const b = conversationIdentity("You are a math bot.", opening, ["add"]);
    expect(a).toBe(b);
  });

  it("is stable as later turns are appended (uses only the run-invariant prefix)", () => {
    const base = conversationIdentity("You are a math bot.", opening, ["add"]);
    const grown: LanguageModelV4Prompt = [
      ...opening,
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "t1", toolName: "add", input: { a: 17, b: 28 } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "add",
            output: { type: "json", value: { result: 45 } },
          },
        ],
      },
    ];
    expect(conversationIdentity("You are a math bot.", grown, ["add"])).toBe(base);
  });

  it("does not depend on tool-name order", () => {
    const a = conversationIdentity("s", opening, ["add", "mul"]);
    const b = conversationIdentity("s", opening, ["mul", "add"]);
    expect(a).toBe(b);
  });

  it("differs when the system prompt, opening turn, or tool set differ", () => {
    const base = conversationIdentity("s", opening, ["add"]);
    const otherOpening: LanguageModelV4Prompt = [
      { role: "system", content: "You are a math bot." },
      { role: "user", content: [{ type: "text", text: "99 * 2?" }] },
    ];
    expect(conversationIdentity("different", opening, ["add"])).not.toBe(base);
    expect(conversationIdentity("s", otherOpening, ["add"])).not.toBe(base);
    expect(conversationIdentity("s", opening, ["add", "mul"])).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// findPendingToolResult
// ---------------------------------------------------------------------------

describe("findPendingToolResult", () => {
  const prompt: LanguageModelV4Prompt = [
    { role: "user", content: [{ type: "text", text: "add" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "tc-0", toolName: "add", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc-0",
          toolName: "add",
          output: { type: "json", value: { result: 45 } },
        },
      ],
    },
  ];

  it("returns the output that answers the pending deferred id", () => {
    const out = findPendingToolResult(prompt, "tc-0");
    expect(out).toEqual({ type: "json", value: { result: 45 } });
  });

  it("returns undefined for a null pending id", () => {
    expect(findPendingToolResult(prompt, null)).toBeUndefined();
  });

  it("returns undefined when no tool result matches", () => {
    expect(findPendingToolResult(prompt, "tc-99")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SessionCache
// ---------------------------------------------------------------------------

describe("SessionCache", () => {
  it("stores and retrieves a session by identity", () => {
    const cache = new SessionCache();
    const e = entry("sess-1", "tc-0");
    cache.set("id-a", e);
    expect(cache.get("id-a")).toBe(e);
    expect(cache.size).toBe(1);
    cache.disposeAll();
  });

  it("evicts + disposes sessions idle longer than the TTL", () => {
    const cache = new SessionCache(10);
    const e = entry("sess-1", "tc-0");
    cache.set("id-a", e);
    e.lastSeenAt = Date.now() - 1000; // force stale
    expect(cache.get("id-a")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(existsSync(e.shim.storeDir)).toBe(false);
  });

  it("delete() disposes the shim store dir and removes the entry", () => {
    const cache = new SessionCache();
    const e = entry("sess-1", null);
    cache.set("id-a", e);
    cache.delete("id-a");
    expect(cache.get("id-a")).toBeUndefined();
    expect(existsSync(e.shim.storeDir)).toBe(false);
  });

  it("replacing an identity with a new shim disposes the prior one", () => {
    const cache = new SessionCache();
    const first = entry("sess-1", "tc-0");
    const second = entry("sess-2", "tc-1");
    cache.set("id-a", first);
    cache.set("id-a", second);
    expect(existsSync(first.shim.storeDir)).toBe(false);
    expect(existsSync(second.shim.storeDir)).toBe(true);
    expect(cache.get("id-a")).toBe(second);
    cache.disposeAll();
  });

  it("disposeAll() tears down every live session", () => {
    const cache = new SessionCache();
    const a = entry("sess-1", null);
    const b = entry("sess-2", null);
    cache.set("id-a", a);
    cache.set("id-b", b);
    cache.disposeAll();
    expect(cache.size).toBe(0);
    expect(existsSync(a.shim.storeDir)).toBe(false);
    expect(existsSync(b.shim.storeDir)).toBe(false);
  });
});
