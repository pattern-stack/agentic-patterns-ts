import { beforeEach, describe, expect, it } from "vitest";
import { InProcessTransport } from "../../transport/in-process.js";
import { SandboxEventBus } from "../sandbox-event-bus.js";
import type { AgentAddress, AgentBroadcastEvent, AgentMessageEvent } from "../sandbox-types.js";
import type { BaseEvent } from "../types.js";

describe("SandboxEventBus", () => {
  let transport: InProcessTransport;
  let address: AgentAddress;
  let bus: SandboxEventBus;

  beforeEach(async () => {
    transport = new InProcessTransport();
    address = { deviceId: "local", instanceId: "run-1", agentId: "agent-1", role: "worker" };
    bus = new SandboxEventBus(address, transport);
    await bus.start();
  });

  it("publishes sandbox events both locally and to transport", async () => {
    const localEvents: BaseEvent[] = [];
    const transportEvents: Uint8Array[] = [];

    bus.subscribe("sandbox.agent.message", (event) => {
      localEvents.push(event);
    });

    // Subscribe to transport directly to verify dual publish
    await transport.subscribe("agency.test.run.run-1.agent.target-1", (msg) => {
      transportEvents.push(msg.data);
    });

    const event: AgentMessageEvent = {
      type: "sandbox.agent.message",
      traceId: "",
      runId: "",
      spanId: "test-span",
      timestamp: new Date(),
      origin: address,
      target: { deviceId: "local", instanceId: "run-1", agentId: "target-1", role: "target" },
      agencyId: "test",
      lineupRunId: "run-1",
      content: "hello",
      metadata: {},
    };

    await bus.publish(event);

    expect(localEvents).toHaveLength(1);
    expect(transportEvents).toHaveLength(1);
  });

  it("non-sandbox events only dispatch locally", async () => {
    const localEvents: BaseEvent[] = [];

    bus.subscribe("agent.message.start", (event) => {
      localEvents.push(event);
    });

    const event: BaseEvent = {
      type: "agent.message.start",
      traceId: "",
      runId: "",
      spanId: "test",
      timestamp: new Date(),
    };

    await bus.publish(event);

    expect(localEvents).toHaveLength(1);
  });

  it("resolves broadcast subject correctly", async () => {
    const transportSubjects: string[] = [];

    // Use a broad wildcard to capture what's published
    await transport.subscribe("agency.>", (msg) => {
      transportSubjects.push(msg.subject);
    });

    const event: AgentBroadcastEvent = {
      type: "sandbox.agent.broadcast",
      traceId: "",
      runId: "",
      spanId: "test",
      timestamp: new Date(),
      origin: address,
      agencyId: "crm",
      lineupRunId: "run-1",
      content: "team update",
      channel: "",
    };

    await bus.publish(event);

    expect(transportSubjects).toContain("agency.crm._broadcast");
  });

  it("resolves targeted subject correctly", async () => {
    const transportSubjects: string[] = [];

    await transport.subscribe("agency.>", (msg) => {
      transportSubjects.push(msg.subject);
    });

    const event: AgentMessageEvent = {
      type: "sandbox.agent.message",
      traceId: "",
      runId: "",
      spanId: "test",
      timestamp: new Date(),
      origin: address,
      target: { deviceId: "", instanceId: "", agentId: "bob", role: "analyst" },
      agencyId: "crm",
      lineupRunId: "run-42",
      content: "analyze this",
      metadata: {},
    };

    await bus.publish(event);

    expect(transportSubjects).toContain("agency.crm.run.run-42.agent.bob");
  });

  it("stop closes transport", async () => {
    expect(transport.connected).toBe(true);
    await bus.stop();
    expect(transport.connected).toBe(false);
  });

  it("exposes address property", () => {
    expect(bus.address.agentId).toBe("agent-1");
    expect(bus.address.role).toBe("worker");
  });
});
