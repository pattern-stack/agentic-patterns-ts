/**
 * `exchangesFromMessages` (#480) — the inverse of `_persistExchange`.
 *
 * The round-trip test is the load-bearing one: it persists through a real
 * `InMemoryConversationStore` and rebuilds, so the two halves are pinned to
 * each other rather than to a hand-written fixture that could drift from what
 * `_persistExchange` actually writes.
 */

import { describe, expect, it } from "vitest";
import { Conversation } from "../conversation.js";
import { exchangesFromMessages } from "../rehydrate.js";
import { InMemoryConversationStore } from "../store.js";
import type { StoredMessage } from "../store.js";

/** Minimal `StoredMessage` builder — only the fields the zip actually reads. */
function msg(
  kind: "request" | "response",
  parts: Array<{ type: string; content?: string }>,
  extra?: { inputTokens?: number; outputTokens?: number; runId?: string },
): StoredMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    conversationId: "c1",
    kind,
    inputTokens: extra?.inputTokens ?? 0,
    outputTokens: extra?.outputTokens ?? 0,
    createdAt: new Date("2026-08-12T00:00:00.000Z"),
    parts: parts.map((p, i) => ({
      id: `p-${i}`,
      messageId: "m",
      type: p.type,
      content: p.content,
      metadata: {},
      position: i,
    })),
    ...(extra?.runId !== undefined ? { runId: extra.runId } : {}),
  };
}

describe("exchangesFromMessages", () => {
  it("returns no exchanges for an empty store", () => {
    expect(exchangesFromMessages([])).toEqual([]);
  });

  it("zips request/response pairs into numbered exchanges", () => {
    const exchanges = exchangesFromMessages([
      msg("request", [{ type: "user_prompt", content: "hello" }]),
      msg("response", [{ type: "text", content: "hi there" }], {
        inputTokens: 10,
        outputTokens: 5,
      }),
      msg("request", [{ type: "user_prompt", content: "again" }]),
      msg("response", [{ type: "text", content: "sure" }], { inputTokens: 20, outputTokens: 7 }),
    ]);

    expect(exchanges).toHaveLength(2);
    expect(exchanges.map((e) => [e.number, e.user, e.assistant])).toEqual([
      [1, "hello", "hi there"],
      [2, "again", "sure"],
    ]);
    // Usage lives on the response message, not the request.
    expect(exchanges[0]?.inputTokens).toBe(10);
    expect(exchanges[0]?.outputTokens).toBe(5);
    expect(exchanges[1]?.inputTokens).toBe(20);
  });

  it("carries runId through so the resumed history keeps its trace link", () => {
    const exchanges = exchangesFromMessages([
      msg("request", [{ type: "user_prompt", content: "q" }]),
      msg("response", [{ type: "text", content: "a" }], { runId: "run-7" }),
    ]);
    expect(exchanges[0]?.runId).toBe("run-7");
  });

  it("drops a trailing unpaired request — a resumed run must not send two user turns in a row", () => {
    const exchanges = exchangesFromMessages([
      msg("request", [{ type: "user_prompt", content: "answered" }]),
      msg("response", [{ type: "text", content: "reply" }]),
      // The process died mid-turn: the request landed, the response never did.
      msg("request", [{ type: "user_prompt", content: "never answered" }]),
    ]);

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.user).toBe("answered");
  });

  it("keeps numbering dense across a dropped turn", () => {
    const exchanges = exchangesFromMessages([
      msg("request", [{ type: "user_prompt", content: "one" }]),
      // Two consecutive requests — the first is unanswered and drops out.
      msg("request", [{ type: "user_prompt", content: "two" }]),
      msg("response", [{ type: "text", content: "answer to two" }]),
    ]);

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.number).toBe(1);
    expect(exchanges[0]?.user).toBe("two");
  });

  it("skips a response with no preceding request", () => {
    expect(exchangesFromMessages([msg("response", [{ type: "text", content: "orphan" }])])).toEqual(
      [],
    );
  });

  it("excludes state_delta frames from replayed text", () => {
    const exchanges = exchangesFromMessages([
      msg("request", [{ type: "user_prompt", content: "go" }]),
      // `_persistExchange` writes state_delta parts with NO content, before
      // the terminal text part — they must not become prompt text on replay.
      msg("response", [
        { type: "state_delta" },
        { type: "state_delta" },
        { type: "text", content: "the answer" },
      ]),
    ]);

    expect(exchanges[0]?.assistant).toBe("the answer");
  });

  it("round-trips a real persisted conversation back into replayable history", async () => {
    const store = new InMemoryConversationStore();
    const agent = {
      getModel: () => "test-model",
      getTools: () => [],
      renderInitialPrompt: () => "",
      role: { name: "RoundTrip" },
    };
    let n = 0;
    const runner = {
      async run() {
        n += 1;
        return { response: `answer-${n}`, inputTokens: n, outputTokens: n * 2 };
      },
    };

    const conversation = new Conversation(agent as never, runner as never, { store });
    await conversation.send("first");
    await conversation.send("second");

    const rebuilt = exchangesFromMessages(await store.getMessages(conversation.id));

    // The rebuilt history is equivalent to the live one on every field that
    // survives persistence (invocationId is per-run and deliberately not).
    expect(rebuilt.map((e) => [e.number, e.user, e.assistant])).toEqual(
      conversation.history.map((e) => [e.number, e.user, e.assistant]),
    );
    expect(rebuilt.map((e) => [e.inputTokens, e.outputTokens])).toEqual([
      [1, 2],
      [2, 4],
    ]);
  });
});
