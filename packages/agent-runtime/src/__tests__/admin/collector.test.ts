import { describe, expect, it } from "vitest";
import { InMemoryEventCollector } from "../../admin/collector.js";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import { createEvent } from "../../events/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseFields = {
  traceId: "trace-1",
  runId: "run-1",
} as const;

function makeCollector(): { collector: InMemoryEventCollector; bus: AgentEventBus } {
  const bus = new AgentEventBus();
  const collector = new InMemoryEventCollector();
  collector.attach(bus);
  return { collector, bus };
}

// ---------------------------------------------------------------------------
// Basic lifecycle
// ---------------------------------------------------------------------------

describe("InMemoryEventCollector", () => {
  it("starts with empty dashboard stats", () => {
    const { collector } = makeCollector();
    const stats = collector.getDashboardStats();
    expect(stats.agents).toHaveLength(0);
    expect(stats.activeAgentCount).toBe(0);
    expect(stats.totalTokensUsed).toBe(0);
    expect(stats.totalToolCalls).toBe(0);
    expect(stats.totalErrors).toBe(0);
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks agent from message.start", async () => {
    const { collector, bus } = makeCollector();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    const stats = collector.getDashboardStats();
    expect(stats.agents).toHaveLength(1);
    expect(stats.agents[0]!.agentName).toBe("test-agent");
    expect(stats.agents[0]!.status).toBe("running");
    expect(stats.activeAgentCount).toBe(1);
  });

  it("accumulates tokens from message.complete", async () => {
    const { collector, bus } = makeCollector();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    await bus.publish(
      createEvent("agent.message.complete", {
        ...baseFields,
        content: "hello",
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-4",
      }),
    );
    const agent = collector.getAgentStats("test-agent");
    expect(agent).toBeDefined();
    expect(agent!.totalInputTokens).toBe(100);
    expect(agent!.totalOutputTokens).toBe(50);
    expect(collector.getDashboardStats().totalTokensUsed).toBe(150);
  });

  it("tracks iterations", async () => {
    const { collector, bus } = makeCollector();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    await bus.publish(
      createEvent("agent.iteration.end", {
        ...baseFields,
        iteration: 0,
        toolCallsCount: 2,
        hasMore: true,
      }),
    );
    await bus.publish(
      createEvent("agent.iteration.end", {
        ...baseFields,
        iteration: 1,
        toolCallsCount: 0,
        hasMore: false,
      }),
    );
    const agent = collector.getAgentStats("test-agent");
    expect(agent!.totalIterations).toBe(2);
  });

  it("tracks tool calls and per-tool stats", async () => {
    const { collector, bus } = makeCollector();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    await bus.publish(
      createEvent("agent.tool.end", {
        ...baseFields,
        toolCallId: "tc-1",
        toolName: "search",
        arguments: {},
        result: "ok",
        durationMs: 100,
        resultTokens: 10,
      }),
    );
    await bus.publish(
      createEvent("agent.tool.end", {
        ...baseFields,
        toolCallId: "tc-2",
        toolName: "search",
        arguments: {},
        result: null,
        error: "timeout",
        durationMs: 5000,
        resultTokens: 0,
      }),
    );
    const agent = collector.getAgentStats("test-agent");
    expect(agent!.totalToolCalls).toBe(2);
    expect(agent!.toolStats).toHaveLength(1);
    expect(agent!.toolStats[0]!.toolName).toBe("search");
    expect(agent!.toolStats[0]!.callCount).toBe(2);
    expect(agent!.toolStats[0]!.errorCount).toBe(1);
    expect(agent!.toolStats[0]!.totalDurationMs).toBe(5100);
    expect(agent!.toolStats[0]!.avgDurationMs).toBe(2550);
    expect(collector.getDashboardStats().totalToolCalls).toBe(2);
  });

  it("tracks errors", async () => {
    const { collector, bus } = makeCollector();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    await bus.publish(
      createEvent("agent.error", {
        ...baseFields,
        errorType: "RuntimeError",
        message: "boom",
        recoverable: false,
        context: {},
      }),
    );
    const agent = collector.getAgentStats("test-agent");
    expect(agent!.totalErrors).toBe(1);
    expect(agent!.status).toBe("error");
    expect(collector.getDashboardStats().totalErrors).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Ring buffer
  // ---------------------------------------------------------------------------

  it("maintains recent events ring buffer", async () => {
    const { collector, bus } = makeCollector();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    const events = collector.getRecentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("agent.message.start");
  });

  it("limits recent events with limit parameter", async () => {
    const { collector, bus } = makeCollector();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "a",
      }),
    );
    await bus.publish(
      createEvent("agent.message.complete", {
        ...baseFields,
        content: "done",
        inputTokens: 10,
        outputTokens: 5,
        model: "gpt-4",
      }),
    );
    const events = collector.getRecentEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("agent.message.complete");
  });

  // ---------------------------------------------------------------------------
  // Trace summaries
  // ---------------------------------------------------------------------------

  it("produces trace summaries", async () => {
    const { collector, bus } = makeCollector();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    const summaries = collector.getTraceSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.traceId).toBe("trace-1");
    expect(summaries[0]!.agentName).toBe("test-agent");
    expect(summaries[0]!.status).toBe("running");
  });

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  it("derives conversations from traces", async () => {
    const { collector, bus } = makeCollector();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    const conversations = collector.getConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.conversationId).toBe("trace-1");
    expect(conversations[0]!.status).toBe("active");
  });

  // ---------------------------------------------------------------------------
  // Unknown agent returns undefined
  // ---------------------------------------------------------------------------

  it("returns undefined for unknown agent", () => {
    const { collector } = makeCollector();
    expect(collector.getAgentStats("nonexistent")).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Detach
  // ---------------------------------------------------------------------------

  it("stops collecting after detach", async () => {
    const { collector, bus } = makeCollector();
    collector.detach(bus);
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    expect(collector.getDashboardStats().agents).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // getToolAnalytics — date filters
  // ---------------------------------------------------------------------------

  describe("getToolAnalytics date filters", () => {
    async function seedThreeToolCalls(collector: InMemoryEventCollector, bus: AgentEventBus) {
      // Register the agent via message.start so tool.end has a trace context.
      await bus.publish(
        createEvent("agent.message.start", { ...baseFields, agentName: "agent-1" }),
      );
      const at = (iso: string) => new Date(iso);
      for (const [ts, durationMs] of [
        ["2026-01-01T00:00:00Z", 10],
        ["2026-02-01T00:00:00Z", 20],
        ["2026-03-01T00:00:00Z", 30],
      ] as const) {
        const event = {
          ...createEvent("agent.tool.end", {
            ...baseFields,
            toolCallId: `tc-${ts}`,
            toolName: "read_file",
            arguments: {},
            result: "ok",
            durationMs,
            resultTokens: 0,
          }),
          timestamp: at(ts),
        };
        await bus.publish(event);
      }
      // Silence unused variable warning
      void collector;
    }

    it("returns all calls when no filters provided", async () => {
      const { collector, bus } = makeCollector();
      await seedThreeToolCalls(collector, bus);
      const [tool] = collector.getToolAnalytics();
      expect(tool?.totalCalls).toBe(3);
    });

    it("filters out calls before `from`", async () => {
      const { collector, bus } = makeCollector();
      await seedThreeToolCalls(collector, bus);
      const [tool] = collector.getToolAnalytics({ from: new Date("2026-01-15T00:00:00Z") });
      expect(tool?.totalCalls).toBe(2);
    });

    it("filters out calls after `to`", async () => {
      const { collector, bus } = makeCollector();
      await seedThreeToolCalls(collector, bus);
      const [tool] = collector.getToolAnalytics({ to: new Date("2026-02-15T00:00:00Z") });
      expect(tool?.totalCalls).toBe(2);
    });

    it("applies both `from` and `to` bounds", async () => {
      const { collector, bus } = makeCollector();
      await seedThreeToolCalls(collector, bus);
      const [tool] = collector.getToolAnalytics({
        from: new Date("2026-01-15T00:00:00Z"),
        to: new Date("2026-02-15T00:00:00Z"),
      });
      expect(tool?.totalCalls).toBe(1);
      expect(tool?.totalDurationMs).toBe(20);
    });
  });
});
