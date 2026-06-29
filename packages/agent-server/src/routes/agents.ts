/**
 * Agent listing routes.
 */

import { Hono } from "hono";
import type { AgentRegistration } from "../config.js";

/* Structural view of an agent's declared composition — read without importing the
 * core classes, so any AgentLike (or a looser registration) introspects safely. */
interface ToolDefLike {
  description?: string;
}
interface CapabilityLike {
  name?: string;
  toolbox?: { name?: string; description?: string; tools?: Record<string, ToolDefLike> };
  playbook?: { plays?: Record<string, unknown> };
}
interface AgentIntrospect {
  role?: { name?: string; capabilities?: ReadonlyArray<CapabilityLike> };
  getModel?: () => string;
}

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

  // GET /agents/:id/capabilities — the agent's declared composition (what it CAN
  // do): capabilities → toolbox tools + plays. Sourced from the live registration,
  // not a static catalog, so it stays honest as agents evolve.
  app.get("/agents/:id/capabilities", (c) => {
    const reg = agents.find((a) => a.id === c.req.param("id"));
    if (!reg) return c.json({ error: "Agent not found" }, 404);

    const a = reg.agent as unknown as AgentIntrospect;
    const capabilities = (a.role?.capabilities ?? []).map((cap) => ({
      name: cap.name ?? "capability",
      toolbox: cap.toolbox?.name,
      tools: Object.entries(cap.toolbox?.tools ?? {}).map(([name, def]) => ({
        name,
        description: def?.description ?? "",
      })),
      plays: Object.keys(cap.playbook?.plays ?? {}),
    }));

    return c.json({
      id: reg.id,
      name: reg.name,
      description: reg.description ?? "",
      model: typeof a.getModel === "function" ? a.getModel() : undefined,
      capabilities,
    });
  });

  return app;
}
