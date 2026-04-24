/**
 * Integration tests for the Claude Code chat flow.
 *
 * Two tests:
 *
 * 1. **Live test** — real `claude` subprocess, real Anthropic API/OAuth.
 *    Gated with `it.skipIf(!process.env.AP_E2E_CLAUDE_CODE)` so `bun run
 *    check` stays green without the env var set. Sends two messages in
 *    the same conversation and asserts the second response recalls
 *    information from the first (session resumption).
 *
 * 2. **Mocked test** — no env var needed, runs in CI. Uses a stub
 *    `RunnerFactory` that records invocations; asserts that (a) the
 *    factory is invoked once per conversation with the new id, (b) the
 *    same runner instance is reused across follow-up turns in that
 *    conversation.
 */

import { AgentEventBus, type RunnerProtocol } from "@agentic-patterns/runtime";
import { describe, expect, it } from "vitest";
import { createServer } from "../app.js";
import type { AgentRegistration, RunnerFactory, ServerConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

const mockAgent = {
  getModel: () => "sonnet",
  getTools: () => [],
  getSystemPrompt: () => "You are a test agent.",
  renderInitialPrompt: () => "Test prompt",
  role: { name: "ClaudeCode", capabilities: [] },
};

const mockAdminService = {
  async getDashboardStats() {
    return {
      agents: [],
      activeAgentCount: 0,
      totalTokensUsed: 0,
      totalToolCalls: 0,
      totalErrors: 0,
      activeConversationCount: 0,
      uptimeMs: 0,
    };
  },
  async getAgentStats() {
    return undefined;
  },
  async getAllAgentStats() {
    return [];
  },
  async getRecentEvents() {
    return [];
  },
  async getTraceSummaries() {
    return [];
  },
  async getConversations() {
    return [];
  },
  async getToolAnalytics() {
    return [];
  },
  async getTokenUsage() {
    return [];
  },
};

const mockSseExporter = {
  connect: () => new ReadableStream(),
  disconnect: () => {},
};

function makeConfig(overrides: Partial<ServerConfig>): ServerConfig {
  return {
    agents: [],
    adminService: mockAdminService,
    eventBus: new AgentEventBus(),
    sseExporter: mockSseExporter,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Mocked — factory reuse across turns
// ---------------------------------------------------------------------------

describe("Claude Code runner factory integration", () => {
  it("invokes forConversation once per conversation and reuses the runner across turns", async () => {
    const seenConvIds: string[] = [];
    const instancesCreated: StubRunner[] = [];

    type StubRunner = RunnerProtocol & { callCount: number; lastMessage: string | null };

    const factory: RunnerFactory = {
      forConversation(conversationId) {
        seenConvIds.push(conversationId);
        const stub: StubRunner = {
          callCount: 0,
          lastMessage: null,
          async run() {
            return {
              response: "",
              inputTokens: 0,
              outputTokens: 0,
              toolCallsCount: 0,
              iterations: 0,
              finishReason: "stop",
            };
          },
          async *stream(_agent, message) {
            stub.callCount += 1;
            stub.lastMessage = message;
            yield {
              id: `evt-${stub.callCount}`,
              type: "agent.message.chunk",
              timestamp: new Date().toISOString(),
              spanId: `span-${stub.callCount}`,
              traceId: "t",
              runId: "r",
              delta: `reply-${stub.callCount}`,
              chunkIndex: 0,
              // biome-ignore lint/suspicious/noExplicitAny: loose test event
            } as any;
          },
        };
        instancesCreated.push(stub);
        return stub;
      },
    };

    const reg: AgentRegistration = {
      id: "claude-code",
      name: "Claude Code",
      agent: mockAgent,
      runner: factory,
    };

    const app = createServer(makeConfig({ agents: [reg] }));

    // Create conversation 1
    const c1 = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "claude-code" }),
    });
    const { id: convId1 } = (await c1.json()) as { id: string };

    // Create conversation 2
    const c2 = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "claude-code" }),
    });
    const { id: convId2 } = (await c2.json()) as { id: string };

    expect(seenConvIds).toEqual([convId1, convId2]);
    expect(instancesCreated).toHaveLength(2);
    expect(instancesCreated[0]).not.toBe(instancesCreated[1]);

    // Turn 1 on conversation 1
    const r1 = await app.request(`/conversations/${convId1}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "turn one" }),
    });
    await r1.text();

    // Turn 2 on conversation 1
    const r2 = await app.request(`/conversations/${convId1}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "turn two" }),
    });
    await r2.text();

    // Same runner instance handled both turns — no new factory calls.
    expect(seenConvIds).toHaveLength(2);
    expect(instancesCreated[0]!.callCount).toBe(2);
    expect(instancesCreated[0]!.lastMessage).toBe("turn two");
    // Second conversation's runner untouched.
    expect(instancesCreated[1]!.callCount).toBe(0);
  });

  it("rejects concurrent messages on the same conversation with HTTP 409", async () => {
    const factory: RunnerFactory = {
      forConversation() {
        return {
          async run() {
            return {
              response: "",
              inputTokens: 0,
              outputTokens: 0,
              toolCallsCount: 0,
              iterations: 0,
              finishReason: "stop",
            };
          },
          async *stream() {
            // Hold the stream open long enough for a concurrent request
            // to race in. 50ms is well under the test timeout and more
            // than enough for the second request to reach the guard.
            await new Promise((resolve) => setTimeout(resolve, 50));
          },
        };
      },
    };

    const reg: AgentRegistration = {
      id: "slow",
      name: "Slow",
      agent: mockAgent,
      runner: factory,
    };

    const app = createServer(makeConfig({ agents: [reg] }));
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "slow" }),
    });
    const { id } = (await createRes.json()) as { id: string };

    // Kick off the first request but don't await it — the stream generator
    // sleeps for 50ms, during which we fire the second request.
    const first = app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "a" }),
    });
    // Brief yield so the first request enters the handler and flips the
    // inFlight bit before the second request's guard check.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "b" }),
    });

    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("busy");

    // Drain the first so vitest doesn't leave a dangling promise.
    const firstRes = await first;
    await firstRes.text();
  });
});

// ---------------------------------------------------------------------------
// 2. Live — real claude subprocess, env-gated
// ---------------------------------------------------------------------------

describe("Claude Code live conversation", () => {
  it.skipIf(!process.env.AP_E2E_CLAUDE_CODE)(
    "resumes context across two turns via the runner factory",
    async () => {
      // Import lazily so `bun run check` without the env var doesn't pay
      // the cost of loading the SDK and the core agent builder.
      const { buildClaudeCodeChatAgent, ClaudeCodeAPIRunner } = await import(
        "@agentic-patterns/runtime"
      );

      const reg: AgentRegistration = {
        id: "claude-code",
        name: "Claude Code",
        agent: buildClaudeCodeChatAgent(),
        runner: {
          forConversation() {
            return new ClaudeCodeAPIRunner();
          },
        },
      };

      const app = createServer(makeConfig({ agents: [reg] }));
      const createRes = await app.request("/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "claude-code" }),
      });
      const { id } = (await createRes.json()) as { id: string };

      // Turn 1 — seed a fact.
      const r1 = await app.request(`/conversations/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "My favorite color is periwinkle. Please remember this.",
        }),
      });
      await r1.text();

      // Turn 2 — ask for the fact back.
      const r2 = await app.request(`/conversations/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "What did I just say my favorite color was?",
        }),
      });
      const sseText = await r2.text();

      // SSE payload accumulates all chunks; periwinkle must appear in the
      // streamed response body if session resume is working.
      expect(sseText.toLowerCase()).toContain("periwinkle");
    },
    120_000,
  );
});
