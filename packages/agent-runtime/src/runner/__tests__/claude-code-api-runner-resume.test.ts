/**
 * Tests for ClaudeCodeAPIRunner session resume behavior.
 *
 * First run captures `session_id`; second run on the same instance must
 * pass `resume: <id>` in the SDK options.
 */

import { describe, expect, it, vi } from "vitest";

type Scripted = {
  messages: Array<Record<string, unknown>>;
  optionsHistory: Array<Record<string, unknown>>;
};

const script: { current: Scripted } = {
  current: { messages: [], optionsHistory: [] },
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
      script.current.optionsHistory.push(options);
      async function* gen() {
        for (const msg of script.current.messages) {
          yield msg;
        }
      }
      return gen();
    },
  };
});

import { ClaudeCodeAPIRunner } from "../claude-code-api-runner.js";
import type { AgentLikeForBridge } from "../sdk-bridge.js";

function makeAgent(): AgentLikeForBridge {
  return {
    role: { name: "test", capabilities: [] },
    getModel: () => "sonnet",
    getTools: () => [],
    getSystemPrompt: () => "You are a test agent.",
    renderInitialPrompt: () => "go",
  } as unknown as AgentLikeForBridge;
}

describe("ClaudeCodeAPIRunner resume", () => {
  it("captures session_id from first run and passes resume on the second", async () => {
    script.current = {
      messages: [
        { type: "system", subtype: "init", session_id: "session-1" },
        {
          type: "assistant",
          message: { content: [{ text: "hi" }] },
          session_id: "session-1",
        },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: "session-1",
        },
      ],
      optionsHistory: [],
    };

    const runner = new ClaudeCodeAPIRunner();

    await runner.run(makeAgent(), "turn one");
    expect(runner.sessionId).toBe("session-1");

    const firstOpts = script.current.optionsHistory[0];
    expect(firstOpts).toBeDefined();
    expect(firstOpts?.resume).toBeUndefined();

    await runner.run(makeAgent(), "turn two");

    const secondOpts = script.current.optionsHistory[1];
    expect(secondOpts).toBeDefined();
    expect(secondOpts?.resume).toBe("session-1");
  });

  it("blocks Code-native tools via disallowedTools", async () => {
    script.current = {
      messages: [
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 0, output_tokens: 0 },
          session_id: "s",
        },
      ],
      optionsHistory: [],
    };

    const runner = new ClaudeCodeAPIRunner();
    await runner.run(makeAgent(), "noop");

    const opts = script.current.optionsHistory[0] as { disallowedTools?: string[] };
    expect(opts.disallowedTools).toContain("Bash");
    expect(opts.disallowedTools).toContain("Read");
    expect(opts.disallowedTools).toContain("Write");
  });
});
