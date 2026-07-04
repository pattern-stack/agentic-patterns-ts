/**
 * Routes test for /eval/sets, /eval/sets/:id/cases, /eval/runs, /eval/runs/:id.
 *
 * Builds a real EvalStore against an in-memory SQLite, seeded via the
 * store's own API — upsertEvalSet/upsertEvalCase for the case bank,
 * startEvalRun/finishEvalRun + startRun/finishRun/recordEvalResult per case
 * (exactly what `ap eval` writes, #135's seam) — then mounts only the eval
 * routes (the `events.test.ts` idiom) plus two `createServer`-threading
 * tests (the `app.test.ts:143` `makeConfig` idiom).
 */

import { AgentEventBus, EvalStore } from "@agentic-patterns/runtime";
import type { EvalRunRow, JoinedEvalResultRow } from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../app.js";
import type { ServerConfig } from "../config.js";
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
async function reqJson(
  app: Hono,
  method: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const postJson = (app: Hono, path: string, body: unknown) => reqJson(app, "POST", path, body);
const patchJson = (app: Hono, path: string, body: unknown) => reqJson(app, "PATCH", path, body);
const putJson = (app: Hono, path: string, body: unknown) => reqJson(app, "PUT", path, body);

interface SeedResultOptions {
  inputTokens: number;
  outputTokens: number;
  finalAnswer: string;
  status: "ok" | "error";
  finishReason: string;
  error?: string;
  scores: ReadonlyArray<{ name: string; value: number | null; passed?: boolean }>;
  pass: boolean | null;
}

/** startRun + finishRun + recordEvalResult, wired exactly as `ap eval` writes them. */
function seedResult(
  store: EvalStore,
  evalRunId: string,
  caseId: string,
  opts: SeedResultOptions,
): void {
  const runId = store.startRun({
    agentName: "dealbrain/curator",
    traceId: `${evalRunId}:${caseId}`,
    metadata: { evalRunId, caseId },
  });
  store.finishRun(runId, {
    finalAnswer: opts.finalAnswer,
    toolCalls: 0,
    iterations: 1,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    finishReason: opts.finishReason,
    elapsedMs: 5,
    status: opts.status,
    error: opts.error,
  });
  store.recordEvalResult({
    evalRunId,
    caseId,
    runId,
    scores: opts.scores,
    pass: opts.pass,
  });
}

describe("eval routes", () => {
  let store: EvalStore;
  let runAId: string;
  let runBId: string;
  let runCId: string;

  beforeEach(() => {
    store = new EvalStore({ path: ":memory:", Database });

    // --- case bank: "bank" set, mixed train/dev/untagged splits ---
    store.upsertEvalSet({ id: "bank", name: "Bank One", description: "smoke bank" });
    store.upsertEvalCase("bank", {
      caseId: "case-01",
      input: "2+2?",
      expected: "4",
      tags: ["smoke"],
      split: "dev",
    });
    store.upsertEvalCase("bank", {
      caseId: "case-02",
      input: "3+3?",
      expected: "6",
      tags: ["smoke"],
      split: "train",
    });
    store.upsertEvalCase("bank", {
      caseId: "case-03",
      input: "4+4?",
      expected: "8",
      split: "train",
    });
    store.upsertEvalCase("bank", { caseId: "case-04", input: "5+5?", expected: "10" }); // untagged

    // --- suite A: variant "a", split "dev" ---
    runAId = store.startEvalRun({
      setId: "bank",
      targetId: "dealbrain/curator",
      variant: "a",
      split: "dev",
      model: "sonnet",
      gitSha: "sha-a",
      tsStart: new Date("2026-07-01T00:00:00Z"),
    });
    seedResult(store, runAId, "case-01", {
      inputTokens: 100,
      outputTokens: 10,
      finalAnswer: '"4"',
      status: "ok",
      finishReason: "stop",
      scores: [{ name: "exact-match", value: 1, passed: true }],
      pass: true,
    });
    seedResult(store, runAId, "case-02", {
      inputTokens: 120,
      outputTokens: 12,
      finalAnswer: '"7"',
      status: "ok",
      finishReason: "stop",
      scores: [{ name: "exact-match", value: 0, passed: false }],
      pass: false,
    });
    seedResult(store, runAId, "case-03", {
      inputTokens: 0,
      outputTokens: 0,
      finalAnswer: "",
      status: "error",
      finishReason: "error",
      error: "boom",
      scores: [],
      pass: null,
    });
    store.finishEvalRun(runAId, { status: "ok" });

    // --- suite B: variant "b", split "train", same set/target ---
    runBId = store.startEvalRun({
      setId: "bank",
      targetId: "dealbrain/curator",
      variant: "b",
      split: "train",
      model: "sonnet",
      gitSha: "sha-b",
      tsStart: new Date("2026-07-02T00:00:00Z"),
    });
    seedResult(store, runBId, "case-02", {
      inputTokens: 50,
      outputTokens: 5,
      finalAnswer: '"6"',
      status: "ok",
      finishReason: "stop",
      scores: [{ name: "exact-match", value: 1, passed: true }],
      pass: true,
    });
    seedResult(store, runBId, "case-04", {
      inputTokens: 60,
      outputTokens: 6,
      finalAnswer: '"10"',
      status: "ok",
      finishReason: "stop",
      scores: [{ name: "exact-match", value: 1, passed: true }],
      pass: true,
    });
    store.finishEvalRun(runBId, { status: "ok" });

    // --- suite C: different set/target entirely — filter-exclusion coverage ---
    runCId = store.startEvalRun({
      setId: "other-bank",
      targetId: "other/target",
      variant: "c",
      split: "test",
      model: "sonnet",
      gitSha: "sha-c",
      tsStart: new Date("2026-06-30T00:00:00Z"),
    });
    store.finishEvalRun(runCId, { status: "ok" });
  });

  afterEach(() => {
    store.close();
  });

  describe("GET /eval/sets", () => {
    it("returns sets with per-split counts", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/sets");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sets: Array<{ id: string; caseCount: number; splitCounts: Record<string, number> }>;
      };
      expect(body.sets).toHaveLength(1);
      expect(body.sets[0]?.id).toBe("bank");
      expect(body.sets[0]?.caseCount).toBe(4);
      expect(body.sets[0]?.splitCounts).toEqual({ dev: 1, train: 2, "": 1 });
    });
  });

  describe("GET /eval/sets/:id/cases", () => {
    it("round-trips all cases with input/expected/tags/split intact", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/sets/bank/cases");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        setId: string;
        cases: Array<{
          caseId: string;
          input: unknown;
          expected: unknown;
          tags: string[] | null;
          split: string | null;
        }>;
      };
      expect(body.setId).toBe("bank");
      expect(body.cases).toHaveLength(4);
      const c1 = body.cases.find((c) => c.caseId === "case-01");
      expect(c1?.input).toBe("2+2?");
      expect(c1?.expected).toBe("4");
      expect(c1?.tags).toEqual(["smoke"]);
      expect(c1?.split).toBe("dev");
    });

    it("narrows by ?split=dev", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/sets/bank/cases?split=dev");
      const body = (await res.json()) as { cases: Array<{ caseId: string }> };
      expect(body.cases.map((c) => c.caseId)).toEqual(["case-01"]);
    });

    it("400s on an invalid split", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/sets/bank/cases?split=bogus");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid split "bogus" — expected train | dev | test');
    });

    it("404s for an unknown set id", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/sets/nope/cases");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('eval set "nope" not found');
    });

    it("200s with an empty array for an existing set's empty split slice", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/sets/bank/cases?split=test");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { setId: string; cases: unknown[] };
      expect(body.setId).toBe("bank");
      expect(body.cases).toEqual([]);
    });
  });

  describe("GET /eval/runs", () => {
    it("returns runs newest first", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/runs");
      const body = (await res.json()) as { runs: EvalRunRow[] };
      expect(body.runs.map((r) => r.id)).toEqual([runBId, runAId, runCId]);
    });

    it("narrows by ?set=", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/runs?set=bank");
      const body = (await res.json()) as { runs: EvalRunRow[] };
      expect(body.runs.map((r) => r.id)).toEqual([runBId, runAId]);
    });

    it("narrows by ?target=", async () => {
      const app = mkApp(store);
      const res = await app.request(`/eval/runs?target=${encodeURIComponent("dealbrain/curator")}`);
      const body = (await res.json()) as { runs: EvalRunRow[] };
      expect(body.runs.map((r) => r.id)).toEqual([runBId, runAId]);
    });

    it("narrows by ?variant=", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/runs?variant=a");
      const body = (await res.json()) as { runs: EvalRunRow[] };
      expect(body.runs.map((r) => r.id)).toEqual([runAId]);
    });

    it("narrows by ?split=", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/runs?split=train");
      const body = (await res.json()) as { runs: EvalRunRow[] };
      expect(body.runs.map((r) => r.id)).toEqual([runBId]);
    });

    it("intersects combined filters", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/runs?set=bank&variant=b");
      const body = (await res.json()) as { runs: EvalRunRow[] };
      expect(body.runs.map((r) => r.id)).toEqual([runBId]);
    });

    it("?limit=1 truncates to the newest", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/runs?limit=1");
      const body = (await res.json()) as { runs: EvalRunRow[] };
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0]?.id).toBe(runBId);
    });

    it("?limit=99999 clamps without erroring", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/runs?limit=99999");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: EvalRunRow[] };
      expect(body.runs).toHaveLength(3);
    });

    it("400s on an invalid ?split filter", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/runs?split=bogus");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /eval/runs/:id", () => {
    it("returns the run, joined per-case results, and a matching summary", async () => {
      const app = mkApp(store);
      const res = await app.request(`/eval/runs/${runAId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        run: EvalRunRow;
        results: JoinedEvalResultRow[];
        summary: {
          cases: number;
          passed: number;
          failed: number;
          ungated: number;
          errored: number;
          passRate: number | null;
          inputTokens: number;
          outputTokens: number;
        };
      };

      expect(body.run.id).toBe(runAId);
      expect(body.run.setId).toBe("bank");
      expect(body.run.targetId).toBe("dealbrain/curator");
      expect(body.run.variant).toBe("a");
      expect(body.run.split).toBe("dev");
      expect(body.run.status).toBe("ok");

      expect(body.results).toHaveLength(3);
      const byCase = new Map(body.results.map((r) => [r.caseId, r]));
      // proves the values come from the `runs` side of the JOIN
      expect(byCase.get("case-01")?.finalAnswer).toBe('"4"');
      expect(byCase.get("case-01")?.inputTokens).toBe(100);
      expect(byCase.get("case-01")?.outputTokens).toBe(10);
      expect(byCase.get("case-01")?.traceId).toBe(`${runAId}:case-01`);
      expect(byCase.get("case-01")?.runStatus).toBe("ok");
      expect(byCase.get("case-03")?.runStatus).toBe("error");

      expect(body.summary).toEqual({
        cases: 3,
        passed: 1,
        failed: 1,
        ungated: 1,
        errored: 1,
        passRate: 0.5,
        inputTokens: 220,
        outputTokens: 22,
      });
    });

    it("404s for an unknown run id", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/runs/nope");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('eval run "nope" not found');
    });
  });

  it("returns 503 with a hint on every route when no store is configured", async () => {
    const app = mkApp(undefined);
    for (const path of [
      "/eval/sets",
      "/eval/sets/bank/cases",
      "/eval/runs",
      "/eval/runs/x",
      "/eval/aggregates/splits",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; hint: string };
      expect(body.error).toBe("persistence not configured");
      expect(body.hint).toMatch(/AP_PERSISTENCE/);
    }
  });

  describe("GET /eval/aggregates/splits", () => {
    it("rolls up per-split pass rates across runs, case-split winning over the run label", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/aggregates/splits");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        aggregates: Array<{
          split: string | null;
          results: number;
          passed: number;
          failed: number;
          passRate: number | null;
        }>;
      };
      const bySplit = new Map(body.aggregates.map((a) => [a.split, a]));

      // dev: only run A's case-01 (case-level split "dev" matches the run label).
      expect(bySplit.get("dev")).toEqual({
        split: "dev",
        results: 1,
        passed: 1,
        failed: 0,
        passRate: 1,
      });

      // train: run A's case-02 (fail) + case-03 (ungated, banked "train" though
      // run A is labeled "dev" — case-level split wins over the run label) +
      // run B's case-02 (pass, banked "train") + case-04 (pass, untagged in the
      // bank — COALESCE falls back to run B's "train" label).
      const train = bySplit.get("train");
      expect(train?.results).toBe(4);
      expect(train?.passed).toBe(2);
      expect(train?.failed).toBe(1);
      expect(train?.passRate).toBeCloseTo(2 / 3);

      // run C (other-bank/test) recorded no eval_result rows, so it contributes
      // no bucket at all.
      expect(bySplit.has("test")).toBe(false);
    });

    it("narrows by ?variant=", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/aggregates/splits?variant=b");
      const body = (await res.json()) as {
        aggregates: Array<{
          split: string | null;
          results: number;
          passed: number;
          failed: number;
          passRate: number | null;
        }>;
      };
      expect(body.aggregates).toEqual([
        { split: "train", results: 2, passed: 2, failed: 0, passRate: 1 },
      ]);
    });

    it("narrows by ?set= and ?target=", async () => {
      const app = mkApp(store);
      const res = await app.request(
        `/eval/aggregates/splits?set=bank&target=${encodeURIComponent("dealbrain/curator")}`,
      );
      const body = (await res.json()) as { aggregates: unknown[] };
      expect(body.aggregates).toHaveLength(2);
    });

    it("200s with an empty array for a set/variant with no recorded results", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/aggregates/splits?set=other-bank");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { aggregates: unknown[] };
      expect(body.aggregates).toEqual([]);
    });

    it("200s with an empty array for an unknown filter value (narrowing, not a lookup)", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/aggregates/splits?variant=does-not-exist");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { aggregates: unknown[] };
      expect(body.aggregates).toEqual([]);
    });
  });

  describe("GET /eval/sets/:id/cases/:caseId", () => {
    it("returns the case plus its cross-run history, newest-first, joined through runs", async () => {
      const app = mkApp(store);
      // case-02 was evaluated in run A (fail) then run B (pass).
      const res = await app.request("/eval/sets/bank/cases/case-02");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        case: { caseId: string; input: unknown; expected: unknown; split: string | null };
        history: Array<{
          evalRunId: string;
          variant: string | null;
          pass: boolean | null;
          finalAnswer: string | null;
          runStatus: string;
        }>;
      };
      expect(body.case.caseId).toBe("case-02");
      expect(body.case.input).toBe("3+3?");
      expect(body.case.split).toBe("train");
      expect(body.history.map((h) => h.evalRunId)).toEqual([runBId, runAId]); // newest first
      expect(body.history[0]?.variant).toBe("b");
      expect(body.history[0]?.pass).toBe(true);
      expect(body.history[0]?.finalAnswer).toBe('"6"'); // joined through runs
      expect(body.history[1]?.pass).toBe(false);
    });

    it("returns an empty history for a banked case that was never run", async () => {
      store.upsertEvalCase("bank", { caseId: "case-05", input: "6+6?", expected: "12" });
      const app = mkApp(store);
      const res = await app.request("/eval/sets/bank/cases/case-05");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { history: unknown[] };
      expect(body.history).toEqual([]);
    });

    it("404s for an unknown set", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/sets/nope/cases/case-01");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('eval set "nope" not found');
    });

    it("404s for an unknown case in a known set", async () => {
      const app = mkApp(store);
      const res = await app.request("/eval/sets/bank/cases/no-such");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe(
        'case "no-such" not found in set "bank"',
      );
    });
  });

  describe("POST /eval/sets", () => {
    it("creates a new set (201) and updates an existing one (200)", async () => {
      const app = mkApp(store);
      const created = await postJson(app, "/eval/sets", {
        id: "fresh",
        name: "Fresh",
        description: "new bank",
      });
      expect(created.status).toBe(201);
      const cBody = (await created.json()) as { set: { id: string; name: string } };
      expect(cBody.set.id).toBe("fresh");
      expect(cBody.set.name).toBe("Fresh");

      const updated = await postJson(app, "/eval/sets", { id: "bank", name: "Renamed" });
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as { set: { name: string } }).set.name).toBe("Renamed");
    });

    it("400s when id is missing", async () => {
      const app = mkApp(store);
      const res = await postJson(app, "/eval/sets", { name: "no id" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("id is required");
    });

    it("400s when name is not a string", async () => {
      const app = mkApp(store);
      const res = await postJson(app, "/eval/sets", { id: "x", name: 42 });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /eval/sets/:id", () => {
    it("edits name, preserving description when omitted", async () => {
      const app = mkApp(store);
      const res = await patchJson(app, "/eval/sets/bank", { name: "Bank Renamed" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { set: { name: string; description: string } };
      expect(body.set.name).toBe("Bank Renamed");
      expect(body.set.description).toBe("smoke bank"); // untouched
    });

    it("404s for an unknown set", async () => {
      const app = mkApp(store);
      const res = await patchJson(app, "/eval/sets/nope", { name: "x" });
      expect(res.status).toBe(404);
    });

    it("400s on a non-string name", async () => {
      const app = mkApp(store);
      const res = await patchJson(app, "/eval/sets/bank", { name: 7 });
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /eval/sets/:id/cases/:caseId", () => {
    it("creates a case (201) then updates it (200), round-tripping through the cases list", async () => {
      const app = mkApp(store);
      const created = await putJson(app, "/eval/sets/bank/cases/new-case", {
        input: "9+9?",
        expected: "18",
        tags: ["added"],
        split: "dev",
      });
      expect(created.status).toBe(201);
      const cBody = (await created.json()) as {
        case: { caseId: string; input: unknown; split: string | null };
      };
      expect(cBody.case.caseId).toBe("new-case");
      expect(cBody.case.input).toBe("9+9?");
      expect(cBody.case.split).toBe("dev");

      const updated = await putJson(app, "/eval/sets/bank/cases/new-case", {
        input: "9+9?",
        expected: "eighteen",
      });
      expect(updated.status).toBe(200);
      expect(((await updated.json()) as { case: { expected: unknown } }).case.expected).toBe(
        "eighteen",
      );

      // Confirm it lands in the bank listing.
      const list = await app.request("/eval/sets/bank/cases");
      const listBody = (await list.json()) as { cases: Array<{ caseId: string }> };
      expect(listBody.cases.some((c) => c.caseId === "new-case")).toBe(true);
    });

    it("400s when input is absent", async () => {
      const app = mkApp(store);
      const res = await putJson(app, "/eval/sets/bank/cases/x", { expected: "y" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('"input" is required');
    });

    it("400s on non-string-array tags and on a bad split", async () => {
      const app = mkApp(store);
      const badTags = await putJson(app, "/eval/sets/bank/cases/x", { input: "a", tags: [1, 2] });
      expect(badTags.status).toBe(400);
      const badSplit = await putJson(app, "/eval/sets/bank/cases/x", { input: "a", split: "nope" });
      expect(badSplit.status).toBe(400);
    });

    it("404s for an unknown set", async () => {
      const app = mkApp(store);
      const res = await putJson(app, "/eval/sets/nope/cases/x", { input: "a" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /eval/sets/:id/cases/:caseId", () => {
    it("deletes a case (200) — a subsequent case-detail GET 404s", async () => {
      const app = mkApp(store);
      const del = await app.request("/eval/sets/bank/cases/case-01", { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);

      const after = await app.request("/eval/sets/bank/cases/case-01");
      expect(after.status).toBe(404);
    });

    it("404s for an unknown set and an unknown case", async () => {
      const app = mkApp(store);
      expect((await app.request("/eval/sets/nope/cases/x", { method: "DELETE" })).status).toBe(404);
      expect(
        (await app.request("/eval/sets/bank/cases/no-such", { method: "DELETE" })).status,
      ).toBe(404);
    });
  });

  it("503s on the write + case-detail routes when no store is configured", async () => {
    const app = mkApp(undefined);
    expect((await postJson(app, "/eval/sets", { id: "x" })).status).toBe(503);
    expect((await patchJson(app, "/eval/sets/x", { name: "y" })).status).toBe(503);
    expect((await putJson(app, "/eval/sets/x/cases/y", { input: "a" })).status).toBe(503);
    expect((await app.request("/eval/sets/x/cases/y", { method: "DELETE" })).status).toBe(503);
    expect((await app.request("/eval/sets/x/cases/y")).status).toBe(503);
  });

  describe("config threading (createServer)", () => {
    function makeConfig(overrides?: Partial<ServerConfig>): ServerConfig {
      return {
        agents: [],
        adminService: {} as unknown as ServerConfig["adminService"],
        eventBus: {} as unknown as ServerConfig["eventBus"],
        sseExporter: {} as unknown as ServerConfig["sseExporter"],
        ...overrides,
      };
    }

    it("serves /eval/sets when evalStore is configured", async () => {
      const app = createServer(makeConfig({ evalStore: store }));
      const res = await app.request("/eval/sets");
      expect(res.status).toBe(200);
    });

    it("503s when evalStore is absent", async () => {
      const app = createServer(makeConfig());
      const res = await app.request("/eval/sets");
      expect(res.status).toBe(503);
    });
  });
});
