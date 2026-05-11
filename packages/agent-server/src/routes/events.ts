/**
 * Historical event REST endpoints.
 *
 * Lets the dashboard hydrate on first paint from the persistent event log
 * (handed in via `ServerConfig.eventStore`), then layer live SSE on top.
 * Returns 503 with a friendly hint if the store isn't configured so the UI
 * can degrade gracefully.
 */

import type { EventStore } from "@agentic-patterns/runtime";
import { Hono } from "hono";

export function eventRoutes(eventStore: EventStore | undefined): Hono {
  const app = new Hono();

  app.get("/admin/events/recent", (c) => {
    if (!eventStore) {
      return c.json(
        {
          error: "persistence not configured",
          hint: "start `ap playground` with AP_PERSISTENCE != 0 to enable historical event queries",
        },
        503,
      );
    }
    const since = parseDate(c.req.query("since"));
    const limit = parseInt10(c.req.query("limit"), 1000, 1, 10000);
    const type = c.req.query("type") ?? undefined;
    const rows = eventStore.recent({ since, limit, type });
    return c.json({ events: rows });
  });

  app.get("/admin/claude-code/sessions", (c) => {
    if (!eventStore) {
      return c.json(
        {
          error: "persistence not configured",
          hint: "start `ap playground` with AP_PERSISTENCE != 0 to enable historical session queries",
        },
        503,
      );
    }
    const limit = parseInt10(c.req.query("limit"), 50, 1, 500);
    const sessions = eventStore.sessions(limit);
    return c.json({ sessions });
  });

  app.get("/admin/claude-code/sessions/:sessionId", (c) => {
    if (!eventStore) {
      return c.json({ error: "persistence not configured" }, 503);
    }
    const sessionId = c.req.param("sessionId");
    const events = eventStore.sessionEvents(sessionId);
    return c.json({ sessionId, events });
  });

  return app;
}

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseInt10(s: string | undefined, fallback: number, min: number, max: number): number {
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
