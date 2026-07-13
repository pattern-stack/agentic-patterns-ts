/**
 * Human-in-the-loop conversation wiring: the `agent.input.request` delivery on
 * the message stream (correlated by traceId) + `POST /conversations/:id/input`
 * that resolves the pending registry entry. Mounts only `conversationRoutes`
 * (the `conversations.test.ts` idiom) so the wiring is what's under test.
 */

import type { AgentEvent, RunOptions } from "@agentic-patterns/runtime";
import { AgentEventBus, PendingInputRegistry, createEvent } from "@agentic-patterns/runtime";
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

/**
 * A streaming runner that, mid-turn, PUBLISHES an `agent.input.request` on the
 * bus — standing in for a blocked approval gate. It publishes two: one on the
 * turn's own traceId (should be delivered) and one on a foreign traceId (should
 * be filtered out), proving per-conversation correlation.
 */
function makeApprovalRunner() {
  return {
    async run() {
      throw new Error("run() not used");
    },
    async *stream(
      _agent: unknown,
      _message: string,
      options?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      const traceId = options?.traceId ?? "fallback";
      const runId = "run-1";
      yield createEvent("agent.message.start", { traceId, runId, agentName: "test-agent" });

      const bus = options?.eventBus;
      if (bus) {
        // Foreign traceId — must NOT reach this turn's stream.
        await bus.publish(
          createEvent("agent.input.request", {
            traceId: "other-conversation-trace",
            runId: "other-run",
            correlationId: "other-call",
            kind: "approval",
            prompt: "should not appear",
          }),
        );
        // This turn's request — must be delivered inline.
        await bus.publish(
          createEvent("agent.input.request", {
            traceId,
            runId,
            correlationId: "call-1",
            kind: "approval",
            prompt: 'Approve "ratify_definition"?',
            toolName: "ratify_definition",
            toolCallId: "call-1",
          }),
        );
      }

      yield createEvent("agent.message.complete", {
        traceId,
        runId,
        content: "done",
        inputTokens: 1,
        outputTokens: 1,
        model: "test-model",
      });
    },
  };
}

function mkApp(opts?: {
  agents?: AgentRegistration[];
  eventBus?: AgentEventBus;
  registry?: PendingInputRegistry;
}): Hono {
  const app = new Hono();
  app.route(
    "/",
    conversationRoutes(
      opts?.agents ?? [],
      new Map<string, ConversationEntry>(),
      opts?.eventBus ?? new AgentEventBus(),
      undefined,
      opts?.registry,
    ),
  );
  return app;
}

describe("POST /conversations/:id/input", () => {
  it("501s when no input registry is configured", async () => {
    const app = mkApp();
    const res = await app.request("/conversations/x/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correlation_id: "c", decision: "approve" }),
    });
    expect(res.status).toBe(501);
  });

  it("400s without a correlation_id", async () => {
    const app = mkApp({ registry: new PendingInputRegistry() });
    const res = await app.request("/conversations/x/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s an unknown / already-settled correlation_id", async () => {
    const app = mkApp({ registry: new PendingInputRegistry() });
    const res = await app.request("/conversations/x/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correlation_id: "nope", decision: "approve" }),
    });
    expect(res.status).toBe(404);
  });

  it("resolves a pending request (unblocking the gate) on approve", async () => {
    const registry = new PendingInputRegistry();
    const app = mkApp({ registry });
    const answer = registry.create("call-42");

    const res = await app.request("/conversations/x/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correlation_id: "call-42", decision: "approve" }),
    });
    expect(res.status).toBe(200);
    await expect(answer).resolves.toEqual({ decision: "approve" });
  });

  it("treats a bare value as approval carrying that value (select/text)", async () => {
    const registry = new PendingInputRegistry();
    const app = mkApp({ registry });
    const answer = registry.create("pick-1", { kind: "select" });

    await app.request("/conversations/x/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correlation_id: "pick-1", value: "option-b" }),
    });
    await expect(answer).resolves.toEqual({ decision: "approve", value: "option-b" });
  });
});

describe("agent.input.request delivery on the message stream", () => {
  it("surfaces the turn's request inline and filters foreign traceIds", async () => {
    const eventBus = new AgentEventBus();
    const runner = makeApprovalRunner();
    const reg: AgentRegistration = { id: "gated", name: "Gated", agent: mockAgent, runner };
    const app = mkApp({ agents: [reg], eventBus, registry: new PendingInputRegistry() });

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "gated" }),
    });
    const { id: convId } = (await createRes.json()) as { id: string };

    const streamRes = await app.request(`/conversations/${convId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "go" }),
    });
    expect(streamRes.status).toBe(200);
    const text = await streamRes.text();

    // The turn's own request is delivered exactly once...
    const inputFrames = text.split("\n").filter((l) => l === "event: input.request");
    expect(inputFrames).toHaveLength(1);
    expect(text).toContain('"correlation_id":"call-1"');
    expect(text).toContain('"tool_name":"ratify_definition"');
    // ...and the foreign-traceId request never reaches this stream.
    expect(text).not.toContain("other-call");
    expect(text).not.toContain("should not appear");
  });
});
