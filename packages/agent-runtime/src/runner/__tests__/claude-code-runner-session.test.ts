/**
 * Tests for ClaudeCodeRunner's _onSessionId hook.
 *
 * Mocks `@anthropic-ai/claude-agent-sdk` so the SDK's `query()` returns
 * a scripted async iterable and we can assert hook behavior offline.
 */

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Scripted SDK mock
// ---------------------------------------------------------------------------

type Scripted = {
  messages: Array<Record<string, unknown>>;
  lastOptions: Record<string, unknown> | null;
};

const script: { current: Scripted } = {
  current: {
    messages: [],
    lastOptions: null,
  },
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
      script.current.lastOptions = options;
      async function* gen() {
        for (const msg of script.current.messages) {
          yield msg;
        }
      }
      return gen();
    },
  };
});

// Import after mock declaration.
import { ClaudeCodeRunner } from "../claude-code-runner.js";
import type { AgentLikeForBridge } from "../sdk-bridge.js";

// ---------------------------------------------------------------------------
// Minimal agent stub (not a full AgentLikeForBridge — cast for test)
// ---------------------------------------------------------------------------

function makeAgent(): AgentLikeForBridge {
  return {
    role: { name: "test", capabilities: [] },
    getModel: () => "sonnet",
    getTools: () => [],
    getSystemPrompt: () => "You are a test agent.",
    renderInitialPrompt: () => "go",
  } as unknown as AgentLikeForBridge;
}

// ---------------------------------------------------------------------------
// Test subclass that captures hook invocations.
// ---------------------------------------------------------------------------

class SpyRunner extends ClaudeCodeRunner {
  calls: string[] = [];
  protected override _onSessionId(sessionId: string): void {
    this.calls.push(sessionId);
  }
}

describe("ClaudeCodeRunner._onSessionId", () => {
  it("fires exactly once with the first session_id seen (run)", async () => {
    script.current = {
      messages: [
        { type: "system", subtype: "init", session_id: "abc" },
        {
          type: "assistant",
          message: { content: [{ text: "hi" }] },
          session_id: "abc",
        },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: "abc",
        },
      ],
      lastOptions: null,
    };

    const runner = new SpyRunner();
    await runner.run(makeAgent(), "hello");

    expect(runner.calls).toEqual(["abc"]);
  });

  it("fires exactly once with the first session_id seen (stream)", async () => {
    script.current = {
      messages: [
        { type: "system", subtype: "init", session_id: "xyz" },
        {
          type: "assistant",
          message: { content: [{ text: "hi" }] },
          session_id: "xyz",
        },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: "xyz",
        },
      ],
      lastOptions: null,
    };

    const runner = new SpyRunner();
    for await (const _ev of runner.stream(makeAgent(), "hello")) {
      // drain
    }

    expect(runner.calls).toEqual(["xyz"]);
  });

  it("does not fire when no session_id is present", async () => {
    script.current = {
      messages: [
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      lastOptions: null,
    };

    const runner = new SpyRunner();
    await runner.run(makeAgent(), "hello");

    expect(runner.calls).toEqual([]);
  });
});
