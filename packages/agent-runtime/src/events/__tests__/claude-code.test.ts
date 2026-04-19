import { describe, expect, it } from "vitest";
import { mapClaudeCodeHookToAgentEvents } from "../claude-code-mapper.js";
import type { ClaudeCodeHookEvent } from "../claude-code.js";

function makeHook(overrides: Partial<ClaudeCodeHookEvent>): ClaudeCodeHookEvent {
  return {
    type: "claude_code.hook",
    traceId: "session-1",
    runId: "session-1",
    spanId: "span-1",
    timestamp: new Date(),
    hookName: "SessionStart",
    sessionId: "session-1",
    payload: {},
    ...overrides,
  };
}

describe("mapClaudeCodeHookToAgentEvents", () => {
  it("emits agent.tool.start for PreToolUse and agent.tool.end for PostToolUse", () => {
    const pre = makeHook({
      hookName: "PreToolUse",
      toolUseId: "call-42",
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
    const post = makeHook({
      hookName: "PostToolUse",
      toolUseId: "call-42",
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolResponse: { stdout: "file.txt" },
    });

    const startEvents = mapClaudeCodeHookToAgentEvents(pre);
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]!.type).toBe("agent.tool.start");
    if (startEvents[0]!.type === "agent.tool.start") {
      expect(startEvents[0]!.toolCallId).toBe("call-42");
      expect(startEvents[0]!.toolName).toBe("Bash");
      expect(startEvents[0]!.arguments).toEqual({ command: "ls" });
      expect(startEvents[0]!.traceId).toBe("session-1");
    }

    const endEvents = mapClaudeCodeHookToAgentEvents(post);
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]!.type).toBe("agent.tool.end");
    if (endEvents[0]!.type === "agent.tool.end") {
      expect(endEvents[0]!.toolCallId).toBe("call-42");
      expect(endEvents[0]!.toolName).toBe("Bash");
      expect(endEvents[0]!.result).toEqual({ stdout: "file.txt" });
      expect(endEvents[0]!.durationMs).toBe(0);
      expect(endEvents[0]!.resultTokens).toBe(0);
      expect(endEvents[0]!.error).toBeUndefined();
    }
  });

  it("returns empty array for non-tool hooks", () => {
    expect(mapClaudeCodeHookToAgentEvents(makeHook({ hookName: "SessionStart" }))).toEqual([]);
    expect(mapClaudeCodeHookToAgentEvents(makeHook({ hookName: "Stop" }))).toEqual([]);
  });
});
