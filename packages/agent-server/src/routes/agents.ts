/**
 * Agent listing routes.
 *
 * GET /agents is the instance roster (docs/playground-redesign.md §6): each
 * row carries a `role` ref linking up into the identity catalog (ids match
 * GET /roles) and a `readiness` block — can this instance be exercised right
 * now, i.e. does a model resolve (role default or instance override).
 */

import { Hono } from "hono";
import type { AgentRegistration } from "../config.js";
import { buildRoleEntries, displayRoleOf } from "./composition.js";

/* Structural view of an agent's declared composition — read without importing the
 * core classes, so any AgentLike (or a looser registration) introspects safely. */
interface ToolDefLike {
  description?: string;
}
interface CapabilityLike {
  name?: string;
  /** The capability's own one-line "what this is" summary (Capability ctor arg
   *  2) — the overarching context the chat Tools rail shows above its tools. */
  description?: string;
  toolbox?: { name?: string; description?: string; tools?: Record<string, ToolDefLike> };
  playbook?: { plays?: Record<string, unknown> };
}
interface AgentIntrospect {
  role?: { name?: string; capabilities?: ReadonlyArray<CapabilityLike> };
  /** A promoted pipeline's real Role — DISPLAY only (see `displayRoleOf`). */
  displayRole?: { name?: string; capabilities?: ReadonlyArray<CapabilityLike> };
  getModel?: () => string;
}

export function agentRoutes(agents: AgentRegistration[]): Hono {
  const app = new Hono();

  app.get("/agents", (c) => {
    const roleEntries = buildRoleEntries(agents);
    const summaries = agents.map((a) => {
      const introspect = a.agent as unknown as AgentIntrospect;
      const roleEntry = roleEntries.find((e) => e.members.includes(a));
      let model: string | undefined;
      try {
        model = typeof introspect.getModel === "function" ? introspect.getModel() : undefined;
      } catch {
        model = undefined; // getModel throwing IS the unready signal
      }
      const missing = model ? [] : ["model"];
      return {
        id: a.id,
        name: a.name,
        description: a.description ?? "",
        role: roleEntry ? { id: roleEntry.id, name: roleEntry.role.name ?? "role" } : null,
        readiness: { ready: missing.length === 0, missing },
        // #268 — same sub-shape as the composition/delivered payload
        // (`routes/composition.ts`'s `instantiation`), so the playground
        // seeds its context editor from `GET /agents` without an extra
        // round trip per agent.
        instantiation: {
          available: typeof a.instantiate === "function",
          defaults: a.instantiateDefaults ?? null,
        },
      };
    });
    return c.json(summaries);
  });

  // GET /agents/:id/capabilities — the agent's declared composition (what it CAN
  // do): capabilities → toolbox tools + plays. Sourced from the live registration,
  // not a static catalog, so it stays honest as agents evolve.
  app.get("/agents/:id/capabilities", (c) => {
    const reg = agents.find((a) => a.id === c.req.param("id"));
    if (!reg) return c.json({ error: "Agent not found" }, 404);

    const a = reg.agent as unknown as AgentIntrospect;
    // Display read — a promoted pipeline's capabilities live on `displayRole`
    // (its registered `role` is narrow by design; see `displayRoleOf`).
    const capabilities = (displayRoleOf(a)?.capabilities ?? []).map((cap) => ({
      name: cap.name ?? "capability",
      // The capability's own summary, falling back to the toolbox's — the
      // overarching "what this capability is" line the Tools rail shows.
      description: cap.description ?? cap.toolbox?.description ?? "",
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
