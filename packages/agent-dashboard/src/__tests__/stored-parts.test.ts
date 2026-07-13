/**
 * `chat/stored-parts.ts` — the persisted-session -> `Part`/`ChatMessage`
 * adapter (port-map §4.2.2) the Console's session replay renders through.
 */
import { describe, expect, it } from "vitest";
import type { ConversationMessage, ConversationMessagePart } from "../api/types";
import {
  storedMessageToChatMessage,
  storedMessagesToChat,
  storedPartsToParts,
} from "../chat/stored-parts";

function mkPart(overrides: Partial<ConversationMessagePart>): ConversationMessagePart {
  return {
    id: "part-1",
    messageId: "msg-1",
    type: "text",
    content: null,
    metadata: null,
    position: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function mkMessage(overrides: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    kind: "request",
    runId: null,
    inputTokens: 0,
    outputTokens: 0,
    content: null,
    metadata: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("storedPartsToParts", () => {
  it("maps user_prompt and text to a `text` Part — today's ONLY actually-persisted types", () => {
    const parts = [
      mkPart({ id: "p1", type: "user_prompt", content: "hello", position: 0 }),
      mkPart({ id: "p2", type: "text", content: "hi there", position: 1 }),
    ];
    expect(storedPartsToParts(parts)).toEqual([
      { kind: "text", content: "hello" },
      { kind: "text", content: "hi there" },
    ]);
  });

  it("sorts by position before folding, regardless of array order", () => {
    const parts = [
      mkPart({ id: "p2", type: "text", content: "second", position: 1 }),
      mkPart({ id: "p1", type: "text", content: "first", position: 0 }),
    ];
    expect(storedPartsToParts(parts).map((p) => (p.kind === "text" ? p.content : null))).toEqual([
      "first",
      "second",
    ]);
  });

  it("folds a tool_call + matching tool_result (by tool_call_id) into ONE tool_call Part", () => {
    const parts = [
      mkPart({
        id: "p1",
        type: "tool_call",
        position: 0,
        metadata: { tool_call_id: "tc1", tool_name: "search", arguments: { q: "hi" } },
      }),
      mkPart({
        id: "p2",
        type: "tool_result",
        position: 1,
        content: "2 rows",
        metadata: { tool_call_id: "tc1", duration_ms: 42 },
      }),
    ];
    const result = storedPartsToParts(parts);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "tool_call",
      id: "tc1",
      name: "search",
      arguments: { q: "hi" },
      result: "2 rows",
      error: undefined,
      durationMs: 42,
    });
  });

  it("a tool_result with no matching tool_call falls back to a standalone Part keyed by its own id", () => {
    const parts = [
      mkPart({
        id: "orphan",
        type: "tool_result",
        position: 0,
        content: "late result",
        metadata: { tool_name: "fetch" },
      }),
    ];
    const result = storedPartsToParts(parts);
    expect(result).toEqual([
      {
        kind: "tool_call",
        id: "orphan",
        name: "fetch",
        arguments: undefined,
        result: "late result",
        error: undefined,
        durationMs: undefined,
      },
    ]);
  });

  it("maps agent_step metadata to an agent_step Part with empty children (stored parts are flat)", () => {
    const parts = [
      mkPart({
        id: "p1",
        type: "agent_step",
        position: 0,
        metadata: { span_id: "s1", step_name: "curate", agent_name: "curator", duration_ms: 12 },
      }),
    ];
    expect(storedPartsToParts(parts)).toEqual([
      {
        kind: "agent_step",
        id: "s1",
        name: "curate",
        agentName: "curator",
        arguments: undefined,
        result: undefined,
        error: undefined,
        durationMs: 12,
        children: [],
      },
    ]);
  });

  it("degrades an unknown part type to a neutral text Part naming the type — never drops it", () => {
    const parts = [mkPart({ id: "p1", type: "mystery", position: 0, content: "raw payload" })];
    expect(storedPartsToParts(parts)).toEqual([{ kind: "text", content: "[mystery] raw payload" }]);
  });

  it("an unknown part type with no content but metadata renders the JSON-stringified metadata", () => {
    const parts = [
      mkPart({ id: "p1", type: "mystery", position: 0, content: null, metadata: { a: 1 } }),
    ];
    expect(storedPartsToParts(parts)).toEqual([{ kind: "text", content: '[mystery] {"a":1}' }]);
  });

  it("an unknown part type with neither content nor metadata still names the type", () => {
    const parts = [mkPart({ id: "p1", type: "mystery", position: 0 })];
    expect(storedPartsToParts(parts)).toEqual([{ kind: "text", content: "[mystery]" }]);
  });

  // WI-3 (#226): the reader now HAS a state_delta case — the WI-2 old-reader
  // degradation pin is superseded for buildable rows (unknown types keep the
  // labeled-text contract above; so do state_delta rows with no event name).
  it("rebuilds a persisted state_delta part (#226) into the same Part the live fold builds", () => {
    // Metadata shape mirrors what `Conversation._persistExchange` writes: the
    // wire event name + the canonical snake_case SSE payload, verbatim.
    const parts = [
      mkPart({
        id: "p1",
        type: "state_delta",
        position: 0,
        metadata: {
          event: "backpack.drop",
          key: "backpack.observations",
          origin: "explicit",
          ordinal: 1,
          accepted: 2,
          merged: 0,
          skipped: 0,
          indexes: [1, 2],
          size_before: 0,
          size_after: 2,
          previews: [{ index: 1, op: "added", preview: "obs · one (preview only)" }],
          previews_omitted: 1,
          tool_call_id: "t1",
        },
      }),
    ];
    expect(storedPartsToParts(parts)).toEqual([
      {
        kind: "state_delta",
        op: "drop",
        key: "backpack.observations",
        origin: "explicit",
        ordinal: 1,
        toolCallId: "t1",
        accepted: 2,
        merged: 0,
        skipped: 0,
        indexes: [1, 2],
        sizeBefore: 0,
        sizeAfter: 2,
        previews: [{ index: 1, op: "added", preview: "obs · one (preview only)" }],
        previewsOmitted: 1,
        dropSeq: 0,
      },
    ]);
  });

  it("rebuilds a redacted innate scratchpad.read (#226) — frame survives, text stays gone", () => {
    // Runtime `toStateDeltaPart` strips the preview (the exact injected prompt
    // text follows thinking's posture: streamed live, never stored) and marks
    // `preview_redacted` explicitly.
    const parts = [
      mkPart({
        id: "p1",
        type: "state_delta",
        position: 0,
        metadata: {
          event: "scratchpad.read",
          key: "agents.correlate",
          origin: "innate",
          ordinal: 4,
          preview_redacted: true,
        },
      }),
    ];
    const [frame] = storedPartsToParts(parts);
    expect(frame).toEqual({
      kind: "state_delta",
      op: "read",
      key: "agents.correlate",
      scope: "scratchpad",
      origin: "innate",
      ordinal: 4,
      previewRedacted: true,
    });
  });

  it("a state_delta row with no buildable event name still degrades to labeled text", () => {
    const parts = [
      mkPart({ id: "p1", type: "state_delta", position: 0, metadata: { ordinal: 1 } }),
    ];
    expect(storedPartsToParts(parts)).toEqual([
      { kind: "text", content: '[state_delta] {"ordinal":1}' },
    ]);
  });
});

describe("storedMessageToChatMessage", () => {
  it("maps kind:request -> role:user and kind:response -> role:assistant", () => {
    const req = mkMessage({ kind: "request" });
    const res = mkMessage({ kind: "response", id: "msg-2" });
    expect(storedMessageToChatMessage(req, []).role).toBe("user");
    expect(storedMessageToChatMessage(res, []).role).toBe("assistant");
  });

  it("carries id, at (parsed createdAt), and token counts through", () => {
    const msg = mkMessage({
      id: "msg-9",
      kind: "response",
      inputTokens: 10,
      outputTokens: 5,
      createdAt: "2026-07-01T12:00:00.000Z",
    });
    const chatMsg = storedMessageToChatMessage(msg, []);
    expect(chatMsg.id).toBe("msg-9");
    expect(chatMsg.inputTokens).toBe(10);
    expect(chatMsg.outputTokens).toBe(5);
    expect(chatMsg.at).toBe(Date.parse("2026-07-01T12:00:00.000Z"));
  });
});

describe("storedMessagesToChat", () => {
  it("sorts messages ASC by createdAt and attaches each message's own parts", () => {
    const first = mkMessage({ id: "m1", kind: "request", createdAt: "2026-07-01T00:00:01.000Z" });
    const second = mkMessage({
      id: "m2",
      kind: "response",
      createdAt: "2026-07-01T00:00:02.000Z",
    });
    const partsByMessageId = new Map<string, ConversationMessagePart[]>([
      ["m1", [mkPart({ id: "p1", messageId: "m1", type: "user_prompt", content: "hi" })]],
      ["m2", [mkPart({ id: "p2", messageId: "m2", type: "text", content: "hello" })]],
    ]);
    // pass out of order — the ASC sort must still land them first, second.
    const result = storedMessagesToChat([second, first], partsByMessageId);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result[0]?.parts).toEqual([{ kind: "text", content: "hi" }]);
    expect(result[1]?.parts).toEqual([{ kind: "text", content: "hello" }]);
  });

  it("a message with no entry in the parts map gets an empty parts array, not a crash", () => {
    const msg = mkMessage({ id: "m1" });
    const result = storedMessagesToChat([msg], new Map());
    expect(result[0]?.parts).toEqual([]);
  });
});
