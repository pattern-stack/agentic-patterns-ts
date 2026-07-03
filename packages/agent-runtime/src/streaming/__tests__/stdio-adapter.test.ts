import { describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../../conversation/store.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { AgentLike, RunnerProtocol } from "../../runner/types.js";
import { StdioAdapter } from "../stdio-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(name: string): AgentLike {
  return {
    role: { name },
    getModel: () => "test-model",
    getTools: () => [],
    getSystemPrompt: () => "system",
    renderInitialPrompt: () => "system",
  };
}

function makeAdapter(opts?: {
  agents?: AgentLike[];
  runner?: RunnerProtocol;
  store?: InMemoryConversationStore;
}) {
  const agents = opts?.agents ?? [makeAgent("agent-1")];
  const runner =
    opts?.runner ?? (new MockRunner().addResponse("*", { content: "ok" }) as RunnerProtocol);
  return new StdioAdapter({ agents, runner, store: opts?.store });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StdioAdapter", () => {
  describe("handleRequest", () => {
    it("listAgents returns all registered agents", async () => {
      const adapter = makeAdapter({
        agents: [makeAgent("agent-1"), makeAgent("agent-2")],
      });

      const res = await adapter.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "listAgents",
      });

      expect(res.result).toEqual([
        { name: "agent-1", model: "test-model" },
        { name: "agent-2", model: "test-model" },
      ]);
    });

    it("createConversation creates a new conversation", async () => {
      const store = new InMemoryConversationStore();
      const adapter = makeAdapter({ store });

      const res = await adapter.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "createConversation",
        params: { agentName: "agent-1" },
      });

      const result = res.result as Record<string, unknown>;
      expect(result).toBeDefined();
      expect(result.conversationId).toBeDefined();
      expect(result.agentName).toBe("agent-1");
    });

    it("createConversation rejects unknown agent", async () => {
      const adapter = makeAdapter();

      const res = await adapter.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "createConversation",
        params: { agentName: "unknown" },
      });

      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32602);
    });

    it("sendMessage streams events as notifications", async () => {
      const runner = new MockRunner().addResponse("*", { content: "Hello!" });
      const store = new InMemoryConversationStore();
      const adapter = makeAdapter({ runner: runner as RunnerProtocol, store });

      // Create conversation first
      const createRes = await adapter.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "createConversation",
        params: { agentName: "agent-1" },
      });
      const convId = (createRes.result as Record<string, unknown>).conversationId as string;

      // Collect notifications
      const notifications: unknown[] = [];
      const res = await adapter.handleRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "sendMessage",
          params: { conversationId: convId, message: "Hi" },
        },
        (notification) => notifications.push(notification),
      );

      expect(notifications.length).toBeGreaterThan(0);
      const result = res.result as Record<string, unknown>;
      expect(result).toBeDefined();
      expect(result.status).toBe("completed");
    });

    it("listConversations returns conversations created via adapter", async () => {
      const store = new InMemoryConversationStore();
      const adapter = makeAdapter({ store });

      // Create a conversation through the adapter so it tracks the ID
      await adapter.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "createConversation",
        params: { agentName: "agent-1" },
      });

      const res = await adapter.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "listConversations",
      });

      expect(res.result).toHaveLength(1);
    });

    it("getConversation returns a specific conversation", async () => {
      const store = new InMemoryConversationStore();
      const adapter = makeAdapter({ store });

      // Create via adapter
      const createRes = await adapter.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "createConversation",
        params: { agentName: "agent-1" },
      });
      const convId = (createRes.result as Record<string, unknown>).conversationId as string;

      const res = await adapter.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "getConversation",
        params: { conversationId: convId },
      });

      const result = res.result as Record<string, unknown>;
      expect(result).toBeDefined();
      expect(result.id).toBe(convId);
    });

    it("returns method not found for unknown methods", async () => {
      const adapter = makeAdapter();

      const res = await adapter.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "unknownMethod",
      });

      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32601);
    });
  });
});
