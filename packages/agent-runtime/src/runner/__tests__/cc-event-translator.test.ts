/**
 * TRANSITIONAL test suite (#323 → #326).
 *
 * These tests pin the CC SDK-message → AgentEvent translation contract while it
 * lives inline in `cc-event-translator.ts`. #326 extracts the per-harness
 * adapter and RELOCATES both the translator and this suite behind the adapter
 * seam — expect this file to move (and its imports to change) when that lands.
 * Keep the ASSERTIONS (per-event-kind translation, synthetic provenance,
 * finishReason table, cost passthrough, num_turns reconciliation); they encode
 * the parity guarantee, not the file layout.
 *
 * Fixtures are hand-built minimal shapes of the real SDK message types (the
 * exact fields the translator consumes are pinned type-side in
 * `sdk-contract.test.ts`), cast through `unknown` to the SDK union.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../events/types.js";
import {
  CCMessageTranslator,
  type CCTranslatorContext,
  mapFinishReason,
} from "../cc-event-translator.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture builders (minimal shapes of the real SDK messages)
// ---------------------------------------------------------------------------

function assistantMsg(opts?: {
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
      id: "m1",
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

function streamMessageStart(model = "claude-sonnet-4-5"): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: "u-ms",
    session_id: "sess",
    event: {
      type: "message_start",
      message: {
        id: "m1",
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

function makeCtx(overrides?: Partial<CCTranslatorContext>): CCTranslatorContext {
  return {
    traceId: "trace-1",
    runId: "run-1",
    parentSpanId: "parent-1",
    fallbackModel: "fallback-model",
    hasTools: true,
    maxIterations: 10,
    streaming: false,
    ...overrides,
  };
}

/** Drive a translator across a message list, collecting every emitted event. */
function drive(ctx: CCTranslatorContext, msgs: SDKMessage[]): AgentEvent[] {
  const t = new CCMessageTranslator(ctx);
  const events: AgentEvent[] = [];
  for (const m of msgs) events.push(...t.translate(m));
  return events;
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
// Per-event-kind translation
// ---------------------------------------------------------------------------

describe("translator — per SDK message kind", () => {
  it("assistant message (run mode) → iteration.start, llm.start, llm.end, iteration.end", () => {
    const events = drive(makeCtx(), [assistantMsg({ text: "hi" })]);
    expect(typesOf(events)).toEqual([
      "agent.iteration.start",
      "agent.llm.start",
      "agent.llm.end",
      "agent.iteration.end",
    ]);
  });

  it("llm.end carries usage/model/stop_reason from the embedded BetaMessage", () => {
    const events = drive(makeCtx(), [
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
    const events = drive(makeCtx(), [assistantMsg({ thinking: "let me think" })]);
    const reasoning = events.find((e) => e.type === "agent.reasoning");
    expect(reasoning).toMatchObject({ content: "let me think", isComplete: true });
  });

  it("assistant tool_use block → counted, hasToolCalls true, hasMore on tool_use stop", () => {
    const events = drive(makeCtx(), [assistantMsg({ toolUse: true, stopReason: "tool_use" })]);
    const llmEnd = events.find((e) => e.type === "agent.llm.end");
    expect(llmEnd).toMatchObject({ hasToolCalls: true });
    const iterEnd = events.find((e) => e.type === "agent.iteration.end");
    expect(iterEnd).toMatchObject({ hasMore: true, toolCallsCount: 1 });
  });

  it("falls back to ctx.fallbackModel when the message carries no model", () => {
    const events = drive(makeCtx({ fallbackModel: "the-fallback" }), [
      assistantMsg({ text: "hi", model: "" }),
    ]);
    expect(events.find((e) => e.type === "agent.llm.start")).toMatchObject({
      model: "the-fallback",
    });
  });

  it("stream message_start → iteration.start + OBSERVED llm.start; delta → message.chunk", () => {
    const ctx = makeCtx({ streaming: true });
    const events = drive(ctx, [
      streamMessageStart("claude-sonnet-4-5"),
      streamTextDelta("Hel"),
      streamTextDelta("lo"),
      assistantMsg({ text: "Hello", stopReason: "end_turn" }),
    ]);
    // message_start opens the turn; the later assistant message closes it —
    // exactly ONE iteration, not two.
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
    const events = drive(makeCtx(), [
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
    expect(drive(makeCtx(), [systemMsg("init")])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Synthetic provenance (D12)
// ---------------------------------------------------------------------------

describe("translator — synthetic provenance", () => {
  it("run mode: iteration.start/end AND llm.start are marked meta.synthetic", () => {
    const events = drive(makeCtx({ streaming: false }), [assistantMsg({ text: "hi" })]);
    const byType = (t: string) => events.find((e) => e.type === t);
    expect(byType("agent.iteration.start")?.meta?.synthetic).toBe(true);
    expect(byType("agent.iteration.end")?.meta?.synthetic).toBe(true);
    expect(byType("agent.llm.start")?.meta?.synthetic).toBe(true);
  });

  it("llm.end is observed testimony, NOT marked synthetic", () => {
    const events = drive(makeCtx(), [assistantMsg({ text: "hi" })]);
    expect(events.find((e) => e.type === "agent.llm.end")?.meta?.synthetic).toBeUndefined();
  });

  it("stream mode: llm.start from a real message_start is NOT synthetic", () => {
    const events = drive(makeCtx({ streaming: true }), [
      streamMessageStart(),
      assistantMsg({ text: "hi" }),
    ]);
    expect(events.find((e) => e.type === "agent.llm.start")?.meta?.synthetic).toBeUndefined();
    // iteration boundaries are always synthesized regardless of stream provenance
    expect(events.find((e) => e.type === "agent.iteration.start")?.meta?.synthetic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// finalize() — accounting, cost passthrough, num_turns reconciliation
// ---------------------------------------------------------------------------

describe("translator — finalize() accounting", () => {
  it("cost passthrough + run totals + finishReason + iterations from num_turns", () => {
    const t = new CCMessageTranslator(makeCtx());
    t.translate(assistantMsg({ text: "a", stopReason: "tool_use", toolUse: true }));
    t.translate(assistantMsg({ text: "b", stopReason: "end_turn" }));
    t.translate(resultSuccess({ numTurns: 2, cost: 0.42, inputTokens: 200, outputTokens: 80 }));
    const acc = t.finalize();
    expect(acc).toMatchObject({
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
    const t = new CCMessageTranslator(makeCtx());
    t.translate(resultSuccess({ result: "fallback text" }));
    expect(t.finalize().content).toBe("fallback text");
  });

  it("error result subtype maps finishReason and still carries cost", () => {
    const t = new CCMessageTranslator(makeCtx());
    t.translate(assistantMsg({ text: "x", stopReason: "tool_use" }));
    t.translate(resultError("error_max_turns"));
    const acc = t.finalize();
    expect(acc.finishReason).toBe("max-turns");
    expect(acc.costUsd).toBe(0.5);
  });

  it("num_turns mismatch LOGS (console.warn) but never throws; iterations follow num_turns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new CCMessageTranslator(makeCtx());
    // Synthesize ONE iteration but the SDK reports three turns.
    t.translate(assistantMsg({ text: "one", stopReason: "end_turn" }));
    t.translate(resultSuccess({ numTurns: 3 }));
    const acc = t.finalize();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("num_turns=3");
    expect(acc.iterations).toBe(3);
  });

  it("matching turn count does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new CCMessageTranslator(makeCtx());
    t.translate(assistantMsg({ text: "one", stopReason: "end_turn" }));
    t.translate(resultSuccess({ numTurns: 1 }));
    t.finalize();
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Representative multi-tool run — the full emission sequence
// ---------------------------------------------------------------------------

describe("translator — representative multi-tool run (run mode)", () => {
  it("emits one iteration+llm pair per assistant turn, harness.native for compaction", () => {
    const events = drive(makeCtx(), [
      assistantMsg({ text: "let me add", toolUse: true, stopReason: "tool_use" }),
      systemMsg("compact_boundary", { compact_metadata: { trigger: "auto", pre_tokens: 5000 } }),
      assistantMsg({ text: "now multiply", toolUse: true, stopReason: "tool_use" }),
      assistantMsg({ text: "the answer is 90", stopReason: "end_turn" }),
      resultSuccess({ numTurns: 3, cost: 0.07 }),
    ]);
    expect(typesOf(events)).toEqual([
      // turn 1 (tool_use)
      "agent.iteration.start",
      "agent.llm.start",
      "agent.llm.end",
      "agent.iteration.end",
      // compaction boundary between turns
      "harness.native",
      // turn 2 (tool_use)
      "agent.iteration.start",
      "agent.llm.start",
      "agent.llm.end",
      "agent.iteration.end",
      // turn 3 (final)
      "agent.iteration.start",
      "agent.llm.start",
      "agent.llm.end",
      "agent.iteration.end",
    ]);
  });
});
