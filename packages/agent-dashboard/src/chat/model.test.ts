/**
 * Contract tests for the chat reducer — the streaming-first core.
 *
 * Retargeted to the FRAMEWORK event vocabulary as it lands POST-`toEventLike`
 * (flat `EventLike`): bare event names (`message.delta`, `tool.start/end`,
 * `thinking`, `thinking.complete`, `error`, `message.complete`) with snake_case
 * payload fields (`tool_name`, `duration_ms`, `error_type`, `input_tokens`).
 *
 * The `message.delta` cases guard FOLD-FIX #1 (the framework emits
 * `message.delta`, not the cockpit's `message.chunk`). A persisted-row case is
 * retained to prove the snake_case-column / payload_json accessors still fold.
 */
import { describe, expect, test } from "vitest";
import type { EventLike } from "../graph/trace-from-events";
import { type Part, applyParts, eventsToAssistantMessage } from "./model";

const fold = (events: EventLike[]): Part[] => {
  let parts: Part[] = [];
  for (const e of events) parts = applyParts(parts, e).parts;
  return parts;
};

describe("applyParts", () => {
  test("accumulates message.delta deltas into a single text part (fold-fix #1)", () => {
    const parts = fold([
      { type: "message.delta", delta: "Hel" },
      { type: "message.delta", delta: "lo " },
      { type: "message.delta", delta: "world" },
    ]);
    expect(parts).toEqual([{ kind: "text", content: "Hello world" }]);
  });

  test("pairs tool.start with tool.end on the same tool_call_id", () => {
    const parts = fold([
      {
        type: "tool.start",
        tool_call_id: "t1",
        tool_name: "searchDeals",
        arguments: { q: "acme" },
      },
      {
        type: "tool.end",
        tool_call_id: "t1",
        tool_name: "searchDeals",
        result: [{ id: 1 }],
        duration_ms: 42,
      },
    ]);
    expect(parts).toHaveLength(1);
    const tc = parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.kind).toBe("tool_call");
    expect(tc.id).toBe("t1");
    expect(tc.arguments).toEqual({ q: "acme" });
    expect(tc.result).toEqual([{ id: 1 }]);
    expect(tc.durationMs).toBe(42);
    expect(tc.error).toBeUndefined();
  });

  test("tool.end carries an error through to the tool_call part", () => {
    const parts = fold([
      { type: "tool.start", tool_call_id: "t1", tool_name: "risky" },
      { type: "tool.end", tool_call_id: "t1", tool_name: "risky", error: "boom" },
    ]);
    const tc = parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.error).toBe("boom");
  });

  test("tool.rejected flags the part as rejected with a reason (no tool_call_id)", () => {
    const parts = fold([{ type: "tool.rejected", tool_name: "writeThing", reason: "gate denied" }]);
    const tc = parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.kind).toBe("tool_call");
    expect(tc.name).toBe("writeThing");
    expect(tc.rejected).toBe(true);
    expect(tc.error).toBe("gate denied");
  });

  test("thinking streams then completes (upsert, not duplicate)", () => {
    const parts = fold([
      { type: "thinking", content: "let me " },
      { type: "thinking", content: "check" },
      { type: "thinking.complete", content: "let me check" },
    ]);
    expect(parts).toEqual([{ kind: "thinking", content: "let me check", complete: true }]);
  });

  test("error event appends an error part (snake_case error_type)", () => {
    const parts = fold([
      { type: "error", message: "kaboom", error_type: "ModelError", recoverable: false },
    ]);
    expect(parts).toEqual([{ kind: "error", errorType: "ModelError", message: "kaboom" }]);
  });

  test("message.complete yields model + token metadata, not a part", () => {
    const r = applyParts([], {
      type: "message.complete",
      content: "final",
      model: "sonnet",
      input_tokens: 120,
      output_tokens: 35,
    });
    expect(r.parts).toEqual([]);
    expect(r.meta).toEqual({ model: "sonnet", inputTokens: 120, outputTokens: 35 });
  });
});

describe("eventsToAssistantMessage", () => {
  test("interleaves thinking, text, tool call, text in seq order", () => {
    const msg = eventsToAssistantMessage("a", [
      { type: "thinking", content: "plan", seq: 1 },
      { type: "thinking.complete", content: "plan", seq: 2 },
      { type: "message.delta", delta: "First ", seq: 3 },
      { type: "tool.start", tool_call_id: "t1", tool_name: "add", arguments: { a: 1 }, seq: 4 },
      { type: "tool.end", tool_call_id: "t1", tool_name: "add", result: 3, duration_ms: 5, seq: 5 },
      { type: "message.delta", delta: "done", seq: 6 },
      { type: "message.complete", model: "opus", input_tokens: 9, output_tokens: 2, seq: 7 },
    ]);
    expect(msg.parts.map((p) => p.kind)).toEqual(["thinking", "text", "tool_call", "text"]);
    expect((msg.parts[1] as Extract<Part, { kind: "text" }>).content).toBe("First ");
    expect((msg.parts[3] as Extract<Part, { kind: "text" }>).content).toBe("done");
    expect(msg.model).toBe("opus");
    expect(msg.outputTokens).toBe(2);
  });

  test("reads the PERSISTED row shape (snake_case columns + payload_json)", () => {
    const msg = eventsToAssistantMessage("a", [
      {
        type: "tool.start",
        seq: 1,
        tool_call_id: "t1",
        tool_name: "fetchRows",
        args_json: '{"limit":5}',
        payload_json: '{"toolName":"fetchRows","toolCallId":"t1","arguments":{"limit":5}}',
        run_id: "r1",
      },
      {
        type: "tool.end",
        seq: 2,
        tool_call_id: "t1",
        tool_name: "fetchRows",
        result_json: "[1,2,3]",
        duration_ms: 17,
        payload_json: '{"toolName":"fetchRows","result":[1,2,3],"durationMs":17}',
        run_id: "r1",
      },
    ]);
    const tc = msg.parts[0] as Extract<Part, { kind: "tool_call" }>;
    expect(tc.kind).toBe("tool_call");
    expect(tc.name).toBe("fetchRows");
    expect(tc.arguments).toEqual({ limit: 5 });
    expect(tc.result).toEqual([1, 2, 3]);
    expect(tc.durationMs).toBe(17);
  });

  test("sorts out-of-order events by seq before folding", () => {
    const msg = eventsToAssistantMessage("a", [
      { type: "message.delta", delta: "B", seq: 2 },
      { type: "message.delta", delta: "A", seq: 1 },
    ]);
    expect((msg.parts[0] as Extract<Part, { kind: "text" }>).content).toBe("AB");
  });
});
