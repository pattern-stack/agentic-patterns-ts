/**
 * Routes test for /admin/runs, /admin/runs/:id, /admin/runs/:id/events (spec
 * `.ai-docs/stacks/playground-upgrades/port-map.md` § 3.1).
 *
 * Builds a real `RunStore` against an in-memory SQLite, seeded via the
 * store's own `startRun`/`finishRun`/`append` API, mounts only the runs
 * routes (the `events.test.ts` idiom), and exercises list/filter, get-by-id
 * (incl. unique-prefix), events-ASC, 404s, and the 503 unwired grammar.
 */

import { RunStore } from "@pattern-stack/agentic-runtime";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runsRoutes } from "../routes/runs.js";

function mkApp(store: RunStore | undefined): Hono {
  const app = new Hono();
  app.route("/", runsRoutes(store));
  return app;
}

describe("runs routes", () => {
  let store: RunStore;
  let okRunId: string;
  let errorRunId: string;
  let runningRunId: string;

  beforeEach(() => {
    store = new RunStore({ path: ":memory:", Database });

    const t1 = new Date("2026-05-11T18:00:00Z");
    const t2 = new Date("2026-05-11T18:05:00Z");
    const t3 = new Date("2026-05-11T18:10:00Z");

    okRunId = store.startRun({
      tsStart: t1,
      agentName: "agent-a",
      model: "model-a",
      systemPrompt: "You are agent-a.",
    });
    store.append({
      type: "agent.message.start",
      traceId: okRunId,
      runId: okRunId,
      spanId: "span-1",
      timestamp: t1,
      data: { hello: "start" },
    } as never);
    store.append({
      type: "agent.message.complete",
      traceId: okRunId,
      runId: okRunId,
      spanId: "span-2",
      timestamp: new Date(t1.getTime() + 500),
      data: { hello: "complete" },
    } as never);
    store.finishRun(okRunId, {
      finalAnswer: "the answer",
      toolCalls: 1,
      iterations: 2,
      inputTokens: 10,
      outputTokens: 5,
      finishReason: "stop",
      elapsedMs: 500,
      status: "ok",
    });

    errorRunId = store.startRun({ tsStart: t2, agentName: "agent-b", model: "model-b" });
    store.finishRun(errorRunId, {
      finalAnswer: "",
      toolCalls: 0,
      iterations: 1,
      inputTokens: 3,
      outputTokens: 0,
      finishReason: "error",
      elapsedMs: 20,
      status: "error",
      error: "boom",
    });

    runningRunId = store.startRun({ tsStart: t3, agentName: "agent-a", model: "model-a" }); // left running
  });

  afterEach(() => {
    store.close();
  });

  describe("GET /admin/runs", () => {
    it("lists runs newest first", async () => {
      const app = mkApp(store);
      const res = await app.request("/admin/runs");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: { runId: string }[] };
      expect(body.runs.map((r) => r.runId)).toEqual([runningRunId, errorRunId, okRunId]);
    });

    it("filters by status", async () => {
      const app = mkApp(store);
      const res = await app.request("/admin/runs?status=error");
      const body = (await res.json()) as { runs: { runId: string }[] };
      expect(body.runs.map((r) => r.runId)).toEqual([errorRunId]);
    });

    it("filters by agent", async () => {
      const app = mkApp(store);
      const res = await app.request("/admin/runs?agent=agent-a");
      const body = (await res.json()) as { runs: { runId: string }[] };
      expect(body.runs.map((r) => r.runId)).toEqual([runningRunId, okRunId]);
    });

    it("treats ?agent= (empty string) as absent — no filter, not a filter to the empty agent name", async () => {
      const app = mkApp(store);
      const res = await app.request("/admin/runs?agent=");
      const body = (await res.json()) as { runs: { runId: string }[] };
      expect(body.runs.map((r) => r.runId)).toEqual([runningRunId, errorRunId, okRunId]);
    });

    it("filters by since", async () => {
      const app = mkApp(store);
      const res = await app.request("/admin/runs?since=2026-05-11T18:04:00Z");
      const body = (await res.json()) as { runs: { runId: string }[] };
      expect(body.runs.map((r) => r.runId)).toEqual([runningRunId, errorRunId]);
    });

    it("honors limit", async () => {
      const app = mkApp(store);
      const res = await app.request("/admin/runs?limit=1");
      const body = (await res.json()) as { runs: unknown[] };
      expect(body.runs).toHaveLength(1);
    });

    it("400s an invalid status", async () => {
      const app = mkApp(store);
      const res = await app.request("/admin/runs?status=bogus");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("running | ok | error");
    });

    it("returns run-summary projection — no finalAnswer/systemPrompt blobs", async () => {
      const app = mkApp(store);
      const res = await app.request("/admin/runs");
      const body = (await res.json()) as { runs: Record<string, unknown>[] };
      const ok = body.runs.find((r) => r.runId === okRunId);
      expect(ok).not.toHaveProperty("finalAnswer");
      expect(ok).not.toHaveProperty("systemPrompt");
      expect(ok?.answerLength).toBe("the answer".length);
      expect(ok?.hasPrompt).toBe(true);
    });

    it("503s with a hint when no store is configured", async () => {
      const app = mkApp(undefined);
      const res = await app.request("/admin/runs");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; hint: string };
      expect(body.error).toBe("persistence not configured");
      expect(body.hint).toContain("ap playground");
    });
  });

  describe("GET /admin/runs/:id", () => {
    it("returns the full run row by exact id", async () => {
      const app = mkApp(store);
      const res = await app.request(`/admin/runs/${okRunId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { run: { runId: string; finalAnswer: string } };
      expect(body.run.runId).toBe(okRunId);
      expect(body.run.finalAnswer).toBe("the answer");
    });

    it("resolves a unique id prefix", async () => {
      const app = mkApp(store);
      const res = await app.request(`/admin/runs/${okRunId.slice(0, 8)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { run: { runId: string } };
      expect(body.run.runId).toBe(okRunId);
    });

    it("404s an unknown id", async () => {
      const app = mkApp(store);
      const res = await app.request("/admin/runs/does-not-exist");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("does-not-exist");
    });

    it("503s with a hint when no store is configured", async () => {
      const app = mkApp(undefined);
      const res = await app.request(`/admin/runs/${okRunId}`);
      expect(res.status).toBe(503);
    });
  });

  describe("GET /admin/runs/:id/events", () => {
    it("returns the run's events ASC", async () => {
      const app = mkApp(store);
      const res = await app.request(`/admin/runs/${okRunId}/events`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string; events: { type: string }[] };
      expect(body.runId).toBe(okRunId);
      expect(body.events.map((e) => e.type)).toEqual([
        "agent.message.start",
        "agent.message.complete",
      ]);
    });

    it("resolves a unique id prefix (inherits getRun's prefix matching)", async () => {
      const app = mkApp(store);
      const res = await app.request(`/admin/runs/${okRunId.slice(0, 8)}/events`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string };
      expect(body.runId).toBe(okRunId);
    });

    it("404s an unknown id", async () => {
      const app = mkApp(store);
      const res = await app.request("/admin/runs/does-not-exist/events");
      expect(res.status).toBe(404);
    });

    it("returns an empty array for a run with no events", async () => {
      const app = mkApp(store);
      const res = await app.request(`/admin/runs/${errorRunId}/events`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: unknown[] };
      expect(body.events).toEqual([]);
    });

    it("503s with a hint when no store is configured", async () => {
      const app = mkApp(undefined);
      const res = await app.request(`/admin/runs/${okRunId}/events`);
      expect(res.status).toBe(503);
    });
  });
});
