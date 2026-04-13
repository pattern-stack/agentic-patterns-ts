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
  async getDashboard() {
    return {
      activeConversations: 1,
      totalConversations: 5,
      totalExchanges: 10,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      errorCount: 0,
      agentCount: 2,
    };
  },
  async listAgentStats() {
    return [
      { name: "Agent1", conversationCount: 3, totalInputTokens: 600, totalOutputTokens: 300 },
    ];
  },
  async getToolAnalytics() {
    return [
      {
        toolName: "read_file",
        callCount: 5,
        successCount: 4,
        failureCount: 1,
        avgDurationMs: 25,
      },
    ];
  },
  async getTokenUsage() {
    return [{ group: "Agent1", inputTokens: 600, outputTokens: 300, conversations: 3 }];
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
});

describe("admin routes", () => {
  it("returns dashboard stats", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/admin/dashboard");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentCount: number };
    expect(body.agentCount).toBe(2);
  });

  it("returns agent stats", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/admin/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("Agent1");
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
    const body = (await res.json()) as { group: string }[];
    expect(body[0]!.group).toBe("Agent1");
  });

  it("returns SSE stream from sseExporter", async () => {
    const app = createServer(makeConfig());
    const res = await app.request("/admin/events/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });
});
