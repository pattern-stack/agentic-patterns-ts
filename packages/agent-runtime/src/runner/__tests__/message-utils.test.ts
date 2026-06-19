/**
 * Tests for message history conversion.
 */

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { convertHistory, sanitizeResponseMessages, toJsonValue } from "../message-utils.js";
import type { CanonicalMessage } from "../types.js";

describe("sanitizeResponseMessages", () => {
  it("defaults a missing reasoning `text` to '' while preserving providerOptions (Gemini thoughtSignature round-trip)", () => {
    // Gemini 3.x emits a reasoning part carrying only the signature in providerOptions, no `text`.
    // AI SDK v5's modelMessageSchema requires reasoning.text: string, so re-sending it throws.
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", providerOptions: { google: { thoughtSignature: "sig" } } },
          { type: "tool-call", toolCallId: "t1", toolName: "search", input: {} },
        ],
      },
    ] as unknown as ModelMessage[];

    const out = sanitizeResponseMessages(messages);
    const part = (out[0]!.content as unknown as Array<Record<string, unknown>>)[0]!;
    expect(part.text).toBe(""); // now a string → passes validation
    expect(part.providerOptions).toEqual({ google: { thoughtSignature: "sig" } }); // signature kept
  });

  it("also coerces a text part with a missing text (same missing-required-string class)", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", providerOptions: { google: { thoughtSignature: "sig" } } }],
      },
    ] as unknown as ModelMessage[];
    const part = (
      sanitizeResponseMessages(messages)[0]!.content as unknown as Array<Record<string, unknown>>
    )[0]!;
    expect(part.text).toBe("");
    expect(part.providerOptions).toEqual({ google: { thoughtSignature: "sig" } });
  });

  it("leaves a reasoning part with real text untouched", () => {
    const messages = [
      { role: "assistant", content: [{ type: "reasoning", text: "thought" }] },
    ] as unknown as ModelMessage[];
    const part = (
      sanitizeResponseMessages(messages)[0]!.content as unknown as Array<Record<string, unknown>>
    )[0]!;
    expect(part.text).toBe("thought");
  });

  it("ignores string-content and non-assistant messages", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
    ] as unknown as ModelMessage[];
    expect(sanitizeResponseMessages(messages)).toEqual(messages);
  });
});

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

describe("toJsonValue", () => {
  // Asserts no non-JSON value (undefined / non-finite number / bigint / function)
  // survives anywhere in the tree — that is exactly what v5's jsonValueSchema rejects.
  const hasNonJson = (v: unknown): boolean => {
    if (v === undefined) return true;
    if (typeof v === "number" && !Number.isFinite(v)) return true;
    if (typeof v === "bigint" || typeof v === "function") return true;
    if (Array.isArray(v)) return v.some(hasNonJson);
    if (v && typeof v === "object") return Object.values(v).some(hasNonJson);
    return false;
  };

  it("strips `undefined` fields from a tool result (the inspect-row regression)", () => {
    // Mirrors the captured failure: inspect returns rows with absent fields left as
    // undefined, which aborted the run with "messages must be a ModelMessage[]".
    const toolResult = {
      items: [
        { id: "r1", normalized_text: "wants SSO", type: undefined, occurred_at: undefined },
        { id: "r2", normalized_text: "wants punch-out", type: undefined, occurred_at: undefined },
      ],
    };
    const cleaned = toJsonValue(toolResult);
    expect(hasNonJson(cleaned)).toBe(false);
    expect(cleaned).toEqual({
      items: [
        { id: "r1", normalized_text: "wants SSO" },
        { id: "r2", normalized_text: "wants punch-out" },
      ],
    });
  });

  it("nulls non-finite numbers, stringifies bigint, and drops functions", () => {
    const cleaned = toJsonValue({
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      big: 10n,
      fn: () => 1,
      ok: 42,
    }) as Record<string, unknown>;
    expect(hasNonJson(cleaned)).toBe(false);
    expect(cleaned.nan).toBeNull();
    expect(cleaned.inf).toBeNull();
    expect(cleaned.big).toBe("10");
    expect("fn" in cleaned).toBe(false);
    expect(cleaned.ok).toBe(42);
  });

  it("preserves valid JSON unchanged and survives circular input", () => {
    expect(toJsonValue({ a: 1, b: [true, "x", null] })).toEqual({ a: 1, b: [true, "x", null] });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof toJsonValue(circular)).toBe("string");
  });
});
