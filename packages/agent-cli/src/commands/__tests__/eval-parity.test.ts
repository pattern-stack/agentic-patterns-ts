/**
 * Store-parity lock (spec `.ai-docs/stacks/eval-surface/specs/139.md` § Tests,
 * T3): a UI-launched run (`POST /eval/runs`) and an `ap eval` run
 * (`runEvalCommand`, stored-set mode) must persist identical rows on the same
 * fixture — the acceptance headline, guarded against either path bypassing
 * the shared `createEvalResultRecorder` seam later.
 *
 * Lives in `agent-cli` (not `agent-server`) because it depends on both
 * `@agentic-patterns/server` (the write route) and `@agentic-patterns/runtime`
 * (the CLI command) — `agent-cli` already depends on both.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentEventBus,
  type AgentLike,
  type EvalRunRow,
  EvalStore,
  InMemoryAdminService,
  InMemoryEventCollector,
  type JoinedEvalResultRow,
  MockRunner,
  SSEExporter,
} from "@agentic-patterns/runtime";
import { createServer } from "@agentic-patterns/server";
import type { AgentRegistration } from "@agentic-patterns/server";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCommand } from "../eval.js";

// ---------------------------------------------------------------------------
// Shared fixture — one bank (pass / fail / expected-less / node-error, mixed
// splits), one target, one deterministic MockRunner configuration.
// ---------------------------------------------------------------------------

const PARITY_MODEL = "parity-model";

function makeParityTarget(id: string): AgentLike {
  return {
    role: { name: id },
    getModel: () => PARITY_MODEL,
    getTools: () => [],
    getSystemPrompt: () => "parity target",
    renderInitialPrompt: () => "parity target",
  };
}

/** Deterministic, matched by the case's INPUT string (the AgentLike bridge's prompt = input). */
function makeParityRunner(): MockRunner {
  return new MockRunner()
    .addResponse("boom-input", { content: "", error: new Error("boom") })
    .addResponse("hello-input", { content: "hello-output", inputTokens: 3, outputTokens: 2 })
    .addResponse("wrong-input", { content: "actual-output", inputTokens: 4, outputTokens: 1 })
    .addResponse("unscored-input", { content: "whatever-output", inputTokens: 1, outputTokens: 1 });
}

function seedBank(store: EvalStore): void {
  store.upsertEvalSet({ id: "parity-bank", name: "Parity bank" });
  store.upsertEvalCase("parity-bank", {
    caseId: "pass-case",
    input: "hello-input",
    expected: "hello-output",
    split: "train",
  });
  store.upsertEvalCase("parity-bank", {
    caseId: "fail-case",
    input: "wrong-input",
    expected: "right-output",
    split: "train",
  });
  store.upsertEvalCase("parity-bank", { caseId: "no-expected-case", input: "unscored-input" });
  store.upsertEvalCase("parity-bank", { caseId: "error-case", input: "boom-input", split: "dev" });
}

// ---------------------------------------------------------------------------
// Normalization — drop generated ids/timestamps; substitute the evalRunId
// token in `runs.metadata` and in traceIds (spec § Tests, T3).
// ---------------------------------------------------------------------------

interface NormalizedRun {
  setId: string | null;
  targetId: string | null;
  variant: string | null;
  split: string | null;
  model: string | null;
  status: string;
}

function normalizeEvalRun(run: EvalRunRow): NormalizedRun {
  return {
    setId: run.setId,
    targetId: run.targetId,
    variant: run.variant,
    split: run.split,
    model: run.model,
    status: run.status,
  };
}

interface NormalizedResult {
  caseId: string;
  agentName: string | null;
  model: string | null;
  metadata: Record<string, unknown> | null;
  finalAnswer: string | null;
  finishReason: string | null;
  status: string | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  traceIdShape: string | null;
  scores: unknown;
  pass: boolean | null;
}

function substituteRunId(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return null;
  const { evalRunId: _drop, ...rest } = metadata;
  return { ...rest, evalRunId: "<RUN>" };
}

function normalizeResults(
  store: EvalStore,
  evalRunId: string,
  rows: readonly JoinedEvalResultRow[],
): NormalizedResult[] {
  return [...rows]
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
    .map((r) => {
      const runRow = r.runId ? store.getRun(r.runId) : null;
      return {
        caseId: r.caseId,
        agentName: runRow?.agentName ?? null,
        model: runRow?.model ?? null,
        metadata: substituteRunId(runRow?.metadata ?? null),
        finalAnswer: r.finalAnswer,
        finishReason: r.finishReason,
        status: r.runStatus,
        error: r.runError,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        traceIdShape: r.traceId ? r.traceId.replace(evalRunId, "<RUN>") : null,
        scores: r.scores,
        pass: r.pass,
      };
    });
}

// ---------------------------------------------------------------------------
// Env isolation (AGENT_MODEL pins the CLI path's model to match evalExecution.model)
// ---------------------------------------------------------------------------

function stubStdout() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

const ENV_KEYS = ["AGENT_MODEL", "AGENT_TIER"] as const;

function stashEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let envSaved: Record<string, string | undefined>;
let dirs: string[] = [];
let stdoutSpy: ReturnType<typeof stubStdout>;

beforeEach(() => {
  envSaved = stashEnv();
  process.env.AGENT_MODEL = PARITY_MODEL;
  dirs = [];
  process.exitCode = undefined;
  // The fixture deliberately includes a failing + an errored case (gate
  // exercise, not the point of this test) — `runEvalCommand` prints progress
  // and sets `process.exitCode = 1`; suppress the former and restore the
  // latter so this test doesn't affect the overall suite's exit status.
  stdoutSpy = stubStdout();
});

afterEach(() => {
  stdoutSpy.mockRestore();
  process.exitCode = undefined;
  restoreEnv(envSaved);
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

function mkTempDb(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return join(dir, "events.db");
}

// ---------------------------------------------------------------------------
// The parity test
// ---------------------------------------------------------------------------

describe("eval store parity — UI path vs `ap eval` path", () => {
  it("persist identical eval_run / runs / eval_result rows on the same fixture", async () => {
    const target = makeParityTarget("parity-target");

    // ---- Path A: `ap eval` stored-set mode ---------------------------------
    const dbFileA = mkTempDb("ap-eval-parity-a-");
    const seedA = new EvalStore({ path: dbFileA, Database });
    seedBank(seedA);
    seedA.close();

    await runEvalCommand({
      agents: [
        { id: "parity-target", name: "parity-target", agent: target, file: "/virtual/parity.ts" },
      ],
      set: "parity-bank",
      db: dbFileA,
      variant: "parity",
      runner: makeParityRunner(),
    });

    const storeA = new EvalStore({ path: dbFileA, Database });
    const runsA = storeA.listEvalRuns();
    expect(runsA).toHaveLength(1);
    const runA = runsA[0];
    if (!runA) throw new Error("unreachable");
    const resultsA = storeA.evalRunResults(runA.id);

    // ---- Path B: POST /eval/runs (the server write route) ------------------
    const dbFileB = mkTempDb("ap-eval-parity-b-");
    const storeB = new EvalStore({ path: dbFileB, Database });
    seedBank(storeB);

    const registration: AgentRegistration = {
      id: "parity-target",
      name: "parity-target",
      agent: target,
      // Never used by the route (evalExecution.runner is the one threaded into
      // runEval) — present only to satisfy AgentRegistration's shape.
      runner: new MockRunner(),
    };

    const app = createServer({
      agents: [registration],
      adminService: new InMemoryAdminService(new InMemoryEventCollector()),
      eventBus: new AgentEventBus(),
      sseExporter: new SSEExporter(),
      evalStore: storeB,
      evalExecution: { runner: makeParityRunner(), model: PARITY_MODEL },
    });

    const res = await app.request("/eval/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setId: "parity-bank", targetId: "parity-target", variant: "parity" }),
    });
    expect(res.status).toBe(202);
    const { runId: runBId } = (await res.json()) as { runId: string };

    await vi.waitFor(() => {
      const run = storeB.getEvalRun(runBId);
      if (!run || run.status === "running") {
        throw new Error("still running");
      }
    });

    const runB = storeB.getEvalRun(runBId);
    if (!runB) throw new Error("unreachable");
    const resultsB = storeB.evalRunResults(runB.id);

    // ---- Compare ------------------------------------------------------------
    expect(normalizeEvalRun(runB)).toEqual(normalizeEvalRun(runA));
    expect(resultsB).toHaveLength(resultsA.length);
    expect(normalizeResults(storeB, runB.id, resultsB)).toEqual(
      normalizeResults(storeA, runA.id, resultsA),
    );

    storeA.close();
    storeB.close();
  });
});
