/**
 * Live demo — wires up 3 preset agents + observability + Hono server.
 *
 * Launch: `just dev` (or `pnpm dev`)
 * Dashboard: http://localhost:5173/chat
 */

import {
  AgentEventBus,
  AgentRunner,
  InMemoryAdminService,
  InMemoryEventCollector,
  SSEExporter,
  buildCalculatorAgent,
  buildTodoAgent,
  buildWritingCoachAgent,
  claudeCode,
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

// Default: AgentRunner + claudeCode() provider. Drives Claude via the Agent
// SDK (Max OAuth from ~/.claude or ANTHROPIC_API_KEY) while the standard
// AgentRunner loop emits the full canonical event vocabulary —
// iteration.start/end, llm.start/end, tool.start/end, reasoning deltas.
//
// Override with `AGENT_RUNNER=auto` to fall back to env-var provider
// detection (OpenAI / Ollama / Groq / …) via `createRunner`.
const tier = (process.env.AGENT_TIER as "opus" | "sonnet" | "haiku" | undefined) ?? "sonnet";

const runner =
  process.env.AGENT_RUNNER === "auto"
    ? (await createRunner({ eventBus, tier })).runner
    : new AgentRunner(claudeCode(tier), eventBus);

const config: ServerConfig = {
  agents: [
    {
      id: "calculator",
      name: "Calculator",
      description:
        "8 math operations — add, subtract, multiply, divide, power, sqrt, percentage, modulo",
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
      description:
        "Actionable feedback on clarity, structure, and style — no tools, pure reasoning",
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
