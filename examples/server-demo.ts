/**
 * Server demo — creates a Hono app with a mock echo agent.
 *
 * Usage:
 *   pnpm add -D @hono/node-server  # if not already installed
 *   npx tsx examples/server-demo.ts
 *
 * Then:
 *   curl http://localhost:3000/health
 *   curl http://localhost:3000/agents
 *   curl -X POST http://localhost:3000/conversations \
 *     -H "Content-Type: application/json" \
 *     -d '{"agent_id": "echo"}'
 */

import {
  AgentBuilder,
  Capability,
  Mission,
  Persona,
  RoleBuilder,
  Toolbox,
} from "@pattern-stack/agent-core";
import { MockRunner } from "@pattern-stack/agent-runtime";
import { createApp } from "@pattern-stack/agent-server";

// ---------------------------------------------------------------------------
// Build a simple echo agent
// ---------------------------------------------------------------------------

const persona = new Persona({ name: "Echo", role: "echo assistant" });
const mission = new Mission({ objective: "Echo back user messages" });
const capability = new Capability({
  name: "echo",
  toolbox: new Toolbox({ name: "empty", tools: [] }),
});

const role = new RoleBuilder().withPersona(persona).withCapability(capability).build();

const agent = new AgentBuilder()
  .withRole(role)
  .withMission(mission)
  .withModel("echo-model")
  .build();

// ---------------------------------------------------------------------------
// Create a mock runner that echoes messages
// ---------------------------------------------------------------------------

const runner = new MockRunner([]);
runner.setDefaultResponse({
  response: "Echo: I received your message!",
  inputTokens: 10,
  outputTokens: 15,
  toolCallsCount: 0,
  iterations: 1,
  finishReason: "stop",
});

// ---------------------------------------------------------------------------
// Create and start the server
// ---------------------------------------------------------------------------

const app = createApp({
  agents: [
    {
      id: "echo",
      name: "Echo Agent",
      description: "A simple agent that echoes back messages",
      agent,
      runner,
    },
  ],
});

// Serve with Node.js (requires @hono/node-server)
const port = 3000;
import("@hono/node-server").then(({ serve }) => {
  serve({ fetch: app.fetch, port });
  console.log(`Server running at http://localhost:${port}`);
  console.log("Endpoints:");
  console.log("  GET  /health");
  console.log("  GET  /agents");
  console.log("  POST /conversations");
  console.log("  POST /conversations/:id/messages");
});
