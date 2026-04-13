/**
 * Agent listing routes.
 */

import { Hono } from "hono";
import type { AgentRegistration } from "../config.js";

export function agentRoutes(agents: AgentRegistration[]): Hono {
  const app = new Hono();

  app.get("/agents", (c) => {
    const summaries = agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description ?? "",
    }));
    return c.json(summaries);
  });

  return app;
}
