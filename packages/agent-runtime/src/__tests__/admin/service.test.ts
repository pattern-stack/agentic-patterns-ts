import { describe, expect, it } from "vitest";
import { InMemoryEventCollector } from "../../admin/collector.js";
import { InMemoryAdminService } from "../../admin/service.js";
import type { AdminServiceProtocol } from "../../admin/service.js";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import { createEvent } from "../../events/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseFields = {
  traceId: "trace-1",
  runId: "run-1",
} as const;

function makeService(): {
  service: AdminServiceProtocol;
  collector: InMemoryEventCollector;
  bus: AgentEventBus;
} {
  const bus = new AgentEventBus();
  const collector = new InMemoryEventCollector();
  collector.attach(bus);
  const service = new InMemoryAdminService(collector);
  return { service, collector, bus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InMemoryAdminService", () => {
  it("implements AdminServiceProtocol", () => {
    const { service } = makeService();
    expect(service.getDashboardStats).toBeDefined();
    expect(service.getAgentStats).toBeDefined();
    expect(service.getAllAgentStats).toBeDefined();
    expect(service.getRecentEvents).toBeDefined();
    expect(service.getTraceSummaries).toBeDefined();
    expect(service.getConversations).toBeDefined();
  });

  it("returns dashboard stats via async", async () => {
    const { service } = makeService();
    const stats = await service.getDashboardStats();
    expect(stats.agents).toHaveLength(0);
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("delegates getAgentStats to collector", async () => {
    const { service, bus } = makeService();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    const agent = await service.getAgentStats("test-agent");
    expect(agent).toBeDefined();
    expect(agent!.agentName).toBe("test-agent");
  });

  it("returns undefined for unknown agent", async () => {
    const { service } = makeService();
    const agent = await service.getAgentStats("nonexistent");
    expect(agent).toBeUndefined();
  });

  it("delegates getAllAgentStats", async () => {
    const { service, bus } = makeService();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "agent-1",
      }),
    );
    const agents = await service.getAllAgentStats();
    expect(agents).toHaveLength(1);
  });

  it("delegates getRecentEvents", async () => {
    const { service, bus } = makeService();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    const events = await service.getRecentEvents();
    expect(events.length).toBeGreaterThan(0);
  });

  it("delegates getRecentEvents with limit", async () => {
    const { service, bus } = makeService();
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
    const events = await service.getRecentEvents(1);
    expect(events).toHaveLength(1);
  });

  it("delegates getTraceSummaries", async () => {
    const { service, bus } = makeService();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    const summaries = await service.getTraceSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.traceId).toBe("trace-1");
  });

  it("delegates getConversations", async () => {
    const { service, bus } = makeService();
    await bus.publish(
      createEvent("agent.message.start", {
        ...baseFields,
        agentName: "test-agent",
      }),
    );
    const conversations = await service.getConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.conversationId).toBe("trace-1");
  });
});
