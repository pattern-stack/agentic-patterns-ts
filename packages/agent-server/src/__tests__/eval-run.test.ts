/**
 * POST /eval/runs + GET /eval/runs/:id/stream (spec `.ai-docs/stacks/
 * eval-surface/specs/139.md` § Tests, T1).
 *
 * Real in-memory-SQLite `EvalStore` seeded via `upsertEvalSet`/`upsertEvalCase`;
 * `evalRoutes` mounted with the full option set (`agents`/`eventBus`/
 * `evalExecution`) — the `eval.test.ts` `mkApp` idiom, extended. Fixture
 * agents:
 *   - a promoted `FunctionStep` echo (asAgent) — runner-free, mirrors the CLI
 *     test's `makeEchoTarget`.
 *   - a bare `AgentLike` bridged through the engine's `AgentStep` adapter,
 *     driven by a deferred-gated stub runner (blocks on the FIRST case only,
 *     so a test can attach the stream deterministically mid-run before
 *     releasing it — no timing races).
 *   - a promoted pipeline that NESTS an `AgentStep` — proves the route hands
 *     `runEval` the RAW `evalExecution.runner`, never `reg.runner` (which the
 *     playground may have wrapped in a `NodeBackedRunner` — `as-agent.ts`
 *     throws when that's handed a non-promoted nested agent).
 */

import {
  AgentEventBus,
  type AgentLike,
  AgentStep,
  type EvalResultRecord,
  EvalStore,
  type EventStoreOptions,
  FunctionStep,
  MockRunner,
  NodeBackedRunner,
  type RunOptions,
  type RunResult,
  type RunnerProtocol,
  asAgent,
} from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRegistration, EvalExecutionConfig } from "../config.js";
import { evalRoutes } from "../routes/eval.js";

// ---------------------------------------------------------------------------
// mkApp — the full options set (extends eval.test.ts's read-only mkApp)
// ---------------------------------------------------------------------------

function mkApp(opts: {
  evalStore: EvalStore | undefined;
  agents?: AgentRegistration[];
  evalExecution?: EvalExecutionConfig;
}): Hono {
  const app = new Hono();
  app.route(
    "/",
    evalRoutes({
      evalStore: opts.evalStore,
      agents: opts.agents ?? [],
      eventBus: new AgentEventBus(),
      evalExecution: opts.evalExecution,
    }),
  );
  return app;
}

// ---------------------------------------------------------------------------
// Fixture agents
// ---------------------------------------------------------------------------

/** Promoted echo agent: identity function; throws on "boom" (the node-error path). */
function makeEchoRegistration(id = "echo"): AgentRegistration {
  const node = new FunctionStep<string, string>({
    name: "echo",
    fn: (input: string) => {
      if (input === "boom") throw new Error("boom");
      return input;
    },
  });
  const agent = asAgent(node, { role: { name: id } });
  return { id, name: id, agent, runner: new MockRunner() };
}

/** Bare AgentLike fixture — resolved via the engine's AgentStep bridge. */
function makeAgentLikeRegistration(id = "agent-fixture"): AgentRegistration {
  const agent: AgentLike = {
    role: { name: id },
    getModel: () => "mock-model",
    getTools: () => [],
    getSystemPrompt: () => "You are a test agent.",
    renderInitialPrompt: () => "Initial prompt",
  };
  return { id, name: id, agent, runner: new MockRunner() };
}

/**
 * A promoted pipeline whose node NESTS an `AgentStep` around a bare inner
 * agent. `runner` simulates what `playground.ts` computes for a promoted
 * registration — a `NodeBackedRunner` — which is the TRAP: if the route ever
 * threads `reg.runner` into `runEval` instead of `evalExecution.runner`, the
 * nested `AgentStep`'s call to `ctx.runner.run(innerAgent, ...)` hits
 * `NodeBackedRunner.run()`, which throws on a non-promoted agent.
 */
function makeNestedAgentStepRegistration(id = "nested-pipeline"): AgentRegistration {
  const innerAgent: AgentLike = {
    role: { name: `${id}-inner` },
    getModel: () => "mock-model",
    getTools: () => [],
    getSystemPrompt: () => "inner",
    renderInitialPrompt: () => "inner prompt",
  };
  const agentStep = new AgentStep<string, string>({
    name: "inner-step",
    agent: innerAgent,
    prompt: (input: string) => input,
  });
  const promoted = asAgent(agentStep, { role: { name: id } });
  const trapRunner = new NodeBackedRunner(new MockRunner());
  return { id, name: id, agent: promoted, runner: trapRunner };
}

/** Runner that legitimately handles a raw (non-promoted) `AgentLike` — the
 *  correct `evalExecution.runner` for the nested-AgentStep fixture above. */
class PlainRunner implements RunnerProtocol {
  async run(_agent: AgentLike, _message: string, _options?: RunOptions): Promise<RunResult> {
    return {
      response: "ok",
      inputTokens: 1,
      outputTokens: 1,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
    };
  }
}

/**
 * Blocks the FIRST `run()` call until `.release()` is called; every
 * subsequent call resolves immediately. Deterministic mid-run attach: the
 * detached suite blocks on case 1 synchronously (no `await` precedes the
 * blocking promise in the call chain from the POST handler down), so the
 * test can attach the stream, THEN release, with no timing race.
 */
class GatedRunner implements RunnerProtocol {
  private first = true;
  private releaseFirst: (() => void) | undefined;

  async run(_agent: AgentLike, _message: string): Promise<RunResult> {
    if (this.first) {
      this.first = false;
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });
    }
    return {
      response: "ok",
      inputTokens: 1,
      outputTokens: 1,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
    };
  }

  release(): void {
    this.releaseFirst?.();
    this.releaseFirst = undefined;
  }
}

/** `recordEvalResult` throws on the Nth call — simulates a store write crash mid-suite. */
class CrashingEvalStore extends EvalStore {
  private calls = 0;
  constructor(
    opts: EventStoreOptions,
    private readonly throwOnCall: number,
  ) {
    super(opts);
  }
  override recordEvalResult(r: EvalResultRecord): void {
    this.calls++;
    if (this.calls === this.throwOnCall) {
      throw new Error("simulated store failure");
    }
    super.recordEvalResult(r);
  }
}

// ---------------------------------------------------------------------------
// SSE transcript parsing
// ---------------------------------------------------------------------------

interface ParsedEvent {
  event: string;
  data: unknown;
}

function parseSSE(text: string): ParsedEvent[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      let event = "message";
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        else if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
      }
      return { event, data: JSON.parse(dataLines.join("\n")) };
    });
}

// ---------------------------------------------------------------------------
// Store seeding
// ---------------------------------------------------------------------------

let store: EvalStore;

beforeEach(() => {
  store = new EvalStore({ path: ":memory:", Database });
  store.upsertEvalSet({ id: "bank", name: "Bank" });
  store.upsertEvalCase("bank", { caseId: "c1", input: "hi" });
  store.upsertEvalCase("bank", { caseId: "c2", input: "yo" });
});

afterEach(() => {
  store.close();
});

async function waitForTerminal(evalStore: EvalStore, runId: string): Promise<void> {
  await vi.waitFor(() => {
    const run = evalStore.getEvalRun(runId);
    if (!run || run.status === "running") {
      throw new Error("still running");
    }
  });
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("POST /eval/runs — happy path", () => {
  it("202s {runId, total}; run reaches ok; rows match the #135 CLI shape", async () => {
    const target = makeEchoRegistration("echo-agent");
    const app = mkApp({
      evalStore: store,
      agents: [target],
      evalExecution: { runner: new MockRunner(), model: "sonnet-test", gitSha: "sha-test" },
    });

    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank", targetId: "echo-agent", variant: "v1" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; total: number };
    expect(body.total).toBe(2);

    await waitForTerminal(store, body.runId);

    const run = store.getEvalRun(body.runId);
    expect(run?.status).toBe("ok");
    expect(run?.setId).toBe("bank");
    expect(run?.targetId).toBe("echo-agent");
    expect(run?.variant).toBe("v1");
    expect(run?.model).toBe("sonnet-test");

    const rows = store.evalRunResults(body.runId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.traceId).toBe(`${body.runId}:${row.caseId}`);
      const runRow = store.getRun(row.runId as string);
      expect(runRow?.metadata?.evalRunId).toBe(body.runId);
      expect(runRow?.metadata?.caseId).toBe(row.caseId);
      expect(runRow?.metadata?.variant).toBe("v1");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Case-level split wins over run-level
// ---------------------------------------------------------------------------

describe("POST /eval/runs — split precedence", () => {
  it("case-level split wins over the run-level label in per-case metadata", async () => {
    store.upsertEvalSet({ id: "mixed", name: "Mixed" });
    store.upsertEvalCase("mixed", { caseId: "dev-case", input: "a", split: "dev" });
    store.upsertEvalCase("mixed", { caseId: "untagged-case", input: "b" });

    const target = makeEchoRegistration("echo-agent");
    const app = mkApp({
      evalStore: store,
      agents: [target],
      evalExecution: { runner: new MockRunner() },
    });

    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "mixed", targetId: "echo-agent" }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    await waitForTerminal(store, runId);

    const rows = store.evalRunResults(runId);
    const devRow = rows.find((r) => r.caseId === "dev-case");
    const untaggedRow = rows.find((r) => r.caseId === "untagged-case");
    const devRun = store.getRun(devRow?.runId as string);
    const untaggedRun = store.getRun(untaggedRow?.runId as string);
    expect(devRun?.metadata?.split).toBe("dev");
    expect(untaggedRun?.metadata?.split).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Guard ladder
// ---------------------------------------------------------------------------

describe("POST /eval/runs — guard ladder", () => {
  function countRuns(): number {
    return store.listEvalRuns().length;
  }

  it("400s missing setId", async () => {
    const app = mkApp({ evalStore: store, evalExecution: { runner: new MockRunner() } });
    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId: "x" }),
    });
    expect(res.status).toBe(400);
    expect(countRuns()).toBe(0);
  });

  it("400s missing targetId", async () => {
    const app = mkApp({ evalStore: store, evalExecution: { runner: new MockRunner() } });
    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank" }),
    });
    expect(res.status).toBe(400);
    expect(countRuns()).toBe(0);
  });

  it("400s an invalid split value", async () => {
    const app = mkApp({ evalStore: store, evalExecution: { runner: new MockRunner() } });
    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank", targetId: "x", split: "bogus" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("train | dev | test");
    expect(countRuns()).toBe(0);
  });

  it("403s the held-out test split without allowTest; 202s with it", async () => {
    store.upsertEvalSet({ id: "test-bank", name: "Test bank" });
    store.upsertEvalCase("test-bank", { caseId: "t1", input: "x", split: "test" });
    const target = makeEchoRegistration("echo-agent");
    const app = mkApp({
      evalStore: store,
      agents: [target],
      evalExecution: { runner: new MockRunner() },
    });

    const denied = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "test-bank", targetId: "echo-agent", split: "test" }),
    });
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { error: string; hint: string };
    expect(deniedBody.error).toContain("held-out");
    expect(deniedBody.hint).toContain("allowTest");
    expect(countRuns()).toBe(0);

    const allowed = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        setId: "test-bank",
        targetId: "echo-agent",
        split: "test",
        allowTest: true,
      }),
    });
    expect(allowed.status).toBe(202);
  });

  it("404s an unknown target with an available list; no run row created", async () => {
    const target = makeEchoRegistration("known-agent");
    const app = mkApp({
      evalStore: store,
      agents: [target],
      evalExecution: { runner: new MockRunner() },
    });
    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank", targetId: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toContain("does-not-exist");
    expect(body.hint).toContain("known-agent");
    expect(countRuns()).toBe(0);
  });

  it("404s an unknown set", async () => {
    const target = makeEchoRegistration("echo-agent");
    const app = mkApp({
      evalStore: store,
      agents: [target],
      evalExecution: { runner: new MockRunner() },
    });
    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "does-not-exist", targetId: "echo-agent" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('eval set "does-not-exist" not found');
    expect(countRuns()).toBe(0);
  });

  it("400s an empty split selection; no run row created", async () => {
    const target = makeEchoRegistration("echo-agent");
    const app = mkApp({
      evalStore: store,
      agents: [target],
      evalExecution: { runner: new MockRunner() },
    });
    // "bank" has no "dev"-split cases (both cases are untagged).
    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank", targetId: "echo-agent", split: "dev" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no cases in split");
    expect(countRuns()).toBe(0);
  });

  it("503s when no store is configured", async () => {
    const app = mkApp({ evalStore: undefined, evalExecution: { runner: new MockRunner() } });
    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank", targetId: "echo-agent" }),
    });
    expect(res.status).toBe(503);
  });

  it("503s when evalExecution is absent", async () => {
    const app = mkApp({ evalStore: store });
    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank", targetId: "echo-agent" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("eval execution");
  });
});

// ---------------------------------------------------------------------------
// 4. Crash path
// ---------------------------------------------------------------------------

describe("POST /eval/runs — crash mid-suite", () => {
  it("finalizes the run as error; partial results retained; run.finished{status:error} broadcast", async () => {
    const crashingStore = new CrashingEvalStore({ path: ":memory:", Database }, 2);
    crashingStore.upsertEvalSet({ id: "bank", name: "Bank" });
    crashingStore.upsertEvalCase("bank", { caseId: "c1", input: "hi" });
    crashingStore.upsertEvalCase("bank", { caseId: "c2", input: "yo" });

    const target = makeEchoRegistration("echo-agent");
    const app = mkApp({
      evalStore: crashingStore,
      agents: [target],
      evalExecution: { runner: new MockRunner() },
    });

    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank", targetId: "echo-agent" }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };

    await waitForTerminal(crashingStore, runId);

    const run = crashingStore.getEvalRun(runId);
    expect(run?.status).toBe("error");

    // Case 1's recorder call succeeded (partial results retained); case 2 crashed.
    const rows = crashingStore.evalRunResults(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.caseId).toBe("c1");

    crashingStore.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Stream
// ---------------------------------------------------------------------------

describe("GET /eval/runs/:id/stream", () => {
  it("attach mid-run: run.snapshot -> case.result* -> run.finished -> done, in order", async () => {
    const gated = new GatedRunner();
    const target = makeAgentLikeRegistration("lifecycle-agent");
    const app = mkApp({
      evalStore: store,
      agents: [target],
      evalExecution: { runner: gated },
    });

    const postRes = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank", targetId: "lifecycle-agent" }),
    });
    expect(postRes.status).toBe(202);
    const { runId } = (await postRes.json()) as { runId: string };

    // The detached suite is deterministically blocked on case 1's runner call
    // (no `await` precedes the block in the synchronous chain from POST).
    const streamRes = await app.request(`/eval/runs/${runId}/stream`);
    expect(streamRes.status).toBe(200);

    gated.release();

    const text = await streamRes.text();
    const events = parseSSE(text);
    const names = events.map((e) => e.event);
    expect(names).toEqual(["run.snapshot", "case.result", "case.result", "run.finished", "done"]);

    const snapshot = events[0]?.data as { completed: number; total: number; status: string };
    expect(snapshot.completed).toBe(0);
    expect(snapshot.total).toBe(2);
    expect(snapshot.status).toBe("running");

    const finished = events[3]?.data as { status: string };
    expect(finished.status).toBe("ok");
  });

  it("attach after finish: snapshot + finished + done, immediately", async () => {
    const target = makeEchoRegistration("echo-agent");
    const app = mkApp({
      evalStore: store,
      agents: [target],
      evalExecution: { runner: new MockRunner() },
    });

    const postRes = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank", targetId: "echo-agent" }),
    });
    const { runId } = (await postRes.json()) as { runId: string };
    await waitForTerminal(store, runId);

    const streamRes = await app.request(`/eval/runs/${runId}/stream`);
    expect(streamRes.status).toBe(200);
    const events = parseSSE(await streamRes.text());
    expect(events.map((e) => e.event)).toEqual(["run.snapshot", "run.finished", "done"]);
    expect((events[1]?.data as { status: string }).status).toBe("ok");
  });

  it("404s an unknown run id", async () => {
    const app = mkApp({ evalStore: store });
    const res = await app.request("/eval/runs/nope/stream");
    expect(res.status).toBe(404);
  });

  it("a seeded 'running' row with no live handle -> run.detached", async () => {
    const runId = store.startEvalRun({ setId: "bank", targetId: "echo-agent" });
    const app = mkApp({ evalStore: store });
    const res = await app.request(`/eval/runs/${runId}/stream`);
    expect(res.status).toBe(200);
    const events = parseSSE(await res.text());
    expect(events.map((e) => e.event)).toEqual(["run.snapshot", "run.detached", "done"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Reg-runner trap regression
// ---------------------------------------------------------------------------

describe("POST /eval/runs — reg-runner trap regression", () => {
  it("a promoted target nesting an AgentStep completes against evalExecution.runner, not reg.runner", async () => {
    const target = makeNestedAgentStepRegistration("nested-pipeline");
    const app = mkApp({
      evalStore: store,
      agents: [target],
      evalExecution: { runner: new PlainRunner() },
    });

    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "bank", targetId: "nested-pipeline" }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    await waitForTerminal(store, runId);

    const rows = store.evalRunResults(runId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // If the route had mistakenly used `reg.runner` (a NodeBackedRunner),
      // the nested AgentStep's call would throw and the case would come back
      // `runStatus: "error"` with a "requires a PromotedAgent" message.
      expect(row.runStatus).toBe("ok");
      expect(row.runError).toBeFalsy();
    }
  });
});
