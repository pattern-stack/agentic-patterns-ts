/**
 * `CodingAgentRunner` — `RunOptions.abortSignal` wiring (#368).
 *
 * `ClaudeCodeRunner`/`ClaudeCodeAPIRunner` both extend `CodingAgentRunner` and
 * inherit `run()`/`stream()` from it unchanged — these tests exercise the
 * base directly against a fake `HarnessAdapter`/`HarnessSession` (no real
 * `claude` subprocess), which is exactly the seam #326 designed for. Real
 * termination mechanics (SDK `interrupt()`/`return()` → subprocess
 * SIGTERM/SIGKILL) live in `ClaudeCodeSession` (`claude-code-adapter.ts`) and
 * are NOT re-tested here — that's the SDK's own already-shipped contract.
 * What THIS suite proves is the bug fix itself: the runner now actually
 * calls `HarnessSession.close()` promptly in response to `options.
 * abortSignal` instead of ignoring it (the bug — before #368, nothing in
 * `CodingAgentRunner` ever read `abortSignal` at all).
 */

import { describe, expect, it } from "vitest";

import { AgentEventBus } from "../../../events/agent-event-bus.js";
import type { AgentEvent } from "../../../events/types.js";
import type { AgentLike } from "../../types.js";
import { CodingAgentRunner } from "../coding-agent-runner.js";
import type {
  DecisionVocabulary,
  HarnessAdapter,
  HarnessEvent,
  HarnessProbeResult,
  HarnessRunRequest,
  HarnessSession,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A promise resolved from outside — lets a test unblock a "hanging" fake. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A fake `HarnessSession` that yields a fixed prefix of events, then —
 * unless `endCleanly` — HANGS forever on its next `.next()` call. This
 * mirrors a real `claude` subprocess that keeps generating tokens until
 * something external kills it: `close()` is the only thing that ever
 * unblocks it, exactly like the real `ClaudeCodeSession`'s
 * `interrupt()`+`return()` unblocking its own pending SDK read via
 * `inputStream.done()`.
 *
 * `reachedHang` resolves the instant the generator is genuinely blocked
 * (all prefix events already delivered, now suspended on `this.hang`) — a
 * test awaits it before firing the abort so the mid-generation tests exercise
 * the actual race (not merely the cheap top-of-loop check).
 */
class FakeSession implements HarnessSession {
  closeCalls = 0;
  interruptCalls = 0;
  readonly hang = deferred<void>();
  readonly reachedHang = deferred<void>();
  private readonly events: readonly HarnessEvent[];
  private readonly endCleanly: boolean;

  constructor(events: readonly HarnessEvent[], opts?: { endCleanly?: boolean }) {
    this.events = events;
    this.endCleanly = opts?.endCleanly ?? false;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<HarnessEvent> {
    for (const e of this.events) yield e;
    if (!this.endCleanly) {
      this.reachedHang.resolve();
      await this.hang.promise;
    }
  }

  async respond(): Promise<void> {
    // No asks raised by these fixtures.
  }

  async interrupt(): Promise<void> {
    this.interruptCalls++;
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.hang.resolve();
  }
}

const PROBE_OK: HarnessProbeResult = {
  ok: true,
  issues: [],
  authMode: "subscription",
  enforcement: {
    shell: "enforcing",
    "file-change": "enforcing",
    "mcp-tool": "enforcing",
    "local-tool": "enforcing",
    subagent: "enforcing",
    "hosted-tool": "advisory",
  },
  sandbox: { networkPolicy: "none" },
  features: {
    interactiveAsk: true,
    resume: true,
    partialStreaming: true,
    inputRewrite: true,
    durableRules: true,
  },
};

class FakeAdapter implements HarnessAdapter<AgentLike> {
  readonly name = "fake-harness";
  readonly decisionVocabulary: DecisionVocabulary = {};
  startCalls = 0;

  constructor(private readonly session: HarnessSession) {}

  async probe(): Promise<HarnessProbeResult> {
    return PROBE_OK;
  }

  async start(_req: HarnessRunRequest<AgentLike>): Promise<HarnessSession> {
    this.startCalls++;
    return this.session;
  }
}

class FakeRunner extends CodingAgentRunner<AgentLike> {
  constructor(
    private readonly adapter: FakeAdapter,
    eventBus?: AgentEventBus,
  ) {
    super(eventBus);
  }

  protected createAdapter(): HarnessAdapter<AgentLike> {
    return this.adapter;
  }
}

function makeAgent(): AgentLike {
  return {
    role: { name: "test-agent" },
    getModel: () => "claude-sonnet-4-6",
    getTools: () => [],
    renderInitialPrompt: () => "system",
  };
}

async function collectStream(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function eventTypes(events: AgentEvent[]): string[] {
  return events.map((e) => e.type);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodingAgentRunner — RunOptions.abortSignal (#368)", () => {
  // -------------------------------------------------------------------------
  // (b) pre-aborted signal at entry — never starts the harness subprocess.
  // -------------------------------------------------------------------------

  it("run(): pre-aborted signal never launches the harness — finishReason cancelled, empty response", async () => {
    const controller = new AbortController();
    controller.abort();

    const session = new FakeSession([{ ids: {}, kind: "turn-start" }]);
    const adapter = new FakeAdapter(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const events: AgentEvent[] = [];
    bus.subscribeAll((e) => {
      events.push(e as AgentEvent);
    });

    const result = await runner.run(makeAgent(), "hi", { abortSignal: controller.signal });

    expect(adapter.startCalls).toBe(0);
    expect(session.closeCalls).toBe(0);
    expect(result.finishReason).toBe("cancelled");
    expect(result.response).toBe("");

    expect(eventTypes(events)).toEqual(["agent.message.start", "agent.message.complete"]);
    const complete = events.find((e) => e.type === "agent.message.complete");
    expect((complete as { finishReason?: string }).finishReason).toBe("cancelled");
  });

  it("stream(): pre-aborted signal — message.start then only the cancel signal, generator returns (never throws)", async () => {
    const controller = new AbortController();
    controller.abort();

    const session = new FakeSession([{ ids: {}, kind: "turn-start" }]);
    const adapter = new FakeAdapter(session);
    const runner = new FakeRunner(adapter, new AgentEventBus());

    const events = await collectStream(
      runner.stream(makeAgent(), "hi", { abortSignal: controller.signal }),
    );

    expect(adapter.startCalls).toBe(0);
    expect(session.closeCalls).toBe(0);
    expect(eventTypes(events)).toEqual(["agent.message.start", "agent.message.cancel"]);
    const cancel = events.find((e) => e.type === "agent.message.cancel");
    expect((cancel as { reason?: string }).reason).toBe("cancelled by client");
  });

  // -------------------------------------------------------------------------
  // (a) abort mid-generation — terminates the underlying session and emits
  // the cancel pair. The fake session HANGS after its scripted prefix
  // (mirrors a `claude` subprocess still generating) — proving the runner
  // actually interrupts a genuinely blocked read, not just a between-events
  // gap.
  // -------------------------------------------------------------------------

  it("run(): abort mid-generation closes the session and returns partial content with finishReason cancelled — no agent.error", async () => {
    const controller = new AbortController();
    const session = new FakeSession([
      { ids: {}, kind: "turn-start" },
      { ids: {}, kind: "text-delta", text: "partial answer" },
    ]);
    const adapter = new FakeAdapter(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const errors: AgentEvent[] = [];
    bus.subscribe("agent.error", (e) => {
      errors.push(e as AgentEvent);
    });

    const runPromise = runner.run(makeAgent(), "hi", { abortSignal: controller.signal });

    // Don't fire the abort until the fake session is GENUINELY blocked (all
    // scripted events already delivered) — this is what distinguishes this
    // test from the cheap top-of-loop check covered by the entry-guard tests
    // above.
    await session.reachedHang.promise;
    controller.abort();

    const result = await runPromise;

    expect(adapter.startCalls).toBe(1);
    expect(session.closeCalls).toBe(1);
    expect(session.interruptCalls).toBe(0); // this base never calls interrupt() directly — close() owns it
    expect(result.finishReason).toBe("cancelled");
    // D5 posture: partial output the user already streamed is real, not
    // discarded — never a blanket empty response on a mid-stream abort.
    expect(result.response).toBe("partial answer");
    expect(errors).toHaveLength(0);
  });

  it("stream(): abort while the harness is blocked mid-turn stops draining, closes the session, and emits only the cancel signal", async () => {
    const controller = new AbortController();
    const session = new FakeSession([
      { ids: {}, kind: "turn-start" },
      { ids: {}, kind: "text-delta", text: "partial " },
    ]);
    const adapter = new FakeAdapter(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const errors: AgentEvent[] = [];
    bus.subscribe("agent.error", (e) => {
      errors.push(e as AgentEvent);
    });

    const gen = runner.stream(makeAgent(), "hi", { abortSignal: controller.signal });
    const collected: AgentEvent[] = [];

    // Pump exactly the events the fixture legitimately produces before the
    // harness would hang: message.start, then turn-start's
    // iteration.start + llm.start, then text-delta's message.chunk.
    for (let i = 0; i < 4; i++) {
      const r = await gen.next();
      expect(r.done).toBe(false);
      if (r.value) collected.push(r.value);
    }
    expect(eventTypes(collected)).toEqual([
      "agent.message.start",
      "agent.iteration.start",
      "agent.llm.start",
      "agent.message.chunk",
    ]);

    // The 5th pull asks for a HarnessEvent the fixture doesn't have — this is
    // what puts the drain loop genuinely into its abort race, blocked on a
    // read that will never resolve on its own. Only once that's true do we
    // fire the abort.
    const pending = gen.next();
    await session.reachedHang.promise;
    controller.abort();

    const cancelResult = await pending;
    expect(cancelResult.done).toBe(false);
    expect(cancelResult.value?.type).toBe("agent.message.cancel");
    expect((cancelResult.value as { reason?: string }).reason).toBe("cancelled by client");

    const done = await gen.next();
    expect(done.done).toBe(true);

    expect(adapter.startCalls).toBe(1);
    expect(session.closeCalls).toBe(1);
    expect(errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // (c) non-abort paths are unchanged.
  // -------------------------------------------------------------------------

  const HAPPY_PATH_EVENTS: readonly HarnessEvent[] = [
    { ids: {}, kind: "turn-start" },
    { ids: {}, kind: "text-delta", text: "Hello" },
    {
      ids: {},
      kind: "llm-response",
      usage: { inputTokens: 3, outputTokens: 2 },
      model: "claude-sonnet-4-6",
      stopReason: "end_turn",
    },
    { ids: {}, kind: "turn-end" },
    {
      ids: {},
      kind: "terminal",
      numTurns: 1,
      usage: { inputTokens: 3, outputTokens: 2 },
      finishReason: "stop",
    },
  ];

  it("run(): no abortSignal — normal completion is unaffected (regression guard)", async () => {
    const session = new FakeSession(HAPPY_PATH_EVENTS, { endCleanly: true });
    const adapter = new FakeAdapter(session);
    const runner = new FakeRunner(adapter, new AgentEventBus());

    const result = await runner.run(makeAgent(), "hi");

    expect(adapter.startCalls).toBe(1);
    expect(session.closeCalls).toBe(1); // the pre-existing unconditional finally
    expect(result.finishReason).toBe("stop");
    expect(result.response).toBe("Hello");
  });

  it("stream(): no abortSignal — normal completion is unaffected (regression guard)", async () => {
    const session = new FakeSession(HAPPY_PATH_EVENTS, { endCleanly: true });
    const adapter = new FakeAdapter(session);
    const runner = new FakeRunner(adapter, new AgentEventBus());

    const events = await collectStream(runner.stream(makeAgent(), "hi"));

    expect(adapter.startCalls).toBe(1);
    expect(session.closeCalls).toBe(1);
    expect(eventTypes(events)).toEqual([
      "agent.message.start",
      "agent.iteration.start",
      "agent.llm.start",
      "agent.message.chunk",
      "agent.llm.end",
      "agent.iteration.end",
      "agent.message.complete",
    ]);
    const complete = events.find((e) => e.type === "agent.message.complete");
    expect((complete as { finishReason?: string }).finishReason).toBe("stop");
  });

  // -------------------------------------------------------------------------
  // An abort racing a genuine harness error still surfaces the real error —
  // `_drainSession` only special-cases its OWN abort branch, never a
  // rejection from the harness itself.
  // -------------------------------------------------------------------------

  it("a harness rejection (not caused by abort) still throws through run() as agent.error, unaffected by an unrelated abortSignal present but never fired", async () => {
    class ThrowingSession extends FakeSession {
      override async *[Symbol.asyncIterator](): AsyncGenerator<HarnessEvent> {
        yield { ids: {}, kind: "turn-start" };
        throw new Error("boom");
      }
    }
    const session = new ThrowingSession([]);
    const adapter = new FakeAdapter(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const errors: AgentEvent[] = [];
    bus.subscribe("agent.error", (e) => {
      errors.push(e as AgentEvent);
    });

    const controller = new AbortController(); // present, never aborted
    await expect(runner.run(makeAgent(), "hi", { abortSignal: controller.signal })).rejects.toThrow(
      "boom",
    );

    expect(errors).toHaveLength(1);
    expect((errors[0] as { message?: string }).message).toBe("boom");
  });
});
