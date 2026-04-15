declare function setTimeout(callback: () => void, ms: number): number;

import { AgentBuilder, Mission, Persona, RoleBuilder } from "@pattern-stack/agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import { SandboxEventBus } from "../../events/sandbox-event-bus.js";
import type {
  AgentAddress,
  AgentBroadcastEvent,
  AgentMessageEvent,
} from "../../events/sandbox-types.js";
import type { RunResult, RunnerProtocol } from "../../runner/types.js";
import { InProcessTransport } from "../../transport/in-process.js";
import { MessagingToolbox } from "../../transport/messaging-toolbox.js";
import { AgentNode, BATCH_WINDOW } from "../agent-node.js";

// ---------------------------------------------------------------------------
// Mock runner
// ---------------------------------------------------------------------------

function createMockRunner(responses: string[]): RunnerProtocol {
  let callIndex = 0;
  return {
    run: async (_agent, _message, _options) => {
      const response = responses[callIndex % responses.length] ?? "default response";
      callIndex++;
      const result: RunResult = {
        response,
        inputTokens: 10,
        outputTokens: 20,
        toolCallsCount: 0,
        iterations: 1,
        finishReason: "stop",
      };
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestAgent(roleName: string) {
  const persona = new Persona({ identity: `a ${roleName} agent`, tone: "Professional" });
  const role = new RoleBuilder(roleName).withPersona(persona).build();
  const mission = new Mission({ objective: `Fulfill ${roleName} duties` });
  return new AgentBuilder(role).withMission(mission).build();
}

function createTestNode(options: {
  name: string;
  runner: RunnerProtocol;
  address: AgentAddress;
  bus: SandboxEventBus;
  roster: Record<string, AgentAddress>;
  maxTurns?: number;
  idleTimeout?: number;
  globalTimeout?: number;
}): AgentNode {
  const toolbox = new MessagingToolbox(
    options.bus,
    options.address,
    "test-agency",
    "run-1",
    options.roster,
  );

  return new AgentNode({
    name: options.name,
    agent: createTestAgent(options.name),
    bus: options.bus,
    address: options.address,
    toolbox,
    runner: options.runner,
    maxTurns: options.maxTurns ?? 5,
    idleTimeout: options.idleTimeout ?? 200,
    globalTimeout: options.globalTimeout ?? 2000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentNode", () => {
  let transport: InProcessTransport;
  let address: AgentAddress;
  let bus: SandboxEventBus;
  let roster: Record<string, AgentAddress>;

  beforeEach(async () => {
    transport = new InProcessTransport();
    address = { deviceId: "local", instanceId: "run-1", agentId: "worker", role: "worker" };
    roster = {
      worker: address,
      coordinator: {
        deviceId: "local",
        instanceId: "run-1",
        agentId: "coord",
        role: "coordinator",
      },
    };
    bus = new SandboxEventBus(address, transport);
    await bus.start();
  });

  it("starts and responds to injected message", async () => {
    const runner = createMockRunner(["I got your message"]);
    const node = createTestNode({ name: "worker", runner, address, bus, roster });

    await node.start();
    await node.inject("Hello worker");

    // Wait for worker to process
    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 100));

    expect(node.turnsTaken).toBe(1);
    expect(node.transcript).toContain("<- system: Hello worker");
    expect(node.transcript).toContain("-> worker: I got your message");

    await node.stop();
  });

  it("filters out self-echo messages", async () => {
    const runner = createMockRunner(["response"]);
    const node = createTestNode({ name: "worker", runner, address, bus, roster });

    await node.start();

    // Publish a message FROM the worker (self-echo) -- should be ignored
    const selfMsg: AgentMessageEvent = {
      type: "sandbox.agent.message",
      traceId: "",
      runId: "",
      spanId: "test",
      timestamp: new Date(),
      origin: address, // FROM self
      target: address, // TO self
      agencyId: "test-agency",
      lineupRunId: "run-1",
      content: "self echo",
      metadata: {},
    };
    await bus.publish(selfMsg);

    await new Promise<void>((r) => setTimeout(r, 300));

    // Should not have processed any messages
    expect(node.turnsTaken).toBe(0);

    await node.stop();
  });

  it("handles broadcasts from other agents", async () => {
    const runner = createMockRunner(["got broadcast"]);
    const node = createTestNode({ name: "worker", runner, address, bus, roster });

    await node.start();

    const broadcast: AgentBroadcastEvent = {
      type: "sandbox.agent.broadcast",
      traceId: "",
      runId: "",
      spanId: "test",
      timestamp: new Date(),
      origin: { deviceId: "local", instanceId: "run-1", agentId: "coord", role: "coordinator" },
      agencyId: "test-agency",
      lineupRunId: "run-1",
      content: "team meeting",
      channel: "",
    };
    await bus.publish(broadcast);

    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 100));

    expect(node.turnsTaken).toBe(1);
    expect(node.transcript).toContain("<- coordinator: team meeting");

    await node.stop();
  });

  it("exits on idle timeout", async () => {
    const runner = createMockRunner(["ok"]);
    const node = createTestNode({
      name: "worker",
      runner,
      address,
      bus,
      roster,
      idleTimeout: 100,
      globalTimeout: 200,
    });

    await node.start();
    await node.inject("first message");

    // Wait for idle timeout
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(node.turnsTaken).toBe(1);
    await node.stop();
  });

  it("exits on max turns", async () => {
    const runner = createMockRunner(["ok"]);
    const node = createTestNode({
      name: "worker",
      runner,
      address,
      bus,
      roster,
      maxTurns: 2,
      idleTimeout: 500,
    });

    await node.start();

    // Inject 3 messages but max turns is 2
    await node.inject("msg 1");
    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 50));
    await node.inject("msg 2");
    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 50));
    await node.inject("msg 3");
    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 50));

    expect(node.turnsTaken).toBeLessThanOrEqual(2);

    await node.stop();
  });

  it("formats messages correctly", async () => {
    let capturedMessage = "";
    const runner: RunnerProtocol = {
      run: async (_agent, message, _options) => {
        capturedMessage = message;
        return {
          response: "ok",
          inputTokens: 0,
          outputTokens: 0,
          toolCallsCount: 0,
          iterations: 1,
          finishReason: "stop",
        };
      },
    };

    const node = createTestNode({ name: "worker", runner, address, bus, roster });
    await node.start();

    // Send a directed message from coordinator
    const msg: AgentMessageEvent = {
      type: "sandbox.agent.message",
      traceId: "",
      runId: "",
      spanId: "test",
      timestamp: new Date(),
      origin: { deviceId: "local", instanceId: "run-1", agentId: "coord", role: "coordinator" },
      target: address,
      agencyId: "test-agency",
      lineupRunId: "run-1",
      content: "please analyze data",
      metadata: {},
    };
    await bus.publish(msg);

    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 100));

    expect(capturedMessage).toBe("[Message from coordinator]: please analyze data");

    await node.stop();
  });

  it("emits lifecycle events", async () => {
    const lifecycleTypes: string[] = [];
    bus.subscribe("sandbox.node.lifecycle", (event) => {
      const le = event as unknown as { nodeEventType: string };
      lifecycleTypes.push(le.nodeEventType);
    });

    const runner = createMockRunner(["ok"]);
    const node = createTestNode({
      name: "worker",
      runner,
      address,
      bus,
      roster,
      idleTimeout: 100,
    });

    await node.start();
    await node.inject("test");
    await new Promise<void>((r) => setTimeout(r, 500));
    await node.stop();

    expect(lifecycleTypes).toContain("node.started");
    expect(lifecycleTypes).toContain("node.message_received");
    expect(lifecycleTypes).toContain("node.response_sent");
    expect(lifecycleTypes).toContain("node.stopped");
  });
});
