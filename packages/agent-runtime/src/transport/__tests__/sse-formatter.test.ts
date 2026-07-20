import { describe, expect, it } from "vitest";
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
});
