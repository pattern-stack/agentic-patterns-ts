/**
 * #480 — conversation continuation across server restarts.
 *
 * Two halves, tested end-to-end against a real `InMemoryConversationStore`
 * (the `conversations.test.ts` idiom — the wiring, not a mock, is under test):
 *
 * 1. IDENTITY UNIFICATION: with a store configured, `POST /conversations`
 *    pre-creates the durable row and returns ITS id — list/read/reply agree
 *    on one identity, and a multi-turn chat lands on ONE row instead of
 *    fragmenting across run-keyed rows.
 * 2. REHYDRATION: `POST /conversations/:id/messages` against a fresh server
 *    (new registry map, same store) restores the conversation — history is
 *    rebuilt from stored messages and threaded into `RunOptions.messageHistory`,
 *    later exchanges append to the SAME durable row, and legacy rows written
 *    by `Conversation._persistExchange`'s lazy path (display-name only, no
 *    metadata) fall back to role-name registration matching.
 */

import type { AgentEvent, RunOptions } from "@agentic-patterns/runtime";
import { AgentEventBus, InMemoryConversationStore, createEvent } from "@agentic-patterns/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AgentRegistration } from "../config.js";
import { type ConversationEntry, conversationRoutes } from "../routes/conversations.js";

const mockAgent = {
  getModel: () => "test-model",
  getTools: () => [],
  renderInitialPrompt: () => "Test prompt",
  role: { name: "TestAgent" },
};

function makeStreamingRunner(assistantText: string) {
  const captured: { lastOptions?: RunOptions } = {};
  return {
    captured,
    async run() {
      throw new Error("run() not used in these tests");
    },
    async *stream(
      _agent: unknown,
      _message: string,
      options?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      captured.lastOptions = options;
      const traceId = options?.traceId ?? "trace";
      yield createEvent("agent.message.start", { traceId, runId: "run-1", agentName: "t" });
      yield createEvent("agent.message.complete", {
        traceId,
        runId: "run-1",
        content: assistantText,
        inputTokens: 10,
        outputTokens: 5,
        model: "test-model",
      });
    },
  };
}

function mkApp(store: InMemoryConversationStore, reg: AgentRegistration): Hono {
  const app = new Hono();
  app.route(
    "/",
    conversationRoutes([reg], new Map<string, ConversationEntry>(), new AgentEventBus(), store),
  );
  return app;
}

async function drainSSE(res: Response): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

async function sendMessage(app: Hono, convId: string, content: string): Promise<Response> {
  const res = await app.request(`/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (res.status === 200) await drainSSE(res);
  return res;
}

describe("#480 conversation identity + rehydration", () => {
  it("POST /conversations returns the durable row id and stamps rehydration metadata", async () => {
    const store = new InMemoryConversationStore();
    const reg: AgentRegistration = {
      id: "streamer",
      name: "Streamer",
      agent: mockAgent,
      runner: makeStreamingRunner("hi"),
    };
    const app = mkApp(store, reg);

    const res = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "streamer" }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const durable = await store.getConversation(id);
    expect(durable).not.toBeNull();
    expect(durable?.metadata.agentId).toBe("streamer");
  });

  it("a multi-turn chat lands on ONE durable row (no run-keyed fragmentation)", async () => {
    const store = new InMemoryConversationStore();
    const reg: AgentRegistration = {
      id: "streamer",
      name: "Streamer",
      agent: mockAgent,
      runner: makeStreamingRunner("hi"),
    };
    const app = mkApp(store, reg);

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "streamer" }),
    });
    const { id } = (await createRes.json()) as { id: string };

    expect((await sendMessage(app, id, "turn one")).status).toBe(200);
    expect((await sendMessage(app, id, "turn two")).status).toBe(200);

    const summaries = await store.listConversations();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.conversationId).toBe(id);
    const messages = await store.getMessages(id);
    expect(messages.map((m) => m.kind)).toEqual(["request", "response", "request", "response"]);
  });

  it("continues a persisted conversation on a fresh server, with history threaded", async () => {
    const store = new InMemoryConversationStore();
    const runner1 = makeStreamingRunner("first answer");
    const reg1: AgentRegistration = {
      id: "streamer",
      name: "Streamer",
      agent: mockAgent,
      runner: runner1,
    };
    const app1 = mkApp(store, reg1);

    const createRes = await app1.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "streamer" }),
    });
    const { id } = (await createRes.json()) as { id: string };
    expect((await sendMessage(app1, id, "remember the passphrase ZEBRA-7741")).status).toBe(200);

    // "Restart": fresh registry map + fresh runner, same store.
    const runner2 = makeStreamingRunner("second answer");
    const reg2: AgentRegistration = {
      id: "streamer",
      name: "Streamer",
      agent: mockAgent,
      runner: runner2,
    };
    const app2 = mkApp(store, reg2);

    expect((await sendMessage(app2, id, "what was the passphrase?")).status).toBe(200);

    // The rehydrated turn ran with the persisted first exchange as history.
    const history = runner2.captured.lastOptions?.messageHistory;
    expect(history).toBeDefined();
    expect(history).toHaveLength(2);
    expect(JSON.stringify(history)).toContain("ZEBRA-7741");
    expect(JSON.stringify(history)).toContain("first answer");

    // And it appended to the SAME durable row — still one conversation.
    const summaries = await store.listConversations();
    expect(summaries).toHaveLength(1);
    const messages = await store.getMessages(id);
    expect(messages).toHaveLength(4);
  });

  it("rehydrates a legacy row (display-name only, no metadata) via role-name matching", async () => {
    const store = new InMemoryConversationStore();
    // Simulate a pre-#480 row: minted by Conversation's lazy path — agentName
    // is the ROLE name, metadata is empty.
    const legacy = await store.createConversation("TestAgent", "test-model");
    await store.addMessage(legacy.id, "request", [{ type: "user_prompt", content: "old turn" }]);
    await store.addMessage(legacy.id, "response", [{ type: "text", content: "old answer" }], {
      inputTokens: 3,
      outputTokens: 2,
    });

    const runner = makeStreamingRunner("continued");
    const reg: AgentRegistration = {
      id: "streamer",
      name: "Streamer",
      agent: mockAgent,
      runner,
    };
    const app = mkApp(store, reg);

    expect((await sendMessage(app, legacy.id, "continue please")).status).toBe(200);
    const history = runner.captured.lastOptions?.messageHistory;
    expect(history).toHaveLength(2);
    expect(JSON.stringify(history)).toContain("old answer");
  });

  it("keeps the 404 for ids unknown to both registry and store", async () => {
    const store = new InMemoryConversationStore();
    const reg: AgentRegistration = {
      id: "streamer",
      name: "Streamer",
      agent: mockAgent,
      runner: makeStreamingRunner("hi"),
    };
    const app = mkApp(store, reg);

    const res = await sendMessage(app, "no-such-conversation", "hello?");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Conversation not found" });
  });

  it("404s with a named error when the persisted agent is no longer registered", async () => {
    const store = new InMemoryConversationStore();
    const orphan = await store.createConversation("GhostAgent", "test-model");
    const reg: AgentRegistration = {
      id: "streamer",
      name: "Streamer",
      agent: mockAgent,
      runner: makeStreamingRunner("hi"),
    };
    const app = mkApp(store, reg);

    const res = await sendMessage(app, orphan.id, "anyone home?");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("GhostAgent");
    expect(body.error).toContain("not registered");
  });
});
