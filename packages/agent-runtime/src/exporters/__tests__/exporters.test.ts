import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import { createEvent } from "../../events/types.js";
import { BaseExporter } from "../base.js";
import { ConsoleExporter, type ConsoleLogger, createConsoleExporter } from "../console.js";
import {
  type LangfuseClient,
  LangfuseExporter,
  type LangfuseObservation,
  type LangfuseSpan,
} from "../langfuse.js";
import { OTelExporter, type OTelSpan, OTelStatusCode, type OTelTracer } from "../otel.js";

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

function makeMockLogger(): ConsoleLogger & {
  messages: string[];
  errors: string[];
  writes: string[];
} {
  const messages: string[] = [];
  const errors: string[] = [];
  const writes: string[] = [];
  return {
    messages,
    errors,
    writes,
    log: (msg: string) => {
      messages.push(msg);
    },
    error: (msg: string) => {
      errors.push(msg);
    },
    write: (text: string) => {
      writes.push(text);
    },
  };
}

// ---------------------------------------------------------------------------
// BaseExporter dispatch tests
// ---------------------------------------------------------------------------

describe("BaseExporter", () => {
  it("should dispatch events to _on<Suffix> handler methods", async () => {
    class TestExporter extends BaseExporter {
      calls: string[] = [];
      async _onMessageStart(): Promise<void> {
        this.calls.push("messageStart");
      }
      async _onToolEnd(): Promise<void> {
        this.calls.push("toolEnd");
      }
    }

    const exporter = new TestExporter();
    await exporter.handleEvent(
      createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "test",
      }),
    );
    await exporter.handleEvent(
      createEvent("agent.tool.end", {
        traceId: "t1",
        runId: "r1",
        toolCallId: "tc1",
        toolName: "tool1",
        arguments: {},
        result: "ok",
        durationMs: 100,
        resultTokens: 10,
      }),
    );

    expect(exporter.calls).toEqual(["messageStart", "toolEnd"]);
  });

  it("should attach/detach to EventBus via profile subscription", () => {
    const bus = new EventBus();
    class TestExporter extends BaseExporter {}
    const exporter = new TestExporter();

    exporter.attach(bus);
    expect(bus.getHandlerCount("agent.message.start")).toBeGreaterThan(0);

    exporter.detach(bus);
    expect(bus.getHandlerCount("agent.message.start")).toBe(0);
  });

  it("should ignore events with no matching handler", async () => {
    class TestExporter extends BaseExporter {}
    const exporter = new TestExporter();

    // Should not throw
    await exporter.handleEvent(
      createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "test",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// ConsoleExporter tests
// ---------------------------------------------------------------------------

describe("ConsoleExporter", () => {
  it("should create via factory function", () => {
    const exporter = createConsoleExporter({ verbose: false });
    expect(exporter).toBeInstanceOf(ConsoleExporter);
  });

  it("should log on message start (verbose)", async () => {
    const logger = makeMockLogger();
    const exporter = new ConsoleExporter({ verbose: true, logger });
    await exporter.handleEvent(
      createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "test",
      }),
    );
    expect(logger.messages.length).toBeGreaterThan(0);
    expect(logger.messages.some((m) => m.includes("thinking"))).toBe(true);
  });

  it("should stream chunks via write", async () => {
    const logger = makeMockLogger();
    const exporter = new ConsoleExporter({ logger });
    await exporter.handleEvent(
      createEvent("agent.message.chunk", {
        traceId: "t1",
        runId: "r1",
        delta: "Hello",
        chunkIndex: 0,
      }),
    );
    expect(logger.writes).toContain("Hello");
  });

  it("should log complete message with token counts", async () => {
    const logger = makeMockLogger();
    const exporter = new ConsoleExporter({ verbose: true, logger });
    await exporter.handleEvent(
      createEvent("agent.message.complete", {
        traceId: "t1",
        runId: "r1",
        content: "Done",
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
      }),
    );
    expect(logger.messages.some((m) => m.includes("100"))).toBe(true);
  });

  it("#388: renders a cache/reasoning breakdown when usageDetails is present", async () => {
    const logger = makeMockLogger();
    const exporter = new ConsoleExporter({ verbose: true, logger });
    await exporter.handleEvent(
      createEvent("agent.message.complete", {
        traceId: "t1",
        runId: "r1",
        content: "Done",
        inputTokens: 12000,
        outputTokens: 320,
        model: "test-model",
        usageDetails: { cacheReadTokens: 11900, cacheWriteTokens: 500, reasoningTokens: 140 },
      }),
    );
    expect(
      logger.messages.some((m) => m.includes("cache 11900 read · 500 write · reasoning 140")),
    ).toBe(true);
  });

  it("#388: renders the byte-identical token line when usageDetails is absent (no breakdown)", async () => {
    const logger = makeMockLogger();
    const exporter = new ConsoleExporter({ verbose: true, logger });
    await exporter.handleEvent(
      createEvent("agent.message.complete", {
        traceId: "t1",
        runId: "r1",
        content: "Done",
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
      }),
    );
    expect(logger.messages).toContain("Tokens: 100 in / 50 out | Model: test-model");
  });

  it("should log tool start and end", async () => {
    const logger = makeMockLogger();
    const exporter = new ConsoleExporter({ verbose: true, logger });
    await exporter.handleEvent(
      createEvent("agent.tool.start", {
        traceId: "t1",
        runId: "r1",
        toolCallId: "tc1",
        toolName: "myTool",
        arguments: { a: 1 },
      }),
    );
    await exporter.handleEvent(
      createEvent("agent.tool.end", {
        traceId: "t1",
        runId: "r1",
        toolCallId: "tc1",
        toolName: "myTool",
        arguments: { a: 1 },
        result: "ok",
        durationMs: 42,
        resultTokens: 5,
      }),
    );
    expect(logger.messages.some((m) => m.includes("myTool"))).toBe(true);
  });

  it("should log errors", async () => {
    const logger = makeMockLogger();
    const exporter = new ConsoleExporter({ logger });
    await exporter.handleEvent(
      createEvent("agent.error", {
        traceId: "t1",
        runId: "r1",
        errorType: "RuntimeError",
        message: "something broke",
        recoverable: false,
        context: {},
      }),
    );
    expect(logger.errors.some((m) => m.includes("something broke"))).toBe(true);
  });

  it("should attach to event bus and receive events", async () => {
    const logger = makeMockLogger();
    const bus = new EventBus();
    const exporter = new ConsoleExporter({ verbose: true, logger });
    exporter.attach(bus);

    await bus.publish(
      createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "test",
      }),
    );

    expect(logger.messages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LangfuseExporter tests
// ---------------------------------------------------------------------------

describe("LangfuseExporter", () => {
  function makeMockLangfuse() {
    const mockObservation: LangfuseObservation = {
      update: vi.fn(),
      end: vi.fn(),
    };

    const mockSpan: LangfuseSpan = {
      startSpan: vi.fn((): LangfuseSpan => mockSpan),
      startObservation: vi.fn((): LangfuseObservation => mockObservation),
      update: vi.fn(),
      updateTrace: vi.fn(),
      end: vi.fn(),
    };

    const mockClient: LangfuseClient = {
      startSpan: vi.fn((): LangfuseSpan => mockSpan),
      flush: vi.fn(),
    };

    return { mockClient, mockSpan, mockObservation };
  }

  it("should create a root span on message start", async () => {
    const { mockClient } = makeMockLangfuse();
    const exporter = new LangfuseExporter({ client: mockClient });

    await exporter.handleEvent(
      createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "TestAgent",
      }),
    );

    expect(mockClient.startSpan).toHaveBeenCalledWith(
      expect.objectContaining({ name: "agent.run" }),
    );
  });

  it("should end root span on message complete", async () => {
    const { mockClient, mockSpan } = makeMockLangfuse();
    const exporter = new LangfuseExporter({ client: mockClient });

    await exporter.handleEvent(
      createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "TestAgent",
      }),
    );

    await exporter.handleEvent(
      createEvent("agent.message.complete", {
        traceId: "t1",
        runId: "r1",
        content: "done",
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
      }),
    );

    expect(mockSpan.end).toHaveBeenCalled();
    expect(mockSpan.updateTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ input_tokens: 100 }),
      }),
    );
  });

  it("should create tool observation on tool start/end", async () => {
    const { mockClient, mockSpan, mockObservation } = makeMockLangfuse();
    const exporter = new LangfuseExporter({ client: mockClient });

    await exporter.handleEvent(
      createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "TestAgent",
      }),
    );

    await exporter.handleEvent(
      createEvent("agent.tool.start", {
        traceId: "t1",
        runId: "r1",
        spanId: "s1",
        toolCallId: "tc1",
        toolName: "myTool",
        arguments: { x: 1 },
      }),
    );

    expect(mockSpan.startObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        as_type: "generation",
        name: "tool.myTool",
      }),
    );

    await exporter.handleEvent(
      createEvent("agent.tool.end", {
        traceId: "t1",
        runId: "r1",
        spanId: "s1",
        toolCallId: "tc1",
        toolName: "myTool",
        arguments: { x: 1 },
        result: "ok",
        durationMs: 42,
        resultTokens: 5,
      }),
    );

    expect(mockObservation.end).toHaveBeenCalled();
  });

  it("should flush on demand", () => {
    const { mockClient } = makeMockLangfuse();
    const exporter = new LangfuseExporter({ client: mockClient });
    exporter.flush();
    expect(mockClient.flush).toHaveBeenCalled();
  });

  // #324: exporter pass-through — gate.decision surfaces + costUsd maps to cost.
  it("should surface agent.gate.decision as a span under the run", async () => {
    const { mockClient, mockSpan } = makeMockLangfuse();
    const exporter = new LangfuseExporter({ client: mockClient });

    await exporter.handleEvent(
      createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "TestAgent",
      }),
    );
    await exporter.handleEvent(
      createEvent("agent.gate.decision", {
        traceId: "t1",
        runId: "r1",
        toolName: "deleteFile",
        outcome: "block",
        settledBy: "gate",
        blockedBy: "safety",
        reason: "destructive",
        trail: [{ gate: "safety", result: "block" }],
      }),
    );

    expect(mockSpan.startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "gate.decision",
        metadata: expect.objectContaining({ outcome: "block", blocked_by: "safety" }),
      }),
    );
  });

  it("should map costUsd to Langfuse cost on message complete", async () => {
    const { mockClient, mockSpan } = makeMockLangfuse();
    const exporter = new LangfuseExporter({ client: mockClient });

    await exporter.handleEvent(
      createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "TestAgent",
      }),
    );
    await exporter.handleEvent(
      createEvent("agent.message.complete", {
        traceId: "t1",
        runId: "r1",
        content: "done",
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
        costUsd: 0.0123,
      }),
    );

    expect(mockSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({ cost_details: { total: 0.0123 } }),
    );
  });

  describe("usageDetails (#388)", () => {
    it("maps cache/reasoning detail into usage_details as the non-cached input/output (avoids double-billing)", async () => {
      const { mockClient, mockObservation } = makeMockLangfuse();
      const exporter = new LangfuseExporter({ client: mockClient });

      await exporter.handleEvent(
        createEvent("agent.message.start", { traceId: "t1", runId: "r1", agentName: "Test" }),
      );
      await exporter.handleEvent(
        createEvent("agent.llm.start", {
          traceId: "t1",
          runId: "r1",
          spanId: "gen-1",
          model: "claude",
          messageCount: 1,
          hasTools: false,
        }),
      );
      await exporter.handleEvent(
        createEvent("agent.llm.end", {
          traceId: "t1",
          runId: "r1",
          spanId: "gen-1",
          model: "claude",
          inputTokens: 12000,
          outputTokens: 320,
          durationMs: 100,
          hasToolCalls: false,
          finishReason: "stop",
          usageDetails: { cacheReadTokens: 11900, cacheWriteTokens: 0, reasoningTokens: 140 },
        }),
      );

      expect(mockObservation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          usage_details: {
            input: 100, // 12000 - 11900 - 0 (exclusive, non-cached)
            output: 180, // 320 - 140 (exclusive, non-reasoning)
            cache_read_input_tokens: 11900,
            cache_creation_input_tokens: 0,
            output_reasoning_tokens: 140,
          },
        }),
      );
    });

    it("sends the byte-identical {input, output} shape when usageDetails is absent", async () => {
      const { mockClient, mockObservation } = makeMockLangfuse();
      const exporter = new LangfuseExporter({ client: mockClient });

      await exporter.handleEvent(
        createEvent("agent.message.start", { traceId: "t1", runId: "r1", agentName: "Test" }),
      );
      await exporter.handleEvent(
        createEvent("agent.llm.start", {
          traceId: "t1",
          runId: "r1",
          spanId: "gen-2",
          model: "claude",
          messageCount: 1,
          hasTools: false,
        }),
      );
      await exporter.handleEvent(
        createEvent("agent.llm.end", {
          traceId: "t1",
          runId: "r1",
          spanId: "gen-2",
          model: "claude",
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 10,
          hasToolCalls: false,
          finishReason: "stop",
        }),
      );

      expect(mockObservation.update).toHaveBeenCalledWith(
        expect.objectContaining({ usage_details: { input: 10, output: 5 } }),
      );
    });

    it("adds defined detail members to the trace metadata on message.complete", async () => {
      const { mockClient, mockSpan } = makeMockLangfuse();
      const exporter = new LangfuseExporter({ client: mockClient });

      await exporter.handleEvent(
        createEvent("agent.message.start", { traceId: "t1", runId: "r1", agentName: "Test" }),
      );
      await exporter.handleEvent(
        createEvent("agent.message.complete", {
          traceId: "t1",
          runId: "r1",
          content: "done",
          inputTokens: 12000,
          outputTokens: 320,
          model: "claude",
          usageDetails: { cacheReadTokens: 11900, reasoningTokens: 140 },
        }),
      );

      expect(mockSpan.updateTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            cache_read_input_tokens: 11900,
            output_reasoning_tokens: 140,
          }),
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// OTelExporter tests
// ---------------------------------------------------------------------------

describe("OTelExporter", () => {
  function makeMockTracer() {
    const spans = new Map<string, OTelSpan>();
    const endedSpans: string[] = [];

    const createMockSpan = (name: string): OTelSpan => ({
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(() => {
        endedSpans.push(name);
      }),
    });

    const tracer: OTelTracer = {
      startSpan: vi.fn((name: string) => {
        const span = createMockSpan(name);
        spans.set(name, span);
        return span;
      }),
    };

    return { tracer, spans, endedSpans };
  }

  it("should create root span on message start", async () => {
    const { tracer } = makeMockTracer();
    const exporter = new OTelExporter({ tracer });

    await exporter.handleEvent(
      createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "TestAgent",
      }),
    );

    expect(tracer.startSpan).toHaveBeenCalledWith("agent.run");
  });

  it("should end root span on message complete with attributes", async () => {
    const { tracer, spans, endedSpans } = makeMockTracer();
    const exporter = new OTelExporter({ tracer });

    const startEvent = createEvent("agent.message.start", {
      traceId: "t1",
      runId: "r1",
      agentName: "TestAgent",
    });
    await exporter.handleEvent(startEvent);

    await exporter.handleEvent(
      createEvent("agent.message.complete", {
        traceId: "t1",
        runId: "r1",
        spanId: startEvent.spanId,
        content: "done",
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
      }),
    );

    const rootSpan = spans.get("agent.run");
    expect(rootSpan?.setAttribute).toHaveBeenCalledWith("agent.model", "test-model");
    expect(rootSpan?.setAttribute).toHaveBeenCalledWith("agent.input_tokens", 100);
    expect(endedSpans).toContain("agent.run");
  });

  it("should create tool spans", async () => {
    const { tracer, spans } = makeMockTracer();
    const exporter = new OTelExporter({ tracer });

    await exporter.handleEvent(
      createEvent("agent.tool.start", {
        traceId: "t1",
        runId: "r1",
        toolCallId: "tc1",
        toolName: "searchTool",
        arguments: { q: "test" },
      }),
    );

    expect(tracer.startSpan).toHaveBeenCalledWith("tool.searchTool");
    const toolSpan = spans.get("tool.searchTool");
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith("tool.name", "searchTool");
  });

  it("should mark tool span error on failure", async () => {
    const { tracer, spans } = makeMockTracer();
    const exporter = new OTelExporter({ tracer });

    const startEvent = createEvent("agent.tool.start", {
      traceId: "t1",
      runId: "r1",
      toolCallId: "tc1",
      toolName: "failTool",
      arguments: {},
    });
    await exporter.handleEvent(startEvent);

    await exporter.handleEvent(
      createEvent("agent.tool.end", {
        traceId: "t1",
        runId: "r1",
        spanId: startEvent.spanId,
        toolCallId: "tc1",
        toolName: "failTool",
        arguments: {},
        result: null,
        error: "something went wrong",
        durationMs: 10,
        resultTokens: 0,
      }),
    );

    const toolSpan = spans.get("tool.failTool");
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({
      code: OTelStatusCode.ERROR,
      message: "something went wrong",
    });
  });

  it("should create LLM spans with gen_ai attributes", async () => {
    const { tracer, spans } = makeMockTracer();
    const exporter = new OTelExporter({ tracer });

    await exporter.handleEvent(
      createEvent("agent.llm.start", {
        traceId: "t1",
        runId: "r1",
        model: "claude-sonnet",
        messageCount: 3,
        hasTools: true,
      }),
    );

    expect(tracer.startSpan).toHaveBeenCalledWith("gen_ai.chat");
    const llmSpan = spans.get("gen_ai.chat");
    expect(llmSpan?.setAttribute).toHaveBeenCalledWith("gen_ai.system", "vercel-ai-sdk");
    expect(llmSpan?.setAttribute).toHaveBeenCalledWith("gen_ai.request.model", "claude-sonnet");
  });

  // #324: exporter pass-through — gate.decision surfaces + costUsd maps to cost.
  it("should surface agent.gate.decision as a self-contained span", async () => {
    const { tracer, spans, endedSpans } = makeMockTracer();
    const exporter = new OTelExporter({ tracer });

    await exporter.handleEvent(
      createEvent("agent.gate.decision", {
        traceId: "t1",
        runId: "r1",
        toolName: "deleteFile",
        outcome: "block",
        settledBy: "gate",
        blockedBy: "safety",
        trail: [{ gate: "safety", result: "block" }],
      }),
    );

    expect(tracer.startSpan).toHaveBeenCalledWith("agent.gate.decision");
    const gateSpan = spans.get("agent.gate.decision");
    expect(gateSpan?.setAttribute).toHaveBeenCalledWith("gate.tool_name", "deleteFile");
    expect(gateSpan?.setAttribute).toHaveBeenCalledWith("gate.outcome", "block");
    expect(gateSpan?.setStatus).toHaveBeenCalledWith({ code: OTelStatusCode.ERROR });
    expect(endedSpans).toContain("agent.gate.decision");
  });

  it("should set gen_ai.usage.cost from costUsd on message complete", async () => {
    const { tracer, spans } = makeMockTracer();
    const exporter = new OTelExporter({ tracer });

    const startEvent = createEvent("agent.message.start", {
      traceId: "t1",
      runId: "r1",
      agentName: "TestAgent",
    });
    await exporter.handleEvent(startEvent);
    await exporter.handleEvent(
      createEvent("agent.message.complete", {
        traceId: "t1",
        runId: "r1",
        spanId: startEvent.spanId,
        content: "done",
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
        costUsd: 0.0123,
      }),
    );

    const rootSpan = spans.get("agent.run");
    expect(rootSpan?.setAttribute).toHaveBeenCalledWith("gen_ai.usage.cost", 0.0123);
  });

  describe("usageDetails (#388) — THE OTEL DECISION: inclusive totals + informational sub-attributes", () => {
    it("keeps gen_ai.usage.input_tokens/output_tokens INCLUSIVE and adds cache/reasoning as separate informational attributes", async () => {
      const { tracer, spans } = makeMockTracer();
      const exporter = new OTelExporter({ tracer });

      const startEvent = createEvent("agent.llm.start", {
        traceId: "t1",
        runId: "r1",
        model: "claude-sonnet",
        messageCount: 1,
        hasTools: false,
      });
      await exporter.handleEvent(startEvent);
      await exporter.handleEvent(
        createEvent("agent.llm.end", {
          traceId: "t1",
          runId: "r1",
          spanId: startEvent.spanId,
          model: "claude-sonnet",
          inputTokens: 12000,
          outputTokens: 320,
          durationMs: 100,
          hasToolCalls: false,
          finishReason: "stop",
          usageDetails: { cacheReadTokens: 11900, cacheWriteTokens: 0, reasoningTokens: 140 },
        }),
      );

      const llmSpan = spans.get("gen_ai.chat");
      // Inclusive totals — unchanged from the pre-#388 shape.
      expect(llmSpan?.setAttribute).toHaveBeenCalledWith("gen_ai.usage.input_tokens", 12000);
      expect(llmSpan?.setAttribute).toHaveBeenCalledWith("gen_ai.usage.output_tokens", 320);
      // Official (dotted) semconv attribute names, informational sub-counts.
      expect(llmSpan?.setAttribute).toHaveBeenCalledWith(
        "gen_ai.usage.cache_read.input_tokens",
        11900,
      );
      expect(llmSpan?.setAttribute).toHaveBeenCalledWith(
        "gen_ai.usage.cache_creation.input_tokens",
        0,
      );
      expect(llmSpan?.setAttribute).toHaveBeenCalledWith(
        "gen_ai.usage.reasoning.output_tokens",
        140,
      );
    });

    it("sets no cache_*/reasoning.* attribute on a detail-free event (absent ≠ zero)", async () => {
      const { tracer, spans } = makeMockTracer();
      const exporter = new OTelExporter({ tracer });

      const startEvent = createEvent("agent.llm.start", {
        traceId: "t1",
        runId: "r1",
        model: "claude-sonnet",
        messageCount: 1,
        hasTools: false,
      });
      await exporter.handleEvent(startEvent);
      await exporter.handleEvent(
        createEvent("agent.llm.end", {
          traceId: "t1",
          runId: "r1",
          spanId: startEvent.spanId,
          model: "claude-sonnet",
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 10,
          hasToolCalls: false,
          finishReason: "stop",
        }),
      );

      const llmSpan = spans.get("gen_ai.chat");
      const calledAttrs = (llmSpan?.setAttribute as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(calledAttrs).not.toContain("gen_ai.usage.cache_read.input_tokens");
      expect(calledAttrs).not.toContain("gen_ai.usage.cache_creation.input_tokens");
      expect(calledAttrs).not.toContain("gen_ai.usage.reasoning.output_tokens");
    });

    it("mirrors the same detail under the agent.* namespace on message.complete", async () => {
      const { tracer, spans } = makeMockTracer();
      const exporter = new OTelExporter({ tracer });

      const startEvent = createEvent("agent.message.start", {
        traceId: "t1",
        runId: "r1",
        agentName: "TestAgent",
      });
      await exporter.handleEvent(startEvent);
      await exporter.handleEvent(
        createEvent("agent.message.complete", {
          traceId: "t1",
          runId: "r1",
          spanId: startEvent.spanId,
          content: "done",
          inputTokens: 12000,
          outputTokens: 320,
          model: "test-model",
          usageDetails: { cacheReadTokens: 11900, reasoningTokens: 140 },
        }),
      );

      const rootSpan = spans.get("agent.run");
      expect(rootSpan?.setAttribute).toHaveBeenCalledWith("agent.cache_read_input_tokens", 11900);
      expect(rootSpan?.setAttribute).toHaveBeenCalledWith("agent.reasoning_output_tokens", 140);
    });
  });
});
