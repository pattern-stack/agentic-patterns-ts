/**
 * End-to-end live demo of the admin observability stack.
 *
 * Wires up:
 *   ClaudeCodeAPIRunner → AgentEventBus → InMemoryEventCollector
 *                                        ↘
 *                                         SSEExporter (→ admin /events/stream)
 *   Hono server (routes: /health, /agents, /conversations, /admin/*)
 *
 * Run:
 *   pnpm --filter @agentic-patterns/server demo
 *
 * Requires the `claude` CLI installed and logged in (or ANTHROPIC_API_KEY
 * exported) — ClaudeCodeAPIRunner uses the Claude Agent SDK under the
 * hood but blocks Code-native tools so the agent behaves like a plain
 * Claude API call augmented with our framework tools.
 *
 * Once the server is running on :3000 start the dashboard separately:
 *   pnpm --filter @agentic-patterns/dashboard dev
 * Vite dev proxies /admin, /agents, /conversations, /health to :3000.
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
} from "@agentic-patterns/core";
import {
  AgentEventBus,
  ClaudeCodeAPIRunner,
  InMemoryAdminService,
  InMemoryEventCollector,
  SSEExporter,
} from "@agentic-patterns/runtime";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { createServer } from "../src/app.js";
import type { AgentRegistration, ServerConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Math toolbox — the agent can add and multiply numbers
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

function buildMathAgent() {
  const role = new RoleBuilder("math-assistant")
    .withPersona(
      new Persona({
        identity: "A precise math assistant",
        tone: "concise",
        priorities: ["accuracy"],
        principles: ["always use the provided tools"],
      }),
    )
    .withJudgment(
      new Judgment({
        domain: "mathematics",
        heuristics: ["Use the provided tools for all calculations"],
        constraints: ["Only answer math questions"],
      }),
    )
    .withCapability(new Capability("math_operations", "Arithmetic", new MathToolbox()))
    .withResponsibility(
      new Responsibility({
        key: "calculate",
        name: "Perform Calculations",
        description: "Use math tools to answer user questions about numbers.",
      }),
    )
    .withDefaultModel("sonnet")
    .build();

  const mission = new Mission({
    objective: "Help users with math calculations using the provided tools",
    success_criteria: ["Correct answers", "Tools used appropriately"],
  });

  return new AgentBuilder(role).withMission(mission).build();
}

// ---------------------------------------------------------------------------
// Wire the observability stack
// ---------------------------------------------------------------------------

const eventBus = new AgentEventBus();

const collector = new InMemoryEventCollector();
collector.attach(eventBus);

const adminService = new InMemoryAdminService(collector);

const sseExporter = new SSEExporter();
sseExporter.attach(eventBus);

const runner = new ClaudeCodeAPIRunner({
  eventBus,
  defaults: { tools: [] },
});

const mathAgent = buildMathAgent();

const registration: AgentRegistration = {
  id: "math",
  name: "Math Assistant",
  description: "Adds and multiplies numbers using framework tools",
  agent: mathAgent,
  runner,
};

const config: ServerConfig = {
  agents: [registration],
  adminService,
  eventBus,
  sseExporter,
};

const app = createServer(config);

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`\nagentic-patterns server running on http://localhost:${info.port}`);
  console.log("\nTry:");
  console.log(`  curl http://localhost:${info.port}/agents`);
  console.log(`  curl http://localhost:${info.port}/admin/dashboard`);
  console.log("\nStart a conversation:");
  console.log(`  curl -X POST http://localhost:${info.port}/conversations \\`);
  console.log(`    -H 'Content-Type: application/json' \\`);
  console.log(`    -d '{"agent_id":"math"}'`);
  console.log("\nStream a message (use conversation id from above):");
  console.log(`  curl -N -X POST http://localhost:${info.port}/conversations/<id>/messages \\`);
  console.log(`    -H 'Content-Type: application/json' \\`);
  console.log(`    -d '{"content":"What is 17 + 28?"}'`);
  console.log("\nAdmin SSE stream:");
  console.log(`  curl -N http://localhost:${info.port}/admin/events/stream`);
  console.log("\nOr run the dashboard in another terminal:");
  console.log("  pnpm --filter @agentic-patterns/dashboard dev");
});
