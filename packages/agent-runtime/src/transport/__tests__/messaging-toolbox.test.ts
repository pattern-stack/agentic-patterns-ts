import { beforeEach, describe, expect, it } from "vitest";
import { SandboxEventBus } from "../../events/sandbox-event-bus.js";
import type {
  AgentAddress,
  AgentBroadcastEvent,
  AgentMessageEvent,
} from "../../events/sandbox-types.js";
import type { BaseEvent } from "../../events/types.js";
import { InProcessTransport } from "../in-process.js";
import { MessagingToolbox } from "../messaging-toolbox.js";

describe("MessagingToolbox", () => {
  let bus: SandboxEventBus;
  let transport: InProcessTransport;
  let toolbox: MessagingToolbox;
  let address: AgentAddress;
  let roster: Record<string, AgentAddress>;

  beforeEach(async () => {
    transport = new InProcessTransport();
    address = { deviceId: "local", instanceId: "run-1", agentId: "coord", role: "coordinator" };
    roster = {
      coordinator: address,
      worker: { deviceId: "local", instanceId: "run-1", agentId: "worker", role: "worker" },
      analyst: { deviceId: "local", instanceId: "run-1", agentId: "analyst", role: "analyst" },
    };

    bus = new SandboxEventBus(address, transport);
    await bus.start();

    toolbox = new MessagingToolbox(bus, address, "test-agency", "run-1", roster);
  });

  describe("send_message", () => {
    it("sends message to valid role", async () => {
      const published: BaseEvent[] = [];
      bus.subscribe("sandbox.agent.message", (event) => {
        published.push(event);
      });

      const result = await toolbox.execute("send_message", { to: "worker", content: "do work" });

      expect(result).toBe("Message sent to worker.");
      expect(published).toHaveLength(1);
      const msg = published[0] as AgentMessageEvent;
      expect(msg.type).toBe("sandbox.agent.message");
      expect(msg.origin.agentId).toBe("coord");
      expect(msg.target?.agentId).toBe("worker");
      expect(msg.content).toBe("do work");
    });

    it("returns error for unknown role", async () => {
      const result = await toolbox.execute("send_message", { to: "unknown", content: "hi" });

      expect(result).toContain("Unknown agent 'unknown'");
      expect(result).toContain("analyst");
      expect(result).toContain("coordinator");
      expect(result).toContain("worker");
    });
  });

  describe("broadcast", () => {
    it("broadcasts message to all agents", async () => {
      const published: BaseEvent[] = [];
      bus.subscribe("sandbox.agent.broadcast", (event) => {
        published.push(event);
      });

      const result = await toolbox.execute("broadcast", { content: "team update" });

      expect(result).toBe("Message broadcast to all agents.");
      expect(published).toHaveLength(1);
      const msg = published[0] as AgentBroadcastEvent;
      expect(msg.type).toBe("sandbox.agent.broadcast");
      expect(msg.content).toBe("team update");
      expect(msg.origin.agentId).toBe("coord");
    });
  });

  describe("list_team", () => {
    it("lists all agents sorted by role", async () => {
      const result = (await toolbox.execute("list_team", {})) as Array<{
        role: string;
        agentId: string;
      }>;

      expect(result).toEqual([
        { role: "analyst", agentId: "analyst" },
        { role: "coordinator", agentId: "coord" },
        { role: "worker", agentId: "worker" },
      ]);
    });
  });

  it("exposes correct tool names", () => {
    expect(toolbox.getToolNames()).toEqual(["send_message", "broadcast", "list_team"]);
  });

  it("has correct name and description", () => {
    expect(toolbox.name).toBe("Messaging");
    expect(toolbox.description).toContain("sending messages");
  });
});
