/**
 * Admin routes — dashboard stats, tool analytics, token usage, live event stream.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ServerConfig } from "../config.js";
import { agentEventToSSE } from "../sse.js";

export function adminRoutes(config: ServerConfig): Hono {
  const app = new Hono();

  app.get("/admin/dashboard", async (c) => {
    if (!config.adminService) {
      return c.json({ error: "Admin service not configured" }, 501);
    }
    const stats = await config.adminService.getDashboard();
    return c.json(stats);
  });

  app.get("/admin/agents", async (c) => {
    if (!config.adminService) {
      return c.json({ error: "Admin service not configured" }, 501);
    }
    const agents = await config.adminService.listAgentStats();
    return c.json(agents);
  });

  app.get("/admin/tools", async (c) => {
    if (!config.adminService) {
      return c.json({ error: "Admin service not configured" }, 501);
    }
    const tools = await config.adminService.getToolAnalytics();
    return c.json(tools);
  });

  app.get("/admin/tokens", async (c) => {
    if (!config.adminService) {
      return c.json({ error: "Admin service not configured" }, 501);
    }
    const groupBy = (c.req.query("group_by") as "agent" | "model") ?? "agent";
    const usage = await config.adminService.getTokenUsage({ groupBy });
    return c.json(usage);
  });

  app.get("/admin/events/stream", (c) => {
    if (!config.eventBus) {
      return c.json({ error: "Event bus not configured" }, 501);
    }

    return streamSSE(c, async (stream) => {
      const bus = config.eventBus!;

      const handler = (event: unknown) => {
        const sse = agentEventToSSE(event as import("@agentic-patterns/runtime").AgentEvent);
        if (sse) {
          stream.writeSSE(sse).catch(() => {});
        }
      };

      bus.subscribeAll(handler);

      // Keepalive every 15s
      const keepalive = setInterval(() => {
        stream.writeSSE({ event: "keepalive", data: "{}" }).catch(() => {});
      }, 15_000);

      stream.onAbort(() => {
        bus.unsubscribeAll(handler);
        clearInterval(keepalive);
      });

      // Keep the stream open indefinitely
      await new Promise<void>(() => {});
    });
  });

  return app;
}
