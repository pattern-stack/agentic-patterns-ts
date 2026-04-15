/**
 * Live demo — runs a math agent through ClaudeCodeRunner with full
 * console observability. Shows every event in real time.
 *
 * Usage: npx tsx examples/live-demo.ts
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
} from "@pattern-stack/agent-core";
import { AgentEventBus, ClaudeCodeRunner, ConsoleExporter } from "@pattern-stack/agent-runtime";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Console logger that writes to stdout
// ---------------------------------------------------------------------------

const logger = {
  log: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(`\x1b[31m${msg}\x1b[0m`),
  write: (text: string) => process.stdout.write(text),
};

// ---------------------------------------------------------------------------
// Math toolbox
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
// Build agent
// ---------------------------------------------------------------------------

const persona = new Persona({
  identity: "A helpful math assistant",
  tone: "precise and concise",
  priorities: ["accuracy", "clarity"],
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
  .withDefaultModel("haiku")
  .build();

const mission = new Mission({
  objective: "Help users with math calculations using the provided tools",
  success_criteria: ["Correct answers", "Tools used appropriately"],
});

const agent = new AgentBuilder(role).withMission(mission).build();

// ---------------------------------------------------------------------------
// Set up observability
// ---------------------------------------------------------------------------

const eventBus = new AgentEventBus();

// Console exporter — prints all UX events
const exporter = new ConsoleExporter({ verbose: true, logger });
exporter.attach(eventBus);

// Also subscribe to raw events for a full trace
eventBus.subscribe("agent.tool.intent", (event) => {
  const e = event as { toolName: string; arguments: Record<string, unknown> };
  logger.log(`\x1b[33m  [intent] ${e.toolName}(${JSON.stringify(e.arguments)})\x1b[0m`);
});

eventBus.subscribe("agent.tool.rejected", (event) => {
  const e = event as { toolName: string; reason: string };
  logger.log(`\x1b[31m  [BLOCKED] ${e.toolName}: ${e.reason}\x1b[0m`);
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("  agentic-patterns-ts — Live Demo");
  console.log("  Agent: math-assistant | Runner: ClaudeCodeRunner");
  console.log("=".repeat(60));

  const runner = new ClaudeCodeRunner({
    eventBus,
    defaults: { tools: [] }, // Only MCP tools from capabilities
  });

  const prompt =
    "First add 17 and 28 using the add tool, then multiply that result by 3 using the multiply tool. Show your work.";

  console.log(`\n\x1b[36mUser:\x1b[0m ${prompt}\n`);

  const result = await runner.run(agent, prompt, {
    eventBus,
    maxIterations: 10,
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Result Summary");
  console.log("=".repeat(60));
  console.log(`  Response:    ${result.response.slice(0, 200)}`);
  console.log(`  Tool calls:  ${result.toolCallsCount}`);
  console.log(`  Tokens:      ${result.inputTokens} in / ${result.outputTokens} out`);
  console.log(`  Finish:      ${result.finishReason}`);
  console.log("=".repeat(60));

  exporter.detach(eventBus);
}

main().catch(console.error);
