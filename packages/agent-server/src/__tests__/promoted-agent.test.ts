/**
 * Verify-only test (issue #97, spec § File-level plan "Verify unchanged") — a
 * `PromotedAgent` (via `asAgent()`, `@agentic-patterns/runtime` workflows)
 * genuinely lacks `mission`/`awareness`/`background`. Confirms the
 * introspection routes (`GET /agents`, `GET /agents/:id/composition`) tolerate
 * that absence and render without throwing, rather than rebuilding anything.
 */

import {
  AgentEventBus,
  FunctionStep,
  NodeBackedRunner,
  RunStore,
  RunStoreExporter,
  asAgent,
} from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
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
    // #222: a bare promoted agent declares no model (asAgent no longer pins a
    // default "sonnet"), so the /agents readiness contract — a model must
    // statically resolve — honestly reports it not-ready. The route still
    // RENDERS (status 200, no throw) on the missing composition, which is what
    // this test guards.
    expect(entry?.readiness).toMatchObject({ ready: false, missing: ["model"] });
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

// ---------------------------------------------------------------------------
// S5 follow-up — a promoted-agent chat, driven through the REAL HTTP/SSE
// route, must (a) persist a `runs` row via RunStoreExporter on the shared
// bus and (b) leave the client-visible SSE event sequence byte-identical to
// before the fix (no reordering/duplication of what the dashboard renders).
// ---------------------------------------------------------------------------

describe("promoted-agent registration — chat persists a run without changing the SSE shape", () => {
  let store: RunStore;

  afterEach(() => {
    store?.close();
  });

  it("POST /conversations/:id/messages persists exactly ONE /admin/runs row, and the SSE stream is still just start -> delta -> complete -> done", async () => {
    store = new RunStore({ path: ":memory:", Database });
    const eventBus = new AgentEventBus();
    const runStoreExporter = new RunStoreExporter({ store });
    runStoreExporter.attach(eventBus);

    const pipeline = new FunctionStep<string, string>({
      name: "upper",
      fn: (s) => s.toUpperCase(),
    });
    const promoted = asAgent(pipeline, { role: { name: "Promoted Pipe" } });
    const registration: AgentRegistration = {
      id: "promoted-pipe",
      name: "Promoted Pipe",
      agent: promoted,
      // The fix: eventBus threaded at construction, exactly as `playground.ts`
      // and `run.ts` now do.
      runner: new NodeBackedRunner(
        {
          async run() {
            throw new Error("unused — the pipeline never delegates to the inner runner");
          },
        },
        eventBus,
      ),
    };

    const config: ServerConfig = {
      agents: [registration],
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
      eventBus,
      sseExporter: { connect: () => new ReadableStream(), disconnect: () => {} },
      runStore: store,
    };
    const app = createServer(config);

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "promoted-pipe" }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const msgRes = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(msgRes.status).toBe(200);
    const sseBody = await msgRes.text();

    // The SSE shape the dashboard renders — unchanged by the fix (the fix
    // only ADDS a bus publish alongside each existing yield, never a new
    // yielded event, never a reorder).
    const eventNames = [...sseBody.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(eventNames).toEqual([
      "conversation.start",
      "message.start",
      "message.delta",
      "message.complete",
      "conversation.end",
      "done",
    ]);
    expect(sseBody).toContain("HELLO");

    // The persistence side effect — the actual bug this fixes.
    const rows = store.listRuns();
    expect(rows).toHaveLength(1);
    const row = store.getRun(rows[0]!.runId);
    expect(row?.agentName).toBe("Promoted Pipe");
    expect(row?.status).toBe("ok");
    expect(row?.finalAnswer).toBe("HELLO");
  });
});
