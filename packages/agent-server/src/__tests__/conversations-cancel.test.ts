/**
 * #341 — `POST /conversations/:id/cancel` + `stream.onAbort` disconnect
 * hardening. Reuses the `conversations.test.ts` / `conversations-input.test.ts`
 * idioms (`mkApp`, `PendingInputRegistry`, streaming-runner doubles).
 *
 * Runner doubles below deliberately hold the SAME `PendingInputRegistry`
 * instance the route is wired with (a closure capture) so a mock runner can
 * simulate a parked approval gate by directly `await registry.create(id)`,
 * mirroring what a real gate does internally — without needing the full
 * gate-chain machinery. This lets the deny-sweep / disconnect tests drive
 * and observe both halves (registry resolution + the runner's own
 * abortSignal) deterministically, no polling or raw sleeps.
 */

import type { AgentEvent, RunOptions } from "@agentic-patterns/runtime";
import { AgentEventBus, PendingInputRegistry, createEvent } from "@agentic-patterns/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AgentRegistration } from "../config.js";
import { type ConversationEntry, conversationRoutes } from "../routes/conversations.js";

const mockAgent = {
  getModel: () => "test-model",
  getTools: () => [],
  renderInitialPrompt: () => "Test prompt",
  role: { name: "TestAgent" },
};

const JSON_HEADERS = { "Content-Type": "application/json" };

// ---------------------------------------------------------------------------
// SSE transcript parsing (conversations-stream-error.test.ts idiom)
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
// Runner doubles
// ---------------------------------------------------------------------------

/** Completes immediately — never parks, so `activeTurn` clears right away. */
function makeInstantRunner() {
  return {
    async run(): Promise<never> {
      throw new Error("run() not used in these tests");
    },
    async *stream(
      _agent: unknown,
      _message: string,
      options?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      const traceId = options?.traceId ?? "trace-1";
      yield createEvent("agent.message.start", {
        traceId,
        runId: "run-1",
        agentName: "test-agent",
      });
      yield createEvent("agent.message.complete", {
        traceId,
        runId: "run-1",
        content: "done",
        inputTokens: 1,
        outputTokens: 1,
        model: "test-model",
      });
    },
  };
}

/**
 * Yields `message.start`, resolves `started`, then PARKS until
 * `options.abortSignal` fires — mirroring AgentRunner's real D1 contract:
 * on abort it emits its own `agent.message.cancel` + `agent.conversation.end
 * {reason:"cancelled"}` and RETURNS, never throws.
 */
function makeParkingRunner(): RunnerHandle {
  let resolveStarted: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  return {
    started,
    async run(): Promise<never> {
      throw new Error("run() not used in these tests");
    },
    async *stream(
      _agent: unknown,
      _message: string,
      options?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      const traceId = options?.traceId ?? "trace-1";
      const runId = "run-1";
      yield createEvent("agent.message.start", { traceId, runId, agentName: "test-agent" });
      resolveStarted();

      await new Promise<void>((resolve) => {
        if (options?.abortSignal?.aborted) {
          resolve();
          return;
        }
        options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });

      yield createEvent("agent.message.cancel", {
        traceId,
        runId,
        reason: "cancelled by client",
      });
      yield createEvent("agent.conversation.end", {
        traceId,
        runId,
        conversationId: "runner-own-conversation-id",
        reason: "cancelled",
      });
    },
  };
}

interface RunnerHandle {
  started: Promise<void>;
  run(): Promise<never>;
  stream(agent: unknown, message: string, options?: RunOptions): AsyncGenerator<AgentEvent>;
}

/**
 * Publishes an `agent.input.request` (standing in for a blocked approval
 * gate) then PARKS directly on the SAME `PendingInputRegistry` instance the
 * route uses — exactly like a real gate awaiting the human's answer.
 * Exposes `started` (request published, parked) and `decided` (the answer
 * the registry eventually resolves with — deny via the cancel-triggered
 * sweep, or approve via `POST …/input`).
 */
function makeGatedRunner(registry: PendingInputRegistry) {
  // Resolves once `agent.input.request` has been PUBLISHED (and, since
  // `EventBus.publish` awaits every subscriber, the route's `onInputRequest`
  // has already run — `pendingForTurn` has "call-1" and its SSE frame write
  // has been attempted) and the generator is about to park on
  // `registry.create()`. This is the signal to synchronize on before
  // cancelling/disconnecting — NOT `decided` below, which only resolves
  // AFTER something has already answered the gate.
  let resolveParked: () => void;
  const parked = new Promise<void>((resolve) => {
    resolveParked = resolve;
  });
  let resolveDecided: (d: { decision: string }) => void;
  const decided = new Promise<{ decision: string }>((resolve) => {
    resolveDecided = resolve;
  });
  let sawAbort = false;

  return {
    parked,
    decided,
    sawAbortSync: () => sawAbort,
    async run(): Promise<never> {
      throw new Error("run() not used in these tests");
    },
    async *stream(
      _agent: unknown,
      _message: string,
      options?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      const traceId = options?.traceId ?? "trace-1";
      const runId = "run-1";
      const bus = options?.eventBus;
      options?.abortSignal?.addEventListener("abort", () => {
        sawAbort = true;
      });

      yield createEvent("agent.message.start", { traceId, runId, agentName: "test-agent" });

      if (bus) {
        await bus.publish(
          createEvent("agent.input.request", {
            traceId,
            runId,
            correlationId: "call-1",
            kind: "approval",
            prompt: 'Approve "ratify_definition"?',
            toolName: "ratify_definition",
            toolCallId: "call-1",
          }),
        );
      }

      resolveParked();
      const answer = await registry.create("call-1");
      resolveDecided(answer);

      if (answer.decision === "deny") {
        yield createEvent("agent.message.cancel", {
          traceId,
          runId,
          reason: "cancelled by client",
        });
        yield createEvent("agent.conversation.end", {
          traceId,
          runId,
          conversationId: "runner-own-conversation-id",
          reason: "cancelled",
        });
        return;
      }

      yield createEvent("agent.message.complete", {
        traceId,
        runId,
        content: "approved",
        inputTokens: 1,
        outputTokens: 1,
        model: "test-model",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// App + request helpers
// ---------------------------------------------------------------------------

function mkApp(opts?: {
  agents?: AgentRegistration[];
  eventBus?: AgentEventBus;
  registry?: PendingInputRegistry;
}): Hono {
  const app = new Hono();
  app.route(
    "/",
    conversationRoutes(
      opts?.agents ?? [],
      new Map<string, ConversationEntry>(),
      opts?.eventBus ?? new AgentEventBus(),
      undefined,
      opts?.registry,
    ),
  );
  return app;
}

async function createConversation(app: Hono, agentId: string): Promise<string> {
  const createRes = await app.request("/conversations", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ agent_id: agentId }),
  });
  const { id } = (await createRes.json()) as { id: string };
  return id;
}

async function sendMessage(app: Hono, convId: string, content = "go"): Promise<Response> {
  return app.request(`/conversations/${convId}/messages`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content }),
  });
}

async function cancelTurn(app: Hono, convId: string): Promise<Response> {
  return app.request(`/conversations/${convId}/cancel`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /conversations/:id/cancel", () => {
  it("404s an unknown conversation", async () => {
    const app = mkApp();
    const res = await cancelTurn(app, "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Conversation not found" });
  });

  it("409s a known conversation with no active turn", async () => {
    const reg: AgentRegistration = {
      id: "a",
      name: "A",
      agent: mockAgent,
      runner: makeInstantRunner(),
    };
    const app = mkApp({ agents: [reg] });
    const convId = await createConversation(app, "a");

    const res = await cancelTurn(app, convId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no active turn" });
  });

  it("409s again once a completed turn's activeTurn has cleared (finally's natural-completion belt)", async () => {
    const reg: AgentRegistration = {
      id: "a",
      name: "A",
      agent: mockAgent,
      runner: makeInstantRunner(),
    };
    const app = mkApp({ agents: [reg] });
    const convId = await createConversation(app, "a");

    const streamRes = await sendMessage(app, convId);
    await streamRes.text(); // drain to completion — activeTurn clears in `finally`

    const res = await cancelTurn(app, convId);
    expect(res.status).toBe(409);
  });

  it("202s {ok, run_id} while a turn is streaming, and the turn's own SSE body then winds down message.cancel … done", async () => {
    const runner = makeParkingRunner();
    const reg: AgentRegistration = { id: "gated", name: "Gated", agent: mockAgent, runner };
    const app = mkApp({ agents: [reg] });
    const convId = await createConversation(app, "gated");

    const streamRes = await sendMessage(app, convId);
    // Kick off draining the SSE body in the BACKGROUND before synchronizing
    // on `started` — hono's `StreamingApi.write` applies backpressure, and
    // with nothing reading yet the runner's very first writes (conversation.
    // start, message.start) would block forever, so the generator would
    // never even reach its `resolveStarted()` call.
    const textPromise = streamRes.text();
    await runner.started; // message.start yielded — activeTurn.runId is mirrored by now

    const cancelRes = await cancelTurn(app, convId);
    expect(cancelRes.status).toBe(202);
    const body = (await cancelRes.json()) as { ok: boolean; run_id?: string };
    expect(body.ok).toBe(true);
    expect(body.run_id).toBe("run-1");

    const text = await textPromise;
    const parsed = parseSSE(text);
    const eventNames = parsed.map((p) => p.event);

    expect(eventNames).toContain("message.cancel");
    expect(eventNames.at(-1)).toBe("done");
    // Never the error path — cancelled != error on every surface.
    expect(eventNames).not.toContain("error");
  });

  it("is idempotent while winding down: a second POST during teardown still 202s (AbortController.abort() is a no-op once already aborted)", async () => {
    const runner = makeParkingRunner();
    const reg: AgentRegistration = { id: "gated", name: "Gated", agent: mockAgent, runner };
    const app = mkApp({ agents: [reg] });
    const convId = await createConversation(app, "gated");

    const streamRes = await sendMessage(app, convId);
    const textPromise = streamRes.text();
    await runner.started;

    const first = await cancelTurn(app, convId);
    expect(first.status).toBe(202);
    // Fired again before the stream's `finally` has cleared `activeTurn`.
    const second = await cancelTurn(app, convId);
    expect(second.status).toBe(202);

    await textPromise;
    // Once the turn has actually finished winding down, activeTurn is gone.
    const third = await cancelTurn(app, convId);
    expect(third.status).toBe(409);
  });

  it("409s a second concurrent POST …/messages while a turn is already active", async () => {
    const runner = makeParkingRunner();
    const reg: AgentRegistration = { id: "gated", name: "Gated", agent: mockAgent, runner };
    const app = mkApp({ agents: [reg] });
    const convId = await createConversation(app, "gated");

    const firstStream = await sendMessage(app, convId);
    const firstTextPromise = firstStream.text();
    await runner.started;

    const secondRes = await sendMessage(app, convId);
    expect(secondRes.status).toBe(409);
    expect(await secondRes.json()).toEqual({
      error: "a turn is already streaming for this conversation",
    });

    // Clean up: let the first turn wind down (cancel + drain) so nothing
    // leaks a dangling parked generator across tests.
    await cancelTurn(app, convId);
    await firstTextPromise;
  });

  it("deny-sweep on cancel: a turn parked on an approval gate is denied by the cancel route, and the stream terminates with done (not a hang)", async () => {
    const registry = new PendingInputRegistry();
    const eventBus = new AgentEventBus();
    const runner = makeGatedRunner(registry);
    const reg: AgentRegistration = { id: "gated", name: "Gated", agent: mockAgent, runner };
    const app = mkApp({ agents: [reg], eventBus, registry });
    const convId = await createConversation(app, "gated");

    const streamRes = await sendMessage(app, convId);
    const textPromise = streamRes.text();
    await runner.parked; // input.request published (pendingForTurn has "call-1"), now blocked on registry.create()

    const cancelRes = await cancelTurn(app, convId);
    expect(cancelRes.status).toBe(202);

    // The registry resolved the parked gate with a DENY (the deny-sweep),
    // which is what let the runner's generator unblock at all.
    const decision = await runner.decided;
    expect(decision.decision).toBe("deny");

    const text = await textPromise;
    const eventNames = parseSSE(text).map((p) => p.event);
    expect(eventNames).toContain("input.request");
    expect(eventNames).toContain("message.cancel");
    expect(eventNames.at(-1)).toBe("done");
    expect(eventNames).not.toContain("error");
  });

  it("disconnect hardening: reader.cancel() drives hono's onAbort — the runner observes the abort AND the parked gate is denied (never a server error, never a hang)", async () => {
    const registry = new PendingInputRegistry();
    const eventBus = new AgentEventBus();
    const runner = makeGatedRunner(registry);
    const reg: AgentRegistration = { id: "gated", name: "Gated", agent: mockAgent, runner };
    const app = mkApp({ agents: [reg], eventBus, registry });
    const convId = await createConversation(app, "gated");

    const streamRes = await sendMessage(app, convId);
    const reader = streamRes.body?.getReader();
    expect(reader).toBeDefined();

    // Pump chunks in the background (same backpressure reason as above) so
    // the generator can actually reach its parked state, until it does.
    const pump = (async () => {
      while (true) {
        const { done } = await reader!.read();
        if (done) return;
      }
    })();

    // input.request published, generator now blocked on registry.create() —
    // definitely underway before simulating the client going away.
    await runner.parked;

    // Client disconnect — this is what `stream.onAbort` reacts to, NOT an
    // explicit `POST …/cancel`.
    await reader?.cancel();
    await pump.catch(() => {
      // A cancelled reader's pending read() rejects — expected, not a
      // failure of anything under test.
    });

    const decision = await runner.decided;
    expect(decision.decision).toBe("deny");
    expect(runner.sawAbortSync()).toBe(true);
  });
});
