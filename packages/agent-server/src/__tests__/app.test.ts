import { AgentEventBus, createEvent } from "@agentic-patterns/runtime";
import { describe, expect, it } from "vitest";
import { createServer } from "../app.js";
import type { AgentRegistration, ServerConfig } from "../config.js";

const mockAgent = {
  getModel: () => "test-model",
  getTools: () => [],
  getSystemPrompt: () => "You are a test agent.",
  renderInitialPrompt: () => "Test prompt",
  role: { name: "TestAgent" },
};

const mockRunner = {
  async run() {
    return {
      response: "Hello!",
      inputTokens: 10,
      outputTokens: 5,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
    };
  },
};

const testRegistration: AgentRegistration = {
  id: "test-1",
  name: "Test Agent",
  description: "A test agent",
  agent: mockAgent,
  runner: mockRunner,
};

const mockAdminService = {
  async getDashboardStats() {
    return {
      agents: [
        {
          agentName: "Agent1",
          status: "idle" as const,
          totalIterations: 5,
          totalToolCalls: 10,
          totalInputTokens: 1000,
          totalOutputTokens: 500,
          totalErrors: 0,
          toolStats: [],
        },
        {
          agentName: "Agent2",
          status: "idle" as const,
          totalIterations: 3,
          totalToolCalls: 4,
          totalInputTokens: 200,
          totalOutputTokens: 100,
          totalErrors: 1,
          toolStats: [],
        },
      ],
      activeAgentCount: 2,
      totalTokensUsed: 1800,
      totalToolCalls: 14,
      totalErrors: 1,
      activeConversationCount: 1,
      uptimeMs: 60000,
    };
  },
  async getAgentStats(agentName: string) {
    if (agentName === "Agent1") {
      return {
        agentName: "Agent1",
        status: "idle" as const,
        totalIterations: 5,
        totalToolCalls: 10,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalErrors: 0,
        toolStats: [],
      };
    }
    return undefined;
  },
  async getAllAgentStats() {
    return [
      {
        agentName: "Agent1",
        status: "idle" as const,
        totalIterations: 5,
        totalToolCalls: 10,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalErrors: 0,
        toolStats: [],
      },
    ];
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
    return [
      {
        toolName: "read_file",
        totalCalls: 5,
        totalErrors: 1,
        totalDurationMs: 125,
        avgDurationMs: 25,
        agentBreakdown: [{ agentName: "Agent1", callCount: 5 }],
      },
    ];
  },
  async getTokenUsage() {
    return [
      {
        key: "Agent1",
        inputTokens: 600,
        outputTokens: 300,
        totalTokens: 900,
        conversationCount: 3,
      },
    ];
  },
};

const mockEventBus = {
  subscribe: () => () => {},
  subscribeAll: () => () => {},
  unsubscribeAll: () => {},
  emit: () => {},
};

const mockSseExporter = {
  connect: () => new ReadableStream(),
  disconnect: () => {},
};

function makeConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    agents: [],
    adminService: mockAdminService,
    eventBus: mockEventBus as unknown as ServerConfig["eventBus"],
    sseExporter: mockSseExporter,
    ...overrides,
  };
}

describe("createServer", () => {
  it("returns a Hono app", () => {
    const app = createServer(makeConfig());
    expect(app).toBeDefined();
  });
});

describe("GET /health", () => {
  it("returns status ok", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body).toEqual({ status: "ok" });
  });
});

describe("GET /agents", () => {
  it("returns empty array when no agents", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  it("returns agent summaries", async () => {
    const app = createServer(makeConfig({ agents: [testRegistration] }));
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; description: string }[];
    expect(body).toEqual([{ id: "test-1", name: "Test Agent", description: "A test agent" }]);
  });

  it("defaults description to empty string", async () => {
    const reg = { ...testRegistration, description: undefined };
    const app = createServer(makeConfig({ agents: [reg] }));
    const res = await app.request("/agents");
    const body = (await res.json()) as { description: string }[];
    expect(body[0]!.description).toBe("");
  });
});

describe("POST /conversations", () => {
  it("returns 404 for unknown agent", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("creates a conversation for a valid agent", async () => {
    const app = createServer(makeConfig({ agents: [testRegistration] }));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "test-1" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; agent_id: string };
    expect(body.id).toBeDefined();
    expect(body.agent_id).toBe("test-1");
  });
});

describe("POST /conversations/:id/messages", () => {
  it("returns 404 for unknown conversation", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/conversations/unknown/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 501 when runner has no stream method", async () => {
    const app = createServer(makeConfig({ agents: [testRegistration] }));
    // Create a conversation first
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "test-1" }),
    });
    const { id } = (await createRes.json()) as { id: string };

    // Send message — runner has no stream(), should get 501
    const res = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Streaming not supported by this runner");
  });

  // Regression — events emitted while streaming a conversation must reach
  // the EventBus in ServerConfig so attached exporters (collector, SSE
  // broadcaster) observe them. Previously the route instantiated a fresh
  // AgentEventBus per request and admin stats stayed empty forever.
  it("forwards streaming events to the config eventBus", async () => {
    const eventBus = new AgentEventBus();
    const seen: string[] = [];
    eventBus.subscribe("agent.message.chunk", (e) => {
      seen.push(e.type);
    });

    // Runner whose stream() emits a chunk event through the bus it was
    // handed, then returns. Mirrors how the real AgentRunner behaves.
    const streamingRunner = {
      async run() {
        return {
          response: "ok",
          inputTokens: 0,
          outputTokens: 0,
          toolCallsCount: 0,
          iterations: 0,
          finishReason: "stop",
        };
      },
      async *stream(_agent: unknown, _message: string, options?: { eventBus?: AgentEventBus }) {
        const chunk = createEvent("agent.message.chunk", {
          traceId: "t",
          runId: "r",
          delta: "hello",
          chunkIndex: 0,
        });
        await options?.eventBus?.publish(chunk);
        yield chunk;
      },
    };

    const reg: AgentRegistration = {
      id: "streamer",
      name: "Streamer",
      agent: mockAgent,
      runner: streamingRunner,
    };

    const app = createServer(makeConfig({ agents: [reg], eventBus }));

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "streamer" }),
    });
    const { id } = (await createRes.json()) as { id: string };

    // Drain the SSE response fully so the generator runs to completion.
    const res = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    await res.text();

    expect(seen).toContain("agent.message.chunk");
  });
});

describe("admin routes", () => {
  it("returns dashboard stats", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/admin/dashboard");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activeAgentCount: number };
    expect(body.activeAgentCount).toBe(2);
  });

  it("returns agent stats", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/admin/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentName: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.agentName).toBe("Agent1");
  });

  it("returns tool analytics", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/admin/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { toolName: string }[];
    expect(body[0]!.toolName).toBe("read_file");
  });

  it("returns token usage", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/admin/tokens?group_by=agent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string }[];
    expect(body[0]!.key).toBe("Agent1");
  });

  it("returns SSE stream from sseExporter", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/admin/events/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });
});

describe("CORS configuration", () => {
  it("defaults to wildcard origin", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/health", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com", "Access-Control-Request-Method": "GET" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("honors a custom pinned origin", async () => {
    const app = createServer(makeConfig({ cors: { origin: "https://dashboard.example.com" } }));
    const res = await app.request("/health", {
      method: "OPTIONS",
      headers: {
        Origin: "https://dashboard.example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://dashboard.example.com");
  });
});
