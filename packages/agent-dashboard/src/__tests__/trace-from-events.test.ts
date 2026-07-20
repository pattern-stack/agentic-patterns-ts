/**
 * `persistedToEventLike` (port-map §3.3, the load-bearing S6 adapter) pinned
 * against a REAL production event dump — not hand-typed JSON.
 *
 * Provenance: captured by driving the actual production `AgentRunner` (with
 * `ai/test`'s `MockLanguageModelV2` standing in for the network call — the
 * ai-sdk's own test double, not a stub of our runner protocol) through one
 * tool-call iteration + a final answer, wired to the SAME `SQLiteExporter` +
 * `RunStoreExporter` + `RunStore` stack `ap playground` uses, then reading the
 * row back via `RunStore.getRun`/`runEvents` — i.e. the exact bytes
 * `GET /admin/runs/:id` and `GET /admin/runs/:id/events` would serve. A live
 * `ap playground examples` HTTP run was attempted first per the task brief,
 * but promoted-agent chat currently hangs on credential preflight in this
 * environment before any run persists (a fix is landing in parallel per the
 * port-map) — S5's own event/run-store test idioms (`agent-runner.test.ts`'s
 * `collectEvents` helper, `run-store.test.ts`'s `runEval`-seeded suite) are
 * the sanctioned fallback source and are what produced this dump. Repro
 * (package: @agentic-patterns/runtime):
 *
 *   const store = new RunStore({ path: ":memory:", Database });
 *   const bus = new AgentEventBus();
 *   new SQLiteExporter({ store }).attach(bus);
 *   new RunStoreExporter({ store }).attach(bus);
 *   const runner = new AgentRunner(mockLanguageModelV2, bus);
 *   await runner.run(agent, "What's the weather in Seattle?", { toolExecutor });
 *   // -> store.getRun(runId) / store.runEvents(runId)
 */
import { describe, expect, it } from "vitest";
import type { PersistedEvent, RunRow } from "../api/types";
import { eventsToSteps, persistedToEventLike } from "../graph/trace-from-events";
import type { ToolIndex } from "../graph/trace-from-events";
import type { TraceStep } from "../graph/types";

// ---------------------------------------------------------------------------
// The real dump (verbatim; only whitespace-formatted for readability).
// ---------------------------------------------------------------------------

const REAL_RUN: RunRow = {
  runId: "ZqLQv5HWos1cxbZm",
  traceId: "ZqLQv5HWos1cxbZm",
  tsStart: "2026-07-07T02:06:03.260Z",
  tsEnd: "2026-07-07T02:06:03.266Z",
  agentName: "retrieval-analyst",
  model: "mock-model-id",
  systemPrompt: "You are a helpful retrieval analyst.",
  agentConfig: {
    role: "retrieval-analyst",
    model: "mock-model-id",
    tools: ["get_weather"],
  },
  finalAnswer: "The weather in Seattle is rainy.",
  toolCalls: 1,
  iterations: 2,
  inputTokens: 50,
  outputTokens: 25,
  finishReason: "stop",
  elapsedMs: 6,
  status: "ok",
  error: null,
  stepMetrics: [
    {
      iteration: 0,
      hasMore: true,
      inputTokens: 20,
      outputTokens: 10,
      toolCalls: 1,
      llmDurationMs: 4,
    },
    {
      iteration: 1,
      hasMore: false,
      inputTokens: 30,
      outputTokens: 15,
      toolCalls: 0,
      llmDurationMs: 2,
    },
  ],
  metadata: null,
};

const REAL_EVENTS: PersistedEvent[] = [
  {
    id: 1,
    type: "agent.message.start",
    timestamp: "2026-07-07T02:06:03.260Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "829c8b0a-43a1-48bc-b96f-fc1015e59494",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      agentName: "retrieval-analyst",
      agentConfig: { role: "retrieval-analyst", model: "mock-model-id", tools: ["get_weather"] },
      systemPrompt: "You are a helpful retrieval analyst.",
      type: "agent.message.start",
      timestamp: "2026-07-07T02:06:03.260Z",
      spanId: "829c8b0a-43a1-48bc-b96f-fc1015e59494",
    },
  },
  {
    id: 2,
    type: "agent.iteration.start",
    timestamp: "2026-07-07T02:06:03.260Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "f2db7c68-9b88-4f2a-ab4f-7a7854fa975e",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      parentSpanId: "829c8b0a-43a1-48bc-b96f-fc1015e59494",
      iteration: 0,
      maxIterations: 10,
      type: "agent.iteration.start",
      timestamp: "2026-07-07T02:06:03.260Z",
      spanId: "f2db7c68-9b88-4f2a-ab4f-7a7854fa975e",
    },
  },
  {
    id: 3,
    type: "agent.llm.start",
    timestamp: "2026-07-07T02:06:03.260Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "4a88d09e-b7d0-494d-af1b-fe95c2871fdd",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      parentSpanId: "f2db7c68-9b88-4f2a-ab4f-7a7854fa975e",
      model: "mock-model-id",
      messageCount: 2,
      hasTools: true,
      type: "agent.llm.start",
      timestamp: "2026-07-07T02:06:03.260Z",
      spanId: "4a88d09e-b7d0-494d-af1b-fe95c2871fdd",
    },
  },
  {
    id: 4,
    type: "agent.llm.end",
    timestamp: "2026-07-07T02:06:03.264Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "4a88d09e-b7d0-494d-af1b-fe95c2871fdd",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      spanId: "4a88d09e-b7d0-494d-af1b-fe95c2871fdd",
      parentSpanId: "f2db7c68-9b88-4f2a-ab4f-7a7854fa975e",
      model: "mock-model-id",
      inputTokens: 20,
      outputTokens: 10,
      durationMs: 4,
      hasToolCalls: true,
      finishReason: "tool_calls",
      type: "agent.llm.end",
      timestamp: "2026-07-07T02:06:03.264Z",
    },
  },
  {
    id: 5,
    type: "agent.tool.intent",
    timestamp: "2026-07-07T02:06:03.264Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "fc00a71f-52c0-4e5d-a1e4-a6312ce1c5bb",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      parentSpanId: "f2db7c68-9b88-4f2a-ab4f-7a7854fa975e",
      toolCallId: "tc-1",
      toolName: "get_weather",
      arguments: { city: "Seattle" },
      type: "agent.tool.intent",
      timestamp: "2026-07-07T02:06:03.264Z",
      spanId: "fc00a71f-52c0-4e5d-a1e4-a6312ce1c5bb",
    },
  },
  {
    id: 6,
    type: "agent.tool.start",
    timestamp: "2026-07-07T02:06:03.264Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "tc-1",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      spanId: "tc-1",
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      parentSpanId: "f2db7c68-9b88-4f2a-ab4f-7a7854fa975e",
      toolCallId: "tc-1",
      toolName: "get_weather",
      arguments: { city: "Seattle" },
      type: "agent.tool.start",
      timestamp: "2026-07-07T02:06:03.264Z",
    },
  },
  {
    id: 7,
    type: "agent.tool.end",
    timestamp: "2026-07-07T02:06:03.264Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "tc-1",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      spanId: "tc-1",
      parentSpanId: "f2db7c68-9b88-4f2a-ab4f-7a7854fa975e",
      toolCallId: "tc-1",
      toolName: "get_weather",
      arguments: { city: "Seattle" },
      result: { weather: "rainy", city: "Seattle" },
      durationMs: 0,
      resultTokens: 0,
      type: "agent.tool.end",
      timestamp: "2026-07-07T02:06:03.264Z",
    },
  },
  {
    id: 8,
    type: "agent.iteration.end",
    timestamp: "2026-07-07T02:06:03.264Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "f2db7c68-9b88-4f2a-ab4f-7a7854fa975e",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      spanId: "f2db7c68-9b88-4f2a-ab4f-7a7854fa975e",
      parentSpanId: "829c8b0a-43a1-48bc-b96f-fc1015e59494",
      iteration: 0,
      toolCallsCount: 1,
      hasMore: true,
      type: "agent.iteration.end",
      timestamp: "2026-07-07T02:06:03.264Z",
    },
  },
  {
    id: 9,
    type: "agent.iteration.start",
    timestamp: "2026-07-07T02:06:03.264Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "f63321d3-f361-451e-95bb-59d7d4de1299",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      parentSpanId: "829c8b0a-43a1-48bc-b96f-fc1015e59494",
      iteration: 1,
      maxIterations: 10,
      type: "agent.iteration.start",
      timestamp: "2026-07-07T02:06:03.264Z",
      spanId: "f63321d3-f361-451e-95bb-59d7d4de1299",
    },
  },
  {
    id: 10,
    type: "agent.llm.start",
    timestamp: "2026-07-07T02:06:03.264Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "94eb6000-4521-4a6f-8201-99e2572ad8d4",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      parentSpanId: "f63321d3-f361-451e-95bb-59d7d4de1299",
      model: "mock-model-id",
      messageCount: 4,
      hasTools: true,
      type: "agent.llm.start",
      timestamp: "2026-07-07T02:06:03.264Z",
      spanId: "94eb6000-4521-4a6f-8201-99e2572ad8d4",
    },
  },
  {
    id: 11,
    type: "agent.llm.end",
    timestamp: "2026-07-07T02:06:03.266Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "94eb6000-4521-4a6f-8201-99e2572ad8d4",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      spanId: "94eb6000-4521-4a6f-8201-99e2572ad8d4",
      parentSpanId: "f63321d3-f361-451e-95bb-59d7d4de1299",
      model: "mock-model-id",
      inputTokens: 30,
      outputTokens: 15,
      durationMs: 2,
      hasToolCalls: false,
      finishReason: "stop",
      type: "agent.llm.end",
      timestamp: "2026-07-07T02:06:03.266Z",
    },
  },
  {
    id: 12,
    type: "agent.iteration.end",
    timestamp: "2026-07-07T02:06:03.266Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "f63321d3-f361-451e-95bb-59d7d4de1299",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      spanId: "f63321d3-f361-451e-95bb-59d7d4de1299",
      parentSpanId: "829c8b0a-43a1-48bc-b96f-fc1015e59494",
      iteration: 1,
      toolCallsCount: 0,
      hasMore: false,
      type: "agent.iteration.end",
      timestamp: "2026-07-07T02:06:03.266Z",
    },
  },
  {
    id: 13,
    type: "agent.message.complete",
    timestamp: "2026-07-07T02:06:03.266Z",
    traceId: "ZqLQv5HWos1cxbZm",
    runId: "ZqLQv5HWos1cxbZm",
    spanId: "829c8b0a-43a1-48bc-b96f-fc1015e59494",
    ccSessionId: null,
    ccHookName: null,
    ccCwd: null,
    data: {
      traceId: "ZqLQv5HWos1cxbZm",
      runId: "ZqLQv5HWos1cxbZm",
      spanId: "829c8b0a-43a1-48bc-b96f-fc1015e59494",
      parentSpanId: "829c8b0a-43a1-48bc-b96f-fc1015e59494",
      content: "The weather in Seattle is rainy.",
      inputTokens: 50,
      outputTokens: 25,
      model: "mock-model-id",
      finishReason: "stop",
      type: "agent.message.complete",
      timestamp: "2026-07-07T02:06:03.266Z",
    },
  },
];

describe("persistedToEventLike", () => {
  it("assigns 1-based ordinal seq and spreads `data` at the top level, type from the column", () => {
    const rows = REAL_EVENTS.map(persistedToEventLike);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(rows.map((r) => r.type)).toEqual(REAL_EVENTS.map((e) => e.type));
    // camelCase payload fields land at the top level (agentName, toolName, arguments, …)
    expect(rows[0]).toMatchObject({ type: "agent.message.start", agentName: "retrieval-analyst" });
    expect(rows[5]).toMatchObject({
      type: "agent.tool.start",
      toolName: "get_weather",
      arguments: { city: "Seattle" },
    });
  });

  it("does not misclassify a persisted row as the payload_json/run_id 'row' shape", () => {
    // Neither `payload_json` (string) nor `run_id` (snake_case) is present after
    // adaptation — `normalize()`'s `isRow` discriminator must read false, so the
    // whole flattened object is treated as the camelCase payload `p`.
    const adapted = persistedToEventLike(REAL_EVENTS[0] as PersistedEvent, 0);
    expect("payload_json" in adapted).toBe(false);
    expect("run_id" in adapted).toBe(false);
  });
});

describe("persistedToEventLike + eventsToSteps — real production event dump", () => {
  const TOOLS: ToolIndex = new Map(); // no static registry entry for "get_weather" — blast defaults honestly to "read"

  it("folds the real dump into the exact TraceStep sequence the fold contract promises", () => {
    const eventLikes = REAL_EVENTS.map(persistedToEventLike);
    const steps = eventsToSteps(eventLikes, TOOLS, { terminal: true });

    expect(steps.map((s) => s.kind)).toEqual([
      "context",
      "model",
      "tool_call",
      "tool_result",
      "model",
      "finish",
    ]);

    const [context, model1, toolCall, toolResult, model2, finish] = steps as [
      TraceStep,
      TraceStep,
      TraceStep,
      TraceStep,
      TraceStep,
      TraceStep,
    ];

    // context: iter 0, tagged with the agent from message.start.
    expect(context.iter).toBe(0);
    expect(context.agent).toBe("retrieval-analyst");

    // first model turn: llm.start's provisional step finalized in place by
    // llm.end (iteration 0 -> contract iter 1), carrying real tokens/ms and
    // "planned tool calls" detail (hasToolCalls: true).
    expect(model1.iter).toBe(1);
    expect(model1.ms).toBe(4);
    expect(model1.ctxTokens).toBe(20);
    expect(model1.outTokens).toBe(10);
    expect(model1.detail).toBe("Planned tool calls for this turn.");
    expect(model1.status).toBeUndefined(); // finalized, no longer "thinking"
    expect(model1.emits).toEqual(["get_weather"]); // backfilled from the same iter+agent tool_call

    // tool_call / tool_result: real args/result round-trip through `arguments`/`result`.
    expect(toolCall.tool).toBe("get_weather");
    expect(toolCall.args).toEqual({ city: "Seattle" });
    expect(toolCall.blast).toBe("read"); // no registry entry -> honest default, not fabricated
    expect(toolCall.capability).toBeUndefined();

    expect(toolResult.tool).toBe("get_weather");
    expect(toolResult.status).toBe("ok");
    expect(toolResult.output).toEqual({ weather: "rainy", city: "Seattle" });

    // second model turn: iteration 1 -> contract iter 2, no tool calls this time.
    expect(model2.iter).toBe(2);
    expect(model2.ms).toBe(2);
    expect(model2.ctxTokens).toBe(30);
    expect(model2.outTokens).toBe(15);
    expect(model2.detail).toBe("Composed the answer.");
    expect(model2.emits).toEqual([]); // no tool_call in iter 2 -> backfilled empty, not omitted

    // finish: only the LAST message.complete becomes the terminal step, `terminal: true`.
    expect(finish.status).toBe("ok");
    expect(finish.label).toBe("finishReason: stop");

    // `tool.intent`, `iteration.end`, and `iteration.start` (already folded into
    // `iter`) never produce their own steps — 13 events -> 6 steps.
    expect(eventLikes).toHaveLength(13);
  });

  it("`terminal: false` (live/in-flight) drops the trailing finish step", () => {
    const eventLikes = REAL_EVENTS.map(persistedToEventLike);
    const steps = eventsToSteps(eventLikes, TOOLS, { terminal: false });
    expect(steps.map((s) => s.kind)).toEqual([
      "context",
      "model",
      "tool_call",
      "tool_result",
      "model",
    ]);
  });

  it("the fold's own RunTrace envelope (rowsToRunTrace-independent check): finalAnswer/model line up with the real RunRow", () => {
    // Sanity cross-check against the captured RunRow — S6 doesn't call
    // rowsToRunTrace (RunSurfacePage frames request/answer itself), but the
    // persisted run row's fields should agree with what the event fold saw.
    expect(REAL_RUN.finalAnswer).toBe("The weather in Seattle is rainy.");
    expect(REAL_RUN.toolCalls).toBe(1);
    expect(REAL_RUN.iterations).toBe(2);
    expect("request" in REAL_RUN).toBe(false); // <- the documented gap (api/types.ts RunRow doc comment)
  });
});

describe("eventsToSteps — state-delta curation (#226)", () => {
  const TOOLS: ToolIndex = new Map();

  it("backpack.*/scratchpad.* events produce NO trace steps — they render as Δ frames in the timeline, never twice", () => {
    // Interleave the 7 state-delta events (live snake_case wire shape) with a
    // normal tool round-trip: the fold must yield exactly the tool steps it
    // would without them. Pinned as explicit switch cases (not the default) in
    // trace-from-events.ts so the Trace tab / timeline split stays deliberate.
    const stateEvents = [
      {
        type: "backpack.drop",
        key: "backpack.observations",
        origin: "explicit",
        ordinal: 1,
        accepted: 1,
        indexes: [1],
        size_before: 0,
        size_after: 1,
        previews: [],
        previews_omitted: 0,
      },
      { type: "backpack.read", key: "backpack.observations", ordinal: 2, memo_hit: false, size: 1 },
      {
        type: "backpack.absorb",
        key: "backpack.observations",
        ordinal: 3,
        child_size: 1,
        accepted: 1,
        merged: 0,
        size_before: 1,
        size_after: 2,
        appended_indexes: [2],
      },
      { type: "scratchpad.write", key: "agents.retrieve", origin: "innate", ordinal: 4, op: "set" },
      { type: "scratchpad.read", key: "agents.retrieve", origin: "innate", ordinal: 5 },
      { type: "scratchpad.fork", origin: "innate", ordinal: 6, shared_keys: [] },
      {
        type: "scratchpad.join",
        origin: "innate",
        ordinal: 7,
        merged_keys: [],
        discarded_keys: [],
      },
    ];
    const events = [
      { type: "tool.start", seq: 1, tool_name: "search", tool_call_id: "t1" },
      ...stateEvents.map((e, i) => ({ ...e, seq: i + 2 })),
      { type: "tool.end", seq: 9, tool_name: "search", tool_call_id: "t1", duration_ms: 5 },
    ];
    const steps = eventsToSteps(events, TOOLS, { terminal: true });
    expect(steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result"]);
  });
});

describe("eventsToSteps — synthetic boundary provenance (#324/D12)", () => {
  const TOOLS: ToolIndex = new Map();

  it("flags a model step whose llm.start boundary was synthesized, keeping its OBSERVED ms", () => {
    // Run-mode CC: iteration.start + llm.start are synthesized (meta.synthetic,
    // carried on the wire as top-level `synthetic: true`); llm.end is observed
    // and carries the real duration. The model step must be flagged synthetic
    // (provenance badge) yet keep the observed `ms` — the boundary is
    // reconstructed, the duration is not (never chart a synthetic boundary as
    // a causal latency anchor).
    const events = [
      { type: "message.start", seq: 1, agent_name: "agent" },
      { type: "iteration.start", seq: 2, iteration: 0, max_iterations: 10, synthetic: true },
      {
        type: "llm.start",
        seq: 3,
        model: "opus",
        message_count: 1,
        has_tools: false,
        synthetic: true,
      },
      {
        type: "llm.end",
        seq: 4,
        model: "opus",
        input_tokens: 10,
        output_tokens: 5,
        duration_ms: 830,
        finish_reason: "stop",
      },
    ];
    const steps = eventsToSteps(events, TOOLS, { terminal: false });
    const model = steps.find((s) => s.kind === "model");
    expect(model?.synthetic).toBe(true);
    expect(model?.ms).toBe(830);
  });

  it("does NOT flag a model step when llm.start is observed (non-synthetic)", () => {
    const events = [
      { type: "message.start", seq: 1, agent_name: "agent" },
      { type: "llm.start", seq: 2, model: "opus", message_count: 1, has_tools: false },
      {
        type: "llm.end",
        seq: 3,
        model: "opus",
        input_tokens: 10,
        output_tokens: 5,
        duration_ms: 420,
        finish_reason: "stop",
      },
    ];
    const steps = eventsToSteps(events, TOOLS, { terminal: false });
    const model = steps.find((s) => s.kind === "model");
    expect(model?.synthetic).toBeUndefined();
    expect(model?.ms).toBe(420);
  });

  it("reads synthetic from the persisted camelCase meta.synthetic shape", () => {
    const events = [
      { type: "message.start", seq: 1, agent_name: "agent" },
      {
        type: "llm.start",
        seq: 2,
        run_id: "r1",
        payload_json:
          '{"model":"opus","messageCount":1,"hasTools":false,"meta":{"synthetic":true}}',
      },
      {
        type: "llm.end",
        seq: 3,
        run_id: "r1",
        payload_json:
          '{"model":"opus","inputTokens":10,"outputTokens":5,"durationMs":210,"finishReason":"stop"}',
      },
    ];
    const steps = eventsToSteps(events, TOOLS, { terminal: false });
    const model = steps.find((s) => s.kind === "model");
    expect(model?.synthetic).toBe(true);
  });
});
