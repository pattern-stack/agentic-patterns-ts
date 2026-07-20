/**
 * Routes test for POST /eval/runs/ingest — the import path for COMPLETE,
 * externally-executed suite runs (slice 2).
 *
 * Same harness as eval.test.ts: a real EvalStore against in-memory SQLite,
 * only the eval routes mounted on a bare Hono, exact status + error-string
 * assertions. Ingest-specific concerns pinned here: verbatim timestamp/status
 * persistence (the no-misrepresenting-state rule), idempotent full replacement
 * on re-ingest, the Zod 400 surface, the 32 MiB body guard, and the 503
 * no-store path.
 */

import { AgentEventBus, EvalStore } from "@agentic-patterns/runtime";
import type { EvalRunRow } from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evalRoutes } from "../routes/eval.js";

function mkApp(store: EvalStore | undefined): Hono {
  const app = new Hono();
  app.route(
    "/",
    evalRoutes({
      evalStore: store,
      agents: [],
      eventBus: new AgentEventBus(),
      evalExecution: undefined,
    }),
  );
  return app;
}

/** app.request with a JSON body + method — the write-route test idiom. */
async function reqJson(app: Hono, method: string, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const postJson = (app: Hono, path: string, body: unknown) => reqJson(app, "POST", path, body);

/** A complete, valid ingest payload — tests clone + mutate from here. */
function validBody() {
  return {
    run: {
      id: "ing-1",
      setId: "renderer-grid",
      targetId: "dealbrain/retrieval",
      variant: "grid-a",
      split: "dev",
      model: "sonnet",
      gitSha: "sha-ext",
      scorer: "claims-judge",
      tsStart: "2026-07-10T01:02:03.000Z",
      tsEnd: "2026-07-10T01:07:03.000Z",
      status: "ok" as const,
      meta: { family: "renderer-grid", lens: "curation" },
    },
    results: [
      { caseId: "case-01", pass: true, scores: [{ name: "claim-support", value: 0.81, passed: true }] },
      { caseId: "case-02", pass: false },
    ],
  };
}

interface IngestResponse {
  run: EvalRunRow;
  resultCount: number;
}

describe("POST /eval/runs/ingest", () => {
  let store: EvalStore;

  beforeEach(() => {
    store = new EvalStore({ path: ":memory:", Database });
  });

  afterEach(() => {
    store.close();
  });

  it("201s on first ingest, persisting timestamps/status VERBATIM and the meta blob", async () => {
    const app = mkApp(store);
    const res = await postJson(app, "/eval/runs/ingest", validBody());
    expect(res.status).toBe(201);
    const body = (await res.json()) as IngestResponse;

    expect(body.resultCount).toBe(2);
    // The run in the response is a post-write RE-READ, never the request echo —
    // so every assertion below is proof of what actually landed in the store.
    expect(body.run.id).toBe("ing-1");
    expect(body.run.setId).toBe("renderer-grid");
    expect(body.run.targetId).toBe("dealbrain/retrieval");
    expect(body.run.variant).toBe("grid-a");
    expect(body.run.split).toBe("dev");
    expect(body.run.model).toBe("sonnet");
    expect(body.run.gitSha).toBe("sha-ext");
    expect(body.run.scorer).toBe("claims-judge");
    // Verbatim, not re-stamped with ingest time (no-misrepresenting-state).
    expect(body.run.tsStart).toBe("2026-07-10T01:02:03.000Z");
    expect(body.run.tsEnd).toBe("2026-07-10T01:07:03.000Z");
    expect(body.run.status).toBe("ok");
    expect(body.run.meta).toEqual({ family: "renderer-grid", lens: "curation" });
  });

  it("makes the ingested results readable through GET /eval/runs/:id", async () => {
    const app = mkApp(store);
    await postJson(app, "/eval/runs/ingest", validBody());

    const res = await app.request("/eval/runs/ing-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: EvalRunRow;
      results: Array<{
        caseId: string;
        pass: boolean | null;
        scores: unknown;
        runId: string | null;
      }>;
    };
    expect(body.results).toHaveLength(2);
    const byCase = new Map(body.results.map((r) => [r.caseId, r]));
    expect(byCase.get("case-01")?.pass).toBe(true);
    // Score[] round-trips intact — the one shape `parseScores` surfaces.
    expect(byCase.get("case-01")?.scores).toEqual([
      { name: "claim-support", value: 0.81, passed: true },
    ]);
    expect(byCase.get("case-02")?.pass).toBe(false);
    expect(byCase.get("case-02")?.scores).toBeNull();
    // Imported cases have no RunStore runs row to join.
    expect(byCase.get("case-01")?.runId).toBeNull();
  });

  it("200s on re-ingest of the same id, fully replacing the result set", async () => {
    const app = mkApp(store);
    await postJson(app, "/eval/runs/ingest", validBody());

    const rerun = validBody();
    rerun.run.status = "error" as never;
    rerun.results = [
      { caseId: "case-01", pass: true, scores: [{ name: "claim-support", value: 0.9, passed: true }] },
    ];
    const res = await postJson(app, "/eval/runs/ingest", rerun);
    expect(res.status).toBe(200); // replaced, not created
    const body = (await res.json()) as IngestResponse;
    expect(body.resultCount).toBe(1);
    expect(body.run.status).toBe("error");

    // The stale case-02 result is GONE — replacement, not merge.
    const detail = await app.request("/eval/runs/ing-1");
    const detailBody = (await detail.json()) as { results: Array<{ caseId: string }> };
    expect(detailBody.results.map((r) => r.caseId)).toEqual(["case-01"]);
  });

  it("400s with a field-pathed error when run.targetId is missing", async () => {
    const app = mkApp(store);
    const body = validBody();
    // biome-ignore lint/performance/noDelete: constructing an invalid payload
    delete (body.run as Partial<typeof body.run>).targetId;
    const res = await postJson(app, "/eval/runs/ingest", body);
    expect(res.status).toBe(400);
    const err = ((await res.json()) as { error: string }).error;
    expect(err).toMatch(/^invalid ingest body — /);
    expect(err).toContain("run.targetId");
  });

  it('400s on status "running" — ingest imports terminal runs only', async () => {
    const app = mkApp(store);
    const body = validBody();
    body.run.status = "running" as never;
    const res = await postJson(app, "/eval/runs/ingest", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("run.status");
  });

  it("400s on record-shaped scores — only Score[] survives the read path, so only Score[] is accepted", async () => {
    const app = mkApp(store);
    const body = validBody();
    body.results[0] = { caseId: "case-01", pass: true, scores: { "claim-support": 0.81 } } as never;
    const res = await postJson(app, "/eval/runs/ingest", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("scores");
  });

  it("400s when run.meta is an array", async () => {
    const app = mkApp(store);
    const body = validBody();
    body.run.meta = [] as never;
    const res = await postJson(app, "/eval/runs/ingest", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("run.meta");
  });

  it("400s on an unparseable JSON body with the file idiom", async () => {
    const app = mkApp(store);
    const res = await app.request("/eval/runs/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json {",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid JSON body");
  });

  it("503s when no store is configured", async () => {
    const app = mkApp(undefined);
    const res = await postJson(app, "/eval/runs/ingest", validBody());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("persistence not configured");
  });

  it("413s on a body over the 32 MiB guard", async () => {
    const app = mkApp(store);
    // > 32 MiB of anything — the guard fires before JSON parsing, so the
    // payload never needs to be valid.
    const oversized = "x".repeat(32 * 1024 * 1024 + 1);
    const res = await app.request("/eval/runs/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/too large/);
  });
});
