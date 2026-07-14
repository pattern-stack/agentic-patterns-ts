/**
 * Verify-only test (issue #97, spec § File-level plan "Verify unchanged") — a
 * `PromotedAgent` (via `asAgent()`, `@agentic-patterns/runtime` workflows)
 * genuinely lacks `mission`/`awareness`/`background`. Confirms the
 * introspection routes (`GET /agents`, `GET /agents/:id/composition`) tolerate
 * that absence and render without throwing, rather than rebuilding anything.
 */

import { Agent, Capability, Mission, Persona, RoleBuilder, Toolbox } from "@agentic-patterns/core";
import {
  AgentEventBus,
  AgentStep,
  FunctionStep,
  NodeBackedRunner,
  RunStore,
  RunStoreExporter,
  asAgent,
  deriveToolboxExecutor,
} from "@agentic-patterns/runtime";
import type { AgentLike, RunOptions, RunResult, RunnerProtocol } from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
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

// ---------------------------------------------------------------------------
// Regression — a truthy-but-EMPTY executor disarmed a promoted agent's tools.
//
// `createToolboxExecutor` ALWAYS returns a truthy executor; for a PromotedAgent
// (asAgent()) — whose synthetic role has NO capabilities — its lookup maps are
// EMPTY, so every `execute()` throws `Tool "X" not found`. The conversation
// route used to set that empty executor as `RunOptions.toolExecutor`, and it
// BEAT the AgentStep-level `ctx.toolExecutor ?? deriveToolboxExecutor(agent)`
// fallback that arms the NESTED agent's own tools — silently disarming them
// (traces looked healthy). The fix: DERIVE (returns `undefined` for a
// capability-less agent), leaving the per-agent derivation intact.
// ---------------------------------------------------------------------------

/** A real toolbox with one executable tool, counting how often it ran. */
class LedgerToolbox extends Toolbox {
  readonly name = "ledger";
  readonly description = "reads the household ledger";
  ran = 0;
  readonly tools = {
    getBalance: {
      description: "get a member's balance",
      parameters: z.object({ member: z.string() }),
      execute: async (args: Record<string, unknown>) => {
        this.ran++;
        return { member: args.member, balance: 42 };
      },
    },
  };
}

/** A full core Agent carrying the ledger toolbox as a real Capability. */
function agentWithLedger(tb: Toolbox): Agent {
  const role = new RoleBuilder("insights")
    .withPersona(
      new Persona({
        identity: "reads the household ledger",
        tone: "direct",
        priorities: ["accuracy"],
        principles: ["cite the ledger"],
      }),
    )
    .withCapability(new Capability("ledger", "ledger access", tb))
    .withDefaultModel("mock")
    .build();
  return new Agent({
    role,
    mission: new Mission({
      objective: "answer ledger questions",
      successCriteria: ["answered from the ledger"],
      constraints: [],
    }),
  });
}

/**
 * The NodeBackedRunner's INNER (LLM-stand-in) runner. It doesn't loop — it
 * simply dispatches the ledger tool through whatever executor reached it in
 * `opts.toolExecutor` and reports the balance. This is the pivot: post-fix the
 * AgentStep derives the real executor (the route passes `undefined`); pre-fix
 * the route's empty executor arrives here and `execute()` throws.
 */
function ledgerDispatchingRunner(): RunnerProtocol {
  return {
    async run(_agent: AgentLike, _message: string, opts?: RunOptions): Promise<RunResult> {
      const executor = opts?.toolExecutor;
      if (!executor) throw new Error("no toolExecutor reached the inner runner");
      const out = (await executor.execute("getBalance", { member: "dana" })) as {
        balance: number;
      };
      return {
        response: `balance is ${out.balance}`,
        inputTokens: 0,
        outputTokens: 0,
        toolCallsCount: 1,
        iterations: 1,
        finishReason: "stop",
      };
    },
  };
}

function stubAdminService(): ServerConfig["adminService"] {
  return {
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
}

describe("promoted-agent registration — the conversation route arms nested tools", () => {
  it("POST /conversations then /messages actually dispatches the inner agent's tool (pre-fix: 'Tool not found')", async () => {
    const eventBus = new AgentEventBus();
    const tb = new LedgerToolbox();

    // A promoted node whose INNER agent HAS a real toolbox.
    const step = new AgentStep<string, string>({
      name: "insights",
      agent: agentWithLedger(tb),
      prompt: (q) => q, // string path → generateText (the inner runner above)
    });
    const promoted = asAgent(step, { role: { name: "Ledger Pipe" } });

    const registration: AgentRegistration = {
      id: "ledger-pipe",
      name: "Ledger Pipe",
      agent: promoted,
      runner: new NodeBackedRunner(ledgerDispatchingRunner(), eventBus),
    };

    const app = createServer({
      agents: [registration],
      adminService: stubAdminService(),
      eventBus,
      sseExporter: { connect: () => new ReadableStream(), disconnect: () => {} },
    });

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "ledger-pipe" }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const msgRes = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "what is dana's balance?" }),
    });
    expect(msgRes.status).toBe(200);
    const sseBody = await msgRes.text();

    // The tool actually ran, and its result reached the client stream. Pre-fix
    // the route's truthy-empty executor beat the AgentStep derivation, so the
    // inner runner got an executor that threw `Tool "getBalance" not found`.
    expect(tb.ran).toBe(1);
    expect(sseBody).toContain("balance is 42");
    expect(sseBody).not.toContain("not found");
  });

  it("deriveToolboxExecutor selects the right branch: undefined for a promoted agent, an executor for a capability-bearing one", () => {
    const promoted = asAgent(new FunctionStep<string, string>({ name: "id", fn: (s) => s }), {
      role: { name: "Bare Pipe" },
    });
    // The route's swap: a promoted agent has no capabilities → no forced empty
    // executor (undefined restores the AgentStep-level derivation).
    expect(deriveToolboxExecutor(promoted)).toBeUndefined();

    // A real capability-bearing agent still gets its own executor at the route.
    const withTools = agentWithLedger(new LedgerToolbox());
    expect(deriveToolboxExecutor(withTools)).toBeDefined();
  });
});
