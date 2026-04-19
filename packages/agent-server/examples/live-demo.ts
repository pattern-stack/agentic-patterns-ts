/**
 * Live demo — wires up 3 preset agents + observability + Hono server.
 *
 * Launch: `just dev` (or `pnpm dev`)
 * Dashboard: http://localhost:5173/chat
 */

import {
  AgentEventBus,
  InMemoryAdminService,
  InMemoryEventCollector,
  SSEExporter,
  buildCalculatorAgent,
  buildTodoAgent,
  buildWritingCoachAgent,
  createRunner,
} from "@agentic-patterns/runtime";
import { serve } from "@hono/node-server";
import { createServer } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Wire the observability stack
// ---------------------------------------------------------------------------

const eventBus = new AgentEventBus();

const collector = new InMemoryEventCollector();
collector.attach(eventBus);

const adminService = new InMemoryAdminService(collector);

const sseExporter = new SSEExporter();
sseExporter.attach(eventBus);

// Pick a runner automatically: explicit env (ANTHROPIC_API_KEY / OPENAI_API_KEY
// / OLLAMA_HOST / …) → Claude CLI → error. Set `AGENT_TIER=opus|sonnet|haiku`
// to move up/down the ladder without editing this file.
const { runner } = await createRunner({
  eventBus,
  tier: (process.env.AGENT_TIER as "opus" | "sonnet" | "haiku" | undefined) ?? "sonnet",
});

const config: ServerConfig = {
  agents: [
    {
      id: "calculator",
      name: "Calculator",
      description: "8 math operations — add, subtract, multiply, divide, power, sqrt, percentage, modulo",
      agent: buildCalculatorAgent(),
      runner,
    },
    {
      id: "todo",
      name: "Todo Manager",
      description: "Create, list, complete, update, and delete tasks (in-memory)",
      agent: buildTodoAgent(),
      runner,
    },
    {
      id: "writing-coach",
      name: "Writing Coach",
      description: "Actionable feedback on clarity, structure, and style — no tools, pure reasoning",
      agent: buildWritingCoachAgent(),
      runner,
    },
  ],
  adminService,
  eventBus,
  sseExporter,
};

const app = createServer(config);

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

const port = Number.parseInt(process.env.PORT ?? "3456", 10);

serve({ fetch: app.fetch, port }, (info) => {
  const agents = config.agents.map((a) => a.name).join(", ");
  process.stdout.write(`\n  api   http://localhost:${info.port}\n`);
  process.stdout.write(`  agents  ${agents || "(none)"}\n\n`);
});
