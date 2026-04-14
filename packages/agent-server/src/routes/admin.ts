/**
 * Admin routes — dashboard stats, tool analytics, token usage, live event stream.
 */

import { Hono } from "hono";
import type { ServerConfig } from "../config.js";

export function adminRoutes(config: ServerConfig): Hono {
  const app = new Hono();

  app.get("/admin/dashboard", async (c) => {
    const stats = await config.adminService.getDashboardStats();
    return c.json(stats);
  });

  app.get("/admin/agents", async (c) => {
    const agents = await config.adminService.getAllAgentStats();
    return c.json(agents);
  });

  app.get("/admin/tools", async (c) => {
    const tools = await config.adminService.getToolAnalytics();
    return c.json(tools);
  });

  app.get("/admin/tokens", async (c) => {
    const groupBy = (c.req.query("group_by") as "agent" | "model") ?? "agent";
    const usage = await config.adminService.getTokenUsage({ groupBy });
    return c.json(usage);
  });

  app.get("/admin/events/stream", (c) => {
    const stream = config.sseExporter.connect();

    c.req.raw.signal.addEventListener("abort", () => {
      config.sseExporter.disconnect(stream);
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}
