/**
 * `CodingAgentRunner.runStructured()` (#547) — the base against a fake
 * `HarnessAdapter`/`HarnessSession` (no real `claude` subprocess), mirroring
 * `coding-agent-runner-abort.test.ts`'s fakes with `features.structuredOutput`
 * added to the probe and a `terminal` fixture carrying `structuredOutput`.
 *
 * Event-exactness assertions below are FAKE-SCOPED: they prove what the base
 * emits, not what a live harness's own hooks add (e.g. the CC carrier bypass,
 * covered separately in `claude-code-api-runner.test.ts`).
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentEventBus } from "../../../events/agent-event-bus.js";
import type { AgentEvent } from "../../../events/types.js";
import { RunCancelledError, StructuredOutputUnavailableError } from "../../errors.js";
import { OpenObjectSchemaError } from "../../schema-guard.js";
import type { AgentLike } from "../../types.js";
import { CodingAgentRunner } from "../coding-agent-runner.js";
import { HarnessStartError } from "../types.js";
import type {
  DecisionVocabulary,
  HarnessAdapter,
  HarnessEvent,
  HarnessProbeResult,
  HarnessRunRequest,
  HarnessSession,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fakes (mirrors coding-agent-runner-abort.test.ts)
// ---------------------------------------------------------------------------

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  async respond(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.interruptCalls++;
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.hang.resolve();
  }
}

const PROBE_STRUCTURED: HarnessProbeResult = {
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
    structuredOutput: true,
  },
};

const PROBE_NO_STRUCTURED: HarnessProbeResult = {
  ...PROBE_STRUCTURED,
  features: { ...PROBE_STRUCTURED.features, structuredOutput: false },
};

class FakeAdapter implements HarnessAdapter<AgentLike> {
  readonly name = "fake-harness";
  readonly decisionVocabulary: DecisionVocabulary = {};
  startCalls = 0;
  probeCalls = 0;
  lastRequest: HarnessRunRequest<AgentLike> | undefined;

  constructor(
    private readonly session: HarnessSession,
    private readonly probeResult: HarnessProbeResult = PROBE_STRUCTURED,
  ) {}

  async probe(): Promise<HarnessProbeResult> {
    this.probeCalls++;
    return this.probeResult;
  }

  async start(req: HarnessRunRequest<AgentLike>): Promise<HarnessSession> {
    this.startCalls++;
    this.lastRequest = req;
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

async function drainStructured<T>(
  runner: FakeRunner,
  schema: z.ZodType<T>,
  options?: Parameters<CodingAgentRunner["runStructured"]>[3],
) {
  return runner.runStructured(makeAgent(), "hi", schema, options);
}

function eventTypes(events: AgentEvent[]): string[] {
  return events.map((e) => e.type);
}

const ANSWER_SCHEMA = z.object({ answer: z.number(), reasoning: z.string() });

const HAPPY_TERMINAL: HarnessEvent = {
  ids: {},
  kind: "terminal",
  numTurns: 1,
  usage: { inputTokens: 3, outputTokens: 2 },
  costUsd: 0.01,
  finishReason: "stop",
  structuredOutput: { answer: 42, reasoning: "because" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodingAgentRunner.runStructured() (#547)", () => {
  it("1. happy path: returns parsed object, response as JSON, exact bus events, no agent.error", async () => {
    const session = new FakeSession([HAPPY_TERMINAL], { endCleanly: true });
    const adapter = new FakeAdapter(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const events: AgentEvent[] = [];
    bus.subscribeAll((e) => events.push(e as AgentEvent));

    const result = await drainStructured(runner, ANSWER_SCHEMA);

    expect(result.object).toEqual({ answer: 42, reasoning: "because" });
    expect(result.response).toBe(JSON.stringify(result.object));
    expect(result.finishReason).toBe("stop");
    expect(result.iterations).toBe(1);
    expect(result.costUsd).toBe(0.01);
    expect(result.inputTokens).toBe(3);
    expect(result.outputTokens).toBe(2);

    expect(eventTypes(events)).toEqual(["agent.message.start", "agent.message.complete"]);
    const complete = events.find((e) => e.type === "agent.message.complete") as {
      content?: string;
    };
    expect(complete.content).toBe(result.response);
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
  });

  it("2. the HarnessRunRequest carries structured.jsonSchema with type:object and the declared properties", async () => {
    const session = new FakeSession([HAPPY_TERMINAL], { endCleanly: true });
    const adapter = new FakeAdapter(session);
    const runner = new FakeRunner(adapter, new AgentEventBus());

    await drainStructured(runner, ANSWER_SCHEMA);

    const req = adapter.lastRequest;
    expect(req?.structured).toBeDefined();
    const jsonSchema = req?.structured?.jsonSchema as { type?: string; properties?: object };
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toMatchObject({
      answer: expect.anything(),
      reasoning: expect.anything(),
    });
  });

  it("3. runId/traceId from options are honored on message.start", async () => {
    const session = new FakeSession([HAPPY_TERMINAL], { endCleanly: true });
    const adapter = new FakeAdapter(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const events: AgentEvent[] = [];
    bus.subscribeAll((e) => events.push(e as AgentEvent));

    await drainStructured(runner, ANSWER_SCHEMA, { runId: "run-1", traceId: "trace-1" });

    const start = events.find((e) => e.type === "agent.message.start") as {
      runId?: string;
      traceId?: string;
    };
    expect(start.runId).toBe("run-1");
    expect(start.traceId).toBe("trace-1");
  });

  it("4. schema-invalid structuredOutput rejects with schema-validation error; exactly one agent.error; no message.complete", async () => {
    const badTerminal: HarnessEvent = {
      ...HAPPY_TERMINAL,
      structuredOutput: { answer: "not-a-number" },
    };
    const session = new FakeSession([badTerminal], { endCleanly: true });
    const adapter = new FakeAdapter(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const events: AgentEvent[] = [];
    bus.subscribeAll((e) => events.push(e as AgentEvent));

    await expect(drainStructured(runner, ANSWER_SCHEMA)).rejects.toThrow(
      /failed schema validation/,
    );

    const errors = events.filter((e) => e.type === "agent.error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { recoverable?: boolean }).recoverable).toBe(false);
    expect(events.some((e) => e.type === "agent.message.complete")).toBe(false);
  });

  it("5. success terminal with no structuredOutput rejects with StructuredOutputUnavailableError, finishReason stop, one agent.error", async () => {
    const noPayload: HarnessEvent = {
      ids: {},
      kind: "terminal",
      numTurns: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
    };
    const session = new FakeSession([noPayload], { endCleanly: true });
    const adapter = new FakeAdapter(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const events: AgentEvent[] = [];
    bus.subscribeAll((e) => events.push(e as AgentEvent));

    let caught: unknown;
    try {
      await drainStructured(runner, ANSWER_SCHEMA);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StructuredOutputUnavailableError);
    expect((caught as StructuredOutputUnavailableError).finishReason).toBe("stop");

    expect(events.filter((e) => e.type === "agent.error")).toHaveLength(1);
    const errorEvent = events.find((e) => e.type === "agent.error") as {
      errorType?: string;
      recoverable?: boolean;
    };
    expect(errorEvent.errorType).toBe("StructuredOutputUnavailableError");
    expect(errorEvent.recoverable).toBe(false);
  });

  it("6. finishReason max-structured-output-retries carries the retry hint; error_during_execution has no hint", async () => {
    const retryExhausted: HarnessEvent = {
      ids: {},
      kind: "terminal",
      numTurns: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "max-structured-output-retries",
    };
    const session1 = new FakeSession([retryExhausted], { endCleanly: true });
    const runner1 = new FakeRunner(new FakeAdapter(session1), new AgentEventBus());

    let caught: unknown;
    try {
      await drainStructured(runner1, ANSWER_SCHEMA);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StructuredOutputUnavailableError);
    const structErr = caught as StructuredOutputUnavailableError;
    expect(structErr.name).toBe("StructuredOutputUnavailableError");
    expect(structErr.finishReason).toBe("max-structured-output-retries");
    expect(structErr.message).toMatch(/retry budget/);

    const errored: HarnessEvent = {
      ids: {},
      kind: "terminal",
      numTurns: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "error",
    };
    const session2 = new FakeSession([errored], { endCleanly: true });
    const runner2 = new FakeRunner(new FakeAdapter(session2), new AgentEventBus());

    let caught2: unknown;
    try {
      await drainStructured(runner2, ANSWER_SCHEMA);
    } catch (err) {
      caught2 = err;
    }
    expect(caught2).toBeInstanceOf(StructuredOutputUnavailableError);
    const structErr2 = caught2 as StructuredOutputUnavailableError;
    expect(structErr2.finishReason).toBe("error");
    expect(structErr2.message).not.toMatch(/retry budget/);
    expect(structErr2.message).not.toMatch(/StructuredOutput carrier/);
  });

  it("7. pre-fired abortSignal rejects with RunCancelledError, zero events, adapter.start never called", async () => {
    const controller = new AbortController();
    controller.abort();

    const session = new FakeSession([HAPPY_TERMINAL], { endCleanly: true });
    const adapter = new FakeAdapter(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const events: AgentEvent[] = [];
    bus.subscribeAll((e) => events.push(e as AgentEvent));

    let caught: unknown;
    try {
      await drainStructured(runner, ANSWER_SCHEMA, { abortSignal: controller.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunCancelledError);
    expect((caught as RunCancelledError).name).toBe("RunCancelledError");
    expect(events).toHaveLength(0);
    expect(adapter.startCalls).toBe(0);
  });

  it("7b. abort firing AFTER message.start but before the harness launches finalizes with message.complete{cancelled} and rejects RunCancelledError; adapter.start never called", async () => {
    const controller = new AbortController();
    const session = new FakeSession([HAPPY_TERMINAL], { endCleanly: true });
    // Fire the signal from inside probe(): that is the window between
    // runStructured()'s pre-start check and _startRun's own check, and it
    // runs after `agent.message.start` has been published.
    const adapter = new (class extends FakeAdapter {
      override async probe(): Promise<HarnessProbeResult> {
        controller.abort();
        return super.probe();
      }
    })(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const events: AgentEvent[] = [];
    bus.subscribeAll((e) => events.push(e as AgentEvent));

    let caught: unknown;
    try {
      await drainStructured(runner, ANSWER_SCHEMA, { abortSignal: controller.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunCancelledError);
    expect(adapter.startCalls).toBe(0);
    expect(events.map((e) => e.type)).toEqual(["agent.message.start", "agent.message.complete"]);
    const complete = events[1] as { finishReason?: string; content?: string };
    expect(complete.finishReason).toBe("cancelled");
    expect(complete.content).toBe("");
  });

  it("8. mid-run abort closes the session, publishes message.complete{finishReason:cancelled} with accrued content/tokens, rejects RunCancelledError", async () => {
    const controller = new AbortController();
    const session = new FakeSession([
      { ids: {}, kind: "turn-start" },
      { ids: {}, kind: "text-delta", text: "partial" },
    ]);
    const adapter = new FakeAdapter(session);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const events: AgentEvent[] = [];
    bus.subscribeAll((e) => events.push(e as AgentEvent));

    const runPromise = drainStructured(runner, ANSWER_SCHEMA, { abortSignal: controller.signal });

    await session.reachedHang.promise;
    controller.abort();

    let caught: unknown;
    try {
      await runPromise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunCancelledError);
    expect(session.closeCalls).toBe(1);

    const complete = events.find((e) => e.type === "agent.message.complete") as {
      finishReason?: string;
      content?: string;
      inputTokens?: number;
      outputTokens?: number;
    };
    expect(complete).toBeDefined();
    expect(complete.finishReason).toBe("cancelled");
    expect(complete.content).toBe("partial");
    // Run-level tokens come only from the `terminal` event, which a hung
    // harness never delivered — so the honest accrued value is 0, not absent.
    expect(complete.inputTokens).toBe(0);
    expect(complete.outputTokens).toBe(0);
  });

  it("9. adapter whose probe lacks features.structuredOutput rejects with HarnessStartError capability-missing, before any event, adapter.start never called", async () => {
    const session = new FakeSession([HAPPY_TERMINAL], { endCleanly: true });
    const adapter = new FakeAdapter(session, PROBE_NO_STRUCTURED);
    const bus = new AgentEventBus();
    const runner = new FakeRunner(adapter, bus);

    const events: AgentEvent[] = [];
    bus.subscribeAll((e) => events.push(e as AgentEvent));

    let caught: unknown;
    try {
      await drainStructured(runner, ANSWER_SCHEMA);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessStartError);
    expect((caught as HarnessStartError).code).toBe("capability-missing");
    expect(events).toHaveLength(0);
    expect(adapter.startCalls).toBe(0);
  });

  it("10. z.record(z.string()) rejects with OpenObjectSchemaError before probe; allowOpenObjectSchemas:true proceeds", async () => {
    const openSchema = z.record(z.string());
    const session = new FakeSession(
      [
        {
          ids: {},
          kind: "terminal",
          numTurns: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          structuredOutput: { a: "1" },
        },
      ],
      { endCleanly: true },
    );
    const adapter = new FakeAdapter(session);
    const runner = new FakeRunner(adapter, new AgentEventBus());

    await expect(drainStructured(runner, openSchema)).rejects.toThrow(OpenObjectSchemaError);
    expect(adapter.probeCalls).toBe(0);
    expect(adapter.startCalls).toBe(0);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await drainStructured(runner, openSchema, { allowOpenObjectSchemas: true });
      expect(result.object).toEqual({ a: "1" });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("11. per-call options.eventBus receives the events, the constructor bus does not (#496 parity)", async () => {
    const session = new FakeSession([HAPPY_TERMINAL], { endCleanly: true });
    const adapter = new FakeAdapter(session);
    const constructorBus = new AgentEventBus();
    const perCallBus = new AgentEventBus();
    const runner = new FakeRunner(adapter, constructorBus);

    const constructorEvents: AgentEvent[] = [];
    const perCallEvents: AgentEvent[] = [];
    constructorBus.subscribeAll((e) => constructorEvents.push(e as AgentEvent));
    perCallBus.subscribeAll((e) => perCallEvents.push(e as AgentEvent));

    await drainStructured(runner, ANSWER_SCHEMA, { eventBus: perCallBus });

    expect(perCallEvents.length).toBeGreaterThan(0);
    expect(constructorEvents).toHaveLength(0);
  });

  it("12. runner satisfies RunnerProtocol's runStructured — the AgentStep unlock", async () => {
    const session = new FakeSession([HAPPY_TERMINAL], { endCleanly: true });
    const adapter = new FakeAdapter(session);
    const runner = new FakeRunner(adapter, new AgentEventBus());

    const r: import("../../types.js").RunnerProtocol = runner;
    expect(typeof r.runStructured).toBe("function");
  });
});
