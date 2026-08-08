import { tableArtifact } from "@agentic-patterns/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent } from "../../events/types.js";
import {
  SSEFormatter,
  SSE_EVENT_NAMES,
  SSE_WIRE_EVENT_NAMES,
  formatSSE,
  toSSEMapping,
} from "../sse-formatter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBase() {
  return { traceId: "t1", runId: "r1" };
}

function parseSSE(frame: string): { event: string; data: Record<string, unknown> } {
  const eventMatch = frame.match(/^event: (.+)$/m);
  const dataMatch = frame.match(/^data: (.+)$/m);
  return {
    event: eventMatch?.[1] ?? "",
    data: JSON.parse(dataMatch?.[1] ?? "{}"),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSEFormatter", () => {
  const formatter = new SSEFormatter();

  describe("conversation lifecycle", () => {
    it("formats conversation.start", () => {
      const event = createEvent("agent.conversation.start", {
        ...makeBase(),
        conversationId: "conv-1",
        agentName: "my-agent",
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("conversation.start");
      expect(parsed.data.conversation_id).toBe("conv-1");
      expect(parsed.data.agent_name).toBe("my-agent");
    });

    it("formats conversation.end", () => {
      const event = createEvent("agent.conversation.end", {
        ...makeBase(),
        conversationId: "conv-1",
        reason: "completed",
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("conversation.end");
      expect(parsed.data.conversation_id).toBe("conv-1");
      expect(parsed.data.reason).toBe("completed");
    });
  });

  describe("message lifecycle", () => {
    it("formats message.start", () => {
      const event = createEvent("agent.message.start", {
        ...makeBase(),
        agentName: "my-agent",
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("message.start");
      expect(parsed.data.agent_name).toBe("my-agent");
    });

    it("formats message.delta (message.chunk)", () => {
      const event = createEvent("agent.message.chunk", {
        ...makeBase(),
        delta: "hello",
        chunkIndex: 0,
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("message.delta");
      expect(parsed.data.delta).toBe("hello");
    });

    it("formats message.complete", () => {
      const event = createEvent("agent.message.complete", {
        ...makeBase(),
        content: "full response",
        inputTokens: 10,
        outputTokens: 20,
        model: "gpt-4",
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("message.complete");
      expect(parsed.data.content).toBe("full response");
      expect(parsed.data.input_tokens).toBe(10);
      expect(parsed.data.output_tokens).toBe(20);
    });

    it("formats message.cancel", () => {
      const event = createEvent("agent.message.cancel", {
        ...makeBase(),
        reason: "user cancelled",
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("message.cancel");
      expect(parsed.data.reason).toBe("user cancelled");
    });
  });

  describe("thinking lifecycle", () => {
    it("formats thinking.start", () => {
      const event = createEvent("agent.thinking.start", makeBase());
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("thinking.start");
    });

    it("formats reasoning (isComplete: false) as thinking", () => {
      const event = createEvent("agent.reasoning", {
        ...makeBase(),
        content: "reasoning chunk",
        isComplete: false,
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("thinking");
      expect(parsed.data.content).toBe("reasoning chunk");
    });

    it("formats reasoning (isComplete: true) as thinking.complete", () => {
      const event = createEvent("agent.reasoning", {
        ...makeBase(),
        content: "final reasoning",
        isComplete: true,
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("thinking.complete");
      expect(parsed.data.content).toBe("final reasoning");
    });
  });

  describe("tool lifecycle", () => {
    it("formats tool.intent", () => {
      const event = createEvent("agent.tool.intent", {
        ...makeBase(),
        toolCallId: "tc-1",
        toolName: "search",
        arguments: { query: "hello" },
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("tool.intent");
      expect(parsed.data.tool_call_id).toBe("tc-1");
      expect(parsed.data.tool_name).toBe("search");
    });

    it("formats tool.start", () => {
      const event = createEvent("agent.tool.start", {
        ...makeBase(),
        toolCallId: "tc-1",
        toolName: "search",
        arguments: { query: "hello" },
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("tool.start");
    });

    it("formats tool.start with display_type only when displayType is declared", () => {
      const withHint = createEvent("agent.tool.start", {
        ...makeBase(),
        toolCallId: "tc-1",
        toolName: "edit_file",
        arguments: { path: "a.ts" },
        displayType: "diff",
      });
      const parsedWithHint = parseSSE(formatter.format(withHint)!);
      expect(parsedWithHint.data.display_type).toBe("diff");

      const withoutHint = createEvent("agent.tool.start", {
        ...makeBase(),
        toolCallId: "tc-2",
        toolName: "search",
        arguments: { query: "hello" },
      });
      const parsedWithoutHint = parseSSE(formatter.format(withoutHint)!);
      expect(parsedWithoutHint.data).not.toHaveProperty("display_type");
    });

    it("formats tool.progress", () => {
      const event = createEvent("agent.tool.progress", {
        ...makeBase(),
        toolCallId: "tc-1",
        progress: 0.5,
        statusText: "Searching...",
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("tool.progress");
      expect(parsed.data.tool_call_id).toBe("tc-1");
      expect(parsed.data.progress).toBe(0.5);
      expect(parsed.data.status_text).toBe("Searching...");
    });

    it("formats tool.end", () => {
      const event = createEvent("agent.tool.end", {
        ...makeBase(),
        toolCallId: "tc-1",
        toolName: "search",
        arguments: { query: "hello" },
        result: { items: [] },
        durationMs: 150,
        resultTokens: 0,
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("tool.end");
      expect(parsed.data.duration_ms).toBe(150);
    });

    it("formats tool.end with display_type only when displayType is declared", () => {
      const withHint = createEvent("agent.tool.end", {
        ...makeBase(),
        toolCallId: "tc-1",
        toolName: "edit_file",
        arguments: { path: "a.ts" },
        result: "diff --git a/a.ts b/a.ts",
        durationMs: 50,
        resultTokens: 0,
        displayType: "diff",
      });
      const parsedWithHint = parseSSE(formatter.format(withHint)!);
      expect(parsedWithHint.data.display_type).toBe("diff");

      const withoutHint = createEvent("agent.tool.end", {
        ...makeBase(),
        toolCallId: "tc-2",
        toolName: "search",
        arguments: { query: "hello" },
        result: { items: [] },
        durationMs: 150,
        resultTokens: 0,
      });
      const parsedWithoutHint = parseSSE(formatter.format(withoutHint)!);
      expect(parsedWithoutHint.data).not.toHaveProperty("display_type");
    });

    it("formats tool.rejected", () => {
      const event = createEvent("agent.tool.rejected", {
        ...makeBase(),
        toolName: "rm",
        reason: "unsafe",
        gateName: "safety",
        gateCategory: "safety",
        originalIntent: createEvent("agent.tool.intent", {
          ...makeBase(),
          toolCallId: "tc-1",
          toolName: "rm",
          arguments: {},
        }),
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("tool.rejected");
    });
  });

  describe("iteration lifecycle", () => {
    it("formats iteration.start", () => {
      const event = createEvent("agent.iteration.start", {
        ...makeBase(),
        iteration: 0,
        maxIterations: 5,
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("iteration.start");
      expect(parsed.data.iteration).toBe(0);
      expect(parsed.data.max_iterations).toBe(5);
    });

    it("formats iteration.end", () => {
      const event = createEvent("agent.iteration.end", {
        ...makeBase(),
        iteration: 0,
        toolCallsCount: 2,
        hasMore: true,
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("iteration.end");
      expect(parsed.data.tool_calls_count).toBe(2);
      expect(parsed.data.has_more).toBe(true);
    });
  });

  describe("LLM lifecycle", () => {
    it("formats llm.start", () => {
      const event = createEvent("agent.llm.start", {
        ...makeBase(),
        model: "gpt-4",
        messageCount: 3,
        hasTools: true,
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("llm.start");
      expect(parsed.data.model).toBe("gpt-4");
      expect(parsed.data.message_count).toBe(3);
      expect(parsed.data.has_tools).toBe(true);
    });

    it("formats llm.end", () => {
      const event = createEvent("agent.llm.end", {
        ...makeBase(),
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1200,
        hasToolCalls: false,
        finishReason: "stop",
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("llm.end");
      expect(parsed.data.input_tokens).toBe(100);
      expect(parsed.data.output_tokens).toBe(50);
      expect(parsed.data.duration_ms).toBe(1200);
      expect(parsed.data.finish_reason).toBe("stop");
    });
  });

  describe("memory lifecycle", () => {
    it("formats memory.write with snake_case record previews", () => {
      const event = createEvent("agent.memory.write", {
        ...makeBase(),
        scope: { userId: "u1" },
        count: 2,
        records: [
          { id: "m1", kind: "fact", preview: "the sky is blue" },
          { id: "m2", kind: "preference", preview: "prefers dark mode", supersededId: "m0" },
        ],
        toolCallId: "tc-1",
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("memory.write");
      expect(parsed.data.scope).toEqual({ userId: "u1" });
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.tool_call_id).toBe("tc-1");
      const records = parsed.data.records as Record<string, unknown>[];
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({ id: "m1", kind: "fact", preview: "the sky is blue" });
      // snake_case remap: supersededId → superseded_id, present ONLY on the superseding record.
      expect(records[1]).toEqual({
        id: "m2",
        kind: "preference",
        preview: "prefers dark mode",
        superseded_id: "m0",
      });
      expect("superseded_id" in records[0]!).toBe(false);
    });

    it("omits tool_call_id and superseded_id when absent on memory.write", () => {
      const event = createEvent("agent.memory.write", {
        ...makeBase(),
        scope: { userId: "u1" },
        count: 1,
        records: [{ id: "m1", kind: "episode", preview: "went well" }],
      });
      const parsed = parseSSE(formatter.format(event)!);
      expect(parsed.event).toBe("memory.write");
      expect("tool_call_id" in parsed.data).toBe(false);
      const records = parsed.data.records as Record<string, unknown>[];
      expect("superseded_id" in records[0]!).toBe(false);
    });

    it("formats memory.search with the full payload", () => {
      const event = createEvent("agent.memory.search", {
        ...makeBase(),
        scope: { userId: "u1" },
        query: "dark mode",
        kinds: ["preference", "fact"],
        tags: ["ui"],
        limit: 5,
        includeInvalidated: false,
        resultCount: 2,
        resultIds: ["m2", "m1"],
        toolCallId: "tc-2",
      });
      const parsed = parseSSE(formatter.format(event)!);
      expect(parsed.event).toBe("memory.search");
      expect(parsed.data.scope).toEqual({ userId: "u1" });
      expect(parsed.data.limit).toBe(5);
      expect(parsed.data.include_invalidated).toBe(false);
      expect(parsed.data.result_count).toBe(2);
      expect(parsed.data.result_ids).toEqual(["m2", "m1"]);
      expect(parsed.data.query).toBe("dark mode");
      expect(parsed.data.kinds).toEqual(["preference", "fact"]);
      expect(parsed.data.tags).toEqual(["ui"]);
      expect(parsed.data.tool_call_id).toBe("tc-2");
    });

    it("omits the optional filter keys on memory.search when absent", () => {
      const event = createEvent("agent.memory.search", {
        ...makeBase(),
        scope: { userId: "u1" },
        limit: 10,
        includeInvalidated: true,
        resultCount: 0,
        resultIds: [],
      });
      const parsed = parseSSE(formatter.format(event)!);
      expect(parsed.event).toBe("memory.search");
      expect("query" in parsed.data).toBe(false);
      expect("kinds" in parsed.data).toBe(false);
      expect("tags" in parsed.data).toBe(false);
      expect("tool_call_id" in parsed.data).toBe(false);
    });

    it("formats memory.recall with the pinned chars-based payload", () => {
      const event = createEvent("agent.memory.recall", {
        ...makeBase(),
        scope: { userId: "u1" },
        count: 3,
        chars: 1800,
        budgetChars: 2000,
        truncated: true,
        preview: "## Memory\n- the sky is blue… (preview only)",
      });
      const parsed = parseSSE(formatter.format(event)!);
      expect(parsed.event).toBe("memory.recall");
      // Exactly {scope, count, chars, budget_chars, truncated, preview}
      // plus the formatter's trace enrichment (traceId + timestamp).
      expect(parsed.data).toEqual({
        scope: { userId: "u1" },
        count: 3,
        chars: 1800,
        budget_chars: 2000,
        truncated: true,
        preview: "## Memory\n- the sky is blue… (preview only)",
        traceId: "t1",
        timestamp: event.timestamp.toISOString(),
      });
    });

    it("maps the three agent.memory.* types in SSE_EVENT_NAMES", () => {
      expect(SSE_EVENT_NAMES["agent.memory.write"]).toBe("memory.write");
      expect(SSE_EVENT_NAMES["agent.memory.search"]).toBe("memory.search");
      expect(SSE_EVENT_NAMES["agent.memory.recall"]).toBe("memory.recall");
    });
  });

  describe("error", () => {
    it("formats error events", () => {
      const event = createEvent("agent.error", {
        ...makeBase(),
        errorType: "RuntimeError",
        message: "something failed",
        recoverable: false,
        context: {},
      });
      const frame = formatter.format(event);
      expect(frame).not.toBeNull();
      const parsed = parseSSE(frame!);
      expect(parsed.event).toBe("error");
      expect(parsed.data.error_type).toBe("RuntimeError");
    });
  });

  describe("done terminator", () => {
    it("formats done event", () => {
      expect(SSEFormatter.formatDone()).toBe("event: done\ndata: {}\n\n");
    });
  });

  describe("extractPayload", () => {
    it("returns null for unknown events", () => {
      const event = {
        type: "unknown.event",
        traceId: "t",
        runId: "r",
        spanId: "s",
        timestamp: new Date(),
      };
      // biome-ignore lint/suspicious/noExplicitAny: testing unknown event type
      expect(SSEFormatter.extractPayload(event as any)).toBeNull();
    });

    it("extracts payload with snake_case keys", () => {
      const event = createEvent("agent.llm.end", {
        ...makeBase(),
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1200,
        hasToolCalls: false,
        finishReason: "stop",
      });
      const payload = SSEFormatter.extractPayload(event);
      expect(payload).not.toBeNull();
      expect(payload!.input_tokens).toBe(100);
      expect(payload!.duration_ms).toBe(1200);
      expect(payload!.finish_reason).toBe("stop");
    });
  });

  describe("trace context", () => {
    it("includes traceId and timestamp in every formatted frame", () => {
      const event = createEvent("agent.message.start", {
        ...makeBase(),
        agentName: "test",
      });
      const frame = formatter.format(event);
      const parsed = parseSSE(frame!);
      expect(parsed.data.traceId).toBe("t1");
      expect(parsed.data.timestamp).toBeDefined();
    });
  });

  describe("backward compatibility", () => {
    it("formatSSE function still works", () => {
      const event = createEvent("agent.message.chunk", {
        ...makeBase(),
        delta: "hi",
        chunkIndex: 0,
      });
      const frame = formatSSE(event);
      expect(frame).not.toBeNull();
      expect(frame).toContain("event: message.delta");
    });

    it("SSE_EVENT_NAMES is exported and contains mappings", () => {
      expect(SSE_EVENT_NAMES["agent.message.chunk"]).toBe("message.delta");
    });
  });

  // #324: wire forwarding of cost + synthetic provenance.
  describe("cost + synthetic wire forwarding (#324)", () => {
    it("forwards costUsd as cost_usd on message.complete when present", () => {
      const mapping = toSSEMapping(
        createEvent("agent.message.complete", {
          ...makeBase(),
          content: "done",
          inputTokens: 10,
          outputTokens: 5,
          model: "opus",
          costUsd: 0.0123,
          finishReason: "stop",
        }),
      );
      expect(mapping?.name).toBe("message.complete");
      expect(mapping?.payload.cost_usd).toBe(0.0123);
      expect(mapping?.payload.finish_reason).toBe("stop");
    });

    it("omits cost_usd when the runner reports no cost", () => {
      const mapping = toSSEMapping(
        createEvent("agent.message.complete", {
          ...makeBase(),
          content: "done",
          inputTokens: 10,
          outputTokens: 5,
          model: "opus",
        }),
      );
      expect(mapping?.payload).not.toHaveProperty("cost_usd");
    });

    it("stamps synthetic:true onto the payload for meta.synthetic events (D12)", () => {
      const mapping = toSSEMapping(
        createEvent("agent.llm.start", {
          ...makeBase(),
          model: "opus",
          messageCount: 1,
          hasTools: false,
          meta: { synthetic: true },
        }),
      );
      expect(mapping?.name).toBe("llm.start");
      expect(mapping?.payload.synthetic).toBe(true);
    });

    it("leaves synthetic off for observed events", () => {
      const mapping = toSSEMapping(
        createEvent("agent.llm.end", {
          ...makeBase(),
          model: "opus",
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 100,
          hasToolCalls: false,
          finishReason: "stop",
        }),
      );
      expect(mapping?.payload).not.toHaveProperty("synthetic");
    });

    it("SSE_WIRE_EVENT_NAMES is the complete wire vocabulary (incl. wire-only names)", () => {
      const set = new Set<string>(SSE_WIRE_EVENT_NAMES);
      // wire-only names absent from SSE_EVENT_NAMES's values
      expect(set.has("thinking.complete")).toBe(true);
      expect(set.has("done")).toBe(true);
      // every SSE_EVENT_NAMES value is covered
      for (const wireName of Object.values(SSE_EVENT_NAMES)) {
        expect(set.has(wireName)).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // #388 — usage_details wire forwarding (additive, defined-only, absent ≠ zero).
  // ---------------------------------------------------------------------------
  describe("usage_details wire forwarding (#388)", () => {
    it("forwards usage_details (snake_case, defined-only) on message.complete when present", () => {
      const mapping = toSSEMapping(
        createEvent("agent.message.complete", {
          ...makeBase(),
          content: "done",
          inputTokens: 12000,
          outputTokens: 320,
          model: "opus",
          finishReason: "stop",
          usageDetails: { cacheReadTokens: 11900, cacheWriteTokens: 0, reasoningTokens: 140 },
        }),
      );
      expect(mapping?.payload.usage_details).toEqual({
        cache_read_tokens: 11900,
        cache_write_tokens: 0,
        reasoning_tokens: 140,
      });
      // absent-≠-zero: no key present for members the fixture didn't set
      expect(mapping?.payload.usage_details).not.toHaveProperty("no_cache_tokens");
      expect(mapping?.payload.usage_details).not.toHaveProperty("text_tokens");
    });

    it("omits usage_details entirely on message.complete when absent", () => {
      const mapping = toSSEMapping(
        createEvent("agent.message.complete", {
          ...makeBase(),
          content: "done",
          inputTokens: 10,
          outputTokens: 5,
          model: "opus",
        }),
      );
      expect(mapping?.payload).not.toHaveProperty("usage_details");
    });

    it("forwards usage_details on llm.end when present", () => {
      const mapping = toSSEMapping(
        createEvent("agent.llm.end", {
          ...makeBase(),
          model: "opus",
          inputTokens: 500,
          outputTokens: 20,
          durationMs: 100,
          hasToolCalls: false,
          finishReason: "stop",
          usageDetails: { noCacheTokens: 500, textTokens: 20 },
        }),
      );
      expect(mapping?.name).toBe("llm.end");
      expect(mapping?.payload.usage_details).toEqual({
        no_cache_tokens: 500,
        text_tokens: 20,
      });
    });

    it("omits usage_details entirely on llm.end when absent (zero-token / non-reporting path)", () => {
      const mapping = toSSEMapping(
        createEvent("agent.llm.end", {
          ...makeBase(),
          model: "opus",
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 5,
          hasToolCalls: false,
          finishReason: "error",
        }),
      );
      expect(mapping?.payload).not.toHaveProperty("usage_details");
    });
  });

  // ---------------------------------------------------------------------------
  // ADR-0006 — render-artifact wire forwarding + ceiling enforcement.
  // ---------------------------------------------------------------------------
  describe("render artifacts (ADR-0006)", () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    const artifact = tableArtifact("crm_table:e891", {
      columns: ["deal", "amount"],
      rows: [["Acme", 1200]],
    });

    it("forwards artifacts on tool.end as snake_case display_type", () => {
      const mapping = toSSEMapping(
        createEvent("agent.tool.end", {
          ...makeBase(),
          toolCallId: "tc-1",
          toolName: "run_select",
          arguments: {},
          result: "ref_key: crm_table:e891",
          durationMs: 10,
          resultTokens: 0,
          artifacts: [artifact],
        }),
      );
      expect(mapping?.payload.artifacts).toEqual([
        {
          id: "crm_table:e891",
          display_type: "table",
          data: { columns: ["deal", "amount"], rows: [["Acme", 1200]] },
        },
      ]);
    });

    it("omits the artifacts key on tool.end when none were published", () => {
      const mapping = toSSEMapping(
        createEvent("agent.tool.end", {
          ...makeBase(),
          toolCallId: "tc-1",
          toolName: "search",
          arguments: {},
          result: { items: [] },
          durationMs: 10,
          resultTokens: 0,
        }),
      );
      expect(mapping?.payload).not.toHaveProperty("artifacts");
    });

    it("forwards artifacts and structured_content on message.complete", () => {
      const mapping = toSSEMapping(
        createEvent("agent.message.complete", {
          ...makeBase(),
          content: JSON.stringify({ facets: 3 }),
          inputTokens: 10,
          outputTokens: 5,
          model: "opus",
          finishReason: "terminal_tool",
          structuredContent: { facets: 3 },
          artifacts: [artifact],
        }),
      );
      expect(mapping?.payload.structured_content).toEqual({ facets: 3 });
      expect(mapping?.payload.artifacts).toEqual([
        {
          id: "crm_table:e891",
          display_type: "table",
          data: { columns: ["deal", "amount"], rows: [["Acme", 1200]] },
        },
      ]);
    });

    it("omits artifacts and structured_content on message.complete when absent", () => {
      const mapping = toSSEMapping(
        createEvent("agent.message.complete", {
          ...makeBase(),
          content: "done",
          inputTokens: 10,
          outputTokens: 5,
          model: "opus",
        }),
      );
      expect(mapping?.payload).not.toHaveProperty("artifacts");
      expect(mapping?.payload).not.toHaveProperty("structured_content");
    });

    it("replaces an over-ceiling artifact with a marker (no data, truncated:true) and logs loudly", () => {
      const mapping = toSSEMapping(
        createEvent("agent.tool.end", {
          ...makeBase(),
          toolCallId: "tc-1",
          toolName: "run_select",
          arguments: {},
          result: "ref",
          durationMs: 10,
          resultTokens: 0,
          artifacts: [artifact],
        }),
        { artifactByteCeiling: 5 }, // tiny — guaranteed breach
      );
      expect(mapping?.payload.artifacts).toEqual([
        { id: "crm_table:e891", display_type: "table", truncated: true },
      ]);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("crm_table:e891");
    });

    it("ships the artifact as-is when under a custom (larger) ceiling", () => {
      const mapping = toSSEMapping(
        createEvent("agent.tool.end", {
          ...makeBase(),
          toolCallId: "tc-1",
          toolName: "run_select",
          arguments: {},
          result: "ref",
          durationMs: 10,
          resultTokens: 0,
          artifacts: [artifact],
        }),
        { artifactByteCeiling: 10_000 },
      );
      expect(mapping?.payload.artifacts).toEqual([
        {
          id: "crm_table:e891",
          display_type: "table",
          data: { columns: ["deal", "amount"], rows: [["Acme", 1200]] },
        },
      ]);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("SSEFormatter honors a configured ceiling on format()", () => {
      const strictFormatter = new SSEFormatter({ artifactByteCeiling: 5 });
      const event = createEvent("agent.tool.end", {
        ...makeBase(),
        toolCallId: "tc-1",
        toolName: "run_select",
        arguments: {},
        result: "ref",
        durationMs: 10,
        resultTokens: 0,
        artifacts: [artifact],
      });
      const parsed = parseSSE(strictFormatter.format(event)!);
      expect(parsed.data.artifacts).toEqual([
        { id: "crm_table:e891", display_type: "table", truncated: true },
      ]);
    });
  });
});
