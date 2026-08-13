/**
 * Conversation continuity (#480) — the reported bug and its fix.
 *
 * The bug: `POST /conversations` returned an in-memory ROUTE id while the
 * store persisted the conversation under its own DURABLE id. The two could
 * never be equal, so a conversation listed by `GET /conversations` 404'd on
 * reply, `GET /:id/messages` returned `[]` for the id you could actually
 * write to, and a server restart orphaned every conversation permanently.
 *
 * A "restart" is simulated by clearing the in-memory registry while keeping
 * the store — exactly what a process bounce does, and the only thing that
 * distinguishes a resumable conversation from an unresumable one.
 */

import type { AgentEvent, RunOptions } from "@agentic-patterns/runtime";
import { AgentEventBus, InMemoryConversationStore, createEvent } from "@agentic-patterns/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentRegistration } from "../config.js";
import { type ConversationEntry, conversationRoutes } from "../routes/conversations.js";

const mockAgent = {
  getModel: () => "test-model",
  getTools: () => [],
  renderInitialPrompt: () => "Test prompt",
  role: { name: "TestAgent" },
};

/** Records what each turn was handed, so history threading can be asserted. */
function makeStreamingRunner() {
  const seen: RunOptions[] = [];
  let n = 0;
  return {
    seen,
    async run() {
      throw new Error("run() not used in these tests");
    },
    async *stream(
      _agent: unknown,
      _message: string,
      options?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      if (options) seen.push(options);
      n += 1;
      const runId = `run-${n}`;
      const traceId = options?.traceId ?? runId;
      yield createEvent("agent.message.start", { traceId, runId, agentName: "test-agent" });
      yield createEvent("agent.message.complete", {
        traceId,
        runId,
        content: `reply-${n}`,
        inputTokens: 10,
        outputTokens: 5,
        model: "test-model",
      });
    },
  };
}

interface Harness {
  app: Hono;
  store: InMemoryConversationStore;
  conversations: Map<string, ConversationEntry>;
  runner: ReturnType<typeof makeStreamingRunner>;
  /** Drop every live conversation, keeping the store — a process bounce. */
  restart(): void;
  create(body?: Record<string, unknown>): Promise<Response>;
  send(id: string, body: Record<string, unknown>): Promise<Response>;
  json(res: Response): Promise<unknown>;
}

function harness(opts?: { scope?: AgentRegistration["scope"]; withStore?: boolean }): Harness {
  const store = new InMemoryConversationStore();
  const conversations = new Map<string, ConversationEntry>();
  const runner = makeStreamingRunner();
  const reg = {
    id: "test-agent",
    agent: mockAgent,
    runner,
    ...(opts?.scope ? { scope: opts.scope } : {}),
  } as unknown as AgentRegistration;

  const app = new Hono();
  app.route(
    "/",
    conversationRoutes(
      [reg],
      conversations,
      new AgentEventBus(),
      opts?.withStore === false ? undefined : store,
    ),
  );

  const post = async (path: string, body: Record<string, unknown>): Promise<Response> =>
    await app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  return {
    app,
    store,
    conversations,
    runner,
    restart: () => conversations.clear(),
    create: (body) => post("/conversations", { agent_id: "test-agent", ...body }),
    send: async (id, body) => {
      const res = await post(`/conversations/${id}/messages`, body);
      // Drain the SSE body so the turn's `finally` (and its persistence) runs.
      // Error responses are plain JSON — leave those readable for assertions.
      if (!res.headers.get("content-type")?.includes("text/event-stream")) {
        return res;
      }
      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      return res;
    },
    json: (res) => res.json(),
  };
}

describe("#480 — one identity across create, list, read and reply", () => {
  it("the created id is the listed id is the repliable id", async () => {
    const h = harness();
    const { id } = (await h.json(await h.create())) as { id: string };

    await h.send(id, { content: "hello" });
    await h.send(id, { content: "again" });

    // Listed under the SAME id the caller was given.
    const rows = (await h.json(await h.app.request("/conversations"))) as Array<{
      id: string;
      exchange_count: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.exchange_count).toBe(2);

    // Readable under that id — previously `[]`, because the readable id was
    // a different value than the writable one.
    const messages = (await h.json(
      await h.app.request(`/conversations/${id}/messages`),
    )) as unknown[];
    expect(messages).toHaveLength(4);

    // And repliable under it — previously a 404.
    const third = await h.send(id, { content: "third" });
    expect(third.status).toBe(200);
  });

  it("creates the durable row before the first turn, so an unmessaged conversation still lists", async () => {
    const h = harness();
    const { id } = (await h.json(await h.create())) as { id: string };

    const rows = (await h.json(await h.app.request("/conversations"))) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it("does not fragment a multi-turn chat into one row per turn", async () => {
    const h = harness();
    const { id } = (await h.json(await h.create())) as { id: string };

    await h.send(id, { content: "one" });
    await h.send(id, { content: "two" });
    await h.send(id, { content: "three" });

    expect(await h.store.listConversations()).toHaveLength(1);
  });
});

describe("#480 — a chat outlives the process that created it", () => {
  it("resumes after a restart and threads the prior history into the run", async () => {
    const h = harness();
    const { id } = (await h.json(await h.create())) as { id: string };
    await h.send(id, { content: "first" });
    await h.send(id, { content: "second" });

    h.restart();
    expect(h.conversations.size).toBe(0);

    const res = await h.send(id, { content: "after restart" });
    expect(res.status).toBe(200);

    // The resumed turn carried the rebuilt history — not an empty context.
    const last = h.runner.seen.at(-1);
    const history = last?.messageHistory ?? [];
    expect(history).toHaveLength(4);
    expect(history[0]?.parts[0]).toMatchObject({ type: "user_prompt", content: "first" });
    expect(history[1]?.parts[0]).toMatchObject({ type: "text", content: "reply-1" });
    expect(history[2]?.parts[0]).toMatchObject({ type: "user_prompt", content: "second" });
  });

  it("persists the resumed turn into the SAME row — no fork", async () => {
    const h = harness();
    const { id } = (await h.json(await h.create())) as { id: string };
    await h.send(id, { content: "first" });

    h.restart();
    await h.send(id, { content: "after restart" });

    expect(await h.store.listConversations()).toHaveLength(1);
    expect(await h.store.getMessages(id)).toHaveLength(4);
  });

  it("still 404s an id that was never a conversation", async () => {
    const h = harness();
    const res = await h.send("no-such-conversation", { content: "hi" });
    expect(res.status).toBe(404);
  });

  it("409s a row with no binding stamp — readable, honestly not resumable", async () => {
    const h = harness();
    // A pre-#480 row: persisted, but with no record of which agent it bound.
    await h.store.createConversation("TestAgent", "test-model", { id: "legacy-row" });

    const res = await h.send("legacy-row", { content: "hi" });
    expect(res.status).toBe(409);
    expect(((await h.json(res)) as { error: string }).error).toMatch(/cannot be resumed/);
  });

  it("409s when the stamped agent is no longer registered", async () => {
    const h = harness();
    await h.store.createConversation("Gone", "test-model", {
      id: "orphan",
      metadata: { binding: { agentId: "retired-agent", scopeSupplied: false } },
    });

    const res = await h.send("orphan", { content: "hi" });
    expect(res.status).toBe(409);
    expect(((await h.json(res)) as { error: string }).error).toMatch(/not registered/);
  });

  it("404s on resume when no store is configured — the map really is the whole world", async () => {
    const h = harness({ withStore: false });
    const res = await h.send("anything", { content: "hi" });
    expect(res.status).toBe(404);
  });
});

describe("#480 — scope is re-supplied on resume, never persisted", () => {
  const scope = {
    defaults: { tenant: "acme" },
    redactKeys: ["token"],
    parse: (v: unknown) =>
      z.object({ tenant: z.string(), token: z.string().optional() }).parse(v ?? {}) as Record<
        string,
        unknown
      >,
  } as unknown as AgentRegistration["scope"];

  it("never writes scope values to the store", async () => {
    const h = harness({ scope });
    const { id } = (await h.json(
      await h.create({ scope: { tenant: "acme", token: "s3cret" } }),
    )) as { id: string };

    const row = await h.store.getConversation(id);
    const serialized = JSON.stringify(row?.metadata);
    expect(serialized).not.toContain("s3cret");
    expect(serialized).not.toContain("acme");
    // Only the binding facts resume needs.
    expect(row?.metadata).toEqual({
      binding: { agentId: "test-agent", scopeSupplied: true },
    });
  });

  it("400s a resume that omits the scope the conversation was created with", async () => {
    const h = harness({ scope });
    const { id } = (await h.json(
      await h.create({ scope: { tenant: "acme", token: "s3cret" } }),
    )) as { id: string };
    await h.send(id, { content: "first" });

    h.restart();

    const res = await h.send(id, { content: "after restart" });
    expect(res.status).toBe(400);
    expect(((await h.json(res)) as { error: string }).error).toMatch(/requires `scope`/);
  });

  it("resumes when the caller re-supplies the scope, and re-binds host.scope", async () => {
    const h = harness({ scope });
    const { id } = (await h.json(
      await h.create({ scope: { tenant: "acme", token: "s3cret" } }),
    )) as { id: string };
    await h.send(id, { content: "first" });

    h.restart();

    const res = await h.send(id, {
      content: "after restart",
      scope: { tenant: "acme", token: "s3cret" },
    });
    expect(res.status).toBe(200);

    const host = h.runner.seen.at(-1)?.host as { scope?: Record<string, unknown> } | undefined;
    expect(host?.scope).toMatchObject({ tenant: "acme", token: "s3cret" });
  });

  it("resumes without a scope when none was supplied at creation (defaults re-derive)", async () => {
    const h = harness({ scope });
    const { id } = (await h.json(await h.create())) as { id: string };
    await h.send(id, { content: "first" });

    h.restart();

    const res = await h.send(id, { content: "after restart" });
    expect(res.status).toBe(200);
    const host = h.runner.seen.at(-1)?.host as { scope?: Record<string, unknown> } | undefined;
    expect(host?.scope).toMatchObject({ tenant: "acme" });
  });

  it("rejects a resume whose re-supplied scope fails validation", async () => {
    const h = harness({ scope });
    const { id } = (await h.json(await h.create({ scope: { tenant: "acme" } }))) as { id: string };
    await h.send(id, { content: "first" });

    h.restart();

    const res = await h.send(id, { content: "after restart", scope: { tenant: 42 } });
    expect(res.status).toBe(400);
    expect(((await h.json(res)) as { error: string }).error).toMatch(/scope validation failed/);
  });
});
