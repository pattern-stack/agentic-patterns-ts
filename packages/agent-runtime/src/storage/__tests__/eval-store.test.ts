/**
 * EvalStore unit tests. `:memory:` throughout (run-store.test.ts:47 idiom)
 * except the on-disk v2 -> v3 migration test. `MockRunner` + `FunctionStep`
 * for the integration test, exactly as run-store.test.ts:344-382.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEval } from "../../eval/run-eval.js";
import type { BaseEvent } from "../../events/types.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { FunctionStep } from "../../workflows/function-step.js";
import { EvalStore, derivePass } from "../eval-store.js";
import { EventStore } from "../event-store.js";
import { RunStore } from "../run-store.js";

function mkEvent(overrides: Record<string, unknown> = {}): BaseEvent {
  return {
    type: "agent.message.start",
    traceId: "trace-1",
    runId: "run-1",
    spanId: "span-1",
    timestamp: new Date("2026-05-11T18:00:00Z"),
    ...overrides,
  } as BaseEvent;
}

/**
 * A subclass exposing the protected `_db` handle for tests that must reach
 * past the public API — proving the join reads through (raw `UPDATE runs`)
 * and that `eval_result` structurally cannot hold run data (`PRAGMA
 * table_info`). This is exactly what `protected` (not `private`) enables.
 */
class InspectableEvalStore extends EvalStore {
  rawDb(): DatabaseType {
    return this._db;
  }
}

describe("EvalStore", () => {
  let store: EvalStore;

  beforeEach(() => {
    store = new EvalStore({ path: ":memory:", Database });
  });

  afterEach(() => {
    store.close();
  });

  describe("v2 -> v3 in-place migration", () => {
    it("migrates a hand-built v2 (events+runs) DB in place; EventStore and RunStore also open the v3 file", () => {
      const fs = require("node:fs") as typeof import("node:fs");
      const os = require("node:os") as typeof import("node:os");
      const path = require("node:path") as typeof import("node:path");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evalstore-migrate-"));
      const dbPath = path.join(dir, "events.db");

      // Build a v2 (events + runs) DB by hand — a runs-only DB, the exact
      // acceptance-criteria shape. EvalStore's own TARGET_SCHEMA_VERSION is
      // now 3, so opening it fresh would already create the eval tables.
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          trace_id TEXT,
          run_id TEXT,
          span_id TEXT,
          cc_session_id TEXT,
          cc_hook_name TEXT,
          cc_cwd TEXT,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          trace_id TEXT,
          ts_start TEXT NOT NULL,
          ts_end TEXT,
          agent_name TEXT,
          model TEXT,
          system_prompt TEXT,
          agent_config TEXT,
          final_answer TEXT,
          tool_calls INTEGER,
          iterations INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          finish_reason TEXT,
          elapsed_ms INTEGER,
          status TEXT NOT NULL,
          error TEXT,
          step_metrics TEXT,
          metadata TEXT
        );
      `);
      raw
        .prepare(
          "INSERT INTO events (type, timestamp, trace_id, run_id, span_id, data) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "agent.message.start",
          "2026-05-11T18:00:00.000Z",
          "t1",
          "r1",
          "s1",
          JSON.stringify({ hello: "world" }),
        );
      raw
        .prepare("INSERT INTO runs (run_id, ts_start, agent_name, status) VALUES (?, ?, ?, ?)")
        .run("r1", "2026-05-11T18:00:00.000Z", "agent-a", "ok");
      raw.pragma("user_version = 2");
      raw.close();

      // Reopen via EvalStore: migrates to v3 — four eval tables exist, prior
      // rows intact, user_version = 3.
      const es = new EvalStore({ path: dbPath, Database });
      expect(es.count()).toBe(1);
      expect(es.getRun("r1")).not.toBeNull();
      const evalRunId = es.startEvalRun({ setId: "s1" });
      expect(es.getEvalRun(evalRunId)).not.toBeNull();
      es.close();

      // Plain EventStore AND RunStore both open the v3 file (shared
      // TARGET_SCHEMA_VERSION — interchangeability preserved).
      const plainEvents = new EventStore({ path: dbPath, Database });
      expect(plainEvents.count()).toBe(1);
      plainEvents.close();

      const runStore = new RunStore({ path: dbPath, Database });
      expect(runStore.getRun("r1")).not.toBeNull();
      runStore.close();

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("one file serves all three layers", () => {
    it("append (EventStore) / startRun+finishRun (RunStore) / startEvalRun+recordEvalResult (EvalStore) all land", () => {
      store.append(mkEvent());
      expect(store.count()).toBe(1);

      const runId = store.startRun({ agentName: "agent-a" });
      store.finishRun(runId, {
        finalAnswer: "done",
        toolCalls: 0,
        iterations: 1,
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
        elapsedMs: 1,
        status: "ok",
      });
      expect(store.getRun(runId)).not.toBeNull();

      const evalRunId = store.startEvalRun({ setId: "set-1" });
      store.recordEvalResult({ evalRunId, caseId: "case-1", runId, scores: [], pass: null });
      expect(store.getEvalRun(evalRunId)).not.toBeNull();
      expect(store.evalRunResults(evalRunId)).toHaveLength(1);
    });
  });

  describe("case bank", () => {
    it("round-trips with split/tags/JSON payloads; listEvalSets carries per-split counts; listEvalCases filters; upserts are idempotent", () => {
      store.upsertEvalSet({ id: "set-1", name: "Set One", description: "the first set" });
      store.upsertEvalCase("set-1", {
        caseId: "c1",
        input: { q: "2+2" },
        expected: "4",
        tags: ["math"],
        split: "train",
      });
      store.upsertEvalCase("set-1", { caseId: "c2", input: { q: "3+3" }, split: "test" });
      store.upsertEvalCase("set-1", { caseId: "c3", input: { q: "4+4" } }); // untagged

      let sets = store.listEvalSets();
      expect(sets).toHaveLength(1);
      expect(sets[0]?.name).toBe("Set One");
      expect(sets[0]?.description).toBe("the first set");
      expect(sets[0]?.caseCount).toBe(3);
      expect(sets[0]?.splitCounts).toEqual({ train: 1, test: 1, "": 1 });

      const allCases = store.listEvalCases("set-1");
      expect(allCases).toHaveLength(3);
      const c1 = allCases.find((c) => c.caseId === "c1");
      expect(c1?.input).toEqual({ q: "2+2" });
      expect(c1?.expected).toBe("4");
      expect(c1?.tags).toEqual(["math"]);
      expect(c1?.split).toBe("train");

      expect(store.listEvalCases("set-1", { split: "train" }).map((c) => c.caseId)).toEqual(["c1"]);
      expect(store.listEvalCases("set-1", { split: "test" }).map((c) => c.caseId)).toEqual(["c2"]);

      // Re-upserting the same (setId, caseId) updates in place — row count stable.
      store.upsertEvalCase("set-1", { caseId: "c1", input: { q: "2+2" }, split: "dev" });
      const casesAfter = store.listEvalCases("set-1");
      expect(casesAfter).toHaveLength(3);
      expect(casesAfter.find((c) => c.caseId === "c1")?.split).toBe("dev");

      // Re-upserting the same set id updates name/description — no duplicate row.
      store.upsertEvalSet({ id: "set-1", name: "Renamed Set" });
      sets = store.listEvalSets();
      expect(sets).toHaveLength(1);
      expect(sets[0]?.name).toBe("Renamed Set");
    });
  });

  describe("deleteEvalCase", () => {
    it("removes exactly the targeted case, returns true; a miss returns false; other cases untouched", () => {
      store.upsertEvalSet({ id: "set-1" });
      store.upsertEvalCase("set-1", { caseId: "c1", input: { q: "a" } });
      store.upsertEvalCase("set-1", { caseId: "c2", input: { q: "b" } });

      expect(store.deleteEvalCase("set-1", "c1")).toBe(true);
      expect(store.listEvalCases("set-1").map((c) => c.caseId)).toEqual(["c2"]);

      // Deleting an already-gone case (or an unknown one) is a no-op false.
      expect(store.deleteEvalCase("set-1", "c1")).toBe(false);
      expect(store.deleteEvalCase("set-1", "no-such")).toBe(false);

      // Same case id in a different set is scoped out.
      store.upsertEvalSet({ id: "set-2" });
      store.upsertEvalCase("set-2", { caseId: "c2", input: { q: "c" } });
      expect(store.deleteEvalCase("set-1", "c2")).toBe(true);
      expect(store.listEvalCases("set-2").map((c) => c.caseId)).toEqual(["c2"]);
    });
  });

  describe("caseResultHistory", () => {
    it("returns every run that evaluated a case, newest-first, joining run-owned fields; scoped to (setId, caseId); empty for unknowns", () => {
      store.upsertEvalSet({ id: "set-1" });
      store.upsertEvalCase("set-1", { caseId: "c1", input: { q: "2+2" }, split: "train" });

      // Two runs against c1, an older one then a newer one, each with a runs
      // row so the join carries finalAnswer/tokens/elapsed.
      const runIdOld = store.startRun({ agentName: "agent-a" });
      store.finishRun(runIdOld, {
        finalAnswer: "3",
        toolCalls: 0,
        iterations: 0,
        inputTokens: 10,
        outputTokens: 2,
        finishReason: "stop",
        elapsedMs: 5,
        status: "ok",
      });
      const evalRunOld = store.startEvalRun({
        setId: "set-1",
        targetId: "agent-a",
        variant: "v1",
        model: "m1",
        tsStart: new Date("2026-01-01T00:00:00Z"),
      });
      store.recordEvalResult({
        evalRunId: evalRunOld,
        caseId: "c1",
        runId: runIdOld,
        scores: [{ name: "exact", value: 0, passed: false }],
        pass: false,
      });
      store.finishEvalRun(evalRunOld, { status: "ok" });

      const runIdNew = store.startRun({ agentName: "agent-a" });
      store.finishRun(runIdNew, {
        finalAnswer: "4",
        toolCalls: 0,
        iterations: 0,
        inputTokens: 12,
        outputTokens: 3,
        finishReason: "stop",
        elapsedMs: 7,
        status: "ok",
      });
      const evalRunNew = store.startEvalRun({
        setId: "set-1",
        targetId: "agent-a",
        variant: "v2",
        model: "m2",
        tsStart: new Date("2026-02-01T00:00:00Z"),
      });
      store.recordEvalResult({
        evalRunId: evalRunNew,
        caseId: "c1",
        runId: runIdNew,
        scores: [{ name: "exact", value: 1, passed: true }],
        pass: true,
      });
      store.finishEvalRun(evalRunNew, { status: "ok" });

      const history = store.caseResultHistory("set-1", "c1");
      expect(history.map((h) => h.evalRunId)).toEqual([evalRunNew, evalRunOld]); // newest first

      const newest = history[0];
      expect(newest?.pass).toBe(true);
      expect(newest?.variant).toBe("v2");
      expect(newest?.model).toBe("m2");
      expect(newest?.runStatus).toBe("ok");
      expect(newest?.finalAnswer).toBe("4"); // joined through runs
      expect(newest?.inputTokens).toBe(12);
      expect(newest?.outputTokens).toBe(3);
      expect(newest?.elapsedMs).toBe(7);
      expect(newest?.scores).toEqual([{ name: "exact", value: 1, passed: true }]);

      // Scoped: another set's same case id, and unknown ids, don't leak in.
      store.upsertEvalSet({ id: "set-2" });
      store.upsertEvalCase("set-2", { caseId: "c1", input: { q: "x" } });
      const otherRun = store.startEvalRun({ setId: "set-2" });
      store.recordEvalResult({ evalRunId: otherRun, caseId: "c1", scores: [], pass: true });
      expect(store.caseResultHistory("set-1", "c1")).toHaveLength(2); // unchanged
      expect(store.caseResultHistory("set-1", "no-such")).toEqual([]);
      expect(store.caseResultHistory("no-such-set", "c1")).toEqual([]);
    });

    it("carries null run-owned fields when the result has no runId (annotate-only)", () => {
      store.upsertEvalSet({ id: "set-1" });
      store.upsertEvalCase("set-1", { caseId: "c1", input: { q: "a" } });
      const evalRunId = store.startEvalRun({ setId: "set-1" });
      store.recordEvalResult({ evalRunId, caseId: "c1", scores: [], pass: null });

      const [row] = store.caseResultHistory("set-1", "c1");
      expect(row?.pass).toBeNull();
      expect(row?.finalAnswer).toBeNull();
      expect(row?.inputTokens).toBeNull();
      expect(row?.elapsedMs).toBeNull();
    });

    it("matches composite result ids on either side of '#' (renderer caseId#variant, curation configId#caseId) and labels each row's resultCaseId", () => {
      store.upsertEvalSet({ id: "set-1" });
      store.upsertEvalCase("set-1", { caseId: "fx-003", input: { q: "a" } });
      const evalRunId = store.startEvalRun({ setId: "set-1" });
      for (const caseId of [
        "fx-003", // exact
        "cfg-baseline#fx-003", // curation suffix
        "fx-003#prose-brief-inline", // renderer prefix
        "cfg#fx-0031", // NOT a match: superstring after '#'
        "fx-0030#v", // NOT a match: superstring before '#'
      ]) {
        store.recordEvalResult({ evalRunId, caseId, scores: [], pass: true });
      }

      const ids = store.caseResultHistory("set-1", "fx-003").map((h) => h.resultCaseId);
      expect(ids).toEqual(["cfg-baseline#fx-003", "fx-003", "fx-003#prose-brief-inline"]);
    });

    it("escapes SQL LIKE wildcards in the case id when matching composites", () => {
      store.upsertEvalSet({ id: "set-1" });
      store.upsertEvalCase("set-1", { caseId: "c_1", input: { q: "a" } });
      const evalRunId = store.startEvalRun({ setId: "set-1" });
      store.recordEvalResult({ evalRunId, caseId: "cfg#cx1", scores: [], pass: true });
      store.recordEvalResult({ evalRunId, caseId: "cfg#c_1", scores: [], pass: true });

      const ids = store.caseResultHistory("set-1", "c_1").map((h) => h.resultCaseId);
      expect(ids).toEqual(["cfg#c_1"]); // '_' must not act as a single-char wildcard
    });
  });

  describe("suite lifecycle", () => {
    it("startEvalRun round-trips all EvalRunMeta fields; finishEvalRun is first-terminal-wins; listEvalRuns filters + orders newest-first", () => {
      const t1 = new Date("2026-05-11T18:00:00Z");
      const id1 = store.startEvalRun({
        tsStart: t1,
        setId: "set-1",
        targetId: "agent-a",
        variant: "a",
        split: "train",
        model: "test-model",
        gitSha: "abc123",
        scorer: "set-membership",
      });

      const row = store.getEvalRun(id1);
      expect(row?.setId).toBe("set-1");
      expect(row?.targetId).toBe("agent-a");
      expect(row?.variant).toBe("a");
      expect(row?.split).toBe("train");
      expect(row?.model).toBe("test-model");
      expect(row?.gitSha).toBe("abc123");
      expect(row?.scorer).toBe("set-membership");
      expect(row?.status).toBe("running");
      expect(row?.tsEnd).toBeNull();

      store.finishEvalRun(id1, { status: "ok" });
      store.finishEvalRun(id1, { status: "error" }); // no-op — first-terminal-wins
      expect(store.getEvalRun(id1)?.status).toBe("ok");

      const t2 = new Date("2026-05-11T18:05:00Z");
      const id2 = store.startEvalRun({
        tsStart: t2,
        setId: "set-1",
        targetId: "agent-a",
        variant: "b",
        split: "test",
      });
      const t3 = new Date("2026-05-11T18:10:00Z");
      const id3 = store.startEvalRun({
        tsStart: t3,
        setId: "set-2",
        targetId: "agent-b",
        variant: "a",
      });

      expect(
        store
          .listEvalRuns({ setId: "set-1" })
          .map((r) => r.id)
          .sort(),
      ).toEqual([id1, id2].sort());
      expect(
        store
          .listEvalRuns({ variant: "a" })
          .map((r) => r.id)
          .sort(),
      ).toEqual([id1, id3].sort());
      expect(store.listEvalRuns({ split: "train" }).map((r) => r.id)).toEqual([id1]);
      expect(store.listEvalRuns().map((r) => r.id)).toEqual([id3, id2, id1]); // newest first
      expect(store.listEvalRuns({ limit: 1 })).toHaveLength(1);
    });

    it("scorer omitted -> NULL (external scoring / harness rows); the list read carries the column", () => {
      const scored = store.startEvalRun({ setId: "s", scorer: "exact-match" });
      const unscored = store.startEvalRun({ setId: "s" });
      expect(store.getEvalRun(scored)?.scorer).toBe("exact-match");
      expect(store.getEvalRun(unscored)?.scorer).toBeNull();
      expect(
        store
          .listEvalRuns({ setId: "s" })
          .map((r) => r.scorer)
          .sort(),
      ).toEqual([null, "exact-match"].sort());
    });

    it("meta omitted -> null; meta provided -> parsed object on getEvalRun AND listEvalRuns", () => {
      const meta = { family: "e2e-answer", lens: { scope: "cross" } };
      const withMeta = store.startEvalRun({ setId: "s", meta });
      const without = store.startEvalRun({ setId: "s" });

      expect(store.getEvalRun(withMeta)?.meta).toEqual(meta);
      expect(store.getEvalRun(without)?.meta).toBeNull();

      const listed = new Map(store.listEvalRuns({ setId: "s" }).map((r) => [r.id, r.meta]));
      expect(listed.get(withMeta)).toEqual(meta);
      expect(listed.get(without)).toBeNull();
    });
  });

  describe("eval_set meta", () => {
    it("meta omitted -> null; provided -> parsed; ON CONFLICT re-upsert replaces meta, created_ts unchanged", () => {
      store.upsertEvalSet({ id: "plain" });
      store.upsertEvalSet({
        id: "family",
        createdTs: new Date("2026-01-01T00:00:00Z"),
        meta: { family: "retrieval", version: 1 },
      });

      let bySet = new Map(store.listEvalSets().map((s) => [s.id, s]));
      expect(bySet.get("plain")?.meta).toBeNull();
      expect(bySet.get("family")?.meta).toEqual({ family: "retrieval", version: 1 });

      // Second upsert with different meta: last write wins, created_ts kept
      // (the ON CONFLICT clause deliberately never touches created_ts).
      store.upsertEvalSet({ id: "family", meta: { family: "retrieval", version: 2 } });
      bySet = new Map(store.listEvalSets().map((s) => [s.id, s]));
      expect(bySet.get("family")?.meta).toEqual({ family: "retrieval", version: 2 });
      expect(bySet.get("family")?.createdTs).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  describe("v3 -> v4 in-place migration", () => {
    it("adds eval_run.scorer to a hand-built v3 DB; pre-v4 rows read scorer NULL", () => {
      const fs = require("node:fs") as typeof import("node:fs");
      const os = require("node:os") as typeof import("node:os");
      const path = require("node:path") as typeof import("node:path");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evalstore-migrate-v4-"));
      const dbPath = path.join(dir, "events.db");

      // Hand-build a v3 DB: the v2 tables plus the four eval tables WITHOUT
      // the scorer column (the exact pre-#scorer eval_run shape).
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL, timestamp TEXT NOT NULL, trace_id TEXT, run_id TEXT,
          span_id TEXT, cc_session_id TEXT, cc_hook_name TEXT, cc_cwd TEXT, data TEXT NOT NULL
        );
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY, trace_id TEXT, ts_start TEXT NOT NULL, ts_end TEXT,
          agent_name TEXT, model TEXT, system_prompt TEXT, agent_config TEXT, final_answer TEXT,
          tool_calls INTEGER, iterations INTEGER, input_tokens INTEGER, output_tokens INTEGER,
          finish_reason TEXT, elapsed_ms INTEGER, status TEXT NOT NULL, error TEXT,
          step_metrics TEXT, metadata TEXT
        );
        CREATE TABLE eval_set (id TEXT PRIMARY KEY, name TEXT, description TEXT, created_ts TEXT NOT NULL);
        CREATE TABLE eval_case (
          set_id TEXT NOT NULL, case_id TEXT NOT NULL, input_json TEXT, expected_json TEXT,
          tags_json TEXT, split TEXT, PRIMARY KEY (set_id, case_id)
        );
        CREATE TABLE eval_run (
          id TEXT PRIMARY KEY, ts_start TEXT NOT NULL, ts_end TEXT, set_id TEXT, target_id TEXT,
          variant TEXT, split TEXT, model TEXT, git_sha TEXT, status TEXT NOT NULL
        );
        CREATE TABLE eval_result (
          eval_run_id TEXT NOT NULL, case_id TEXT NOT NULL, run_id TEXT, scores_json TEXT,
          pass INTEGER, PRIMARY KEY (eval_run_id, case_id)
        );
      `);
      raw
        .prepare("INSERT INTO eval_run (id, ts_start, set_id, status) VALUES (?, ?, ?, ?)")
        .run("legacy-run", "2026-05-11T18:00:00.000Z", "set-legacy", "ok");
      raw.pragma("user_version = 3");
      raw.close();

      // Reopen via EvalStore: ALTER lands, the legacy row reads scorer NULL,
      // and a fresh insert round-trips a scorer id.
      const es = new EvalStore({ path: dbPath, Database });
      expect(es.getEvalRun("legacy-run")?.scorer).toBeNull();
      const scored = es.startEvalRun({ setId: "set-legacy", scorer: "none" });
      expect(es.getEvalRun(scored)?.scorer).toBe("none");
      es.close();

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("v4 -> v5 in-place migration", () => {
    it("adds meta_json to eval_run AND eval_set in a hand-built v4 DB; pre-v5 rows read meta null", () => {
      const fs = require("node:fs") as typeof import("node:fs");
      const os = require("node:os") as typeof import("node:os");
      const path = require("node:path") as typeof import("node:path");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evalstore-migrate-v5-"));
      const dbPath = path.join(dir, "events.db");

      // Hand-build a v4 DB: the v3 tables PLUS eval_run.scorer, WITHOUT
      // meta_json anywhere (the exact pre-v5 shape).
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL, timestamp TEXT NOT NULL, trace_id TEXT, run_id TEXT,
          span_id TEXT, cc_session_id TEXT, cc_hook_name TEXT, cc_cwd TEXT, data TEXT NOT NULL
        );
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY, trace_id TEXT, ts_start TEXT NOT NULL, ts_end TEXT,
          agent_name TEXT, model TEXT, system_prompt TEXT, agent_config TEXT, final_answer TEXT,
          tool_calls INTEGER, iterations INTEGER, input_tokens INTEGER, output_tokens INTEGER,
          finish_reason TEXT, elapsed_ms INTEGER, status TEXT NOT NULL, error TEXT,
          step_metrics TEXT, metadata TEXT
        );
        CREATE TABLE eval_set (id TEXT PRIMARY KEY, name TEXT, description TEXT, created_ts TEXT NOT NULL);
        CREATE TABLE eval_case (
          set_id TEXT NOT NULL, case_id TEXT NOT NULL, input_json TEXT, expected_json TEXT,
          tags_json TEXT, split TEXT, PRIMARY KEY (set_id, case_id)
        );
        CREATE TABLE eval_run (
          id TEXT PRIMARY KEY, ts_start TEXT NOT NULL, ts_end TEXT, set_id TEXT, target_id TEXT,
          variant TEXT, split TEXT, model TEXT, git_sha TEXT, status TEXT NOT NULL, scorer TEXT
        );
        CREATE TABLE eval_result (
          eval_run_id TEXT NOT NULL, case_id TEXT NOT NULL, run_id TEXT, scores_json TEXT,
          pass INTEGER, PRIMARY KEY (eval_run_id, case_id)
        );
      `);
      raw
        .prepare("INSERT INTO eval_run (id, ts_start, set_id, status) VALUES (?, ?, ?, ?)")
        .run("legacy-run", "2026-05-11T18:00:00.000Z", "set-legacy", "ok");
      raw
        .prepare("INSERT INTO eval_set (id, name, created_ts) VALUES (?, ?, ?)")
        .run("set-legacy", "Legacy Set", "2026-05-11T18:00:00.000Z");
      raw.pragma("user_version = 4");
      raw.close();

      // Reopen via EvalStore: both ALTERs land; the legacy run AND set read
      // meta null; fresh writes round-trip a meta object.
      const es = new EvalStore({ path: dbPath, Database });
      expect(es.getEvalRun("legacy-run")?.meta).toBeNull();
      expect(es.listEvalSets().find((s) => s.id === "set-legacy")?.meta).toBeNull();

      const withMeta = es.startEvalRun({ setId: "set-legacy", meta: { family: "e2e-answer" } });
      expect(es.getEvalRun(withMeta)?.meta).toEqual({ family: "e2e-answer" });
      es.upsertEvalSet({ id: "set-new", meta: { kind: "eval-family" } });
      expect(es.listEvalSets().find((s) => s.id === "set-new")?.meta).toEqual({
        kind: "eval-family",
      });
      es.close();

      // The ladder stamped the file at v5.
      const check = new Database(dbPath);
      expect(check.pragma("user_version", { simple: true })).toBe(5);
      check.close();

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("onResult wiring (integration, the acceptance path)", () => {
    it("persists one runs row + one eval_result row per case; evalRunResults reads run-owned fields through the join", async () => {
      const evalRunId = store.startEvalRun({
        setId: "set-x",
        targetId: "target-x",
        variant: "a",
        split: "train",
      });

      const report = await runEval(
        {
          target: new FunctionStep<string, string>({ fn: (i) => i.toUpperCase() }),
          cases: [
            { id: "1", input: "a", expected: "A" },
            { id: "2", input: "b", expected: "B" },
          ],
          scorers: [],
          onResult: (r) => {
            const runId = store.startRun({
              agentName: "target-x",
              metadata: { evalRunId, caseId: r.case.id, variant: "a", split: "train" },
            });
            store.finishRun(runId, {
              finalAnswer: JSON.stringify(r.output ?? null),
              toolCalls: 0,
              iterations: 0,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              finishReason: r.succeeded ? "stop" : "error",
              elapsedMs: 0,
              status: r.succeeded ? "ok" : "error",
              error: r.error,
            });
            store.recordEvalResult({
              evalRunId,
              caseId: r.case.id,
              runId,
              scores: r.scores,
              pass: derivePass(r.scores),
            });
          },
        },
        { runner: new MockRunner() },
      );
      store.finishEvalRun(evalRunId, { status: "ok" });

      expect(report.summary.cases).toBe(2);
      expect(store.getEvalRun(evalRunId)?.status).toBe("ok");

      // metadata carries the join keys — read back via getRun().metadata
      const runs = store.listRuns();
      expect(runs).toHaveLength(2);
      for (const r of runs) {
        const full = store.getRun(r.runId);
        expect(full?.metadata?.evalRunId).toBe(evalRunId);
        expect(["1", "2"]).toContain(full?.metadata?.caseId);
      }

      const joined = store.evalRunResults(evalRunId);
      expect(joined).toHaveLength(2);
      const byCase = new Map(joined.map((j) => [j.caseId, j]));
      expect(byCase.get("1")?.finalAnswer).toBe(JSON.stringify("A"));
      expect(byCase.get("2")?.finalAnswer).toBe(JSON.stringify("B"));
      for (const j of joined) {
        expect(j.runStatus).toBe("ok");
        expect(j.finishReason).toBe("stop");
        expect(j.inputTokens).not.toBeNull();
        expect(j.outputTokens).not.toBeNull();
        expect(j.runId).not.toBeNull();
      }
    });
  });

  describe("join proves no duplication (the load-bearing test)", () => {
    it("eval_result has exactly the annotation columns; mutating the runs row directly is reflected via evalRunResults", () => {
      const inspectable = new InspectableEvalStore({ path: ":memory:", Database });
      const raw = inspectable.rawDb();

      const columns = (
        raw.prepare("PRAGMA table_info(eval_result)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toEqual(["eval_run_id", "case_id", "run_id", "scores_json", "pass"]);

      const runId = inspectable.startRun({ agentName: "agent-a" });
      inspectable.finishRun(runId, {
        finalAnswer: "original",
        toolCalls: 0,
        iterations: 0,
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
        elapsedMs: 1,
        status: "ok",
      });
      const evalRunId = inspectable.startEvalRun({ setId: "set-1" });
      inspectable.recordEvalResult({ evalRunId, caseId: "c1", runId, scores: [], pass: true });

      expect(inspectable.evalRunResults(evalRunId)[0]?.finalAnswer).toBe("original");

      // Mutate the runs row directly — bypassing every EvalStore method.
      raw.prepare("UPDATE runs SET final_answer = ? WHERE run_id = ?").run("mutated!", runId);

      // The join reads through: nothing was copied onto eval_result.
      expect(inspectable.evalRunResults(evalRunId)[0]?.finalAnswer).toBe("mutated!");

      inspectable.close();
    });
  });

  describe("recordEvalResult idempotency", () => {
    it("re-recording the same (evalRunId, caseId) is one row — second write wins", () => {
      const runId = store.startRun();
      store.finishRun(runId, {
        finalAnswer: "x",
        toolCalls: 0,
        iterations: 0,
        inputTokens: 0,
        outputTokens: 0,
        finishReason: "stop",
        elapsedMs: 0,
        status: "ok",
      });
      const evalRunId = store.startEvalRun();

      store.recordEvalResult({
        evalRunId,
        caseId: "c1",
        runId,
        scores: [{ name: "exact", value: 0, passed: false }],
        pass: false,
      });
      store.recordEvalResult({
        evalRunId,
        caseId: "c1",
        runId,
        scores: [{ name: "exact", value: 1, passed: true }],
        pass: true,
      });

      const rows = store.evalRunResults(evalRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.pass).toBe(true);
      expect(rows[0]?.scores).toEqual([{ name: "exact", value: 1, passed: true }]);
    });
  });

  describe("ingestEvalRun", () => {
    // Score[] — the same shape as EvalResultRecord.scores; the ONE shape
    // parseScores surfaces on the read path.
    const scoresOf = (passed: boolean) => [{ name: "exact", value: passed ? 1 : 0, passed }];

    it("fresh ingest: replaced false; ts_start/ts_end/status/meta land VERBATIM (never stamped with now())", () => {
      const { replaced } = store.ingestEvalRun({
        run: {
          id: "imported-1",
          setId: "set-x",
          targetId: "agent-a",
          variant: "a",
          split: "test",
          model: "m1",
          gitSha: "abc123",
          scorer: "exact-match",
          tsStart: "2025-12-01T00:00:00.000Z", // long before "now" — proves verbatim
          tsEnd: "2025-12-01T00:05:00.000Z",
          status: "ok",
          meta: { family: "e2e-answer" },
        },
        results: [
          { caseId: "c1", pass: true, scores: scoresOf(true) },
          { caseId: "c2", pass: false, scores: scoresOf(false) },
          { caseId: "c3", pass: true }, // scores omitted -> NULL
        ],
      });
      expect(replaced).toBe(false);

      const row = store.getEvalRun("imported-1");
      expect(row?.tsStart).toBe("2025-12-01T00:00:00.000Z");
      expect(row?.tsEnd).toBe("2025-12-01T00:05:00.000Z");
      expect(row?.status).toBe("ok");
      expect(row?.setId).toBe("set-x");
      expect(row?.targetId).toBe("agent-a");
      expect(row?.variant).toBe("a");
      expect(row?.split).toBe("test");
      expect(row?.model).toBe("m1");
      expect(row?.gitSha).toBe("abc123");
      expect(row?.scorer).toBe("exact-match");
      expect(row?.meta).toEqual({ family: "e2e-answer" });

      const results = store.evalRunResults("imported-1");
      expect(results).toHaveLength(3);
      const byCase = new Map(results.map((r) => [r.caseId, r]));
      expect(byCase.get("c1")?.pass).toBe(true);
      expect(byCase.get("c1")?.scores).toEqual([{ name: "exact", value: 1, passed: true }]);
      expect(byCase.get("c2")?.pass).toBe(false);
      expect(byCase.get("c2")?.scores).toEqual([{ name: "exact", value: 0, passed: false }]);
      expect(byCase.get("c3")?.scores).toBeNull();
      // Imported cases carry no RunStore runs row — run_id stays NULL.
      expect(byCase.get("c1")?.runId).toBeNull();
    });

    it("re-ingest same id with FEWER results: replaced true, the stale result row is GONE, exactly one eval_run row", () => {
      const inspectable = new InspectableEvalStore({ path: ":memory:", Database });

      const run = {
        id: "imported-1",
        setId: "set-x",
        targetId: "agent-a",
        tsStart: "2025-12-01T00:00:00.000Z",
        tsEnd: "2025-12-01T00:05:00.000Z",
        status: "ok" as const,
        meta: { attempt: 1 },
      };
      expect(
        inspectable.ingestEvalRun({
          run,
          results: [
            { caseId: "c1", pass: true },
            { caseId: "c2", pass: false },
          ],
        }).replaced,
      ).toBe(false);

      // Re-ingest with only c1 — the whole point of delete-then-insert: the
      // stale c2 row must vanish (an upsert could never shrink the set).
      expect(
        inspectable.ingestEvalRun({
          run: { ...run, meta: { attempt: 2 } },
          results: [{ caseId: "c1", pass: true }],
        }).replaced,
      ).toBe(true);

      expect(inspectable.evalRunResults("imported-1").map((r) => r.caseId)).toEqual(["c1"]);
      expect(inspectable.getEvalRun("imported-1")?.meta).toEqual({ attempt: 2 });

      const { n } = inspectable
        .rawDb()
        .prepare("SELECT COUNT(*) AS n FROM eval_run WHERE id = ?")
        .get("imported-1") as { n: number };
      expect(n).toBe(1);

      inspectable.close();
    });

    it("status 'error' is written verbatim", () => {
      store.ingestEvalRun({
        run: {
          id: "imported-err",
          setId: "set-x",
          targetId: "agent-a",
          tsStart: "2025-12-02T00:00:00.000Z",
          tsEnd: "2025-12-02T00:01:00.000Z",
          status: "error",
        },
        results: [],
      });
      expect(store.getEvalRun("imported-err")?.status).toBe("error");
      expect(store.getEvalRun("imported-err")?.meta).toBeNull();
    });
  });

  describe("A/B compare", () => {
    it("aligns per case; one-sided cases carry null for the missing side; summary counts are correct", () => {
      const evalRunA = store.startEvalRun({ setId: "set-1", variant: "a" });
      const evalRunB = store.startEvalRun({ setId: "set-1", variant: "b" });

      // c1: both pass. c2: both fail. c3: A passes, B fails (regression).
      // c4: A fails, B passes (improvement). c5: only in A. c6: only in B.
      const record = (evalRunId: string, caseId: string, pass: boolean | null) =>
        store.recordEvalResult({ evalRunId, caseId, scores: [], pass });

      record(evalRunA, "c1", true);
      record(evalRunB, "c1", true);
      record(evalRunA, "c2", false);
      record(evalRunB, "c2", false);
      record(evalRunA, "c3", true);
      record(evalRunB, "c3", false);
      record(evalRunA, "c4", false);
      record(evalRunB, "c4", true);
      record(evalRunA, "c5", true);
      record(evalRunB, "c6", true);

      const cmp = store.compareEvalRuns(evalRunA, evalRunB);
      expect(cmp.a.id).toBe(evalRunA);
      expect(cmp.b.id).toBe(evalRunB);
      expect(cmp.rows).toHaveLength(6);

      expect(cmp.summary).toEqual({
        bothPassed: 1,
        bothFailed: 1,
        onlyAPassed: 1,
        onlyBPassed: 1,
        aOnly: 1,
        bOnly: 1,
      });

      const c5 = cmp.rows.find((r) => r.caseId === "c5");
      expect(c5?.a?.pass).toBe(true);
      expect(c5?.b).toBeNull();

      const c6 = cmp.rows.find((r) => r.caseId === "c6");
      expect(c6?.a).toBeNull();
      expect(c6?.b?.pass).toBe(true);
    });

    it("throws on an unknown eval run id", () => {
      const evalRunA = store.startEvalRun();
      expect(() => store.compareEvalRuns(evalRunA, "no-such-run")).toThrow();
      expect(() => store.compareEvalRuns("no-such-run", evalRunA)).toThrow();
    });
  });

  describe("splitAggregates", () => {
    it("computes per-split pass rates; case-level split wins over run-level; unmirrored cases fall back; null-pass results are counted but excluded from passRate", () => {
      store.upsertEvalCase("set-1", { caseId: "train-1", split: "train" });
      store.upsertEvalCase("set-1", { caseId: "train-2", split: "train" });
      store.upsertEvalCase("set-1", { caseId: "test-1", split: "test" });

      const evalRunId = store.startEvalRun({ setId: "set-1", targetId: "agent-a", variant: "a" });

      // Two train cases (mirrored split wins over the run-level label below).
      store.recordEvalResult({ evalRunId, caseId: "train-1", scores: [], pass: true });
      store.recordEvalResult({ evalRunId, caseId: "train-2", scores: [], pass: false });
      // One test case.
      store.recordEvalResult({ evalRunId, caseId: "test-1", scores: [], pass: true });
      // A case NOT in the mirror — falls back to eval_run.split (COALESCE branch).
      const runWithSplit = store.startEvalRun({
        setId: "set-1",
        targetId: "agent-a",
        variant: "a",
        split: "dev",
      });
      store.recordEvalResult({
        evalRunId: runWithSplit,
        caseId: "unmirrored-1",
        scores: [],
        pass: true,
      });
      // A result with pass = NULL: counted in results, excluded from passRate.
      store.recordEvalResult({
        evalRunId: runWithSplit,
        caseId: "unmirrored-2",
        scores: [],
        pass: null,
      });

      const aggs = store.splitAggregates({ setId: "set-1" });
      const bySplit = new Map(aggs.map((a) => [a.split, a]));

      const train = bySplit.get("train");
      expect(train?.results).toBe(2);
      expect(train?.passed).toBe(1);
      expect(train?.failed).toBe(1);
      expect(train?.passRate).toBeCloseTo(0.5);

      const test = bySplit.get("test");
      expect(test?.results).toBe(1);
      expect(test?.passed).toBe(1);
      expect(test?.passRate).toBe(1);

      const dev = bySplit.get("dev");
      expect(dev?.results).toBe(2);
      expect(dev?.passed).toBe(1);
      expect(dev?.failed).toBe(0);
      expect(dev?.passRate).toBe(1); // null-pass result excluded from the rate, still counted in results
    });
  });

  describe("evalRunSummaries", () => {
    it("rolls up per-run pass counts; ungated excludes null-pass; result-less runs are absent; honors filters", () => {
      // Run A: 1 pass, 1 fail, 1 ungated (null pass).
      const runA = store.startEvalRun({ setId: "set-1", targetId: "agent-a", variant: "a" });
      store.recordEvalResult({ evalRunId: runA, caseId: "c1", scores: [], pass: true });
      store.recordEvalResult({ evalRunId: runA, caseId: "c2", scores: [], pass: false });
      store.recordEvalResult({ evalRunId: runA, caseId: "c3", scores: [], pass: null });

      // Run B: 2 pass — a different variant, same set (filter coverage).
      const runB = store.startEvalRun({ setId: "set-1", targetId: "agent-a", variant: "b" });
      store.recordEvalResult({ evalRunId: runB, caseId: "c1", scores: [], pass: true });
      store.recordEvalResult({ evalRunId: runB, caseId: "c2", scores: [], pass: true });

      // Run C: started but never recorded a result — absent from the rollup.
      const runC = store.startEvalRun({ setId: "set-1", targetId: "agent-a", variant: "c" });

      const byId = new Map(store.evalRunSummaries({ setId: "set-1" }).map((s) => [s.evalRunId, s]));

      expect(byId.get(runA)).toEqual({
        evalRunId: runA,
        cases: 3,
        passed: 1,
        failed: 1,
        ungated: 1,
        passRate: 0.5,
      });
      expect(byId.get(runB)).toEqual({
        evalRunId: runB,
        cases: 2,
        passed: 2,
        failed: 0,
        ungated: 0,
        passRate: 1,
      });
      // No eval_result rows -> no group -> absent (the list falls back to no summary).
      expect(byId.has(runC)).toBe(false);

      // Facet filter narrows to a single run.
      expect(store.evalRunSummaries({ variant: "b" }).map((s) => s.evalRunId)).toEqual([runB]);
    });

    it("a fully-ungated run yields passRate null", () => {
      const run = store.startEvalRun({ setId: "set-x", targetId: "agent-a" });
      store.recordEvalResult({ evalRunId: run, caseId: "c1", scores: [], pass: null });
      const [summary] = store.evalRunSummaries({ setId: "set-x" });
      expect(summary).toEqual({
        evalRunId: run,
        cases: 1,
        passed: 0,
        failed: 0,
        ungated: 1,
        passRate: null,
      });
    });
  });

  describe("derivePass", () => {
    it("all gated scores passed -> true", () => {
      expect(
        derivePass([
          { name: "a", value: 1, passed: true },
          { name: "b", value: 1, passed: true },
        ]),
      ).toBe(true);
    });

    it("one gated failure -> false", () => {
      expect(
        derivePass([
          { name: "a", value: 1, passed: true },
          { name: "b", value: 0, passed: false },
        ]),
      ).toBe(false);
    });

    it("no scores carry `passed` -> null", () => {
      expect(derivePass([{ name: "a", value: 1 }])).toBeNull();
      expect(derivePass([])).toBeNull();
    });

    it("an errored score (value: null, no passed) alone -> null", () => {
      expect(derivePass([{ name: "a", value: null, error: "boom" }])).toBeNull();
    });
  });

  describe("loadEvalStore", () => {
    it("happy path returns a live EvalStore (better-sqlite3 is a devDependency here)", async () => {
      const { loadEvalStore } = await import("../load.js");
      const result = await loadEvalStore({ path: ":memory:" });
      expect(result.unavailable).toBe(false);
      expect(result.store).toBeInstanceOf(EvalStore);
      expect(result.reason).toContain(":memory:");
      result.store?.close();
    });
  });
});
