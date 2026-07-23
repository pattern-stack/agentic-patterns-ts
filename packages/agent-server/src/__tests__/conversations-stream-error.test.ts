/**
 * N5 torn-stream fix (#340) — server-side stream error test.
 *
 * When the runner throws before its first yield (model-resolution reject,
 * provider construction failure — any pre-yield setup throw) or mid-stream,
 * the drain loop's `catch` in `routes/conversations.ts` (between the
 * existing `try`/`finally`) must write the canonical `error` frame + a
 * `done` terminator, in that order, so the stream is honestly torn on the
 * wire instead of silently swallowed by hono's `streamSSE`. Reuses
 * `conversations.test.ts`'s `makeStreamingRunner`/`mkApp` idioms.
 */

import type { AgentEvent, RunOptions } from "@agentic-patterns/runtime";
import { AgentEventBus, createEvent } from "@agentic-patterns/runtime";
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

// ---------------------------------------------------------------------------
// SSE transcript parsing (eval-run.test.ts idiom)
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

/**
 * Throws before yielding a single event — the exact pre-token failure
 * window (model-resolution reject, provider construction failure) N5 fixes
 * on the wire (`agent-runner.ts:1105`'s pre-yield window in the real
 * runner).
 */
function makeThrowBeforeFirstYieldRunner(message: string) {
  return {
    async run(): Promise<never> {
      throw new Error("run() not used in these tests");
    },
    // biome-ignore lint/correctness/useYield: throw-before-first-yield IS the case under test
    async *stream(): AsyncGenerator<AgentEvent> {
      throw new Error(message);
    },
  };
}

/** Yields one `agent.message.start` (with a runId), then throws mid-stream. */
function makeThrowMidStreamRunner(runId: string, message: string) {
  return {
    async run(): Promise<never> {
      throw new Error("run() not used in these tests");
    },
    async *stream(
      _agent: unknown,
      _message: string,
      options?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      const traceId = options?.traceId ?? runId;
      yield createEvent("agent.message.start", {
        traceId,
        runId,
        agentName: "test-agent",
      });
      throw new Error(message);
    },
  };
}

// ---------------------------------------------------------------------------
// App + request helpers
// ---------------------------------------------------------------------------

function mkApp(opts?: { agents?: AgentRegistration[]; eventBus?: AgentEventBus }): Hono {
  const app = new Hono();
  app.route(
    "/",
    conversationRoutes(
      opts?.agents ?? [],
      new Map<string, ConversationEntry>(),
      opts?.eventBus ?? new AgentEventBus(),
      undefined,
    ),
  );
  return app;
}

async function createAndStream(app: Hono, agentId: string): Promise<Response> {
  const createRes = await app.request("/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
  const { id } = (await createRes.json()) as { id: string };
  return app.request(`/conversations/${id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "hi" }),
  });
}

describe("N5 torn-stream fix — error+done frames on runner failure", () => {
  it("pre-token throw: conversation.start -> conversation.end{error} -> error -> done, in order", async () => {
    const runner = makeThrowBeforeFirstYieldRunner(
      'ModelResolver: cannot resolve model id "bogus-9000".',
    );
    const reg: AgentRegistration = { id: "broken", name: "Broken", agent: mockAgent, runner };
    const app = mkApp({ agents: [reg] });

    const res = await createAndStream(app, "broken");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSSE(await res.text());
    const names = events.map((e) => e.event);

    expect(names).toEqual(["conversation.start", "conversation.end", "error", "done"]);

    const endFrame = events[1] as { data: { reason: string } };
    expect(endFrame.data.reason).toBe("error");

    const errorFrame = events[2] as {
      data: { error_type: string; message: string; recoverable: boolean };
    };
    expect(errorFrame.data.error_type).toBe("Error");
    expect(errorFrame.data.message).toMatch(/cannot resolve model id/);
    expect(errorFrame.data.recoverable).toBe(false);

    // Pre-token failure -> no agent.message.start was ever observed -> done {}.
    const doneFrame = events[3] as { event: string; data: Record<string, unknown> };
    expect(doneFrame.event).toBe("done");
    expect(doneFrame.data).toEqual({});
    expect(events[events.length - 1]?.event).toBe("done");
  });

  it("mid-stream throw: error + done are present, and done carries the observed run_id", async () => {
    const runId = "runner-run-mid-stream";
    const runner = makeThrowMidStreamRunner(runId, "boom mid-stream");
    const reg: AgentRegistration = { id: "mid-throw", name: "MidThrow", agent: mockAgent, runner };
    const app = mkApp({ agents: [reg] });

    const res = await createAndStream(app, "mid-throw");
    const events = parseSSE(await res.text());
    const names = events.map((e) => e.event);

    expect(names).toContain("error");
    expect(names).toContain("done");
    // done is the last frame, and carries the runId the mid-stream throw observed.
    const doneFrame = events[events.length - 1] as { event: string; data: { run_id?: string } };
    expect(doneFrame.event).toBe("done");
    expect(doneFrame.data.run_id).toBe(runId);
  });

  it("status/content-type stay 200 + text/event-stream on a pre-token throw", async () => {
    // Documents that the fix is frame-level: the HTTP status is committed
    // BEFORE streaming begins, which is why a torn stream still reads 200 —
    // exactly why the wire-level error/done frames are the only fix available.
    const runner = makeThrowBeforeFirstYieldRunner("boom before first token");
    const reg: AgentRegistration = { id: "broken2", name: "Broken2", agent: mockAgent, runner };
    const app = mkApp({ agents: [reg] });

    const res = await createAndStream(app, "broken2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.text();
  });

  it("publishes a synthesized agent.error on the event bus alongside the SSE frame", async () => {
    const runner = makeThrowBeforeFirstYieldRunner("boom for bus");
    const reg: AgentRegistration = { id: "broken3", name: "Broken3", agent: mockAgent, runner };
    const eventBus = new AgentEventBus();
    const busEvents: AgentEvent[] = [];
    eventBus.subscribe("agent.error", async (ev) => {
      busEvents.push(ev as AgentEvent);
    });
    const app = mkApp({ agents: [reg], eventBus });

    const res = await createAndStream(app, "broken3");
    await res.text();

    expect(busEvents).toHaveLength(1);
    const errEvent = busEvents[0] as Extract<AgentEvent, { type: "agent.error" }>;
    expect(errEvent.type).toBe("agent.error");
    expect(errEvent.message).toBe("boom for bus");
    expect(errEvent.recoverable).toBe(false);
    expect(typeof errEvent.traceId).toBe("string");
  });
});
