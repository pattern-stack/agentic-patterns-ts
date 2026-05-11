/**
 * Routes test for /admin/events/recent and /admin/claude-code/sessions.
 *
 * Builds a real EventStore against an in-memory SQLite, mounts only the
 * event routes (the rest of the app stack isn't needed), and exercises
 * happy + missing-store paths.
 */

import { EventStore } from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventRoutes } from "../routes/events.js";

function mkApp(store: EventStore | undefined): Hono {
  const app = new Hono();
  app.route("/", eventRoutes(store));
  return app;
}

describe("events routes", () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore({ path: ":memory:", Database });
    // Seed two CC sessions
    const baseTs = Date.parse("2026-05-11T18:00:00Z");
    for (let i = 0; i < 3; i++) {
      store.append({
        type: "claude_code.hook",
        traceId: "sess-A",
        runId: "sess-A",
        spanId: `a-${i}`,
        timestamp: new Date(baseTs + i * 1000),
        sessionId: "sess-A",
        hookName: i === 0 ? "SessionStart" : "PreToolUse",
        cwd: "/proj/a",
      } as never);
    }
    store.append({
      type: "claude_code.hook",
      traceId: "sess-B",
      runId: "sess-B",
      spanId: "b-0",
      timestamp: new Date(baseTs + 10_000),
      sessionId: "sess-B",
      hookName: "SessionStart",
      cwd: "/proj/b",
    } as never);
  });

  afterEach(() => {
    store.close();
  });

  it("GET /admin/events/recent returns events DESC", async () => {
    const app = mkApp(store);
    const res = await app.request("/admin/events/recent?limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { spanId: string; timestamp: string }[] };
    expect(body.events).toHaveLength(4);
    // newest first
    expect(body.events[0]?.spanId).toBe("b-0");
  });

  it("GET /admin/events/recent honors `since`", async () => {
    const app = mkApp(store);
    const res = await app.request("/admin/events/recent?since=2026-05-11T18:00:05Z");
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(1); // only sess-B is after 18:00:05Z
  });

  it("GET /admin/claude-code/sessions returns one row per session, newest first", async () => {
    const app = mkApp(store);
    const res = await app.request("/admin/claude-code/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: { sessionId: string; eventCount: number; cwd: string }[];
    };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]?.sessionId).toBe("sess-B");
    expect(body.sessions[1]?.sessionId).toBe("sess-A");
    expect(body.sessions[1]?.eventCount).toBe(3);
    expect(body.sessions[1]?.cwd).toBe("/proj/a");
  });

  it("GET /admin/claude-code/sessions/:id returns ASC by timestamp", async () => {
    const app = mkApp(store);
    const res = await app.request("/admin/claude-code/sessions/sess-A");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      events: { spanId: string; ccHookName: string }[];
    };
    expect(body.sessionId).toBe("sess-A");
    expect(body.events.map((e) => e.spanId)).toEqual(["a-0", "a-1", "a-2"]);
    expect(body.events[0]?.ccHookName).toBe("SessionStart");
  });

  it("returns 503 with a hint when no store is configured", async () => {
    const app = mkApp(undefined);
    for (const path of [
      "/admin/events/recent",
      "/admin/claude-code/sessions",
      "/admin/claude-code/sessions/x",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
    }
  });

  it("clamps `limit` to a sane range", async () => {
    const app = mkApp(store);
    const high = await app.request("/admin/events/recent?limit=99999");
    expect(high.status).toBe(200);
    const low = await app.request("/admin/events/recent?limit=-5");
    expect(low.status).toBe(200);
  });
});
