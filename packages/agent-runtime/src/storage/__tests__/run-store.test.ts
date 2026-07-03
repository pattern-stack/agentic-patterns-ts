/**
 * RunStore unit tests. Uses an in-memory SQLite database so the suite does
 * not touch the filesystem (event-store.test.ts precedent), plus a couple
 * of on-disk tests for the v1 -> v2 migration.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEval } from "../../eval/run-eval.js";
import type { BaseEvent } from "../../events/types.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { FunctionStep } from "../../workflows/function-step.js";
import { EventStore } from "../event-store.js";
import type { RunOutcome } from "../run-store.js";
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

/** A finished-ok outcome with sensible defaults, overridable per-field. */
function mkOutcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    finalAnswer: "done",
    toolCalls: 0,
    iterations: 1,
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "stop",
    elapsedMs: 1,
    status: "ok",
    ...overrides,
  };
}

describe("RunStore", () => {
  let store: RunStore;

  beforeEach(() => {
    store = new RunStore({ path: ":memory:", Database });
  });

  afterEach(() => {
    store.close();
  });

  describe("v1 -> v2 migration", () => {
    it("migrates a hand-built v1 events-only DB in place; EventStore also opens the v2 file", () => {
      const fs = require("node:fs") as typeof import("node:fs");
      const os = require("node:os") as typeof import("node:os");
      const path = require("node:path") as typeof import("node:path");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runstore-migrate-"));
      const dbPath = path.join(dir, "events.db");

      // Build a v1 events-only DB by hand (a raw Database, not via EventStore
      // — EventStore's own TARGET_SCHEMA_VERSION is now 2, so opening it
      // fresh would already create the runs table).
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
      raw.pragma("user_version = 1");
      raw.close();

      // Reopen via RunStore: migrates to v2 — runs table exists, existing
      // event rows intact, user_version = 2.
      const rs = new RunStore({ path: dbPath, Database });
      expect(rs.count()).toBe(1);
      const runId = rs.startRun({ agentName: "x" });
      expect(rs.getRun(runId)).not.toBeNull();
      rs.close();

      // Plain EventStore also opens a v2 file (shared TARGET_SCHEMA_VERSION).
      const es = new EventStore({ path: dbPath, Database });
      expect(es.count()).toBe(1);
      es.close();

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("startRun/finishRun round-trip", () => {
    it("round-trips all RunRow fields, incl. JSON round-trip of agentConfig/stepMetrics/metadata", () => {
      const runId = store.startRun({
        traceId: "trace-a",
        tsStart: new Date("2026-05-11T18:00:00Z"),
        agentName: "agent-a",
        model: "test-model",
        systemPrompt: "You are helpful.",
        agentConfig: { role: "agent-a", model: "test-model", tools: ["t1"] },
        metadata: { caseId: "case-1" },
      });

      const stepMetrics = [
        {
          iteration: 0,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 1,
          llmDurationMs: 12,
          hasMore: true,
        },
      ];
      store.finishRun(
        runId,
        mkOutcome({
          finalAnswer: "42",
          toolCalls: 2,
          iterations: 3,
          inputTokens: 100,
          outputTokens: 50,
          finishReason: "stop",
          elapsedMs: 1234,
          status: "ok",
          stepMetrics,
        }),
      );

      const row = store.getRun(runId);
      expect(row).not.toBeNull();
      expect(row?.runId).toBe(runId);
      expect(row?.traceId).toBe("trace-a");
      expect(row?.agentName).toBe("agent-a");
      expect(row?.model).toBe("test-model");
      expect(row?.systemPrompt).toBe("You are helpful.");
      expect(row?.agentConfig).toEqual({ role: "agent-a", model: "test-model", tools: ["t1"] });
      expect(row?.finalAnswer).toBe("42");
      expect(row?.toolCalls).toBe(2);
      expect(row?.iterations).toBe(3);
      expect(row?.inputTokens).toBe(100);
      expect(row?.outputTokens).toBe(50);
      expect(row?.finishReason).toBe("stop");
      expect(row?.elapsedMs).toBe(1234);
      expect(row?.status).toBe("ok");
      expect(row?.error).toBeNull();
      expect(row?.stepMetrics).toEqual(stepMetrics);
      expect(row?.metadata).toEqual({ caseId: "case-1" });
    });

    it("generates a runId when omitted, honors a supplied runId", () => {
      const generated = store.startRun();
      expect(typeof generated).toBe("string");
      expect(generated.length).toBeGreaterThan(0);

      const supplied = store.startRun({ runId: "my-run-id" });
      expect(supplied).toBe("my-run-id");
      expect(store.getRun("my-run-id")).not.toBeNull();
    });

    it("re-finalizing is a no-op — first finalize wins", () => {
      const runId = store.startRun();
      store.finishRun(runId, mkOutcome({ finalAnswer: "first", status: "ok" }));
      store.finishRun(
        runId,
        mkOutcome({ finalAnswer: "second", status: "error", error: "should not apply" }),
      );

      const row = store.getRun(runId);
      expect(row?.finalAnswer).toBe("first");
      expect(row?.status).toBe("ok");
      expect(row?.error).toBeNull();
    });
  });

  describe("listRuns", () => {
    it("lists newest first and supports limit/status/agentName/since filters", () => {
      const t1 = new Date("2026-05-11T18:00:00Z");
      const t2 = new Date("2026-05-11T18:05:00Z");
      const t3 = new Date("2026-05-11T18:10:00Z");

      const r1 = store.startRun({ tsStart: t1, agentName: "agent-a" });
      store.finishRun(r1, mkOutcome());

      const r2 = store.startRun({ tsStart: t2, agentName: "agent-b" });
      store.finishRun(r2, mkOutcome({ status: "error", error: "boom", finishReason: "error" }));

      const r3 = store.startRun({ tsStart: t3, agentName: "agent-a" }); // left running

      expect(store.listRuns().map((r) => r.runId)).toEqual([r3, r2, r1]);
      expect(store.listRuns({ limit: 1 })).toHaveLength(1);
      expect(store.listRuns({ status: "error" }).map((r) => r.runId)).toEqual([r2]);
      expect(store.listRuns({ status: "running" }).map((r) => r.runId)).toEqual([r3]);
      expect(store.listRuns({ agentName: "agent-a" }).map((r) => r.runId)).toEqual([r3, r1]);
      expect(store.listRuns({ since: t2 }).map((r) => r.runId)).toEqual([r3, r2]);
    });

    it("projection carries answerLength/hasPrompt and omits the blob columns", () => {
      const runId = store.startRun({ systemPrompt: "a system prompt" });
      store.finishRun(runId, mkOutcome({ finalAnswer: "hello world" }));

      const [summary] = store.listRuns();
      expect(summary?.answerLength).toBe("hello world".length);
      expect(summary?.hasPrompt).toBe(true);
      expect(summary).not.toHaveProperty("finalAnswer");
      expect(summary).not.toHaveProperty("systemPrompt");
    });

    it("a running row (no finalAnswer/systemPrompt) projects answerLength 0 / hasPrompt false", () => {
      store.startRun();
      const [summary] = store.listRuns();
      expect(summary?.answerLength).toBe(0);
      expect(summary?.hasPrompt).toBe(false);
    });
  });

  describe("getRun", () => {
    it("returns by exact id and by unique prefix; null on miss", () => {
      const runId = store.startRun();
      expect(store.getRun(runId)?.runId).toBe(runId);
      expect(store.getRun(runId.slice(0, 8))?.runId).toBe(runId);
      expect(store.getRun("no-such-run")).toBeNull();
    });

    it("returns null on an ambiguous prefix", () => {
      const r1 = store.startRun({ runId: "abc-1" });
      const r2 = store.startRun({ runId: "abc-2" });
      expect(store.getRun("abc-")).toBeNull();
      expect(store.getRun(r1)?.runId).toBe(r1);
      expect(store.getRun(r2)?.runId).toBe(r2);
    });
  });

  describe("runEvents", () => {
    it("returns the append()ed per-run ordered event streams for interleaved runIds", () => {
      store.append(mkEvent({ runId: "run-a", spanId: "s1", type: "agent.message.start" }));
      store.append(mkEvent({ runId: "run-b", spanId: "s2", type: "agent.message.start" }));
      store.append(mkEvent({ runId: "run-a", spanId: "s3", type: "agent.message.complete" }));
      store.append(mkEvent({ runId: "run-b", spanId: "s4", type: "agent.message.complete" }));

      expect(store.runEvents("run-a").map((e) => e.spanId)).toEqual(["s1", "s3"]);
      expect(store.runEvents("run-b").map((e) => e.spanId)).toEqual(["s2", "s4"]);
      expect(store.runEvents("run-c")).toEqual([]);
    });
  });

  describe("stats", () => {
    it("aggregates counts by status + token sums + means, with filters", () => {
      const r1 = store.startRun({ agentName: "a", model: "m1" });
      store.finishRun(
        r1,
        mkOutcome({ iterations: 2, inputTokens: 10, outputTokens: 5, elapsedMs: 100 }),
      );

      const r2 = store.startRun({ agentName: "a", model: "m1" });
      store.finishRun(
        r2,
        mkOutcome({
          iterations: 1,
          inputTokens: 20,
          outputTokens: 10,
          elapsedMs: 50,
          status: "error",
          error: "boom",
        }),
      );

      store.startRun({ agentName: "b", model: "m2" }); // left running

      const stats = store.stats();
      expect(stats.runs).toBe(3);
      expect(stats.ok).toBe(1);
      expect(stats.error).toBe(1);
      expect(stats.running).toBe(1);
      expect(stats.totalInputTokens).toBe(30);
      expect(stats.totalOutputTokens).toBe(15);
      expect(stats.meanElapsedMs).toBeCloseTo(75); // avg over the 2 finished rows
      expect(stats.meanIterations).toBeCloseTo(1.5);

      const statsA = store.stats({ agentName: "a" });
      expect(statsA.runs).toBe(2);
      expect(statsA.running).toBe(0);

      const statsB = store.stats({ model: "m2" });
      expect(statsB.runs).toBe(1);
      expect(statsB.running).toBe(1);
      expect(statsB.meanElapsedMs).toBeNull();
      expect(statsB.meanIterations).toBeNull();
    });

    it("returns zeroed counts and null means on an empty store", () => {
      const stats = store.stats();
      expect(stats.runs).toBe(0);
      expect(stats.ok).toBe(0);
      expect(stats.error).toBe(0);
      expect(stats.running).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.meanElapsedMs).toBeNull();
      expect(stats.meanIterations).toBeNull();
    });
  });

  describe("sweepRunning", () => {
    it("marks stale 'running' rows errored and returns the count; finished rows are untouched", () => {
      const r1 = store.startRun();
      const r2 = store.startRun();
      store.finishRun(r2, mkOutcome());

      const swept = store.sweepRunning();
      expect(swept).toBe(1);

      expect(store.getRun(r1)?.status).toBe("error");
      expect(store.getRun(r1)?.error).toBeTruthy();
      expect(store.getRun(r2)?.status).toBe("ok"); // untouched — already finalized
    });

    it("is a no-op (returns 0) when nothing is running", () => {
      const runId = store.startRun();
      store.finishRun(runId, mkOutcome());
      expect(store.sweepRunning()).toBe(0);
    });
  });

  describe("secondary producer — runEval onResult seam (zero coupling to eval/)", () => {
    it("persists one row per case via the public startRun/finishRun API", async () => {
      const report = await runEval(
        {
          target: new FunctionStep<string, string>({ fn: (i) => i.toUpperCase() }),
          cases: [
            { id: "1", input: "a", expected: "A" },
            { id: "2", input: "b", expected: "B" },
          ],
          scorers: [],
          onResult: (r) => {
            const runId = store.startRun({ metadata: { caseId: r.case.id } });
            store.finishRun(runId, {
              finalAnswer: JSON.stringify(r.output),
              toolCalls: 0,
              iterations: 0,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              finishReason: r.succeeded ? "stop" : "error",
              elapsedMs: 0,
              status: r.succeeded ? "ok" : "error",
              error: r.error,
            });
          },
        },
        { runner: new MockRunner() },
      );

      expect(report.summary.cases).toBe(2);
      const rows = store.listRuns();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === "ok")).toBe(true);

      const withMeta = rows
        .map((r) => store.getRun(r.runId))
        .map((r) => r?.metadata?.caseId)
        .sort();
      expect(withMeta).toEqual(["1", "2"]);
    });
  });
});
