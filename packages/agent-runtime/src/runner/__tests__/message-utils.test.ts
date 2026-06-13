/**
 * Tests for message history conversion.
 */

import { describe, expect, it } from "vitest";
import { convertHistory } from "../message-utils.js";
import type { CanonicalMessage } from "../types.js";

describe("convertHistory", () => {
  it("should return empty array for empty history", () => {
    const result = convertHistory([]);
    expect(result).toEqual([]);
  });

  it("should convert text-only request messages", () => {
    const history: CanonicalMessage[] = [
      {
        kind: "request",
        parts: [{ type: "user_prompt", content: "Hello there" }],
      },
    ];

    const result = convertHistory(history);
    expect(result).toEqual([{ role: "user", content: "Hello there" }]);
  });

  it("should convert text-only response messages", () => {
    const history: CanonicalMessage[] = [
      {
        kind: "response",
        parts: [{ type: "text", content: "I am an AI assistant." }],
      },
    ];

    const result = convertHistory(history);
    expect(result).toEqual([{ role: "assistant", content: "I am an AI assistant." }]);
  });

  it("should convert tool call + tool result pairs", () => {
    const history: CanonicalMessage[] = [
      {
        kind: "response",
        parts: [
          { type: "text", content: "Let me search for that." },
          {
            type: "tool_call",
            tool_name: "search",
            tool_call_id: "tc-1",
            arguments: { query: "weather" },
          },
          {
            type: "tool_return",
            tool_name: "search",
            tool_call_id: "tc-1",
            content: "Sunny, 72F",
          },
        ],
      },
    ];

    const result = convertHistory(history);
    expect(result).toHaveLength(2);

    // Assistant message with text + tool call (v5: tool-call payload is `input`)
    expect(result[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me search for that." },
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "search",
          input: { query: "weather" },
        },
      ],
    });

    // Tool result message (v5: result carried under `output` as a typed union)
    expect(result[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc-1",
          toolName: "",
          output: { type: "text", value: "Sunny, 72F" },
        },
      ],
    });
  });

  it("should skip system_prompt parts in request messages", () => {
    const history: CanonicalMessage[] = [
      {
        kind: "request",
        parts: [
          { type: "system_prompt", content: "You are helpful." },
          { type: "user_prompt", content: "Hi" },
        ],
      },
    ];

    const result = convertHistory(history);
    expect(result).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("should handle full conversation round-trip", () => {
    const history: CanonicalMessage[] = [
      {
        kind: "request",
        parts: [{ type: "user_prompt", content: "What's the weather?" }],
      },
      {
        kind: "response",
        parts: [
          {
            type: "tool_call",
            tool_name: "get_weather",
            tool_call_id: "tc-1",
            arguments: { city: "Seattle" },
          },
          {
            type: "tool_return",
            tool_name: "get_weather",
            tool_call_id: "tc-1",
            content: "Rain, 55F",
          },
        ],
      },
      {
        kind: "response",
        parts: [{ type: "text", content: "It's raining in Seattle at 55F." }],
      },
    ];

    const result = convertHistory(history);
    expect(result).toHaveLength(4);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
    expect(result[2]!.role).toBe("tool");
    expect(result[3]!.role).toBe("assistant");
  });
});
