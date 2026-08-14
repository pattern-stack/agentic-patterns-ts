/**
 * Verify-only test (issue #97, spec § File-level plan "Verify unchanged") — a
 * `PromotedAgent` (via `asAgent()`, `@pattern-stack/agentic-runtime` workflows)
 * genuinely lacks `mission`/`awareness`/`background`. Confirms the
 * introspection routes (`GET /agents`, `GET /agents/:id/composition`) tolerate
 * that absence and render without throwing, rather than rebuilding anything.
 */

import {
  Agent,
  Capability,
  Mission,
  Persona,
  RoleBuilder,
  Toolbox,
} from "@pattern-stack/agentic-core";
import {
  AgentEventBus,
  AgentStep,
  FunctionStep,
  NodeBackedRunner,
  RunStore,
  RunStoreExporter,
  asAgent,
  deriveToolboxExecutor,
} from "@pattern-stack/agentic-runtime";
import type {
  AgentLike,
  RunOptions,
  RunResult,
  RunnerProtocol,
} from "@pattern-stack/agentic-runtime";
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

// ---------------------------------------------------------------------------
// `PromotedAgent.displayRole` — the display/execution DECOUPLING.
//
// A promoted pipeline registers a NARROW `role: { name }` so that
// `deriveToolboxExecutor` declines to build an outer executor (arming one would
// shadow the per-AgentStep `ctx.toolExecutor ?? deriveToolboxExecutor(agent)`
// derivation and disarm nested agents' tools — the #13 bug fixed in #241). The
// cost, until now, was that every Build page rendered a promoted pipeline as an
// EMPTY agent. `displayRole` carries the real Role for DISPLAY reads only, so
// the Build pages get the truth while the executor derivation stays blind to it.
// ---------------------------------------------------------------------------

/** The pipeline's DISPLAY capability — 2 tools, and a DIFFERENT toolbox than the
 *  nested agent's. If the outer executor were ever (re-)armed from `displayRole`,
 *  it would ride `RunOptions.toolExecutor` into the inner runner and shadow the
 *  nested agent's own tools — so the guard below asserts these never run. */
class PipelineToolbox extends Toolbox {
  readonly name = "pipeline-surface";
  readonly description = "the promoted pipeline's declared surface";
  ran = 0;
  readonly tools = {
    summarize: {
      description: "summarize the ledger",
      parameters: z.object({ scope: z.string() }),
      execute: async () => {
        this.ran++;
        return { summary: "n/a" };
      },
    },
    forecast: {
      description: "forecast next month",
      parameters: z.object({ months: z.number() }),
      execute: async () => {
        this.ran++;
        return { forecast: "n/a" };
      },
    },
  };
}

/** A full core Role carrying the display capability — what `asAgent` keeps on
 *  `displayRole` and the Build pages render. */
function pipelineDisplayRole(tb: Toolbox) {
  return new RoleBuilder("Ledger Insights")
    .withPersona(
      new Persona({
        identity: "a ledger insights pipeline",
        tone: "direct",
        priorities: ["accuracy"],
        principles: ["cite the ledger"],
      }),
    )
    .withCapability(new Capability("insights", "ledger insights", tb))
    .withDefaultModel("mock")
    .build();
}

describe("promoted-agent registration — displayRole renders the Build pages", () => {
  /** The promoted pipeline under test: a nested ledger AGENT (its real tools)
   *  promoted with a rich display Role (its declared surface). */
  function setup() {
    const eventBus = new AgentEventBus();
    const ledgerTb = new LedgerToolbox(); // the NESTED agent's real tools
    const displayTb = new PipelineToolbox(); // the pipeline's DISPLAY surface

    const step = new AgentStep<string, string>({
      name: "insights",
      agent: agentWithLedger(ledgerTb),
      prompt: (q) => q,
    });
    const promoted = asAgent(step, { role: pipelineDisplayRole(displayTb) });

    const registration: AgentRegistration = {
      id: "insights-pipe",
      name: "Insights Pipe",
      description: "ledger insights",
      agent: promoted,
      runner: new NodeBackedRunner(ledgerDispatchingRunner(), eventBus),
    };
    const app = createServer({
      agents: [registration],
      adminService: stubAdminService(),
      eventBus,
      sseExporter: { connect: () => new ReadableStream(), disconnect: () => {} },
    });
    return { app, promoted, ledgerTb, displayTb };
  }

  it("GET /agents/:id/capabilities lists the displayRole's capability and its 2 tools (pre-fix: empty)", async () => {
    const { app } = setup();
    const res = await app.request("/agents/insights-pipe/capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      capabilities: Array<{ name: string; toolbox?: string; tools: Array<{ name: string }> }>;
    };
    expect(body.capabilities).toHaveLength(1);
    expect(body.capabilities[0]?.name).toBe("insights");
    expect(body.capabilities[0]?.toolbox).toBe("pipeline-surface");
    expect(body.capabilities[0]?.tools.map((t) => t.name).sort()).toEqual([
      "forecast",
      "summarize",
    ]);
  });

  it("GET /agents groups two pipelines promoted with the SAME Role into ONE role entry (pre-fix: two look-alike entries)", async () => {
    // Pre-fix each `asAgent` minted its own `{name}` literal, so N pipelines
    // sharing one Role produced N distinct catalog entries ("ledger-insights",
    // "ledger-insights-2", …) — the Universe page showed phantom roles. Reading
    // `displayRole` restores REFERENCE identity: one Role object, one entry.
    const eventBus = new AgentEventBus();
    const sharedRole = pipelineDisplayRole(new PipelineToolbox());
    const mk = (id: string): AgentRegistration => ({
      id,
      name: id,
      agent: asAgent(new FunctionStep<string, string>({ name: id, fn: (s) => s }), {
        role: sharedRole,
      }),
      runner: new NodeBackedRunner(ledgerDispatchingRunner(), eventBus),
    });
    const app = createServer({
      agents: [mk("pipe-a"), mk("pipe-b")],
      adminService: stubAdminService(),
      eventBus,
      sseExporter: { connect: () => new ReadableStream(), disconnect: () => {} },
    });

    const agentsBody = (await (await app.request("/agents")).json()) as Array<{
      id: string;
      role: { id: string; name: string } | null;
    }>;
    // Both instances point at the SAME role entry in the identity catalog.
    expect(agentsBody.map((a) => a.role?.id)).toEqual(["ledger-insights", "ledger-insights"]);
    expect(agentsBody.every((a) => a.role?.name === "Ledger Insights")).toBe(true);

    const roles = (await (await app.request("/roles")).json()) as Array<{
      id: string;
      agents: Array<{ id: string }>;
    }>;
    expect(roles).toHaveLength(1);
    expect(roles[0]?.agents.map((a) => a.id)).toEqual(["pipe-a", "pipe-b"]);
  });

  it("GET /agents/:id/composition renders the real role slots (persona + capabilities)", async () => {
    const { app } = setup();
    const res = await app.request("/agents/insights-pipe/composition");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      role: {
        name: string;
        defaultModel: string;
        persona: { text: string };
        capabilities: Array<{ name: string }>;
      };
    };
    expect(body.role.name).toBe("Ledger Insights");
    expect(body.role.defaultModel).toBe("mock");
    expect(body.role.persona.text).toContain("ledger insights pipeline");
    expect(body.role.capabilities.map((c) => c.name)).toEqual(["insights"]);
  });

  it("GET /roles and /capabilities catalog the promoted pipeline (the Universe pages)", async () => {
    const { app } = setup();

    const rolesRes = await app.request("/roles");
    const roles = (await rolesRes.json()) as Array<{
      id: string;
      name: string;
      defaultModel: string;
      agents: Array<{ id: string }>;
    }>;
    expect(roles).toHaveLength(1);
    expect(roles[0]?.name).toBe("Ledger Insights");
    // Pre-fix the narrow `{name}` role had no defaultModel — the catalog rendered "".
    expect(roles[0]?.defaultModel).toBe("mock");
    expect(roles[0]?.agents.map((a) => a.id)).toEqual(["insights-pipe"]);

    const capsRes = await app.request("/capabilities");
    const caps = (await capsRes.json()) as Array<{
      name: string;
      toolbox: { name: string };
      usedBy: { agents: string[] };
    }>;
    expect(caps).toHaveLength(1);
    expect(caps[0]?.name).toBe("insights");
    expect(caps[0]?.toolbox.name).toBe("pipeline-surface");
    expect(caps[0]?.usedBy.agents).toEqual(["insights-pipe"]);
  });

  // -------------------------------------------------------------------------
  // THE REGRESSION GUARD (#13/#241). displayRole must NOT re-arm the outer
  // executor. If it did, the conversation route would set it as
  // `RunOptions.toolExecutor`, it would ride NodeBackedRunner → ctx.toolExecutor
  // and SHADOW the AgentStep's own derivation — so the nested ledger agent would
  // dispatch into the PIPELINE's toolbox (which has no `getBalance`) instead of
  // its own. The toolbox split makes that failure loud rather than coincidental.
  // -------------------------------------------------------------------------

  it("does NOT re-arm the outer executor: deriveToolboxExecutor still returns undefined for a displayRole-bearing promoted agent", () => {
    const { promoted } = setup();
    // The registered `role` is narrow; `displayRole` is where the capability
    // lives — and the executor derivation reads the former, by design.
    expect(deriveToolboxExecutor(promoted)).toBeUndefined();
    expect(promoted.role).toEqual({ name: "Ledger Insights" });
    expect(promoted.displayRole?.capabilities).toHaveLength(1);
    expect(promoted.getTools()).toEqual([]);
  });

  it("nested tool dispatch still works exactly as #241 proves — the inner agent's OWN tool runs, the display toolbox never does", async () => {
    const { app, ledgerTb, displayTb } = setup();

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "insights-pipe" }),
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

    // The NESTED agent's own tool ran (the AgentStep derived its executor) …
    expect(ledgerTb.ran).toBe(1);
    expect(sseBody).toContain("balance is 42");
    expect(sseBody).not.toContain("not found");
    // … and the pipeline's DISPLAY toolbox was never armed for execution.
    expect(displayTb.ran).toBe(0);
  });
});
