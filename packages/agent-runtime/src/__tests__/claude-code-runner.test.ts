/**
 * Integration test: Build an agent from framework primitives and run it
 * via the ClaudeCodeRunner (Claude Agent SDK).
 *
 * Tests the full stack:
 *   atoms → molecules → organisms → ClaudeCodeRunner → Claude Agent SDK
 *
 * Requires: Claude Code CLI installed + ANTHROPIC_API_KEY (or OAuth)
 * Skip: Set CI=true or SKIP_SDK_TESTS=true to skip
 */

import {
  AgentBuilder,
  Capability,
  Judgment,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
  type ToolDefinition,
  Toolbox,
} from "@pattern-stack/agentic-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentEventBus } from "../events/agent-event-bus.js";
import type { AgentEvent } from "../events/types.js";
import { ClaudeCodeAPIRunner } from "../runner/claude-code-api-runner.js";
import { ClaudeCodeRunner } from "../runner/claude-code-runner.js";

// ---------------------------------------------------------------------------
// Skip if no SDK / CI environment
// ---------------------------------------------------------------------------

const shouldSkip = process.env.CI === "true" || process.env.SKIP_SDK_TESTS === "true";

// ---------------------------------------------------------------------------
// Math toolbox for testing
// ---------------------------------------------------------------------------

class MathToolbox extends Toolbox {
  readonly name = "math_operations";
  readonly description = "Basic math operations";

  readonly tools: Record<string, ToolDefinition> = {
    add: {
      description: "Add two numbers together",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return { result: a + b };
      },
    },
    multiply: {
      description: "Multiply two numbers together",
      parameters: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return { result: a * b };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Build agent from framework primitives
// ---------------------------------------------------------------------------

function buildMathAgent() {
  const persona = new Persona({
    identity: "A helpful math assistant",
    tone: "precise and concise",
    priorities: ["accuracy", "clarity"],
    principles: ["always show your work"],
  });

  const judgment = new Judgment({
    domain: "mathematics",
    heuristics: ["Use the provided tools for all calculations"],
    constraints: ["Only perform math operations when asked"],
  });

  const mathCapability = new Capability(
    "math_operations",
    "Basic math operations for arithmetic",
    new MathToolbox(),
  );

  const responsibility = new Responsibility({
    key: "calculate",
    name: "Perform Calculations",
    description: "Use math tools to answer questions about numbers",
  });

  const role = new RoleBuilder("math-assistant")
    .withPersona(persona)
    .withJudgment(judgment)
    .withCapability(mathCapability)
    .withResponsibility(responsibility)
    .withDefaultModel("sonnet")
    .build();

  const mission = new Mission({
    objective: "Help users with math calculations using the provided tools",
    successCriteria: ["Correct answers", "Tools used appropriately"],
  });

  return new AgentBuilder(role).withMission(mission).build();
}

/**
 * A TOOL-LESS agent for the structured-output smoke (#547, spec §12): no
 * Capability, so `_buildOptions` wires no MCP servers and `allowedTools` stays
 * empty — the only tool the CLI can end the turn on is its own force-appended
 * `StructuredOutput` carrier.
 */
function buildToolLessAgent() {
  const persona = new Persona({
    identity: "A concise arithmetic assistant",
    tone: "precise",
    priorities: ["accuracy"],
    principles: ["answer directly"],
  });
  const role = new RoleBuilder("arithmetic-assistant")
    .withPersona(persona)
    .withDefaultModel("sonnet")
    .build();
  const mission = new Mission({
    objective: "Answer arithmetic questions",
    successCriteria: ["Correct answers"],
  });
  return new AgentBuilder(role).withMission(mission).build();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkip)("ClaudeCodeRunner integration", () => {
  it(
    "builds an agent from framework primitives and runs via Claude Agent SDK",
    async () => {
      const agent = buildMathAgent();

      // Verify agent was built correctly from primitives
      expect(agent.role.name).toBe("math-assistant");
      expect(agent.getModel()).toBe("sonnet");
      expect(agent.getTools().map((t) => t.name)).toEqual(["add", "multiply"]);
      expect(agent.renderInitialPrompt().length).toBeGreaterThan(100);

      // Set up event bus to capture events
      const events: AgentEvent[] = [];
      const eventBus = new AgentEventBus();
      const capture = (event: unknown) => {
        events.push(event as AgentEvent);
      };
      eventBus.subscribe("agent.message.start", capture);
      eventBus.subscribe("agent.message.complete", capture);
      eventBus.subscribe("agent.error", capture);

      const runner = new ClaudeCodeRunner({
        eventBus,
        defaults: {
          tools: [], // Only MCP tools from our capability
        },
      });

      const result = await runner.run(agent, "What is 17 + 28? Use the add tool.", {
        eventBus,
        maxIterations: 5,
      });

      // Verify result
      expect(result.response).toBeTruthy();
      expect(result.response).toMatch(/45/); // 17 + 28 = 45
      expect(result.finishReason).toBe("stop");

      // Verify events were emitted
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("agent.message.start");
      expect(eventTypes).toContain("agent.message.complete");

      console.log("\n✅ ClaudeCodeRunner integration test passed!");
      console.log(`   Response: ${result.response.slice(0, 100)}...`);
      console.log(`   Tool calls: ${result.toolCallsCount}`);
      console.log(`   Tokens: ${result.inputTokens} in / ${result.outputTokens} out`);
    },
    { timeout: 120_000 },
  );

  it(
    "multi-step tool use: add then multiply",
    async () => {
      const agent = buildMathAgent();
      const eventBus = new AgentEventBus();

      const runner = new ClaudeCodeRunner({
        eventBus,
        defaults: { tools: [] },
      });

      const result = await runner.run(
        agent,
        "First add 10 and 20 using the add tool, then multiply that result by 3 using the multiply tool. Report the final answer.",
        { eventBus, maxIterations: 10 },
      );

      expect(result.response).toBeTruthy();
      expect(result.response).toMatch(/90/); // (10+20) * 3 = 90
      expect(result.toolCallsCount).toBeGreaterThanOrEqual(2);

      console.log("\n✅ Multi-step tool use test passed!");
      console.log(`   Response: ${result.response.slice(0, 100)}...`);
      console.log(`   Tool calls: ${result.toolCallsCount}`);
    },
    { timeout: 120_000 },
  );

  it(
    "runStructured on ClaudeCodeAPIRunner (tools: []) — proves the CLI's force-include of the StructuredOutput carrier end to end (#547)",
    async () => {
      const agent = buildToolLessAgent();
      expect(agent.getTools()).toHaveLength(0);
      const eventBus = new AgentEventBus();
      const events: AgentEvent[] = [];
      eventBus.subscribeAll((e) => events.push(e as AgentEvent));

      // API runner preset: tools: [] — and a tool-less agent, so no MCP
      // servers are wired either. If the SDK's tool-list resolution hid the
      // carrier there would be nothing on the wire to produce
      // structured_output at all; a structured result here proves the CLI
      // force-appends the carrier after `tools` resolution.
      // `disableSandbox` keeps host config mode (like its sibling tests
      // above) — this test isn't exercising OAuth isolation, and it would
      // otherwise fail on a missing token instead of exercising the carrier.
      const runner = new ClaudeCodeAPIRunner({ eventBus, disableSandbox: true });

      const schema = z.object({ answer: z.number(), reasoning: z.string() });
      const result = await runner.runStructured(
        agent,
        "What is 17 + 28? Answer with the number and a one-sentence reasoning.",
        schema,
        { eventBus, maxIterations: 5 },
      );

      expect(typeof result.object.answer).toBe("number");
      expect(result.response).toBe(JSON.stringify(result.object));

      // The carrier must never appear as an agent.tool.* event name.
      const toolEventNames = events
        .filter((e) => e.type.startsWith("agent.tool."))
        .map((e) => (e as { toolName?: string }).toolName);
      expect(toolEventNames).not.toContain("StructuredOutput");
    },
    { timeout: 120_000 },
  );
});

describe("ClaudeCodeRunner unit (no SDK)", () => {
  it("agent built from framework primitives has correct shape", () => {
    const agent = buildMathAgent();

    expect(agent.role.name).toBe("math-assistant");
    expect(agent.getModel()).toBe("sonnet");
    expect(agent.getTools()).toHaveLength(2);
    expect(agent.getTools()[0]!.name).toBe("add");
    expect(agent.getTools()[1]!.name).toBe("multiply");

    // System prompt includes all primitives (judgment domain renders
    // Title-Cased under ## Methodology in the section-composed prompt)
    const prompt = agent.renderInitialPrompt();
    expect(prompt).toContain("math assistant");
    expect(prompt).toContain("### Mathematics");
    expect(prompt).toContain("Use the provided tools for all calculations");
    expect(prompt).toContain("Perform Calculations");
  });

  it("SDK bridge converts capabilities to MCP server configs", async () => {
    const { buildAgentServers } = await import("../runner/sdk-bridge.js");
    const agent = buildMathAgent();

    const { mcpServers, allowedTools } = buildAgentServers(agent);

    expect(Object.keys(mcpServers)).toEqual(["math_operations"]);
    expect(allowedTools).toEqual(["mcp__math_operations__add", "mcp__math_operations__multiply"]);
  });
});
