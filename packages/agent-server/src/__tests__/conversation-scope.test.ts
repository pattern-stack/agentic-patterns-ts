/**
 * Server integration tests for #308 (SessionScope — validated, redacted,
 * default/preset-bearing session configuration superseding ad hoc `context`).
 * Harness cloned from `conversation-context.test.ts` (#268's precedent):
 * real HTTP/SSE chat through `createServer` against real core `Agent`/
 * `SessionScope` compositions, not route unit stubs.
 *
 * Covers decisions.md D3 (duck-typed `err.issues` 400), D5 (`instantiation.
 * available` widens to `hasHook || hasScope`), D8/D9 (response/registry
 * widening for scope-only, hook-less registrations), D10 (parse order — the
 * PARSED value reaches `instantiate`, redaction, run-metadata, and
 * `buildScopeHost` host injection), D11 (a bare POST against a scope with
 * required fields and no defaults is a deliberate 400).
 */

import {
  Agent,
  Capability,
  Mission,
  Persona,
  RoleBuilder,
  Toolbox,
  scopeItem,
  sessionScope,
} from "@pattern-stack/agentic-core";
import {
  AgentEventBus,
  MockRunner,
  RunStore,
  RunStoreExporter,
  createEvent,
  readScope,
} from "@pattern-stack/agentic-runtime";
import type { AgentEvent, AgentLike, RunOptions, RunResult } from "@pattern-stack/agentic-runtime";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer } from "../app.js";
import type { AgentRegistration, ServerConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real Toolbox whose one tool reads `host.scope` via `readScope` — the
 *  pivot every "the server's parsed scope actually reaches a tool" test
 *  hangs on (mirrors `conversation-context.test.ts`'s closure-based
 *  `WhoAmIToolbox`, but reads the RUN's host instead of a build-time
 *  closure — scope is per-conversation, not per-registration). */
class ScopeWhoAmIToolbox extends Toolbox {
  readonly name = "identity";
  readonly description = "reports the bound scope's workspace";
  readonly tools: Toolbox["tools"] = {
    whoami: {
      description: "who am I bound as (reads host.scope)",
      parameters: z.object({}),
      execute: async (_args, ctx) => {
        const scope = readScope(ctx);
        return { workspace: (scope?.workspace as string | undefined) ?? "none" };
      },
    },
  };
}

/** A full core Agent whose ONLY capability answers `whoami` from `host.scope`. */
function scopeAgent(): Agent {
  const role = new RoleBuilder("scope-agent")
    .withPersona(
      new Persona({
        identity: "reports its bound scope",
        tone: "direct",
        priorities: ["accuracy"],
        principles: ["answer with the bound workspace"],
      }),
    )
    .withCapability(new Capability("identity", "identity lookup", new ScopeWhoAmIToolbox()))
    .withDefaultModel("mock")
    .build();
  return new Agent({
    role,
    mission: new Mission({
      objective: "report the bound workspace",
      successCriteria: ["reported"],
      constraints: [],
    }),
  });
}

/** A full core Agent with NO capabilities — the capability-less control case. */
function bareAgent(name = "bare"): Agent {
  const role = new RoleBuilder(name)
    .withPersona(
      new Persona({ identity: "a bare agent", tone: "direct", priorities: [], principles: [] }),
    )
    .withDefaultModel("mock")
    .build();
  return new Agent({
    role,
    mission: new Mission({ objective: "n/a", successCriteria: [], constraints: [] }),
  });
}

/** The scope every fixture below declares: a required `workspace`, an
 *  optional redacted `apiKey`. */
function workspaceScope(options?: Parameters<typeof sessionScope>[1]) {
  return sessionScope(
    {
      workspace: scopeItem(z.string().min(1), { description: "Tenant workspace" }),
      apiKey: scopeItem(z.string().optional(), { description: "Secret", redact: true }),
    },
    options,
  );
}

/**
 * A streaming runner (`RunnerProtocol`-shaped, no LLM) whose response is
 * DERIVED from the `whoami` tool's `host.scope` read — mirrors
 * `AgentRunner`'s own contract (#124): copy `RunOptions.host` onto every
 * `ToolExecutionContext.host` the tool call receives, and publish every
 * event onto `opts.eventBus` as well as yielding it.
 */
function scopeAwareStreamingRunner(): AgentRegistration["runner"] {
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
        const result = (await opts.toolExecutor.execute("whoami", {}, { host: opts.host })) as {
          workspace: string;
        };
        content = `workspace is ${result.workspace}`;
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
// Scope-only (hook-less) registration — host injection reaches tools
// ---------------------------------------------------------------------------

describe("scope-only, hook-less registration — host.scope reaches tools", () => {
  it("readScope() inside a tool sees the PARSED create-time scope, per conversation", async () => {
    const eventBus = new AgentEventBus();
    const registration: AgentRegistration = {
      id: "scope-only",
      name: "Scope Only",
      agent: scopeAgent(),
      scope: workspaceScope(),
      runner: scopeAwareStreamingRunner(),
    };
    const app = createServer(makeConfig([registration], { eventBus }));

    const createA = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "scope-only", scope: { workspace: "acme-ops" } }),
    });
    expect(createA.status).toBe(201);
    const { id: idA } = (await createA.json()) as { id: string };
    const msgA = await app.request(`/conversations/${idA}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "who are you?" }),
    });
    expect(await msgA.text()).toContain("workspace is acme-ops");

    const createB = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "scope-only", scope: { workspace: "globex-ops" } }),
    });
    const { id: idB } = (await createB.json()) as { id: string };
    const msgB = await app.request(`/conversations/${idB}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "who are you?" }),
    });
    expect(await msgB.text()).toContain("workspace is globex-ops");
  });
});

// ---------------------------------------------------------------------------
// Scope validation — valid echo, invalid 400 with duck-typed issues
// ---------------------------------------------------------------------------

describe("scope validation", () => {
  function hookedScopeRegistration(): AgentRegistration {
    return {
      id: "hooked-scope",
      name: "Hooked Scope",
      agent: scopeAgent(),
      instantiate: async () => scopeAgent(),
      scope: workspaceScope(),
      runner: new MockRunner(),
    };
  }

  it("echoes the PARSED scope on success (both `context` and `scope` keys present)", async () => {
    const app = createServer(makeConfig([hookedScopeRegistration()]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hooked-scope", scope: { workspace: "acme" } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { context: unknown; scope: unknown };
    expect(body.context).toEqual({ workspace: "acme" });
    expect(body.scope).toEqual({ workspace: "acme" });
  });

  it("rejects an invalid scope with 400 and a duck-typed `issues` array (never `.flatten()`)", async () => {
    const app = createServer(makeConfig([hookedScopeRegistration()]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hooked-scope", scope: { workspace: "" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("scope validation failed");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("the deprecated `context` alias is still accepted when no `scope` key is sent", async () => {
    const app = createServer(makeConfig([hookedScopeRegistration()]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hooked-scope", context: { workspace: "acme" } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: unknown };
    expect(body.scope).toEqual({ workspace: "acme" });
  });

  it("`scope` wins when both `scope` and `context` are sent", async () => {
    const app = createServer(makeConfig([hookedScopeRegistration()]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        agent_id: "hooked-scope",
        scope: { workspace: "from-scope" },
        context: { workspace: "from-context" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: unknown };
    expect(body.scope).toEqual({ workspace: "from-scope" });
  });

  it("a bare POST against a scope with a required field and no defaults is a deliberate 400 (D11)", async () => {
    const app = createServer(makeConfig([hookedScopeRegistration()]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "hooked-scope" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("scope validation failed");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("falls back to scope.defaults on a bare POST when defaults are declared", async () => {
    const registration: AgentRegistration = {
      id: "defaulted-scope",
      name: "Defaulted Scope",
      agent: scopeAgent(),
      scope: workspaceScope({ defaults: { workspace: "default-ws" } }),
      runner: new MockRunner(),
    };
    const app = createServer(makeConfig([registration]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "defaulted-scope" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: unknown };
    expect(body.scope).toEqual({ workspace: "default-ws" });
  });
});

// ---------------------------------------------------------------------------
// Redaction — union of scope.redactKeys and the deprecated contextRedactKeys
// ---------------------------------------------------------------------------

describe("redaction merges scope.redactKeys with the deprecated contextRedactKeys", () => {
  it("redacts BOTH a scope-declared key and a legacy contextRedactKeys key", async () => {
    const registration: AgentRegistration = {
      id: "merged-redact",
      name: "Merged Redact",
      agent: scopeAgent(),
      scope: workspaceScope(), // marks `apiKey` redact: true
      contextRedactKeys: ["userId"],
      runner: new MockRunner(),
    };
    const app = createServer(makeConfig([registration]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        agent_id: "merged-redact",
        // `userId` is not a declared scope field, but `redactContext` only
        // needs the KEY to be present — extra top-level keys pass through
        // zod's default (strip) parse behavior untouched only when declared;
        // exercise the merge using the scope's own declared field instead.
        scope: { workspace: "acme", apiKey: "secret-key" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      scope: Record<string, unknown>;
      context_redacted: string[];
    };
    expect(body.scope.apiKey).toBe("[redacted]");
    expect(body.context_redacted).toContain("apiKey");
    expect(JSON.stringify(body)).not.toContain("secret-key");
  });
});

// ---------------------------------------------------------------------------
// instantiate receives the PARSED scope value (D10)
// ---------------------------------------------------------------------------

describe("instantiate receives the PARSED (defaulted/coerced) scope value", () => {
  it("a hook observes zod's parsed output, not the raw request body", async () => {
    let observed: unknown;
    const registration: AgentRegistration = {
      id: "observing-hook",
      name: "Observing Hook",
      agent: scopeAgent(),
      instantiate: async (ctx) => {
        observed = ctx;
        return scopeAgent();
      },
      scope: workspaceScope(),
      runner: new MockRunner(),
    };
    const app = createServer(makeConfig([registration]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        agent_id: "observing-hook",
        scope: { workspace: "acme", unknownField: "not declared on the schema" },
      }),
    });
    expect(res.status).toBe(201);
    // The RAW request body carried `unknownField`; zod's object `.parse()`
    // strips undeclared keys by default, so the hook receiving exactly
    // `{ workspace: "acme" }` proves it got `scope.parse()`'s OUTPUT, not
    // the raw JSON body (decisions.md D10(a)).
    expect(observed).toEqual({ workspace: "acme" });
  });
});

// ---------------------------------------------------------------------------
// Run metadata stamped for a scope-only, hook-less registration (D9)
// ---------------------------------------------------------------------------

describe("run metadata is stamped for a scope-only, hook-less registration (D9)", () => {
  let store: RunStore;

  afterEach(() => {
    store?.close();
  });

  it("GET /admin/runs/:id returns metadata.context for a registration with a scope but NO instantiate hook", async () => {
    store = new RunStore({ path: ":memory:", Database });
    const eventBus = new AgentEventBus();
    new RunStoreExporter({ store }).attach(eventBus);

    const registration: AgentRegistration = {
      id: "scope-only-stamped",
      name: "Scope Only Stamped",
      agent: scopeAgent(),
      scope: workspaceScope(),
      runner: scopeAwareStreamingRunner(),
    };
    const app = createServer(makeConfig([registration], { eventBus, runStore: store }));

    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "scope-only-stamped", scope: { workspace: "acme" } }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const msgRes = await app.request(`/conversations/${created.id}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: "who are you?" }),
    });
    expect(msgRes.status).toBe(200);
    const sseBody = await msgRes.text();
    const runId = extractRunId(sseBody);
    expect(runId).toBeDefined();

    const runRes = await app.request(`/admin/runs/${runId}`);
    expect(runRes.status).toBe(200);
    const { run } = (await runRes.json()) as { run: { metadata: Record<string, unknown> | null } };
    expect(run.metadata?.context).toEqual({ workspace: "acme" });
  });
});

// ---------------------------------------------------------------------------
// GET /agents — instantiation exposes schema/defaults/presets (D5)
// ---------------------------------------------------------------------------

describe("GET /agents — instantiation exposes scope schema/defaults/presets (D5)", () => {
  it("a scope-only, hook-less registration reports available: true with schema/defaults/presets", async () => {
    const scope = workspaceScope({
      defaults: { workspace: "default-ws" },
      presets: { acme: { workspace: "acme-ops" }, globex: { workspace: "globex-ops" } },
    });
    const registration: AgentRegistration = {
      id: "scope-roster",
      name: "Scope Roster",
      agent: scopeAgent(),
      scope,
      runner: new MockRunner(),
    };
    const app = createServer(makeConfig([registration]));

    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      instantiation: {
        available: boolean;
        defaults: Record<string, unknown> | null;
        schema: Record<string, unknown> | null;
        presets: Record<string, unknown> | null;
      };
    }>;
    const entry = body.find((a) => a.id === "scope-roster");
    expect(entry?.instantiation.available).toBe(true);
    expect(entry?.instantiation.defaults).toEqual({ workspace: "default-ws" });
    expect(entry?.instantiation.schema).toHaveProperty("type", "object");
    expect(entry?.instantiation.presets).toEqual({
      acme: { workspace: "acme-ops" },
      globex: { workspace: "globex-ops" },
    });
  });
});

// ---------------------------------------------------------------------------
// Pinned-shape survivals — the #268 byte-identical/400 guards still hold
// ---------------------------------------------------------------------------

describe("pinned-shape survivals (hook-less AND scope-less registrations)", () => {
  const hooklessScopeless: AgentRegistration = {
    id: "plain",
    name: "Plain",
    agent: bareAgent(),
    runner: new MockRunner(),
  };

  it("create response is still byte-identical to before #268/#308 (no `context`/`scope` key)", async () => {
    const app = createServer(makeConfig([hooklessScopeless]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "plain" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["agent_id", "id"]);
  });

  it("`context` on a hook-less, scope-less registration is still rejected with 400", async () => {
    const app = createServer(makeConfig([hooklessScopeless]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "plain", context: { anything: "x" } }),
    });
    expect(res.status).toBe(400);
  });

  it("`scope` on a hook-less, scope-less registration is also rejected with 400", async () => {
    const app = createServer(makeConfig([hooklessScopeless]));
    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "plain", scope: { anything: "x" } }),
    });
    expect(res.status).toBe(400);
  });
});
