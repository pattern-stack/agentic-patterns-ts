/**
 * PR-1 server integration tests for #268 (playground run-scope: per-conversation
 * `instantiate(context)` binding + run-metadata stamping). Harness modeled on
 * `promoted-agent.test.ts:137-145` — real HTTP/SSE chat through `createServer`
 * against a `RunStore` + `RunStoreExporter` on a shared bus, not route unit
 * stubs, so the actual `app.ts` wiring (incl. the new `runStore` thread into
 * `conversationRoutes`) is exercised end-to-end.
 *
 * Covers the spec's PR-1 test plan (`.ai-docs/specs/playground-run-scope.md`
 * § Test plan, items 1-10) one describe block per item.
 */

import { Agent, Capability, Mission, Persona, RoleBuilder, Toolbox } from "@agentic-patterns/core";
import {
  AgentEventBus,
  FunctionStep,
  MockRunner,
  NodeBackedRunner,
  RunStore,
  RunStoreExporter,
  asAgent,
  createEvent,
  depKey,
  isPromotedAgent,
  provideDeps,
} from "@agentic-patterns/runtime";
import type { AgentEvent, AgentLike, RunOptions, RunResult } from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer } from "../app.js";
import type { AgentRegistration, ServerConfig } from "../config.js";
import { type ConversationEntry, conversationRoutes } from "../routes/conversations.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real Toolbox whose one tool reports the tenant closed over at build time. */
class WhoAmIToolbox extends Toolbox {
  readonly name = "identity";
  readonly description = "reports the bound tenant";
  readonly tools: Toolbox["tools"];

  constructor(tenant: string) {
    super();
    this.tools = {
      whoami: {
        description: "who am I bound as",
        parameters: z.object({}),
        execute: async () => ({ tenant }),
      },
    };
  }
}

/** A full core Agent whose ONLY capability answers `whoami` with the given tenant. */
function agentForTenant(tenant: string): Agent {
  const role = new RoleBuilder(`tenant-${tenant}`)
    .withPersona(
      new Persona({
        identity: "reports its bound tenant",
        tone: "direct",
        priorities: ["accuracy"],
        principles: ["answer with the bound tenant"],
      }),
    )
    .withCapability(new Capability("identity", "identity lookup", new WhoAmIToolbox(tenant)))
    .withDefaultModel("mock")
    .build();
  return new Agent({
    role,
    mission: new Mission({
      objective: "report the bound tenant",
      successCriteria: ["reported"],
      constraints: [],
    }),
  });
}

/** A full core Agent with NO capabilities — the capability-less control case. */
function bareAgent(name = "bare"): Agent {
  const role = new RoleBuilder(name)
    .withPersona(
      new Persona({
        identity: "a bare agent",
        tone: "direct",
        priorities: [],
        principles: [],
      }),
    )
    .withDefaultModel("mock")
    .build();
  return new Agent({
    role,
    mission: new Mission({ objective: "n/a", successCriteria: [], constraints: [] }),
  });
}

/**
 * A streaming runner (`RunnerProtocol`-shaped, no LLM) whose response is
 * DERIVED from whatever `whoami` tool the bound agent's executor exposes —
 * the pivot every "delivered instance's closures actually execute" test
 * hangs on. Mirrors `AgentRunner`/`NodeBackedRunner`'s own contract: publish
 * every event onto `opts.eventBus` (so `RunStoreExporter` sees it) as well
 * as yielding it to the caller.
 */
function whoAmIStreamingRunner(): AgentRegistration["runner"] {
  return {
    async run(): Promise<RunResult> {
      throw new Error("unused — Conversation.stream() drives .stream(), never .run()");
    },
    async *stream(
      agent: AgentLike,
      _message: string,
      opts?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      const traceId = opts?.traceId ?? `trace-${Math.random().toString(36).slice(2)}`;
      const runId = opts?.runId ?? `run-${Math.random().toString(36).slice(2)}`;
      const bus = opts?.eventBus;

      const startEvent = createEvent("agent.message.start", {
        traceId,
        runId,
        agentName: agent.role.name,
      });
      if (bus) await bus.publish(startEvent);
      yield startEvent;

      let content = "no tool executor";
      if (opts?.toolExecutor) {
        const result = (await opts.toolExecutor.execute("whoami", {})) as { tenant: string };
        content = `tenant is ${result.tenant}`;
      }

      const completeEvent = createEvent("agent.message.complete", {
        traceId,
        runId,
        content,
        inputTokens: 0,
        outputTokens: 0,
        model: agent.getModel() ?? "",
      });
      if (bus) await bus.publish(completeEvent);
      yield completeEvent;
    },
  };
}

/**
 * A streaming runner that fails mid-run — reproduces the exact shape
 * `Conversation.stream()` produces for a genuine runner/tool error: publish
 * `message.start`, publish a non-recoverable `agent.error` (so
 * `RunStoreExporter` finalizes the row as `status: 'error'`), THEN throw.
 * `Conversation.stream()` catches that throw, yields `agent.conversation.end`,
 * and re-throws — so the ROUTE's `for await` loop also throws, after the row
 * is already finalized. This is the repro for Gate 2.5 quality note 1.
 *
 * The error path never reaches the route's `done` SSE frame (that write sits
 * after the loop, which threw) — so the client-visible stream carries no
 * `run_id`. `capture`, when passed, receives the minted runId directly so a
 * test can look up the finalized row without depending on that frame.
 */
function erroringStreamingRunner(capture?: { runId?: string }): AgentRegistration["runner"] {
  return {
    async run(): Promise<RunResult> {
      throw new Error("unused — Conversation.stream() drives .stream(), never .run()");
    },
    async *stream(
      agent: AgentLike,
      _message: string,
      opts?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      const traceId = opts?.traceId ?? `trace-${Math.random().toString(36).slice(2)}`;
      const runId = opts?.runId ?? `run-${Math.random().toString(36).slice(2)}`;
      if (capture) capture.runId = runId;
      const bus = opts?.eventBus;

      const startEvent = createEvent("agent.message.start", {
        traceId,
        runId,
        agentName: agent.role.name,
      });
      if (bus) await bus.publish(startEvent);
      yield startEvent;

      const errorMessage = "boom — tool exploded mid-run";
      const errorEvent = createEvent("agent.error", {
        traceId,
        runId,
        errorType: "Error",
        message: errorMessage,
        recoverable: false,
        context: {},
      });
      if (bus) await bus.publish(errorEvent);
      yield errorEvent;

      throw new Error(errorMessage);
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

function makeConfig(
  agents: AgentRegistration[],
  opts: { eventBus?: AgentEventBus; runStore?: RunStore } = {},
): ServerConfig {
  return {
    agents,
    adminService: stubAdminService(),
    eventBus: opts.eventBus ?? new AgentEventBus(),
    sseExporter: { connect: () => new ReadableStream(), disconnect: () => {} },
    ...(opts.runStore ? { runStore: opts.runStore } : {}),
  };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function extractRunId(sseBody: string): string | undefined {
  return sseBody.match(/"run_id":"([^"]+)"/)?.[1];
}

// ---------------------------------------------------------------------------
// Test 1 — plain agent, hook rebinds closures
// ---------------------------------------------------------------------------

describe("plain agent — instantiate hook rebinds closures per conversation (test 1)", () => {
  it("two conversations with different contexts get demonstrably different tool results", async () => {
    const eventBus = new AgentEventBus();
    const registration: AgentRegistration = {
      id: "tenant-agent",
      name: "Tenant Agent",
      agent: agentForTenant("declared-should-never-run"),
      instantiate: async (ctx) => agentForTenant((ctx?.tenant as string) ?? "default"),
      runner: whoAmIStreamingRunner(),
    };
    const app = createServer(makeConfig([registration], { eventBus }));

    const createA = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "tenant-agent", context: { tenant: "acme" } }),
    });
    expect(createA.status).toBe(201);
    const { id: idA } = (await createA.json()) as { id: string };
    const msgA = await app.request(`/conversations/${idA}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "who are you?" }),
    });
    const bodyA = await msgA.text();

    const createB = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "tenant-agent", context: { tenant: "globex" } }),
    });
    const { id: idB } = (await createB.json()) as { id: string };
    const msgB = await app.request(`/conversations/${idB}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "who are you?" }),
    });
    const bodyB = await msgB.text();

    expect(bodyA).toContain("tenant is acme");
    expect(bodyA).not.toContain("tenant is globex");
    expect(bodyB).toContain("tenant is globex");
    expect(bodyB).not.toContain("tenant is acme");
  });
});

// ---------------------------------------------------------------------------
// Test 2 — promoted registration, deps resolved from context
// ---------------------------------------------------------------------------

describe("promoted registration — deps resolved from context (test 2)", () => {
  it("instantiate rebuilds via asAgent(node, { deps }); NodeBackedRunner reflects the per-conversation dep", async () => {
    const tenantKey = depKey<string>("tenant");
    const pipeline = new FunctionStep<string, string>({
      name: "whoami",
      fn: (_input, _slots, ctx) => `tenant: ${ctx.deps?.getOptional(tenantKey) ?? "none"}`,
    });

    function promoteForTenant(tenant: string) {
      return asAgent(pipeline, {
        role: { name: "Tenant Pipe" },
        deps: provideDeps([[tenantKey, tenant]]).build(),
      });
    }

    // The rebuilt instance is still a genuine PromotedAgent — NodeBackedRunner
    // would otherwise fail loud (as-agent.ts:222-226).
    expect(isPromotedAgent(promoteForTenant("acme"))).toBe(true);

    const eventBus = new AgentEventBus();
    const registration: AgentRegistration = {
      id: "tenant-pipe",
      name: "Tenant Pipe",
      agent: promoteForTenant("declared-should-never-run"),
      instantiate: async (ctx) => promoteForTenant((ctx?.tenant as string) ?? "default"),
      runner: new NodeBackedRunner(
        {
          async run() {
            throw new Error("unused — the pipeline never delegates to the inner runner");
          },
        },
        eventBus,
      ),
    };

    const app = createServer(makeConfig([registration], { eventBus }));

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "tenant-pipe", context: { tenant: "acme" } }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const msgRes = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "hello" }),
    });
    expect(msgRes.status).toBe(200);
    const sseBody = await msgRes.text();
    expect(sseBody).toContain("tenant: acme");
  });
});

// ---------------------------------------------------------------------------
// Test 3 — create response echoes effective context
// ---------------------------------------------------------------------------

describe("create response echoes the effective context (test 3)", () => {
  function hookedRegistration(defaults?: Record<string, unknown>): AgentRegistration {
    return {
      id: "hooked",
      name: "Hooked",
      agent: agentForTenant("declared"),
      instantiate: async (ctx) => agentForTenant((ctx?.tenant as string) ?? "default"),
      ...(defaults ? { instantiateDefaults: defaults } : {}),
      runner: new MockRunner(),
    };
  }

  it("echoes an explicit context verbatim", async () => {
    const app = createServer(makeConfig([hookedRegistration()]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hooked", context: { tenant: "acme" } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { context: unknown };
    expect(body.context).toEqual({ tenant: "acme" });
  });

  it("falls back to instantiateDefaults when context is omitted", async () => {
    const app = createServer(makeConfig([hookedRegistration({ tenant: "default-tenant" })]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hooked" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { context: unknown };
    expect(body.context).toEqual({ tenant: "default-tenant" });
  });

  it("is null when the hook has no defaults and none was supplied", async () => {
    const app = createServer(makeConfig([hookedRegistration()]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hooked" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { context: unknown };
    expect(body.context).toBeNull();
  });

  it("a hook that mutates its received context does not corrupt instantiateDefaults for later conversations (Gate 2.5 note 2)", async () => {
    // A hook receiving `reg.instantiateDefaults` BY REFERENCE could mutate the
    // shared object; the route must hand it a defensive shallow copy instead.
    // Record what each invocation OBSERVED (before it mutates) — the
    // discriminating signal: pre-fix, call 2 would observe call 1's
    // mutation ("MUTATED") because both calls shared one object; post-fix,
    // every call observes the pristine default.
    const observedTenants: unknown[] = [];
    const mutatingRegistration: AgentRegistration = {
      id: "mutating",
      name: "Mutating",
      agent: agentForTenant("declared"),
      instantiate: async (ctx) => {
        observedTenants.push(ctx?.tenant);
        if (ctx) {
          (ctx as Record<string, unknown>).tenant = "MUTATED";
        }
        return agentForTenant((ctx?.tenant as string) ?? "default");
      },
      instantiateDefaults: { tenant: "default-tenant" },
      runner: new MockRunner(),
    };
    const app = createServer(makeConfig([mutatingRegistration]));

    const first = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "mutating" }),
    });
    expect(first.status).toBe(201);

    const second = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "mutating" }),
    });
    expect(second.status).toBe(201);

    expect(observedTenants).toEqual(["default-tenant", "default-tenant"]);
    // The shared registration object itself is never touched.
    expect(mutatingRegistration.instantiateDefaults).toEqual({ tenant: "default-tenant" });
  });
});

// ---------------------------------------------------------------------------
// Test 4 — 400s
// ---------------------------------------------------------------------------

describe("400s (test 4)", () => {
  const hooked: AgentRegistration = {
    id: "hooked",
    name: "Hooked",
    agent: agentForTenant("declared"),
    instantiate: async (ctx) => agentForTenant((ctx?.tenant as string) ?? "default"),
    runner: new MockRunner(),
  };
  const hookless: AgentRegistration = {
    id: "hookless",
    name: "Hookless",
    agent: bareAgent(),
    runner: new MockRunner(),
  };

  it("rejects a non-object context", async () => {
    const app = createServer(makeConfig([hooked]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hooked", context: "oops" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an explicit null context", async () => {
    const app = createServer(makeConfig([hooked]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hooked", context: null }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects context for a hook-less registration", async () => {
    const app = createServer(makeConfig([hookless]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hookless", context: { tenant: "x" } }),
    });
    expect(res.status).toBe(400);
  });

  it("a hook-less registration's create response is byte-identical to before this feature (no `context` key)", async () => {
    const app = createServer(makeConfig([hookless]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hookless" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["agent_id", "id"]);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — 502, no conversation entry created
// ---------------------------------------------------------------------------

describe("502 — a rejecting instantiate hook creates no conversation entry (test 5)", () => {
  it("returns 502 with the instantiate-failed grammar and leaves the registry untouched", async () => {
    // Mounted directly (not via createServer) so the internal registry Map is
    // inspectable — the only way to observe "no entry was created".
    const eventBus = new AgentEventBus();
    const conversations = new Map<string, ConversationEntry>();
    const registration: AgentRegistration = {
      id: "rejecting",
      name: "Rejecting",
      agent: bareAgent(),
      instantiate: async () => {
        throw new Error("nope");
      },
      runner: new MockRunner(),
    };
    const app = new Hono();
    app.route(
      "/",
      conversationRoutes([registration], conversations, eventBus, undefined, undefined, undefined),
    );

    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "rejecting", context: { tenant: "x" } }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("instantiate failed");
    expect(body.error).toContain("nope");
    expect(conversations.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — executor derives from the DELIVERED instance, not the declared one
// ---------------------------------------------------------------------------

describe("executor derives from the delivered instance (test 6)", () => {
  it("declared capability-less + delivered with tools → the tool fires", async () => {
    const registration: AgentRegistration = {
      id: "swap-in",
      name: "Swap In",
      agent: bareAgent(),
      instantiate: async () => agentForTenant("acme"),
      runner: whoAmIStreamingRunner(),
    };
    const app = createServer(makeConfig([registration]));
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "swap-in" }),
    });
    const { id } = (await createRes.json()) as { id: string };
    const msgRes = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "hi" }),
    });
    const sseBody = await msgRes.text();
    expect(sseBody).toContain("tenant is acme");
  });

  it("declared with tools + delivered capability-less → no phantom executor (the tool never fires)", async () => {
    const registration: AgentRegistration = {
      id: "swap-out",
      name: "Swap Out",
      agent: agentForTenant("declared-should-never-run"),
      instantiate: async () => bareAgent(),
      runner: whoAmIStreamingRunner(),
    };
    const app = createServer(makeConfig([registration]));
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "swap-out" }),
    });
    const { id } = (await createRes.json()) as { id: string };
    const msgRes = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "hi" }),
    });
    const sseBody = await msgRes.text();
    expect(sseBody).toContain("no tool executor");
    expect(sseBody).not.toContain("tenant is");
  });
});

// ---------------------------------------------------------------------------
// Test 7 — run metadata stamped
// ---------------------------------------------------------------------------

describe("run metadata is stamped post-drain (test 7)", () => {
  let store: RunStore;

  afterEach(() => {
    store?.close();
  });

  it("GET /admin/runs/:id returns metadata.context equal to the echoed context; a second turn stamps its own run too", async () => {
    store = new RunStore({ path: ":memory:", Database });
    const eventBus = new AgentEventBus();
    new RunStoreExporter({ store }).attach(eventBus);

    const registration: AgentRegistration = {
      id: "tenant-agent",
      name: "Tenant Agent",
      agent: agentForTenant("declared-should-never-run"),
      instantiate: async (ctx) => agentForTenant((ctx?.tenant as string) ?? "default"),
      runner: whoAmIStreamingRunner(),
    };
    const app = createServer(makeConfig([registration], { eventBus, runStore: store }));

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "tenant-agent", context: { tenant: "acme" } }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; context: Record<string, unknown> };
    expect(created.context).toEqual({ tenant: "acme" });

    const msgRes1 = await app.request(`/conversations/${created.id}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "who are you?" }),
    });
    expect(msgRes1.status).toBe(200);
    const sseBody1 = await msgRes1.text();
    const runId1 = extractRunId(sseBody1);
    expect(runId1).toBeDefined();

    const runRes1 = await app.request(`/admin/runs/${runId1}`);
    expect(runRes1.status).toBe(200);
    const { run: run1 } = (await runRes1.json()) as {
      run: { metadata: Record<string, unknown> | null };
    };
    expect(run1.metadata?.context).toEqual({ tenant: "acme" });

    // A second turn on the SAME (immutable-scope) conversation stamps its OWN run.
    const msgRes2 = await app.request(`/conversations/${created.id}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "who are you again?" }),
    });
    const sseBody2 = await msgRes2.text();
    const runId2 = extractRunId(sseBody2);
    expect(runId2).toBeDefined();
    expect(runId2).not.toBe(runId1);

    const runRes2 = await app.request(`/admin/runs/${runId2}`);
    const { run: run2 } = (await runRes2.json()) as {
      run: { metadata: Record<string, unknown> | null };
    };
    expect(run2.metadata?.context).toEqual({ tenant: "acme" });
  });
});

// ---------------------------------------------------------------------------
// Gate 2.5 quality note 1 — errored/disconnected runs still get stamped
// ---------------------------------------------------------------------------

describe("run metadata is stamped even when the turn errors mid-run (Gate 2.5 note 1)", () => {
  let store: RunStore;

  afterEach(() => {
    store?.close();
  });

  it("a throwing runner still leaves an error-status run row with metadata.context stamped", async () => {
    store = new RunStore({ path: ":memory:", Database });
    const eventBus = new AgentEventBus();
    new RunStoreExporter({ store }).attach(eventBus);

    const capture: { runId?: string } = {};
    const registration: AgentRegistration = {
      id: "erroring-agent",
      name: "Erroring Agent",
      agent: agentForTenant("declared-should-never-run"),
      instantiate: async (ctx) => agentForTenant((ctx?.tenant as string) ?? "default"),
      runner: erroringStreamingRunner(capture),
    };
    const app = createServer(makeConfig([registration], { eventBus, runStore: store }));

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "erroring-agent", context: { tenant: "acme" } }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; context: Record<string, unknown> };
    expect(created.context).toEqual({ tenant: "acme" });

    // Headers commit as soon as streamSSE starts (200), even though the
    // callback throws partway through — draining the (short) body is what
    // lets the route's `finally` actually run and complete before we assert.
    const msgRes = await app.request(`/conversations/${created.id}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "who are you?" }),
    });
    expect(msgRes.status).toBe(200);
    await msgRes.text();

    const runId = capture.runId;
    expect(runId).toBeDefined();

    const runRes = await app.request(`/admin/runs/${runId}`);
    expect(runRes.status).toBe(200);
    const { run } = (await runRes.json()) as {
      run: { status: string; metadata: Record<string, unknown> | null };
    };
    // The row is finalized as errored (RunStoreExporter._onError) …
    expect(run.status).toBe("error");
    // … AND still carries the context stamp — the actual gap Fix 1 closes.
    expect(run.metadata?.context).toEqual({ tenant: "acme" });
  });
});

// ---------------------------------------------------------------------------
// Test 8 — redaction
// ---------------------------------------------------------------------------

describe("redaction (test 8)", () => {
  let store: RunStore;

  afterEach(() => {
    store?.close();
  });

  it("redacts declared keys on the create response AND run metadata; the raw value touches the store nowhere", async () => {
    store = new RunStore({ path: ":memory:", Database });
    const eventBus = new AgentEventBus();
    new RunStoreExporter({ store }).attach(eventBus);

    const registration: AgentRegistration = {
      id: "redacting",
      name: "Redacting",
      agent: agentForTenant("declared"),
      instantiate: async (ctx) => agentForTenant((ctx?.tenant as string) ?? "default"),
      contextRedactKeys: ["userId"],
      runner: whoAmIStreamingRunner(),
    };
    const app = createServer(makeConfig([registration], { eventBus, runStore: store }));

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        agent_id: "redacting",
        context: { tenant: "acme", userId: "secret-u1" },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      context: Record<string, unknown>;
      context_redacted: string[];
    };
    expect(created.context).toEqual({ tenant: "acme", userId: "[redacted]" });
    expect(created.context_redacted).toEqual(["userId"]);
    expect(JSON.stringify(created)).not.toContain("secret-u1");

    const msgRes = await app.request(`/conversations/${created.id}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "who are you?" }),
    });
    const sseBody = await msgRes.text();
    // The DELIVERED instance still received the RAW context (redaction is a
    // display/persistence concern only) — the tool answers the real tenant.
    expect(sseBody).toContain("tenant is acme");
    const runId = extractRunId(sseBody);
    expect(runId).toBeDefined();

    const runRes = await app.request(`/admin/runs/${runId}`);
    const { run } = (await runRes.json()) as {
      run: { metadata: Record<string, unknown> | null };
    };
    expect(run.metadata?.context).toEqual({ tenant: "acme", userId: "[redacted]" });
    expect(run.metadata?.context_redacted).toEqual(["userId"]);

    // The raw value appears nowhere in the store — assert on the raw row.
    const rawRow = store.getRun(runId as string);
    expect(JSON.stringify(rawRow)).not.toContain("secret-u1");
  });
});

// ---------------------------------------------------------------------------
// Test 9 — no-store degradation
// ---------------------------------------------------------------------------

describe("no run store wired — chat works, no stamp, no error (test 9)", () => {
  it("completes the SSE stream normally with no runStore configured", async () => {
    const eventBus = new AgentEventBus();
    const registration: AgentRegistration = {
      id: "no-store",
      name: "No Store",
      agent: agentForTenant("declared-should-never-run"),
      instantiate: async (ctx) => agentForTenant((ctx?.tenant as string) ?? "default"),
      runner: whoAmIStreamingRunner(),
    };
    const app = createServer(makeConfig([registration], { eventBus })); // no runStore

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "no-store", context: { tenant: "acme" } }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const msgRes = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "hi" }),
    });
    expect(msgRes.status).toBe(200);
    const sseBody = await msgRes.text();
    expect(sseBody).toContain("tenant is acme");
    expect(sseBody).toContain("event: done");
  });
});

// ---------------------------------------------------------------------------
// Test 10 — GET /agents instantiation availability
// ---------------------------------------------------------------------------

describe("GET /agents — instantiation availability (test 10)", () => {
  it("reports available+defaults for a hook-bearing registration, unavailable+null for a hook-less one", async () => {
    const hooked: AgentRegistration = {
      id: "hooked",
      name: "Hooked",
      agent: agentForTenant("declared"),
      instantiate: async () => agentForTenant("x"),
      instantiateDefaults: { tenant: "default-tenant" },
      runner: new MockRunner(),
    };
    const hookless: AgentRegistration = {
      id: "hookless",
      name: "Hookless",
      agent: bareAgent(),
      runner: new MockRunner(),
    };
    const app = createServer(makeConfig([hooked, hookless]));

    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      instantiation: { available: boolean; defaults: Record<string, unknown> | null };
    }>;

    expect(body.find((a) => a.id === "hooked")?.instantiation).toEqual({
      available: true,
      defaults: { tenant: "default-tenant" },
    });
    expect(body.find((a) => a.id === "hookless")?.instantiation).toEqual({
      available: false,
      defaults: null,
    });
  });
});
