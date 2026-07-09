declare function setTimeout(callback: () => void, ms: number): number;

import { Agency } from "@agentic-patterns/core";
import { describe, expect, it } from "vitest";
import type { RunResult, RunnerProtocol } from "../../runner/types.js";
import { AgencyRuntime } from "../agency-runtime.js";
import { BATCH_WINDOW } from "../agent-node.js";

// ---------------------------------------------------------------------------
// Mock runner that records calls and optionally uses send_message tool
// ---------------------------------------------------------------------------

interface MockCall {
  agentName: string;
  message: string;
}

function createMockRunner(options?: {
  responses?: Record<string, string>;
  defaultResponse?: string;
}): RunnerProtocol & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  const responses = options?.responses ?? {};
  const defaultResponse = options?.defaultResponse ?? "acknowledged";

  return {
    calls,
    run: async (agent, message, _options) => {
      const agentName = agent.role.name;
      calls.push({ agentName, message });
      const response = responses[agentName] ?? defaultResponse;
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
// Tests
// ---------------------------------------------------------------------------

describe("AgencyRuntime", () => {
  function createTestAgency() {
    return new Agency({
      name: "test-agency",
      description: "Test agency for unit tests",
      agents: [
        { role: "coordinator", isCoordinator: true, model: "test-model" },
        { role: "worker", isCoordinator: false, model: "test-model" },
      ],
    });
  }

  it("creates correct number of nodes from agency", async () => {
    const agency = createTestAgency();
    const runner = createMockRunner();
    const runtime = new AgencyRuntime(agency, runner, "test-run-id");

    await runtime.start();

    const nodes = runtime.nodes;
    expect(Object.keys(nodes)).toHaveLength(2);
    expect(nodes.coordinator).toBeDefined();
    expect(nodes.worker).toBeDefined();

    await runtime.stop();
  });

  it("inject routes to correct node", async () => {
    const agency = createTestAgency();
    const runner = createMockRunner();
    const runtime = new AgencyRuntime(agency, runner);

    await runtime.start();
    await runtime.inject("worker", "do work");

    // Wait for message processing
    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 100));

    const workerNode = runtime.nodes.worker;
    expect(workerNode).toBeDefined();
    expect(workerNode!.turnsTaken).toBe(1);

    await runtime.stop();
  });

  it("injectCoordinator routes to coordinator", async () => {
    const agency = createTestAgency();
    const runner = createMockRunner();
    const runtime = new AgencyRuntime(agency, runner);

    await runtime.start();
    await runtime.injectCoordinator("start processing");

    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 100));

    const coordNode = runtime.nodes.coordinator;
    expect(coordNode).toBeDefined();
    expect(coordNode!.turnsTaken).toBe(1);

    await runtime.stop();
  });

  it("inject throws for unknown role", async () => {
    const agency = createTestAgency();
    const runner = createMockRunner();
    const runtime = new AgencyRuntime(agency, runner);

    await runtime.start();

    await expect(runtime.inject("nonexistent", "hi")).rejects.toThrow(
      "No agent with role 'nonexistent'",
    );

    await runtime.stop();
  });

  it("coordinatorAddress returns coordinator address", async () => {
    const agency = createTestAgency();
    const runner = createMockRunner();
    const runtime = new AgencyRuntime(agency, runner);

    await runtime.start();

    const addr = runtime.coordinatorAddress;
    expect(addr).toBeDefined();
    expect(addr!.role).toBe("coordinator");
    expect(addr!.agentId).toBe("coordinator");

    await runtime.stop();
  });

  it("status returns running/stopped for each node", async () => {
    const agency = createTestAgency();
    const runner = createMockRunner();
    const runtime = new AgencyRuntime(agency, runner);

    await runtime.start();

    const status = runtime.status();
    expect(status.coordinator).toBe("running");
    expect(status.worker).toBe("running");

    await runtime.stop();

    const stoppedStatus = runtime.status();
    expect(stoppedStatus.coordinator).toBe("stopped");
    expect(stoppedStatus.worker).toBe("stopped");
  });

  it("runId is preserved", () => {
    const agency = createTestAgency();
    const runner = createMockRunner();
    const runtime = new AgencyRuntime(agency, runner, "custom-run-id");

    expect(runtime.runId).toBe("custom-run-id");
  });

  it("stop is idempotent", async () => {
    const agency = createTestAgency();
    const runner = createMockRunner();
    const runtime = new AgencyRuntime(agency, runner);

    await runtime.start();
    await runtime.stop();
    // Should not throw on second stop
    await runtime.stop();
  });

  it("start is idempotent", async () => {
    const agency = createTestAgency();
    const runner = createMockRunner();
    const runtime = new AgencyRuntime(agency, runner);

    await runtime.start();
    // Should not throw or create duplicate nodes
    await runtime.start();

    expect(Object.keys(runtime.nodes)).toHaveLength(2);

    await runtime.stop();
  });

  it("integration: 2-agent agency with mock runner", async () => {
    const agency = createTestAgency();
    const runner = createMockRunner({
      responses: {
        coordinator: "delegating to worker",
        worker: "work completed",
      },
    });

    const runtime = new AgencyRuntime(agency, runner);
    await runtime.start();

    // Inject to coordinator
    await runtime.injectCoordinator("Process lead: Acme Corp");

    // Wait for processing
    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 200));

    // Coordinator should have received and processed the message
    expect(runner.calls.length).toBeGreaterThanOrEqual(1);
    expect(runner.calls[0]!.agentName).toBe("coordinator");
    expect(runner.calls[0]!.message).toContain("Process lead: Acme Corp");

    await runtime.stop();
  });
});
