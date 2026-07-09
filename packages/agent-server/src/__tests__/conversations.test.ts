/**
 * Conversation READ routes test (spec `.ai-docs/stacks/playground-upgrades/
 * port-map.md` § 4.1 — the phantom-endpoint fix): GET /admin/conversations,
 * GET /conversations/:id, GET /conversations/:id/messages, GET
 * /messages/:id/parts. Mounts only `conversationRoutes` (the `runs.test.ts`
 * idiom) against a real `InMemoryConversationStore` so the wiring — not a
 * mock — is what's under test. Also covers the store→Conversation wiring
 * (`store: config.store`, previously accepted and never used) and the
 * runId/traceId threading fix end-to-end through the SSE stream route.
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

const RUNNER_RUN_ID = "runner-internal-run-id";

/** Mirrors AgentRunner's real traceId/runId contract (conversation.test.ts precedent). */
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
      const effectiveTraceId = options?.traceId ?? RUNNER_RUN_ID;
      yield createEvent("agent.message.start", {
        traceId: effectiveTraceId,
        runId: RUNNER_RUN_ID,
        agentName: "test-agent",
      });
      yield createEvent("agent.message.complete", {
        traceId: effectiveTraceId,
        runId: RUNNER_RUN_ID,
        content: assistantText,
        inputTokens: 10,
        outputTokens: 5,
        model: "test-model",
      });
    },
  };
}

function mkApp(opts?: {
  store?: InMemoryConversationStore;
  agents?: AgentRegistration[];
  eventBus?: AgentEventBus;
}): Hono {
  const app = new Hono();
  app.route(
    "/",
    conversationRoutes(
      opts?.agents ?? [],
      new Map<string, ConversationEntry>(),
      opts?.eventBus ?? new AgentEventBus(),
      opts?.store,
    ),
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

describe("conversation read routes", () => {
  describe("GET /admin/conversations", () => {
    it("503s with a hint when no store is configured", async () => {
      const app = mkApp();
      const res = await app.request("/admin/conversations");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; hint: string };
      expect(body.error).toBe("persistence not configured");
      expect(body.hint).toContain("ap playground");
    });

    it("lists conversations newest first as ConversationSummary[]", async () => {
      const store = new InMemoryConversationStore();
      const a = await store.createConversation("agent-a", "model-a");
      await new Promise((r) => setTimeout(r, 2));
      const b = await store.createConversation("agent-b", "model-b");
      await store.addMessage(a.id, "request", [{ type: "user_prompt", content: "hi" }]);
      await store.addMessage(a.id, "response", [{ type: "text", content: "hello" }], {
        inputTokens: 10,
        outputTokens: 5,
      });

      const app = mkApp({ store });
      const res = await app.request("/admin/conversations");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        conversationId: string;
        agentName: string;
        messageCount: number;
        tokenCount: number;
        startedAt: string;
        lastMessageAt?: string;
        status: string;
      }>;
      expect(body.map((s) => s.conversationId)).toEqual([b.id, a.id]);
      const summaryA = body.find((s) => s.conversationId === a.id);
      expect(summaryA?.messageCount).toBe(2);
      expect(summaryA?.tokenCount).toBe(15);
      expect(summaryA?.status).toBe("active");
      expect(typeof summaryA?.startedAt).toBe("string");
      expect(typeof summaryA?.lastMessageAt).toBe("string");
    });
  });

  describe("GET /conversations/:id", () => {
    it("503s with a hint when no store is configured", async () => {
      const app = mkApp();
      const res = await app.request("/conversations/some-id");
      expect(res.status).toBe(503);
    });

    it("404s an unknown conversation id", async () => {
      const store = new InMemoryConversationStore();
      const app = mkApp({ store });
      const res = await app.request("/conversations/does-not-exist");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("does-not-exist");
    });

    it("returns ConversationDetail with computed aggregates and honest nulls", async () => {
      const store = new InMemoryConversationStore();
      const conv = await store.createConversation("TestAgent", "gpt-4");
      await store.addMessage(conv.id, "request", [{ type: "user_prompt", content: "hi" }]);
      await store.addMessage(conv.id, "response", [{ type: "text", content: "hello" }], {
        inputTokens: 10,
        outputTokens: 5,
      });

      const app = mkApp({ store });
      const res = await app.request(`/conversations/${conv.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        agentConfigId: string | null;
        status: string;
        agentName: string;
        model: string;
        tokenCount: number;
        messageCount: number;
        startedAt: string | null;
        completedAt: string | null;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      };
      expect(body.id).toBe(conv.id);
      expect(body.agentName).toBe("TestAgent");
      expect(body.model).toBe("gpt-4");
      expect(body.messageCount).toBe(2);
      expect(body.tokenCount).toBe(15);
      expect(body.status).toBe("active");
      // Fields with no equivalent concept in this runtime's ConversationStore
      // are honestly null, never invented.
      expect(body.agentConfigId).toBeNull();
      expect(body.completedAt).toBeNull();
      expect(body.error).toBeNull();
      expect(typeof body.startedAt).toBe("string");
      expect(typeof body.createdAt).toBe("string");
      expect(typeof body.updatedAt).toBe("string");
    });
  });

  describe("GET /conversations/:id/messages", () => {
    it("503s with a hint when no store is configured", async () => {
      const app = mkApp();
      const res = await app.request("/conversations/some-id/messages");
      expect(res.status).toBe(503);
    });

    it("returns an empty array (not 404) for an unknown conversation id", async () => {
      const store = new InMemoryConversationStore();
      const app = mkApp({ store });
      const res = await app.request("/conversations/does-not-exist/messages");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("returns ConversationMessage[] ASC with derived content, runId, and null metadata", async () => {
      const store = new InMemoryConversationStore();
      const conv = await store.createConversation("Agent", "model");
      await store.addMessage(conv.id, "request", [{ type: "user_prompt", content: "hi" }], {
        runId: "run-1",
      });
      await store.addMessage(conv.id, "response", [{ type: "text", content: "hello" }], {
        runId: "run-1",
        inputTokens: 10,
        outputTokens: 5,
      });

      const app = mkApp({ store });
      const res = await app.request(`/conversations/${conv.id}/messages`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        id: string;
        conversationId: string;
        kind: string;
        runId: string | null;
        inputTokens: number;
        outputTokens: number;
        content: string | null;
        metadata: unknown;
        createdAt: string;
        updatedAt: string;
      }>;
      expect(body).toHaveLength(2);
      expect(body.map((m) => m.kind)).toEqual(["request", "response"]);
      expect(body[0]?.content).toBe("hi");
      expect(body[1]?.content).toBe("hello");
      expect(body.every((m) => m.runId === "run-1")).toBe(true);
      expect(body.every((m) => m.metadata === null)).toBe(true);
      // The wire type omits the full parts array — messages list, not detail.
      expect(body[0]).not.toHaveProperty("parts");
    });
  });

  describe("GET /messages/:id/parts", () => {
    it("503s with a hint when no store is configured", async () => {
      const app = mkApp();
      const res = await app.request("/messages/some-id/parts");
      expect(res.status).toBe(503);
    });

    it("returns an empty array (not 404) for an unknown message id", async () => {
      const store = new InMemoryConversationStore();
      const app = mkApp({ store });
      const res = await app.request("/messages/does-not-exist/parts");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("returns ConversationMessagePart[] ASC by position", async () => {
      const store = new InMemoryConversationStore();
      const conv = await store.createConversation("Agent", "model");
      const msg = await store.addMessage(conv.id, "request", [
        { type: "user_prompt", content: "Hello" },
        { type: "context", content: "extra", metadata: { source: "test" } },
      ]);

      const app = mkApp({ store });
      const res = await app.request(`/messages/${msg.id}/parts`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        id: string;
        messageId: string;
        type: string;
        content: string | null;
        metadata: Record<string, unknown> | null;
        position: number;
        createdAt: string;
        updatedAt: string;
      }>;
      expect(body.map((p) => p.position)).toEqual([0, 1]);
      expect(body.map((p) => p.type)).toEqual(["user_prompt", "context"]);
      expect(body[1]?.metadata).toEqual({ source: "test" });
      expect(typeof body[0]?.createdAt).toBe("string");
    });
  });

  describe("store wiring: POST /conversations passes config.store into Conversation", () => {
    it("persists request + response messages with the runner's runId, and the traceId joins conversation + run events", async () => {
      const store = new InMemoryConversationStore();
      const runner = makeStreamingRunner("hi back");
      const reg: AgentRegistration = { id: "streamer", name: "Streamer", agent: mockAgent, runner };
      const eventBus = new AgentEventBus();

      const app = mkApp({ store, agents: [reg], eventBus });

      const createRes = await app.request("/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "streamer" }),
      });
      expect(createRes.status).toBe(201);
      const { id: convId } = (await createRes.json()) as { id: string };

      const streamRes = await app.request(`/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      });
      expect(streamRes.status).toBe(200);
      await drainSSE(streamRes);

      // traceId threading: the runner received a traceId distinct from its
      // own internally-generated runId (the pre-fix fallback).
      const traceId = runner.captured.lastOptions?.traceId;
      expect(traceId).toBeTruthy();
      expect(traceId).not.toBe(RUNNER_RUN_ID);

      // `Conversation.id` (returned by POST /conversations, used for the live
      // SSE-continuation path) is a separate in-process session id from the
      // STORE's own persisted conversation id (lazily created by
      // `_persistExchange` on first write) — look the persisted row up via
      // `listConversations()`, exactly as the dashboard's `/admin/conversations`
      // → `/conversations/:id` navigation does.
      void convId;
      const [persisted] = await store.listConversations();
      expect(persisted).toBeDefined();

      // runId threading: both persisted messages carry the runner's runId.
      const messages = await store.getMessages(persisted!.conversationId);
      expect(messages).toHaveLength(2);
      expect(messages.every((m) => m.runId === RUNNER_RUN_ID)).toBe(true);
      expect(messages[0]?.kind).toBe("request");
      expect(messages[1]?.kind).toBe("response");
      expect(messages[1]?.parts[0]?.content).toBe("hi back");
    });
  });
});
