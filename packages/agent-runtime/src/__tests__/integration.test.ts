/**
 * End-to-end integration smoke tests.
 *
 * These tests verify cross-package functionality:
 * 1. Single-agent: atoms -> organisms -> mock runner -> events -> console exporter
 * 2. Multi-agent: Agency -> AgencyRuntime -> inject -> inter-agent messaging -> response
 */

declare function setTimeout(callback: () => void, ms: number): number;

import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agency,
  AgentBuilder,
  Awareness,
  Background,
  Judgment,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
  ToolSchema,
} from "@agentic-patterns/core";

import { AgentEventBus } from "../events/agent-event-bus.js";
import type { BaseEvent } from "../events/types.js";
import { ConsoleExporter, type ConsoleLogger } from "../exporters/console.js";
import { AgentRunner } from "../runner/agent-runner.js";
import type { ToolExecutor } from "../runner/types.js";
import type { RunResult, RunnerProtocol } from "../runner/types.js";
import { AgencyRuntime } from "../runtime/agency-runtime.js";
import { BATCH_WINDOW } from "../runtime/agent-node.js";

// ---------------------------------------------------------------------------
// Helpers
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
// Test 1: Single-agent end-to-end smoke test
// ---------------------------------------------------------------------------

describe("integration: single-agent end-to-end", () => {
  it("atoms -> organisms -> runner -> events -> console exporter", async () => {
    // 1. Build atoms
    const persona = new Persona({
      identity: "a research assistant specializing in data analysis",
      tone: "professional and precise",
    });

    const mission = new Mission({
      objective: "Analyze the provided dataset and produce a summary report.",
    });

    const judgment = new Judgment({
      domain: "source-quality",
      heuristics: ["Prefer peer-reviewed sources", "Cross-reference statistics"],
    });

    const responsibility = new Responsibility({
      key: "analysis",
      name: "Analysis",
      description: "Produce accurate, well-sourced analysis",
    });

    const background = new Background({
      teamContext: { company: "Acme Research Corp" },
    });

    const awareness = new Awareness({
      domains: [
        {
          name: "statistics",
          description: "Statistical analysis domain",
          accessMethod: "direct",
        },
      ],
    });

    // 2. Build role and agent (no toolbox/manual/capability since those are abstract)
    const role = new RoleBuilder("research-assistant")
      .withPersona(persona)
      .withJudgment(judgment)
      .withResponsibility(responsibility)
      .withDefaultModel("test-model")
      .build();

    const agent = new AgentBuilder(role)
      .withBackground(background)
      .withAwareness(awareness)
      .withMission(mission)
      .withModel("test-model")
      .build();

    // Verify the agent is built correctly
    expect(agent.role.data.name).toBe("research-assistant");
    expect(agent.getModel()).toBe("test-model");

    // Verify prompt rendering
    const systemPrompt = agent.getSystemPrompt();
    expect(systemPrompt).toContain("research assistant");
    expect(systemPrompt).toContain("source-quality");

    const initialPrompt = agent.renderInitialPrompt();
    expect(initialPrompt).toContain("Analyze the provided dataset");

    // 3. Set up events + console exporter
    const bus = new AgentEventBus();
    const logger = makeMockLogger();
    const exporter = new ConsoleExporter({ verbose: true, logger });
    exporter.attach(bus);

    const collectedEvents: BaseEvent[] = [];
    bus.subscribe("agent.message.start", (e) => collectedEvents.push(e));
    bus.subscribe("agent.message.complete", (e) => collectedEvents.push(e));
    bus.subscribe("agent.tool.start", (e) => collectedEvents.push(e));
    bus.subscribe("agent.tool.end", (e) => collectedEvents.push(e));

    // 4. Run with mock model (tool call then final response)
    let callCount = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "tc-1",
                toolName: "search_docs",
                input: JSON.stringify({ query: "revenue data" }),
              },
            ],
            finishReason: "tool-calls" as const,
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
            warnings: [],
          };
        }
        return {
          content: [
            { type: "text" as const, text: "Based on the data, Q4 revenue increased by 15%." },
          ],
          finishReason: "stop" as const,
          usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180 },
          warnings: [],
        };
      },
    });

    // Register a tool so the runner knows about it
    const searchSchema = z.object({ query: z.string() });
    const searchTool = ToolSchema.fromZod("search_docs", "Search documentation", searchSchema);

    const toolExecutor: ToolExecutor = {
      execute: async (_name, args) => ({
        results: [{ title: "Q4 Report", revenue: 1500000 }],
        query: args.query,
      }),
    };

    const runner = new AgentRunner(model, bus);
    // Create an AgentLike wrapper that overrides getTools to include our tool
    const agentWithTools = {
      role: agent.role,
      getModel: () => agent.getModel(),
      getTools: () => [searchTool],
      getSystemPrompt: () => agent.getSystemPrompt(),
      renderInitialPrompt: () => agent.renderInitialPrompt(),
    };
    const result = await runner.run(agentWithTools, "Analyze Q4 revenue trends.", { toolExecutor });

    // 5. Verify full pipeline
    expect(result.response).toBe("Based on the data, Q4 revenue increased by 15%.");
    expect(result.toolCallsCount).toBe(1);
    expect(result.iterations).toBe(2);
    expect(result.inputTokens).toBe(250);
    expect(result.outputTokens).toBe(50);

    // Events flowed through the bus
    const eventTypes = collectedEvents.map((e) => e.type);
    expect(eventTypes).toContain("agent.message.start");
    expect(eventTypes).toContain("agent.message.complete");
    expect(eventTypes).toContain("agent.tool.start");
    expect(eventTypes).toContain("agent.tool.end");

    // Console exporter received events (verbose mode logs messages)
    expect(logger.messages.length).toBeGreaterThan(0);
    expect(logger.messages.some((m) => m.includes("Agent thinking"))).toBe(true);
    expect(logger.messages.some((m) => m.includes("search_docs"))).toBe(true);

    exporter.detach(bus);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Multi-agent end-to-end smoke test
// ---------------------------------------------------------------------------

describe("integration: multi-agent end-to-end", () => {
  it("Agency -> AgencyRuntime -> inject -> inter-agent messaging -> response", async () => {
    // 1. Define agency
    const agency = new Agency({
      name: "sales-team",
      description: "Sales coordination team",
      agents: [
        { role: "coordinator", isCoordinator: true, model: "test-model" },
        { role: "researcher", isCoordinator: false, model: "test-model" },
      ],
    });

    expect(agency.data.name).toBe("sales-team");
    expect(agency.data.agents).toHaveLength(2);
    expect(agency.coordinator).toBeDefined();
    expect(agency.coordinator!.role).toBe("coordinator");

    // 2. Create mock runner
    const calls: Array<{ agentName: string; message: string }> = [];
    const mockRunner: RunnerProtocol = {
      run: async (agent, message) => {
        const agentName = agent.role.name;
        calls.push({ agentName, message });
        const result: RunResult = {
          response: `${agentName} processed: ${message.slice(0, 30)}`,
          inputTokens: 10,
          outputTokens: 20,
          toolCallsCount: 0,
          iterations: 1,
          finishReason: "stop",
        };
        return result;
      },
    };

    // 3. Start runtime and inject
    const runtime = new AgencyRuntime(agency, mockRunner, "test-run");
    await runtime.start();

    expect(runtime.runId).toBe("test-run");
    const status = runtime.status();
    expect(status.coordinator).toBe("running");
    expect(status.researcher).toBe("running");

    // Inject a message to the coordinator
    await runtime.injectCoordinator("Research lead: Acme Corp");

    // Wait for message processing
    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 200));

    // Coordinator should have been called
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.agentName).toBe("coordinator");
    expect(calls[0]!.message).toContain("Research lead: Acme Corp");

    // Inject directly to researcher
    await runtime.inject("researcher", "Gather data on Acme Corp");
    await new Promise<void>((r) => setTimeout(r, BATCH_WINDOW + 200));

    const researcherCalls = calls.filter((c) => c.agentName === "researcher");
    expect(researcherCalls.length).toBeGreaterThanOrEqual(1);

    // Coordinator address is available
    const coordAddr = runtime.coordinatorAddress;
    expect(coordAddr).toBeDefined();
    expect(coordAddr!.role).toBe("coordinator");

    await runtime.stop();

    // After stop, nodes report stopped
    const stoppedStatus = runtime.status();
    expect(stoppedStatus.coordinator).toBe("stopped");
    expect(stoppedStatus.researcher).toBe("stopped");
  });
});
