/**
 * CC translation contract — SDK message → normalized HarnessEvent → AgentEvent.
 *
 * RELOCATED from `runner/__tests__/cc-event-translator.test.ts` (B-1 → B-2 / #326).
 * The translator split into two halves behind the harness seam: the CC-specific
 * {@link CCHarnessTranslator} (SDK → HarnessEvent) and the harness-agnostic
 * {@link HarnessEventTranslator} (HarnessEvent → AgentEvent). These tests drive
 * the two together end-to-end so B-1's parity ASSERTIONS (per-event-kind
 * translation, synthetic provenance, finishReason table, cost passthrough,
 * num_turns reconciliation) hold across the new seam.
 *
 * NEW in B-2: the multi-assistant-message iteration over-count fix (routed from
 * the PR #358 B-1 review) — assistant messages sharing one `message.id` open a
 * single iteration.
 *
 * Fixtures are hand-built minimal shapes of the real SDK message types, cast
 * through `unknown` (the exact fields consumed are pinned type-side in
 * `sdk-contract.test.ts`).
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../../events/types.js";
import { CCHarnessTranslator, mapFinishReason } from "../claude-code/cc-harness-translator.js";
import { HarnessEventTranslator, type HarnessRunAccounting } from "../harness-event-translator.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function assistantMsg(opts?: {
  id?: string;
  text?: string;
  thinking?: string;
  toolUse?: boolean;
  model?: string;
  stopReason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
}): SDKAssistantMessage {
  const content: unknown[] = [];
  if (opts?.thinking) content.push({ type: "thinking", thinking: opts.thinking });
  if (opts?.text) content.push({ type: "text", text: opts.text });
  if (opts?.toolUse) content.push({ type: "tool_use", id: "tu_1", name: "add", input: { a: 1 } });
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "u-assistant",
    session_id: "sess",
    message: {
      id: opts?.id ?? "m1",
      type: "message",
      role: "assistant",
      model: opts?.model ?? "claude-sonnet-4-5",
      content,
      stop_reason: opts?.stopReason === undefined ? "end_turn" : opts.stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: opts?.inputTokens ?? 10,
        output_tokens: opts?.outputTokens ?? 5,
      },
    },
  } as unknown as SDKAssistantMessage;
}

function resultSuccess(opts?: {
  numTurns?: number;
  cost?: number;
  result?: string;
  inputTokens?: number;
  outputTokens?: number;
}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: opts?.numTurns ?? 1,
    result: opts?.result ?? "final answer",
    stop_reason: null,
    total_cost_usd: opts?.cost ?? 0.0123,
    usage: {
      input_tokens: opts?.inputTokens ?? 100,
      output_tokens: opts?.outputTokens ?? 50,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "u-result",
    session_id: "sess",
  } as unknown as SDKResultMessage;
}

function resultError(subtype: string): SDKResultMessage {
  return {
    type: "result",
    subtype,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.5,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: "u-result-err",
    session_id: "sess",
  } as unknown as SDKResultMessage;
}

function streamMessageStart(model = "claude-sonnet-4-5", id = "m1"): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: "u-ms",
    session_id: "sess",
    event: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    },
  } as unknown as SDKMessage;
}

function streamTextDelta(text: string): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: "u-delta",
    session_id: "sess",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  } as unknown as SDKMessage;
}

function systemMsg(subtype: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "system",
    subtype,
    uuid: "u-sys",
    session_id: "sess",
    ...extra,
  } as unknown as SDKMessage;
}

function rateLimitMsg(): SDKMessage {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning" },
    uuid: "u-rl",
    session_id: "sess",
  } as unknown as SDKMessage;
}

// ---------------------------------------------------------------------------
// End-to-end driver: SDK messages → HarnessEvents → AgentEvents
// ---------------------------------------------------------------------------

interface DriveOpts {
  streaming?: boolean;
  fallbackModel?: string;
  hasTools?: boolean;
  maxIterations?: number;
}

function drive(msgs: SDKMessage[], opts: DriveOpts = {}) {
  const streaming = opts.streaming ?? false;
  const cc = new CCHarnessTranslator({
    fallbackModel: opts.fallbackModel ?? "fallback-model",
    streaming,
  });
  const base = new HarnessEventTranslator({
    traceId: "trace-1",
    runId: "run-1",
    parentSpanId: "parent-1",
    harnessName: "claude-code",
    fallbackModel: opts.fallbackModel ?? "fallback-model",
    hasTools: opts.hasTools ?? true,
    maxIterations: opts.maxIterations ?? 10,
    streaming,
  });
  const events: AgentEvent[] = [];
  for (const m of msgs) {
    for (const h of cc.translate(m)) events.push(...base.translate(h));
  }
  return { events, finalize: (): HarnessRunAccounting => base.finalize() };
}

const typesOf = (events: AgentEvent[]) => events.map((e) => e.type);

// ---------------------------------------------------------------------------
// finishReason mapping table
// ---------------------------------------------------------------------------

describe("mapFinishReason (result subtype → canonical finishReason)", () => {
  const cases: [string | undefined, string][] = [
    ["success", "stop"],
    ["error_max_turns", "max-turns"],
    ["error_during_execution", "error"],
    ["error_max_budget_usd", "budget"],
    ["error_max_structured_output_retries", "unknown"],
    ["something_new", "unknown"],
    [undefined, "unknown"],
  ];
  it.each(cases)("subtype %s → %s", (subtype, expected) => {
    expect(mapFinishReason(subtype)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Per-event-kind translation (B-1 parity, across the seam)
// ---------------------------------------------------------------------------

describe("translation — per SDK message kind", () => {
  it("assistant message (run mode) → iteration.start, llm.start, llm.end, iteration.end", () => {
    const { events } = drive([assistantMsg({ text: "hi" })]);
    expect(typesOf(events)).toEqual([
      "agent.iteration.start",
      "agent.llm.start",
      "agent.llm.end",
      "agent.iteration.end",
    ]);
  });

  it("llm.end carries usage/model/stop_reason", () => {
    const { events } = drive([
      assistantMsg({
        text: "hi",
        model: "claude-opus-4",
        stopReason: "end_turn",
        inputTokens: 42,
        outputTokens: 17,
      }),
    ]);
    const llmEnd = events.find((e) => e.type === "agent.llm.end");
    expect(llmEnd).toMatchObject({
      model: "claude-opus-4",
      inputTokens: 42,
      outputTokens: 17,
      finishReason: "end_turn",
      hasToolCalls: false,
    });
    expect(typeof (llmEnd as { durationMs: number }).durationMs).toBe("number");
  });

  it("assistant thinking block → agent.reasoning", () => {
    const { events } = drive([assistantMsg({ thinking: "let me think" })]);
    expect(events.find((e) => e.type === "agent.reasoning")).toMatchObject({
      content: "let me think",
      isComplete: true,
    });
  });

  it("assistant tool_use block → counted, hasToolCalls true, hasMore on tool_use stop", () => {
    const { events } = drive([assistantMsg({ toolUse: true, stopReason: "tool_use" })]);
    expect(events.find((e) => e.type === "agent.llm.end")).toMatchObject({ hasToolCalls: true });
    expect(events.find((e) => e.type === "agent.iteration.end")).toMatchObject({
      hasMore: true,
      toolCallsCount: 1,
    });
  });

  it("falls back to the fallback model when the message carries none", () => {
    const { events } = drive([assistantMsg({ text: "hi", model: "" })], {
      fallbackModel: "the-fallback",
    });
    expect(events.find((e) => e.type === "agent.llm.start")).toMatchObject({
      model: "the-fallback",
    });
  });

  it("stream message_start → iteration.start + OBSERVED llm.start; delta → message.chunk", () => {
    const { events } = drive(
      [
        streamMessageStart("claude-sonnet-4-5"),
        streamTextDelta("Hel"),
        streamTextDelta("lo"),
        assistantMsg({ text: "Hello", stopReason: "end_turn" }),
      ],
      { streaming: true },
    );
    expect(typesOf(events)).toEqual([
      "agent.iteration.start",
      "agent.llm.start",
      "agent.message.chunk",
      "agent.message.chunk",
      "agent.llm.end",
      "agent.iteration.end",
    ]);
    const chunks = events.filter((e) => e.type === "agent.message.chunk");
    expect(chunks.map((c) => (c as { delta: string }).delta)).toEqual(["Hel", "lo"]);
    expect(chunks.map((c) => (c as { chunkIndex: number }).chunkIndex)).toEqual([0, 1]);
  });

  it("compaction / task-progress / rate-limit → harness.native envelope", () => {
    const { events } = drive([
      systemMsg("compact_boundary", { compact_metadata: { trigger: "auto", pre_tokens: 1000 } }),
      systemMsg("task_progress", { task_id: "task-1", description: "working" }),
      rateLimitMsg(),
    ]);
    expect(typesOf(events)).toEqual(["harness.native", "harness.native", "harness.native"]);
    expect(events.map((e) => (e as { name: string }).name)).toEqual([
      "compact_boundary",
      "task_progress",
      "rate_limit_event",
    ]);
    for (const e of events) {
      expect((e as { harness: string }).harness).toBe("claude-code");
      expect((e as { payload: unknown }).payload).toBeTypeOf("object");
    }
  });

  it("unmapped system subtype (init) is dropped", () => {
    expect(drive([systemMsg("init")]).events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Synthetic provenance (D12)
// ---------------------------------------------------------------------------

describe("translation — synthetic provenance", () => {
  it("run mode: iteration.start/end AND llm.start are marked meta.synthetic", () => {
    const { events } = drive([assistantMsg({ text: "hi" })], { streaming: false });
    const byType = (t: string) => events.find((e) => e.type === t);
    expect(byType("agent.iteration.start")?.meta?.synthetic).toBe(true);
    expect(byType("agent.iteration.end")?.meta?.synthetic).toBe(true);
    expect(byType("agent.llm.start")?.meta?.synthetic).toBe(true);
  });

  it("llm.end is observed testimony, NOT marked synthetic", () => {
    const { events } = drive([assistantMsg({ text: "hi" })]);
    expect(events.find((e) => e.type === "agent.llm.end")?.meta?.synthetic).toBeUndefined();
  });

  it("stream mode: llm.start from a real message_start is NOT synthetic; iteration still is", () => {
    const { events } = drive([streamMessageStart(), assistantMsg({ text: "hi" })], {
      streaming: true,
    });
    expect(events.find((e) => e.type === "agent.llm.start")?.meta?.synthetic).toBeUndefined();
    expect(events.find((e) => e.type === "agent.iteration.start")?.meta?.synthetic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-assistant-message turn de-dup (routed from PR #358 B-1 review)
// ---------------------------------------------------------------------------

describe("translation — multi-message turn de-dup (over-count fix)", () => {
  it("two assistant messages sharing message.id open exactly ONE iteration", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // resumed_from_incomplete_thinking: the SDK emits two assistant messages
    // for one logical turn, both with message.id "m1".
    const { events, finalize } = drive([
      assistantMsg({ id: "m1", thinking: "partial…", stopReason: null }),
      assistantMsg({ id: "m1", text: "…resumed answer", stopReason: "end_turn" }),
      resultSuccess({ numTurns: 1 }),
    ]);
    const iterStarts = events.filter((e) => e.type === "agent.iteration.start");
    const iterEnds = events.filter((e) => e.type === "agent.iteration.end");
    expect(iterStarts).toHaveLength(1);
    expect(iterEnds).toHaveLength(1);
    // The continuation still surfaces its content + a second llm.end…
    expect(events.filter((e) => e.type === "agent.llm.end")).toHaveLength(2);
    expect(events.find((e) => e.type === "agent.reasoning")).toBeDefined();
    // …and iterations reconcile against num_turns=1 with NO over-count warning.
    expect(finalize().iterations).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("distinct message.ids open distinct iterations (no false merge)", () => {
    const { events } = drive([
      assistantMsg({ id: "m1", text: "a", stopReason: "tool_use", toolUse: true }),
      assistantMsg({ id: "m2", text: "b", stopReason: "end_turn" }),
    ]);
    expect(events.filter((e) => e.type === "agent.iteration.start")).toHaveLength(2);
    expect(events.filter((e) => e.type === "agent.iteration.end")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// finalize() — accounting, cost, num_turns reconciliation
// ---------------------------------------------------------------------------

describe("translation — finalize() accounting", () => {
  it("cost passthrough + run totals + finishReason + iterations from num_turns", () => {
    const { finalize } = drive([
      assistantMsg({ id: "a", text: "a", stopReason: "tool_use", toolUse: true }),
      assistantMsg({ id: "b", text: "b", stopReason: "end_turn" }),
      resultSuccess({ numTurns: 2, cost: 0.42, inputTokens: 200, outputTokens: 80 }),
    ]);
    expect(finalize()).toMatchObject({
      content: "ab",
      inputTokens: 200,
      outputTokens: 80,
      costUsd: 0.42,
      toolCallsCount: 1,
      iterations: 2,
      finishReason: "stop",
    });
  });

  it("result string is the content fallback only when nothing else was captured", () => {
    const { finalize } = drive([resultSuccess({ result: "fallback text" })]);
    expect(finalize().content).toBe("fallback text");
  });

  it("error result subtype maps finishReason and still carries cost", () => {
    const { finalize } = drive([
      assistantMsg({ text: "x", stopReason: "tool_use" }),
      resultError("error_max_turns"),
    ]);
    const acc = finalize();
    expect(acc.finishReason).toBe("max-turns");
    expect(acc.costUsd).toBe(0.5);
  });

  it("num_turns mismatch LOGS (console.warn) but never throws; iterations follow num_turns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { finalize } = drive([
      assistantMsg({ text: "one", stopReason: "end_turn" }),
      resultSuccess({ numTurns: 3 }),
    ]);
    const acc = finalize();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("num_turns=3");
    expect(acc.iterations).toBe(3);
  });

  it("matching turn count does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { finalize } = drive([
      assistantMsg({ text: "one", stopReason: "end_turn" }),
      resultSuccess({ numTurns: 1 }),
    ]);
    finalize();
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Representative multi-tool run — full emission sequence
// ---------------------------------------------------------------------------

describe("translation — representative multi-tool run (run mode)", () => {
  it("emits one iteration+llm pair per assistant turn, harness.native for compaction", () => {
    const { events } = drive([
      assistantMsg({ id: "t1", text: "let me add", toolUse: true, stopReason: "tool_use" }),
      systemMsg("compact_boundary", { compact_metadata: { trigger: "auto", pre_tokens: 5000 } }),
      assistantMsg({ id: "t2", text: "now multiply", toolUse: true, stopReason: "tool_use" }),
      assistantMsg({ id: "t3", text: "the answer is 90", stopReason: "end_turn" }),
      resultSuccess({ numTurns: 3, cost: 0.07 }),
    ]);
    expect(typesOf(events)).toEqual([
      "agent.iteration.start",
      "agent.llm.start",
      "agent.llm.end",
      "agent.iteration.end",
      "harness.native",
      "agent.iteration.start",
      "agent.llm.start",
      "agent.llm.end",
      "agent.iteration.end",
      "agent.iteration.start",
      "agent.llm.start",
      "agent.llm.end",
      "agent.iteration.end",
    ]);
  });
});
