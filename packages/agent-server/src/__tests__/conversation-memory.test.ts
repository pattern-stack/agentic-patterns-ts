/**
 * Server integration tests for #444 (playground memory wiring — turn-1
 * recall through the host bag). Harness cloned from
 * `conversation-scope.test.ts` (#308's precedent): real HTTP/SSE chat
 * through `createServer`, a `RunnerProtocol`-shaped streaming runner that
 * CAPTURES `RunOptions.host` (the seam the real runners narrow into
 * `RenderContext` — that half is pinned by the runtime's own
 * `renderInitialPrompt recall relay (#444)` tests).
 *
 * Covers: turn-1 assembly populates `host.recall` from seeded records ·
 * assembly is one-shot (second turn re-renders the SAME block, no re-fetch)
 * · empty store leaves the bag recall-less (rendering byte-identical) ·
 * `agent.memory.recall` reaches the shared bus · scope derivation runs
 * against the PARSED effective context · invalid derivations 502 at
 * creation · memory-less registrations keep hostless behavior byte-identically.
 */

import {
  Agent,
  Mission,
  Persona,
  RoleBuilder,
  scopeItem,
  sessionScope,
} from "@pattern-stack/agentic-core";
import { AgentEventBus, InMemoryMemoryStore, createEvent } from "@pattern-stack/agentic-runtime";
import type {
  AgentEvent,
  AgentLike,
  MemoryStore,
  RunOptions,
  RunResult,
} from "@pattern-stack/agentic-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createServer } from "../app.js";
import type { AgentRegistration, ServerConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal full core Agent — memory delivery is host-side; no tools needed. */
function plainAgent(name = "memory-subject"): Agent {
  const role = new RoleBuilder(name)
    .withPersona(
      new Persona({ identity: "a test subject", tone: "direct", priorities: [], principles: [] }),
    )
    .withDefaultModel("mock")
    .build();
  return new Agent({
    role,
    mission: new Mission({ objective: "n/a", successCriteria: [], constraints: [] }),
  });
}

/**
 * A streaming runner that records every `RunOptions.host` it receives — the
 * exact value the real runners' `_renderCtx` narrows. Captured by REFERENCE
 * plus a per-call snapshot of `host.recall`, so tests can distinguish "the
 * bag was populated before this turn" from later mutation.
 */
function hostCapturingRunner(captured: Array<{ host: unknown; recallAtCall: unknown }>): {
  runner: AgentRegistration["runner"];
} {
  return {
    runner: {
      async run(): Promise<RunResult> {
        throw new Error("unused — Conversation.stream() drives .stream()");
      },
      async *stream(
        agent: AgentLike,
        _message: string,
        opts?: RunOptions,
      ): AsyncGenerator<AgentEvent> {
        captured.push({
          host: opts?.host,
          recallAtCall: (opts?.host as { recall?: string } | undefined)?.recall,
        });
        const traceId = opts?.traceId ?? "trace-x";
        const runId = `run-${captured.length}`;
        yield createEvent("agent.message.start", { traceId, runId, agentName: agent.role.name });
        yield createEvent("agent.message.complete", {
          traceId,
          runId,
          content: "ok",
          inputTokens: 0,
          outputTokens: 0,
          model: agent.getModel() ?? "",
        });
      },
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

function makeConfig(agents: AgentRegistration[], eventBus: AgentEventBus): ServerConfig {
  return {
    agents,
    adminService: stubAdminService(),
    eventBus,
    sseExporter: { connect: () => new ReadableStream(), disconnect: () => {} },
  };
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const SCOPE = { user: "dug", agent: "companion" };

/**
 * The first user message on every turn-1-recall test — deliberately sharing a
 * whole content token with each fixture's seed (`espresso`, `tea`).
 *
 * This used to be `"what do I drink?"`, which shares NO content word with
 * `"Doug takes espresso, no milk."` and retrieved it only because
 * `InMemoryMemoryStore` matched SUBSTRINGS: the query token `do` was a
 * substring of `Doug`, and `i` a substring of `likes`. These tests are about
 * turn-1 recall reaching the host bag, not about retrieval quality, so they
 * were silently resting on a store bug — ADR-0009 D-3 removed it (one shared
 * `tokenize()`, whole-token matching on both shipped backends) and the probe
 * has to actually overlap now.
 */
const RECALL_PROBE = "what do I drink — espresso or tea?";

/** Seed the partition with one preference + one unrelated-scope record. */
async function seededStore(): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  await store.write([
    { scope: SCOPE, kind: "preference", content: "Doug takes espresso, no milk." },
    { scope: { user: "someone-else" }, kind: "fact", content: "Unrelated partition record." },
  ]);
  return store;
}

async function createConversation(
  app: ReturnType<typeof createServer>,
  agentId: string,
  scope?: Record<string, unknown>,
): Promise<{ status: number; id: string }> {
  const res = await app.request("/conversations", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ agent_id: agentId, ...(scope ? { scope } : {}) }),
  });
  const body = (await res.json()) as { id?: string };
  return { status: res.status, id: body.id ?? "" };
}

async function postMessage(
  app: ReturnType<typeof createServer>,
  id: string,
  content: string,
): Promise<string> {
  const res = await app.request(`/conversations/${id}/messages`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content }),
  });
  return res.text();
}

// ---------------------------------------------------------------------------
// Turn-1 recall through the host bag
// ---------------------------------------------------------------------------

describe("memory-declaring registration — turn-1 recall (#444)", () => {
  it("assembles once at first-message time, populates host.recall, and keeps it for later turns", async () => {
    const store = await seededStore();
    let searchCalls = 0;
    const countingStore: MemoryStore = {
      write: (i) => store.write(i),
      search: (q) => {
        searchCalls += 1;
        return store.search(q);
      },
      get: (id) => store.get(id),
      invalidate: (id, reason) => store.invalidate(id, reason),
      delete: (id) => store.delete(id),
      capabilities: () => store.capabilities(),
    };

    const captured: Array<{ host: unknown; recallAtCall: unknown }> = [];
    const eventBus = new AgentEventBus();
    const app = createServer(
      makeConfig(
        [
          {
            id: "companion",
            name: "Companion",
            agent: plainAgent(),
            memory: { store: countingStore, scope: SCOPE },
            ...hostCapturingRunner(captured),
          },
        ],
        eventBus,
      ),
    );

    const recallEvents: AgentEvent[] = [];
    eventBus.subscribe("agent.memory.recall", (e) => {
      recallEvents.push(e as AgentEvent);
    });

    const { status, id } = await createConversation(app, "companion");
    expect(status).toBe(201);

    // No search happens at creation — recall waits for the first user text.
    expect(searchCalls).toBe(0);

    const firstBody = await postMessage(app, id, RECALL_PROBE);

    const first = captured[0];
    expect(first).toBeDefined();
    expect(first?.recallAtCall).toContain("## Recalled Memories");
    expect(first?.recallAtCall).toContain("Doug takes espresso, no milk.");
    // The other partition's record never crosses the scope boundary.
    expect(first?.recallAtCall).not.toContain("Unrelated partition record.");

    // Route-owned emission, both sinks: `publish()` on the shared bus
    // (asserted via direct subscription — NOTE: no built-in exporter
    // implements a memory.recall handler yet, so this pins the bus contract
    // only), AND the SSE frame written onto THIS turn's stream so the chat
    // surface sees recall arrive. traceId groups by conversation (m4).
    expect(recallEvents).toHaveLength(1);
    expect((recallEvents[0] as { count?: number }).count).toBe(1);
    expect(recallEvents[0]?.traceId).toBe(id);
    expect(firstBody).toContain("memory.recall");

    const searchesAfterFirstTurn = searchCalls;
    expect(searchesAfterFirstTurn).toBeGreaterThan(0);

    // Second turn: NO re-assembly (one-shot latch), same block still on the bag.
    await postMessage(app, id, "and to eat?");
    expect(searchCalls).toBe(searchesAfterFirstTurn);
    expect(recallEvents).toHaveLength(1);
    const second = captured[1];
    expect(second?.recallAtCall).toBe(first?.recallAtCall);
    // Same bag by reference across turns (Conversation holds _host verbatim).
    expect(second?.host).toBe(first?.host);
  });

  it("leaves the bag recall-less when the partition is empty (rendering byte-identical)", async () => {
    const captured: Array<{ host: unknown; recallAtCall: unknown }> = [];
    const app = createServer(
      makeConfig(
        [
          {
            id: "companion",
            name: "Companion",
            agent: plainAgent(),
            memory: { store: new InMemoryMemoryStore(), scope: SCOPE },
            ...hostCapturingRunner(captured),
          },
        ],
        new AgentEventBus(),
      ),
    );

    const { id } = await createConversation(app, "companion");
    await postMessage(app, id, "anything?");

    expect(captured[0]?.recallAtCall).toBeUndefined();
    // The bag itself exists (memory-declared) — only `recall` is absent.
    expect(captured[0]?.host).toBeDefined();
    expect("recall" in (captured[0]?.host as Record<string, unknown>)).toBe(false);
  });

  it("derives the memory scope from the PARSED effective context, once, at creation", async () => {
    const store = await seededStore();
    const derivationArgs: Array<Record<string, unknown> | undefined> = [];
    const captured: Array<{ host: unknown; recallAtCall: unknown }> = [];
    const app = createServer(
      makeConfig(
        [
          {
            id: "companion",
            name: "Companion",
            agent: plainAgent(),
            scope: sessionScope({
              user: scopeItem(z.string().default("dug"), { description: "who" }),
            }),
            memory: {
              store,
              scope: (ctx) => {
                derivationArgs.push(ctx);
                return { user: String(ctx?.user), agent: "companion" };
              },
            },
            ...hostCapturingRunner(captured),
          },
        ],
        new AgentEventBus(),
      ),
    );

    const { status, id } = await createConversation(app, "companion");
    expect(status).toBe(201);
    // Derivation ran exactly once, at creation, on the zod-parsed value
    // (the default applied — the caller sent no scope at all).
    expect(derivationArgs).toEqual([{ user: "dug" }]);

    await postMessage(app, id, RECALL_PROBE);
    expect(captured[0]?.recallAtCall).toContain("espresso");
    expect(derivationArgs).toHaveLength(1);
  });

  it("502s at creation when the derivation returns an empty scope (unscoped search, ADR-0007)", async () => {
    const app = createServer(
      makeConfig(
        [
          {
            id: "companion",
            name: "Companion",
            agent: plainAgent(),
            memory: { store: new InMemoryMemoryStore(), scope: () => ({}) },
            ...hostCapturingRunner([]),
          },
        ],
        new AgentEventBus(),
      ),
    );

    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "companion" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("memory scope");
  });

  it("502s at creation when the derivation throws", async () => {
    const app = createServer(
      makeConfig(
        [
          {
            id: "companion",
            name: "Companion",
            agent: plainAgent(),
            memory: {
              store: new InMemoryMemoryStore(),
              scope: () => {
                throw new Error("boom");
              },
            },
            ...hostCapturingRunner([]),
          },
        ],
        new AgentEventBus(),
      ),
    );

    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "companion" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("boom");
  });

  it("502s at creation when the derivation returns a non-string value (Gate 2.5 M5)", async () => {
    const app = createServer(
      makeConfig(
        [
          {
            id: "companion",
            name: "Companion",
            agent: plainAgent(),
            memory: {
              store: new InMemoryMemoryStore(),
              scope: () => ({ user: 123 }) as unknown as Record<string, string>,
            },
            ...hostCapturingRunner([]),
          },
        ],
        new AgentEventBus(),
      ),
    );

    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "companion" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("memory scope");
  });

  it("502s at creation for a STATIC empty scope map (same check, non-fn path)", async () => {
    const app = createServer(
      makeConfig(
        [
          {
            id: "companion",
            name: "Companion",
            agent: plainAgent(),
            memory: { store: new InMemoryMemoryStore(), scope: {} },
            ...hostCapturingRunner([]),
          },
        ],
        new AgentEventBus(),
      ),
    );

    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "companion" }),
    });
    expect(res.status).toBe(502);
  });

  it("502s at creation for a non-positive-integer budgetChars (Gate 2.5 m3/M1 — fail loud, not a dead latch)", async () => {
    const app = createServer(
      makeConfig(
        [
          {
            id: "companion",
            name: "Companion",
            agent: plainAgent(),
            memory: { store: new InMemoryMemoryStore(), scope: SCOPE, budgetChars: 0 },
            ...hostCapturingRunner([]),
          },
        ],
        new AgentEventBus(),
      ),
    );

    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "companion" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("budgetChars");
  });

  it("a memory-only registration ACCEPTS a caller scope and feeds it to the derivation (Gate 2.5 m5)", async () => {
    const store = new InMemoryMemoryStore();
    await store.write([
      {
        scope: { user: "guest", agent: "companion" },
        kind: "preference",
        content: "Guest likes tea.",
      },
    ]);
    const derivationArgs: Array<Record<string, unknown> | undefined> = [];
    const captured: Array<{ host: unknown; recallAtCall: unknown }> = [];
    const app = createServer(
      makeConfig(
        [
          {
            id: "companion",
            name: "Companion",
            agent: plainAgent(),
            // NO instantiate hook, NO SessionScope — memory alone must accept context.
            memory: {
              store,
              scope: (ctx) => {
                derivationArgs.push(ctx);
                return { user: String(ctx?.user ?? "local"), agent: "companion" };
              },
            },
            ...hostCapturingRunner(captured),
          },
        ],
        new AgentEventBus(),
      ),
    );

    const res = await app.request("/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agent_id: "companion", scope: { user: "guest" } }),
    });
    expect(res.status).toBe(201);
    expect(derivationArgs).toEqual([{ user: "guest" }]);

    const { id } = (await res.json()) as { id: string };
    await postMessage(app, id, RECALL_PROBE);
    expect(captured[0]?.recallAtCall).toContain("Guest likes tea.");
  });

  it("a recall-assembly failure is best-effort: the turn still streams, without recall", async () => {
    const broken: MemoryStore = {
      write: async () => {
        throw new Error("down");
      },
      search: async () => {
        throw new Error("down");
      },
      get: async () => null,
      invalidate: async () => {},
      delete: async () => {},
      capabilities: async () => ({ search: "keyword" as const }),
    };
    const captured: Array<{ host: unknown; recallAtCall: unknown }> = [];
    const app = createServer(
      makeConfig(
        [
          {
            id: "companion",
            name: "Companion",
            agent: plainAgent(),
            memory: { store: broken, scope: SCOPE },
            ...hostCapturingRunner(captured),
          },
        ],
        new AgentEventBus(),
      ),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { id } = await createConversation(app, "companion");
      const body = await postMessage(app, id, "hello");

      expect(body).toContain("message.complete");
      expect(captured[0]?.recallAtCall).toBeUndefined();
      // Best-effort means LOGGED, never silent (Gate 2.5 N4).
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("recall assembly failed"),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Control: memory-less registrations are byte-identical to before
// ---------------------------------------------------------------------------

describe("memory-less registration — hostless behavior unchanged", () => {
  it("passes NO host bag when the registration declares neither scope nor memory", async () => {
    const captured: Array<{ host: unknown; recallAtCall: unknown }> = [];
    const app = createServer(
      makeConfig(
        [{ id: "plain", name: "Plain", agent: plainAgent(), ...hostCapturingRunner(captured) }],
        new AgentEventBus(),
      ),
    );

    const { id } = await createConversation(app, "plain");
    await postMessage(app, id, "hello");

    expect(captured[0]?.host).toBeUndefined();
  });
});
