import { describe, expect, it } from "vitest";
import {
  agentAddressToString,
  createAgentAddress,
  deserializeSandboxEventFromString,
  serializeSandboxEventToString,
} from "../sandbox-types.js";
import type {
  AgentMessageEvent,
  HealthPongEvent,
  SandboxEvent,
  TaskAssignEvent,
} from "../sandbox-types.js";

describe("Sandbox Event Types", () => {
  const origin = createAgentAddress({
    deviceId: "dev-1",
    instanceId: "inst-1",
    agentId: "agent-1",
    role: "worker",
  });

  describe("AgentAddress", () => {
    it("creates with defaults", () => {
      const addr = createAgentAddress();
      expect(addr.deviceId).toBe("");
      expect(addr.instanceId).toBe("");
      expect(addr.agentId).toBe("");
      expect(addr.role).toBe("");
    });

    it("creates with partial values", () => {
      expect(origin.deviceId).toBe("dev-1");
      expect(origin.role).toBe("worker");
    });

    it("formats toString correctly", () => {
      const str = agentAddressToString(origin);
      expect(str).toBe("worker@dev-1/inst-1/agent-1");
    });
  });

  describe("Serialization round-trip", () => {
    it("serializes and deserializes AgentMessageEvent", () => {
      const event: AgentMessageEvent = {
        type: "sandbox.agent.message",
        traceId: "trace-1",
        runId: "run-1",
        spanId: "span-1",
        timestamp: new Date("2024-01-01T00:00:00Z"),
        origin,
        agencyId: "agency-1",
        lineupRunId: "lineup-1",
        content: "Hello world",
        metadata: { key: "value" },
      };

      const json = serializeSandboxEventToString(event);
      const deserialized = deserializeSandboxEventFromString(json);

      expect(deserialized.type).toBe("sandbox.agent.message");
      expect(deserialized.origin.deviceId).toBe("dev-1");
      expect(deserialized.agencyId).toBe("agency-1");
      if (deserialized.type === "sandbox.agent.message") {
        expect(deserialized.content).toBe("Hello world");
        expect(deserialized.metadata).toEqual({ key: "value" });
      }
    });

    it("serializes and deserializes HealthPongEvent", () => {
      const event: HealthPongEvent = {
        type: "sandbox.health.pong",
        traceId: "trace-1",
        runId: "run-1",
        spanId: "span-1",
        timestamp: new Date("2024-01-01T00:00:00Z"),
        origin,
        agencyId: "agency-1",
        lineupRunId: "lineup-1",
        status: "healthy",
        uptimeSeconds: 3600,
      };

      const json = serializeSandboxEventToString(event);
      const deserialized = deserializeSandboxEventFromString(json);

      expect(deserialized.type).toBe("sandbox.health.pong");
      if (deserialized.type === "sandbox.health.pong") {
        expect(deserialized.status).toBe("healthy");
        expect(deserialized.uptimeSeconds).toBe(3600);
      }
    });

    it("serializes and deserializes TaskAssignEvent", () => {
      const assignee = createAgentAddress({
        deviceId: "dev-2",
        agentId: "agent-2",
        role: "reviewer",
      });

      const event: TaskAssignEvent = {
        type: "sandbox.task.assign",
        traceId: "trace-1",
        runId: "run-1",
        spanId: "span-1",
        timestamp: new Date("2024-01-01T00:00:00Z"),
        origin,
        agencyId: "agency-1",
        lineupRunId: "lineup-1",
        taskId: "task-1",
        assignee,
      };

      const json = serializeSandboxEventToString(event);
      const deserialized = deserializeSandboxEventFromString(json);

      expect(deserialized.type).toBe("sandbox.task.assign");
      if (deserialized.type === "sandbox.task.assign") {
        expect(deserialized.assignee.role).toBe("reviewer");
      }
    });

    it("handles targeted events with target address", () => {
      const target = createAgentAddress({
        deviceId: "dev-2",
        agentId: "agent-2",
        role: "manager",
      });

      const event: AgentMessageEvent = {
        type: "sandbox.agent.message",
        traceId: "trace-1",
        runId: "run-1",
        spanId: "span-1",
        timestamp: new Date("2024-01-01T00:00:00Z"),
        origin,
        target,
        agencyId: "agency-1",
        lineupRunId: "lineup-1",
        content: "targeted message",
        metadata: {},
      };

      const json = serializeSandboxEventToString(event);
      const deserialized = deserializeSandboxEventFromString(json);

      expect(deserialized.target).toBeDefined();
      expect(deserialized.target?.role).toBe("manager");
    });

    it("handles broadcasts without target", () => {
      const event: SandboxEvent = {
        type: "sandbox.agent.broadcast",
        traceId: "trace-1",
        runId: "run-1",
        spanId: "span-1",
        timestamp: new Date("2024-01-01T00:00:00Z"),
        origin,
        agencyId: "agency-1",
        lineupRunId: "lineup-1",
        content: "broadcast",
        channel: "general",
      };

      const json = serializeSandboxEventToString(event);
      const deserialized = deserializeSandboxEventFromString(json);

      expect(deserialized.target).toBeUndefined();
    });

    it("narrows discriminated union on type field", () => {
      const event: SandboxEvent = {
        type: "sandbox.agent.join",
        traceId: "t",
        runId: "r",
        spanId: "s",
        timestamp: new Date(),
        origin,
        agencyId: "a",
        lineupRunId: "l",
        reason: "startup",
      };

      switch (event.type) {
        case "sandbox.agent.join":
          expect(event.reason).toBe("startup");
          break;
        default:
          expect.unreachable("Should have matched sandbox.agent.join");
      }
    });
  });
});
