import { describe, expect, it } from "vitest";
import { createEvent } from "../../events/types.js";
import { InMemoryEventCollector } from "../collector.js";
import { InMemoryAdminService } from "../service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBase(traceId = "t1") {
  return { traceId, runId: "r1" };
}

function createCollectorWithEvents(): InMemoryEventCollector {
  const collector = new InMemoryEventCollector();
  return collector;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("B3: Admin Service Upgrade", () => {
  describe("InMemoryEventCollector — tokensByModel", () => {
    it("tracks tokens by model from llm.end events", async () => {
      const collector = createCollectorWithEvents();

      // Simulate message start to create a trace
      await collector.handleEvent(
        createEvent("agent.message.start", {
          ...makeBase(),
          agentName: "agent-1",
        }),
      );

      await collector.handleEvent(
        createEvent("agent.llm.end", {
          ...makeBase(),
          model: "gpt-4",
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 1000,
          hasToolCalls: false,
          finishReason: "stop",
        }),
      );

      await collector.handleEvent(
        createEvent("agent.llm.end", {
          ...makeBase(),
          model: "gpt-4",
          inputTokens: 200,
          outputTokens: 80,
          durationMs: 800,
          hasToolCalls: false,
          finishReason: "stop",
        }),
      );

      await collector.handleEvent(
        createEvent("agent.llm.end", {
          ...makeBase(),
          model: "claude-3",
          inputTokens: 50,
          outputTokens: 30,
          durationMs: 500,
          hasToolCalls: false,
          finishReason: "stop",
        }),
      );

      const usage = collector.getTokenUsage({ groupBy: "model" });
      expect(usage).toHaveLength(2);

      const gpt4 = usage.find((u) => u.key === "gpt-4");
      expect(gpt4).toBeDefined();
      expect(gpt4!.inputTokens).toBe(300);
      expect(gpt4!.outputTokens).toBe(130);
      expect(gpt4!.totalTokens).toBe(430);

      const claude = usage.find((u) => u.key === "claude-3");
      expect(claude).toBeDefined();
      expect(claude!.inputTokens).toBe(50);
      expect(claude!.outputTokens).toBe(30);
    });

    it("tracks conversation association in tokensByModel", async () => {
      const collector = createCollectorWithEvents();

      // Two traces
      await collector.handleEvent(
        createEvent("agent.message.start", {
          ...makeBase("t1"),
          agentName: "agent-1",
        }),
      );
      await collector.handleEvent(
        createEvent("agent.message.start", {
          traceId: "t2",
          runId: "r2",
          agentName: "agent-1",
        }),
      );

      await collector.handleEvent(
        createEvent("agent.llm.end", {
          ...makeBase("t1"),
          model: "gpt-4",
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 1000,
          hasToolCalls: false,
          finishReason: "stop",
        }),
      );
      await collector.handleEvent(
        createEvent("agent.llm.end", {
          traceId: "t2",
          runId: "r2",
          model: "gpt-4",
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 1000,
          hasToolCalls: false,
          finishReason: "stop",
        }),
      );

      const usage = collector.getTokenUsage({ groupBy: "model" });
      const gpt4 = usage.find((u) => u.key === "gpt-4");
      expect(gpt4!.conversationCount).toBe(2);
    });
  });

  describe("InMemoryEventCollector — conversation lifecycle", () => {
    it("tracks active conversations from conversation.start/end", async () => {
      const collector = createCollectorWithEvents();

      await collector.handleEvent(
        createEvent("agent.conversation.start", {
          ...makeBase(),
          conversationId: "conv-1",
          agentName: "agent-1",
        }),
      );

      const stats1 = collector.getDashboardStats();
      expect(stats1.activeConversationCount).toBe(1);

      await collector.handleEvent(
        createEvent("agent.conversation.end", {
          ...makeBase(),
          conversationId: "conv-1",
          reason: "completed",
        }),
      );

      const stats2 = collector.getDashboardStats();
      expect(stats2.activeConversationCount).toBe(0);
    });
  });

  describe("InMemoryEventCollector — message cancel", () => {
    it("handles message.cancel by updating trace status", async () => {
      const collector = createCollectorWithEvents();

      await collector.handleEvent(
        createEvent("agent.message.start", {
          ...makeBase(),
          agentName: "agent-1",
        }),
      );

      await collector.handleEvent(
        createEvent("agent.message.cancel", {
          ...makeBase(),
          reason: "user cancelled",
        }),
      );

      const traces = collector.getTraceSummaries();
      expect(traces).toHaveLength(1);
      expect(traces[0]!.status).toBe("completed");
    });
  });

  describe("InMemoryEventCollector — getToolAnalytics", () => {
    it("aggregates tool stats across agents", async () => {
      const collector = createCollectorWithEvents();

      // Agent 1 trace
      await collector.handleEvent(
        createEvent("agent.message.start", {
          ...makeBase("t1"),
          agentName: "agent-1",
        }),
      );
      await collector.handleEvent(
        createEvent("agent.tool.end", {
          ...makeBase("t1"),
          toolCallId: "tc1",
          toolName: "search",
          arguments: {},
          result: null,
          durationMs: 100,
          resultTokens: 0,
        }),
      );
      await collector.handleEvent(
        createEvent("agent.tool.end", {
          ...makeBase("t1"),
          toolCallId: "tc2",
          toolName: "search",
          arguments: {},
          result: null,
          durationMs: 200,
          resultTokens: 0,
        }),
      );

      // Agent 2 trace
      await collector.handleEvent(
        createEvent("agent.message.start", {
          traceId: "t2",
          runId: "r2",
          agentName: "agent-2",
        }),
      );
      await collector.handleEvent(
        createEvent("agent.tool.end", {
          traceId: "t2",
          runId: "r2",
          toolCallId: "tc3",
          toolName: "search",
          arguments: {},
          result: null,
          durationMs: 150,
          resultTokens: 0,
        }),
      );
      await collector.handleEvent(
        createEvent("agent.tool.end", {
          traceId: "t2",
          runId: "r2",
          toolCallId: "tc4",
          toolName: "calculator",
          arguments: {},
          result: null,
          error: "overflow",
          durationMs: 50,
          resultTokens: 0,
        }),
      );

      const analytics = collector.getToolAnalytics();
      expect(analytics).toHaveLength(2);

      const search = analytics.find((a) => a.toolName === "search");
      expect(search).toBeDefined();
      expect(search!.totalCalls).toBe(3);
      expect(search!.totalDurationMs).toBe(450);
      expect(search!.avgDurationMs).toBe(150);
      expect(search!.agentBreakdown).toHaveLength(2);

      const calc = analytics.find((a) => a.toolName === "calculator");
      expect(calc).toBeDefined();
      expect(calc!.totalCalls).toBe(1);
      expect(calc!.totalErrors).toBe(1);
    });
  });

  describe("InMemoryEventCollector — getTokenUsage groupBy agent", () => {
    it("returns per-agent token breakdown", async () => {
      const collector = createCollectorWithEvents();

      await collector.handleEvent(
        createEvent("agent.message.start", {
          ...makeBase("t1"),
          agentName: "agent-1",
        }),
      );
      await collector.handleEvent(
        createEvent("agent.message.complete", {
          ...makeBase("t1"),
          content: "hi",
          inputTokens: 100,
          outputTokens: 50,
          model: "gpt-4",
        }),
      );

      await collector.handleEvent(
        createEvent("agent.message.start", {
          traceId: "t2",
          runId: "r2",
          agentName: "agent-2",
        }),
      );
      await collector.handleEvent(
        createEvent("agent.message.complete", {
          traceId: "t2",
          runId: "r2",
          content: "hello",
          inputTokens: 200,
          outputTokens: 80,
          model: "claude-3",
        }),
      );

      const usage = collector.getTokenUsage({ groupBy: "agent" });
      expect(usage).toHaveLength(2);

      const a1 = usage.find((u) => u.key === "agent-1");
      expect(a1).toBeDefined();
      expect(a1!.inputTokens).toBe(100);
      expect(a1!.outputTokens).toBe(50);
      expect(a1!.totalTokens).toBe(150);
    });
  });

  describe("InMemoryAdminService — new methods", () => {
    it("delegates getToolAnalytics to collector", async () => {
      const collector = createCollectorWithEvents();
      const service = new InMemoryAdminService(collector);

      const analytics = await service.getToolAnalytics();
      expect(analytics).toEqual([]);
    });

    it("delegates getTokenUsage to collector", async () => {
      const collector = createCollectorWithEvents();
      const service = new InMemoryAdminService(collector);

      const usage = await service.getTokenUsage({ groupBy: "model" });
      expect(usage).toEqual([]);
    });
  });
});
