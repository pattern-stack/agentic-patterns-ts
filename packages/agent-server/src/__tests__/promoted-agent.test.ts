/**
 * Verify-only test (issue #97, spec § File-level plan "Verify unchanged") — a
 * `PromotedAgent` (via `asAgent()`, `@agentic-patterns/runtime` workflows)
 * genuinely lacks `mission`/`awareness`/`background`. Confirms the
 * introspection routes (`GET /agents`, `GET /agents/:id/composition`) tolerate
 * that absence and render without throwing, rather than rebuilding anything.
 */

import { FunctionStep, NodeBackedRunner, asAgent } from "@agentic-patterns/runtime";
import { describe, expect, it } from "vitest";
import { createServer } from "../app.js";
import type { AgentRegistration, ServerConfig } from "../config.js";

function makeApp(agents: AgentRegistration[]): ReturnType<typeof createServer> {
  const config: ServerConfig = {
    agents,
    adminService: {
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
    },
    eventBus: {
      subscribe: () => () => {},
      subscribeAll: () => () => {},
      unsubscribeAll: () => {},
      emit: () => {},
    } as unknown as ServerConfig["eventBus"],
    sseExporter: { connect: () => new ReadableStream(), disconnect: () => {} },
  };
  return createServer(config);
}

describe("promoted-agent registration — server introspection", () => {
  const pipeline = new FunctionStep<string, string>({ name: "upper", fn: (s) => s.toUpperCase() });
  const promoted = asAgent(pipeline, { role: { name: "Promoted Pipe" } });
  const registration: AgentRegistration = {
    id: "promoted-pipe",
    name: "Promoted Pipe",
    agent: promoted,
    runner: new NodeBackedRunner({
      async run() {
        return {
          response: "ok",
          inputTokens: 0,
          outputTokens: 0,
          toolCallsCount: 0,
          iterations: 1,
          finishReason: "stop",
        };
      },
    }),
  };

  it("GET /agents renders a promoted registration without throwing (empty capabilities)", async () => {
    const app = makeApp([registration]);
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    const entry = body.find((a) => a.id === "promoted-pipe");
    expect(entry).toBeDefined();
    expect(entry?.readiness).toMatchObject({ ready: true, missing: [] });
  });

  it("GET /agents/:id/composition renders a promoted registration without throwing (empty mission)", async () => {
    const app = makeApp([registration]);
    const res = await app.request("/agents/promoted-pipe/composition");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("promoted-pipe");
    expect((body.instance as Record<string, unknown>).mission).toBeNull();
    expect((body.instance as Record<string, unknown>).awareness).toBeNull();
    expect((body.instance as Record<string, unknown>).background).toBeNull();
  });
});
