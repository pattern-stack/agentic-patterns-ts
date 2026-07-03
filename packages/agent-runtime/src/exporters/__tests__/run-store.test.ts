/**
 * RunStoreExporter integration test — attach the exporter to a real bus,
 * publish a run lifecycle, verify the aggregate row folds correctly and
 * that exceptions don't break the bus (SQLiteExporter's contract).
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type {
  BaseEvent,
  ErrorEvent,
  IterationEndEvent,
  LLMCallEndEvent,
  MessageCompleteEvent,
  MessageStartEvent,
  ToolCallEndEvent,
} from "../../events/types.js";
import { RunStore } from "../../storage/run-store.js";
import { RunStoreExporter } from "../run-store.js";
import { SQLiteExporter } from "../sqlite.js";

function mkBase(overrides: Partial<BaseEvent> = {}): BaseEvent {
  return {
    type: "agent.message.start",
    traceId: "trace-1",
    runId: "run-1",
    spanId: `span-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date("2026-05-11T18:00:00.000Z"),
    ...overrides,
  } as BaseEvent;
}

function messageStart(overrides: Partial<MessageStartEvent> = {}): MessageStartEvent {
  return {
    ...mkBase(),
    type: "agent.message.start",
    agentName: "test-agent",
    agentConfig: { role: "test-agent", model: "test-model", tools: [] },
    systemPrompt: "You are a test agent.",
    ...overrides,
  } as MessageStartEvent;
}

function llmEnd(overrides: Partial<LLMCallEndEvent> = {}): LLMCallEndEvent {
  return {
    ...mkBase(),
    type: "agent.llm.end",
    model: "test-model",
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 100,
    hasToolCalls: false,
    finishReason: "stop",
    ...overrides,
  } as LLMCallEndEvent;
}

function toolEnd(overrides: Partial<ToolCallEndEvent> = {}): ToolCallEndEvent {
  return {
    ...mkBase(),
    type: "agent.tool.end",
    toolCallId: "tc-1",
    toolName: "search",
    arguments: {},
    result: "ok",
    durationMs: 20,
    resultTokens: 0,
    ...overrides,
  } as ToolCallEndEvent;
}

function iterationEnd(overrides: Partial<IterationEndEvent> = {}): IterationEndEvent {
  return {
    ...mkBase(),
    type: "agent.iteration.end",
    iteration: 0,
    toolCallsCount: 0,
    hasMore: false,
    ...overrides,
  } as IterationEndEvent;
}

function messageComplete(overrides: Partial<MessageCompleteEvent> = {}): MessageCompleteEvent {
  return {
    ...mkBase(),
    type: "agent.message.complete",
    content: "done",
    inputTokens: 10,
    outputTokens: 5,
    model: "test-model",
    ...overrides,
  } as MessageCompleteEvent;
}

function errorEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    ...mkBase(),
    type: "agent.error",
    errorType: "Error",
    message: "boom",
    recoverable: false,
    context: {},
    ...overrides,
  } as ErrorEvent;
}

describe("RunStoreExporter", () => {
  let store: RunStore;
  let bus: AgentEventBus;
  let exporter: RunStoreExporter;

  beforeEach(() => {
    store = new RunStore({ path: ":memory:", Database });
    bus = new AgentEventBus();
    exporter = new RunStoreExporter({ store });
    exporter.attach(bus);
  });

  afterEach(() => {
    exporter.detach(bus);
    store.close();
  });

  it("folds a success sequence (start -> iterations -> complete) into an 'ok' row", async () => {
    const runId = "run-success";
    const t0 = new Date("2026-05-11T18:00:00.000Z");
    const t1 = new Date("2026-05-11T18:00:01.500Z"); // +1500ms, event-clock

    await bus.publish(messageStart({ runId, timestamp: t0, agentName: "agent-x" }));
    await bus.publish(
      llmEnd({ runId, inputTokens: 10, outputTokens: 5, finishReason: "tool_calls" }),
    );
    await bus.publish(toolEnd({ runId }));
    await bus.publish(iterationEnd({ runId, iteration: 0, hasMore: true }));
    await bus.publish(llmEnd({ runId, inputTokens: 20, outputTokens: 8, finishReason: "stop" }));
    await bus.publish(iterationEnd({ runId, iteration: 1, hasMore: false }));
    await bus.publish(
      messageComplete({
        runId,
        timestamp: t1,
        content: "final answer",
        inputTokens: 30,
        outputTokens: 13,
        finishReason: "stop",
      }),
    );

    const row = store.getRun(runId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("ok");
    expect(row?.finalAnswer).toBe("final answer");
    expect(row?.inputTokens).toBe(30);
    expect(row?.outputTokens).toBe(13);
    expect(row?.toolCalls).toBe(1);
    expect(row?.iterations).toBe(2);
    expect(row?.finishReason).toBe("stop");
    expect(row?.elapsedMs).toBe(1500);
    expect(row?.stepMetrics).toEqual([
      {
        iteration: 0,
        inputTokens: 10,
        outputTokens: 5,
        toolCalls: 1,
        llmDurationMs: 100,
        hasMore: true,
      },
      {
        iteration: 1,
        inputTokens: 20,
        outputTokens: 8,
        toolCalls: 0,
        llmDurationMs: 100,
        hasMore: false,
      },
    ]);
  });

  it("finalizes a non-recoverable error as 'error'; a later terminal is ignored (first-terminal-wins)", async () => {
    const runId = "run-error";
    await bus.publish(messageStart({ runId }));
    await bus.publish(errorEvent({ runId, message: "tool exploded", recoverable: false }));

    const row = store.getRun(runId);
    expect(row?.status).toBe("error");
    expect(row?.error).toBe("tool exploded");

    await bus.publish(messageComplete({ runId, content: "should be ignored" }));
    const after = store.getRun(runId);
    expect(after?.status).toBe("error");
    expect(after?.finalAnswer).toBe(""); // the error finalize's own finalAnswer, unchanged
  });

  it("does not finalize on a recoverable error — the run stays open and finalizes normally after", async () => {
    const runId = "run-recoverable";
    await bus.publish(messageStart({ runId }));
    await bus.publish(errorEvent({ runId, recoverable: true }));

    expect(store.getRun(runId)?.status).toBe("running");

    await bus.publish(messageComplete({ runId, content: "recovered" }));
    expect(store.getRun(runId)?.status).toBe("ok");
    expect(store.getRun(runId)?.finalAnswer).toBe("recovered");
  });

  it("leaves an orphan 'running' when no terminal event arrives; sweepRunning() flips it", async () => {
    const runId = "run-orphan";
    await bus.publish(messageStart({ runId }));
    await bus.publish(llmEnd({ runId }));

    expect(store.getRun(runId)?.status).toBe("running");

    const swept = store.sweepRunning();
    expect(swept).toBe(1);
    expect(store.getRun(runId)?.status).toBe("error");
  });

  it("tracks interleaved runs independently (nested sub-agent shape)", async () => {
    await bus.publish(messageStart({ runId: "run-a", agentName: "a" }));
    await bus.publish(messageStart({ runId: "run-b", agentName: "b" }));
    await bus.publish(messageComplete({ runId: "run-a", content: "a-done" }));
    await bus.publish(messageComplete({ runId: "run-b", content: "b-done" }));

    expect(store.getRun("run-a")?.status).toBe("ok");
    expect(store.getRun("run-a")?.finalAnswer).toBe("a-done");
    expect(store.getRun("run-b")?.status).toBe("ok");
    expect(store.getRun("run-b")?.finalAnswer).toBe("b-done");
  });

  it("does not throw if the store rejects a write — bus stays healthy", async () => {
    const failing = {
      startRun: vi.fn(() => {
        throw new Error("disk full");
      }),
    } as unknown as RunStore;

    const onError = vi.fn();
    const failingExporter = new RunStoreExporter({ store: failing, onError });
    failingExporter.attach(bus);

    await expect(bus.publish(messageStart({ runId: "run-fail" }))).resolves.toBeDefined();
    expect(onError).toHaveBeenCalledTimes(1);

    failingExporter.detach(bus);
  });

  it("evicts the oldest open accumulator once maxOpenRuns is reached", async () => {
    // Isolated bus + store: the eviction cap is exercised on `capped` alone —
    // sharing the outer `store`/`bus` would double-insert the same runId
    // (the beforeEach `exporter` is also subscribed) and hit the runs.run_id
    // UNIQUE constraint.
    const localStore = new RunStore({ path: ":memory:", Database });
    const localBus = new AgentEventBus();
    const capped = new RunStoreExporter({ store: localStore, maxOpenRuns: 1 });
    capped.attach(localBus);

    await localBus.publish(messageStart({ runId: "run-old" }));
    await localBus.publish(messageStart({ runId: "run-new" })); // evicts run-old's accumulator

    // run-old's row exists (startRun ran) but its accumulator was evicted, so
    // its terminal event has nothing to finalize against — it stays 'running'.
    await localBus.publish(messageComplete({ runId: "run-old", content: "too late" }));
    expect(localStore.getRun("run-old")?.status).toBe("running");

    // run-new still has its accumulator and finalizes normally.
    await localBus.publish(messageComplete({ runId: "run-new", content: "on time" }));
    expect(localStore.getRun("run-new")?.status).toBe("ok");

    capped.detach(localBus);
    localStore.close();
  });

  it("composes with SQLiteExporter on one bus — runEvents(runId) returns the stream the aggregate row summarizes", async () => {
    const sqliteExporter = new SQLiteExporter({ store });
    sqliteExporter.attach(bus);

    const runId = "run-composed";
    await bus.publish(messageStart({ runId }));
    await bus.publish(llmEnd({ runId }));
    await bus.publish(messageComplete({ runId, content: "composed" }));

    const row = store.getRun(runId);
    expect(row?.status).toBe("ok");
    expect(row?.finalAnswer).toBe("composed");

    const events = store.runEvents(runId);
    expect(events.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.llm.end",
      "agent.message.complete",
    ]);

    sqliteExporter.detach(bus);
  });
});
