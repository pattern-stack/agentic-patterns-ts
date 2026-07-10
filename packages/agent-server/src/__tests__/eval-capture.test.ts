/**
 * POST /eval/cases/from-session (spec `.ai-docs/stacks/eval-surface/specs/
 * 140.md` § Tests, T1-T6) + the capture -> run round-trip (T5, against #139's
 * `POST /eval/runs` mounted in the same `evalRoutes` app).
 *
 * Real in-memory-SQLite `EvalStore` (the `eval-run.test.ts` harness), fixture
 * `Conversation`s built with injected `history` — a stub `AgentLike` +
 * `MockRunner`, neither ever invoked since history is injected directly into
 * the constructor — registered in a `Map<string, ConversationEntry>` handed
 * to `evalRoutes`'s new `conversations` option.
 */

import {
  AgentEventBus,
  type AgentLike,
  Conversation,
  EvalStore,
  type Exchange,
  FunctionStep,
  MockRunner,
  asAgent,
} from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRegistration, EvalExecutionConfig } from "../config.js";
import type { ConversationEntry } from "../routes/conversations.js";
import { evalRoutes } from "../routes/eval.js";

// ---------------------------------------------------------------------------
// mkApp — extends eval-run.test.ts's mkApp with the `conversations` registry
// ---------------------------------------------------------------------------

function mkApp(opts: {
  evalStore: EvalStore | undefined;
  agents?: AgentRegistration[];
  evalExecution?: EvalExecutionConfig;
  conversations?: Map<string, ConversationEntry>;
}): Hono {
  const app = new Hono();
  app.route(
    "/",
    evalRoutes({
      evalStore: opts.evalStore,
      agents: opts.agents ?? [],
      eventBus: new AgentEventBus(),
      evalExecution: opts.evalExecution,
      conversations: opts.conversations,
    }),
  );
  return app;
}

// ---------------------------------------------------------------------------
// Response shape (file-local mirror — the route's own type isn't exported)
// ---------------------------------------------------------------------------

interface CaptureFromSessionResponse {
  setId: string;
  caseId: string;
  created: boolean;
  input: string;
  expected: string;
  tags: string[];
  split: "train" | "dev" | "test";
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkExchange(number: number, user: string, assistant: string): Exchange {
  return {
    number,
    invocationId: `inv-${number}`,
    user,
    assistant,
    toolCalls: [],
    inputTokens: 1,
    outputTokens: 1,
    timestamp: new Date(),
  };
}

/** A live conversation entry with injected history — runner/agent are never
 *  invoked by the capture route (it reads `conversation.history` directly). */
function makeConversationEntry(opts: { agentId: string; history: Exchange[] }): ConversationEntry {
  const agent: AgentLike = {
    role: { name: opts.agentId },
    getModel: () => "mock-model",
    getTools: () => [],
    renderInitialPrompt: () => "stub",
  };
  const conversation = new Conversation(agent, new MockRunner(), { history: opts.history });
  return { conversation, agentId: opts.agentId };
}

/** Promoted echo agent for the T5 round-trip — identity function. */
function makeEchoRegistration(id = "echo"): AgentRegistration {
  const node = new FunctionStep<string, string>({
    name: "echo",
    fn: (input: string) => input,
  });
  const agent = asAgent(node, { role: { name: id } });
  return { id, name: id, agent, runner: new MockRunner() };
}

async function waitForTerminal(evalStore: EvalStore, runId: string): Promise<void> {
  await vi.waitFor(() => {
    const run = evalStore.getEvalRun(runId);
    if (!run || run.status === "running") {
      throw new Error("still running");
    }
  });
}

// ---------------------------------------------------------------------------
// Store seeding
// ---------------------------------------------------------------------------

let store: EvalStore;

beforeEach(() => {
  store = new EvalStore({ path: ":memory:", Database });
  store.upsertEvalSet({ id: "bank", name: "Bank" });
});

afterEach(() => {
  store.close();
});

// ---------------------------------------------------------------------------
// T1 — happy path (defaults)
// ---------------------------------------------------------------------------

describe("POST /eval/cases/from-session — happy path (defaults)", () => {
  it("201s; echoes caseId/input/expected/split/tags from exchange 1; visible via GET /eval/sets/:id/cases", async () => {
    const conversationId = "conv-1";
    const agentId = "echo-agent";
    const history = [mkExchange(1, "hello", "hi there"), mkExchange(2, "how are you", "great")];
    const conversations = new Map<string, ConversationEntry>([
      [conversationId, makeConversationEntry({ agentId, history })],
    ]);
    const app = mkApp({ evalStore: store, conversations });

    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CaptureFromSessionResponse;
    expect(body.caseId).toBe(`session-${conversationId}-1`);
    expect(body.input).toBe("hello");
    expect(body.expected).toBe("hi there");
    expect(body.split).toBe("train");
    expect(body.tags).toEqual(["captured", `agent:${agentId}`]);
    expect(body.created).toBe(true);

    const casesRes = await app.request("/eval/sets/bank/cases");
    const casesBody = (await casesRes.json()) as { cases: Array<{ caseId: string }> };
    expect(casesBody.cases.map((c) => c.caseId)).toContain(body.caseId);
  });
});

// ---------------------------------------------------------------------------
// T2 — exchange selection + expected override
// ---------------------------------------------------------------------------

describe("POST /eval/cases/from-session — exchange selection + expected override", () => {
  it("selects exchange 2 by number; an explicit expected overrides the seeded answer", async () => {
    const conversationId = "conv-2";
    const history = [
      mkExchange(1, "first", "first-answer"),
      mkExchange(2, "second", "second-answer"),
    ];
    const conversations = new Map<string, ConversationEntry>([
      [conversationId, makeConversationEntry({ agentId: "a", history })],
    ]);
    const app = mkApp({ evalStore: store, conversations });

    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank", exchange: 2, expected: "edited" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CaptureFromSessionResponse;
    expect(body.caseId).toBe(`session-${conversationId}-2`);
    expect(body.input).toBe("second");
    expect(body.expected).toBe("edited");
  });
});

// ---------------------------------------------------------------------------
// T3 — idempotence (acceptance 3)
// ---------------------------------------------------------------------------

describe("POST /eval/cases/from-session — idempotence (Decision 3)", () => {
  it("re-capturing the same exchange updates the same row (201 then 200); explicit caseId forks a distinct row", async () => {
    const conversationId = "conv-3";
    const history = [mkExchange(1, "hi", "first answer")];
    const conversations = new Map<string, ConversationEntry>([
      [conversationId, makeConversationEntry({ agentId: "a", history })],
    ]);
    const app = mkApp({ evalStore: store, conversations });

    const first = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank" }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as CaptureFromSessionResponse;
    expect(firstBody.created).toBe(true);

    const second = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank", expected: "edited answer" }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as CaptureFromSessionResponse;
    expect(secondBody.created).toBe(false);
    expect(secondBody.caseId).toBe(firstBody.caseId);

    const rows = store.listEvalCases("bank").filter((c) => c.caseId === firstBody.caseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expected).toBe("edited answer");

    // Explicit caseId override forks a distinct, deliberately-versioned row.
    const versioned = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId,
        setId: "bank",
        caseId: `${firstBody.caseId}-tightened`,
      }),
    });
    expect(versioned.status).toBe(201);
    expect(store.listEvalCases("bank")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T4 — set creation (Decision 4)
// ---------------------------------------------------------------------------

describe("POST /eval/cases/from-session — set creation (Decision 4)", () => {
  it("404s an unknown set with the createSet hint; writes no rows", async () => {
    const conversationId = "conv-4";
    const history = [mkExchange(1, "hi", "hey")];
    const conversations = new Map<string, ConversationEntry>([
      [conversationId, makeConversationEntry({ agentId: "a", history })],
    ]);
    const app = mkApp({ evalStore: store, conversations });

    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "new-bank" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toContain("new-bank");
    expect(body.hint).toContain("createSet");
    expect(store.listEvalSets().some((s) => s.id === "new-bank")).toBe(false);
  });

  it("creates the set on createSet opt-in; both the set and the case land", async () => {
    const conversationId = "conv-4b";
    const history = [mkExchange(1, "hi", "hey")];
    const conversations = new Map<string, ConversationEntry>([
      [conversationId, makeConversationEntry({ agentId: "a", history })],
    ]);
    const app = mkApp({ evalStore: store, conversations });

    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId,
        setId: "new-bank",
        createSet: { name: "New bank" },
      }),
    });
    expect(res.status).toBe(201);

    const setsRes = await app.request("/eval/sets");
    const setsBody = (await setsRes.json()) as {
      sets: Array<{ id: string; name: string | null; caseCount: number }>;
    };
    const created = setsBody.sets.find((s) => s.id === "new-bank");
    expect(created?.name).toBe("New bank");
    expect(created?.caseCount).toBe(1);
  });

  it("ignores createSet on an existing set — name/description unchanged (clobber guard)", async () => {
    const conversationId = "conv-4c";
    const history = [mkExchange(1, "hi", "hey")];
    const conversations = new Map<string, ConversationEntry>([
      [conversationId, makeConversationEntry({ agentId: "a", history })],
    ]);
    const app = mkApp({ evalStore: store, conversations });

    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId,
        setId: "bank",
        createSet: { name: "Clobbered name" },
      }),
    });
    expect(res.status).toBe(201);

    const setsRes = await app.request("/eval/sets");
    const setsBody = (await setsRes.json()) as { sets: Array<{ id: string; name: string | null }> };
    const bank = setsBody.sets.find((s) => s.id === "bank");
    expect(bank?.name).toBe("Bank"); // unchanged from the beforeEach seed
  });
});

// ---------------------------------------------------------------------------
// T5 — capture -> run round-trip (acceptance 2)
// ---------------------------------------------------------------------------

describe("POST /eval/cases/from-session — capture -> run round-trip (#139)", () => {
  it("a captured case executes and scores when its set is run", async () => {
    const conversationId = "conv-5";
    const history = [mkExchange(1, "echo this", "echo this")];
    const conversations = new Map<string, ConversationEntry>([
      [conversationId, makeConversationEntry({ agentId: "a", history })],
    ]);
    const target = makeEchoRegistration("echo-agent");
    const app = mkApp({
      evalStore: store,
      agents: [target],
      evalExecution: { runner: new MockRunner() },
      conversations,
    });

    const captureRes = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId,
        setId: "round-trip",
        createSet: { name: "Round trip" },
      }),
    });
    expect(captureRes.status).toBe(201);
    const captureBody = (await captureRes.json()) as CaptureFromSessionResponse;

    const runRes = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "round-trip", targetId: "echo-agent" }),
    });
    expect(runRes.status).toBe(202);
    const { runId } = (await runRes.json()) as { runId: string };

    await waitForTerminal(store, runId);

    const results = store.evalRunResults(runId);
    const row = results.find((r) => r.caseId === captureBody.caseId);
    expect(row).toBeDefined();
    expect(row?.runStatus).toBe("ok");
    expect(row?.pass).toBe(true); // echo target returns the input; expected == input
  });
});

// ---------------------------------------------------------------------------
// T6 — the ladder
// ---------------------------------------------------------------------------

describe("POST /eval/cases/from-session — validation ladder", () => {
  const conversationId = "conv-ladder";

  function baseConversations(): Map<string, ConversationEntry> {
    const history = [mkExchange(1, "hi", "hey")];
    return new Map([[conversationId, makeConversationEntry({ agentId: "a", history })]]);
  }

  it("400s missing conversationId", async () => {
    const app = mkApp({ evalStore: store, conversations: baseConversations() });
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s missing setId", async () => {
    const app = mkApp({ evalStore: store, conversations: baseConversations() });
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });
    expect(res.status).toBe(400);
  });

  it("400s an invalid exchange value — zero", async () => {
    const app = mkApp({ evalStore: store, conversations: baseConversations() });
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank", exchange: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("400s an invalid exchange value — non-integer", async () => {
    const app = mkApp({ evalStore: store, conversations: baseConversations() });
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank", exchange: 1.5 }),
    });
    expect(res.status).toBe(400);
  });

  it("400s an invalid exchange value — non-numeric", async () => {
    const app = mkApp({ evalStore: store, conversations: baseConversations() });
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank", exchange: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s an out-of-range exchange, with the count in the message", async () => {
    const app = mkApp({ evalStore: store, conversations: baseConversations() });
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank", exchange: 5 }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("has 1");
  });

  it("400s a conversation with no completed exchanges yet", async () => {
    const emptyConvId = "conv-empty";
    const conversations = new Map<string, ConversationEntry>([
      [emptyConvId, makeConversationEntry({ agentId: "a", history: [] })],
    ]);
    const app = mkApp({ evalStore: store, conversations });
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: emptyConvId, setId: "bank" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no completed exchanges");
  });

  it("404s an unknown conversation, with the live-registry hint", async () => {
    const app = mkApp({ evalStore: store, conversations: baseConversations() });
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "does-not-exist", setId: "bank" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toContain("does-not-exist");
    expect(body.hint).toContain("live conversations");
  });

  it("400s an invalid split value", async () => {
    const app = mkApp({ evalStore: store, conversations: baseConversations() });
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank", split: "bogus" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("train | dev | test");
  });

  it("503s when no store is configured", async () => {
    const app = mkApp({ evalStore: undefined, conversations: baseConversations() });
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank" }),
    });
    expect(res.status).toBe(503);
  });

  it("404s when the conversations Map option is absent entirely (older embedders)", async () => {
    const app = mkApp({ evalStore: store }); // no `conversations` option at all
    const res = await app.request("/eval/cases/from-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, setId: "bank" }),
    });
    expect(res.status).toBe(404);
  });
});
