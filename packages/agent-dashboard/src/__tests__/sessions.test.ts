/**
 * `lib/sessions.ts` — the Console SessionsMenu's agent-filtering + sort logic
 * (port-map §4.2.1), pulled out of `ChatPage` so it's unit-testable without
 * rendering the whole chat page (`lib/runPicker.ts`'s precedent).
 */
import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../api/types";
import { sessionsForAgent } from "../lib/sessions";

function mkConv(overrides: Partial<ConversationSummary>): ConversationSummary {
  return {
    conversationId: "c1",
    agentName: "retrieval-analyst",
    messageCount: 2,
    tokenCount: 100,
    startedAt: "2026-07-01T00:00:00Z",
    lastMessageAt: "2026-07-01T00:01:00Z",
    status: "active",
    ...overrides,
  };
}

describe("sessionsForAgent", () => {
  const conversations: ConversationSummary[] = [
    mkConv({
      conversationId: "a-old",
      agentName: "retrieval-analyst",
      startedAt: "2026-07-01T00:00:00Z",
      lastMessageAt: "2026-07-01T00:01:00Z",
    }),
    mkConv({
      conversationId: "a-new",
      agentName: "retrieval-analyst",
      startedAt: "2026-07-03T00:00:00Z",
      lastMessageAt: "2026-07-03T00:05:00Z",
    }),
    mkConv({
      conversationId: "b-1",
      agentName: "curator",
      startedAt: "2026-07-04T00:00:00Z",
      lastMessageAt: "2026-07-04T00:01:00Z",
    }),
  ];

  it("filters to only the selected agent's conversations", () => {
    const result = sessionsForAgent(conversations, "retrieval-analyst");
    expect(result.map((c) => c.conversationId)).toEqual(["a-new", "a-old"]);
  });

  it("sorts newest-first by lastMessageAt", () => {
    const result = sessionsForAgent(conversations, "retrieval-analyst");
    expect(result[0]?.conversationId).toBe("a-new");
    expect(result[1]?.conversationId).toBe("a-old");
  });

  it("falls back to startedAt when lastMessageAt is absent (no messages yet)", () => {
    const noMessages = [
      mkConv({
        conversationId: "fresh",
        agentName: "retrieval-analyst",
        startedAt: "2026-07-05T00:00:00Z",
        lastMessageAt: undefined,
      }),
      mkConv({
        conversationId: "a-new",
        agentName: "retrieval-analyst",
        startedAt: "2026-07-03T00:00:00Z",
        lastMessageAt: "2026-07-03T00:05:00Z",
      }),
    ];
    const result = sessionsForAgent(noMessages, "retrieval-analyst");
    expect(result.map((c) => c.conversationId)).toEqual(["fresh", "a-new"]);
  });

  it("returns an empty array when no agent is selected", () => {
    expect(sessionsForAgent(conversations, null)).toEqual([]);
    expect(sessionsForAgent(conversations, undefined)).toEqual([]);
  });

  it("returns an empty array when the agent has no sessions", () => {
    expect(sessionsForAgent(conversations, "nobody")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const copy = [...conversations];
    sessionsForAgent(conversations, "retrieval-analyst");
    expect(conversations).toEqual(copy);
  });
});
