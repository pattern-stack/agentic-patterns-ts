/**
 * Tests for `ap eval` (spec `.ai-docs/stacks/eval-surface/specs/135.md` § Tests).
 *
 * `tools.test.ts`'s stdio/exit harness idiom + `case-bank.test.ts`'s
 * `mkdtempSync` temp-file idiom. Fixture agents:
 *   - `makeEchoTarget` — a promoted `FunctionStep` (identity; throws on "boom")
 *     wrapped via `asAgent`, exercised runner-free (resolveEvalTarget runs the
 *     promoted node directly).
 *   - `makeAgentLikeTarget` + `LifecycleStubRunner` — a bare `AgentLike` bridged
 *     through the engine's `AgentStep` adapter, driven by a ~25-line lifecycle
 *     stub runner (the #133 `trace-capture.test.ts` idiom) that emits
 *     `message.start`/`message.complete` to `options.eventBus` — the only way
 *     to prove the command's `SQLiteExporter` + shared-bus wiring end-to-end.
 *
 * `opts.runner` is injected everywhere (no env/LLM dependence).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentLike,
  EvalStore,
  FunctionStep,
  MockRunner,
  type RunOptions,
  type RunResult,
  type RunnerProtocol,
  asAgent,
  createEvent,
} from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredAgent } from "../../helpers/discover.js";
import { runEvalCommand } from "../eval.js";

// ---------------------------------------------------------------------------
// Temp dir + jsonl fixtures
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ap-eval-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(name: string, rows: Record<string, unknown>[]): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  return filePath;
}

function dbPath(name = "events.db"): string {
  return join(dir, name);
}

// ---------------------------------------------------------------------------
// Agent fixtures
// ---------------------------------------------------------------------------

/** Promoted echo agent: identity function; throws on "boom" (the node-error path). */
function makeEchoTarget(id = "echo"): DiscoveredAgent {
  const node = new FunctionStep<string, string>({
    name: "echo",
    fn: (input: string) => {
      if (input === "boom") throw new Error("boom");
      return input;
    },
  });
  const agent = asAgent(node, { role: { name: id } });
  return { id, name: id, agent, file: "/virtual/echo.ts" };
}

/** Bare AgentLike fixture — resolved via the engine's AgentStep bridge, exercises the runner. */
function makeAgentLikeTarget(id = "agent-fixture"): DiscoveredAgent {
  const agent: AgentLike = {
    role: { name: id },
    getModel: () => "mock-model",
    getTools: () => [],
    getSystemPrompt: () => "You are a test agent.",
    renderInitialPrompt: () => "Initial prompt",
  };
  return { id, name: id, agent, file: "/virtual/agent-fixture.ts" };
}

/** ~25-line lifecycle-stub runner (the #133 trace-capture.test.ts idiom) — emits
 *  exactly the lifecycle AgentRunner does, so SQLiteExporter has events to persist. */
class LifecycleStubRunner implements RunnerProtocol {
  async run(agent: AgentLike, _message: string, options?: RunOptions): Promise<RunResult> {
    const traceId = options?.traceId ?? "no-trace";
    const bus = options?.eventBus;
    if (bus) {
      await bus.publish(
        createEvent("agent.message.start", {
          traceId,
          runId: traceId,
          agentName: agent.role.name,
        }),
      );
      await bus.publish(
        createEvent("agent.message.complete", {
          traceId,
          runId: traceId,
          content: "ok",
          inputTokens: 1,
          outputTokens: 1,
          model: agent.getModel(),
          finishReason: "stop",
        }),
      );
    }
    return {
      response: "ok",
      inputTokens: 1,
      outputTokens: 1,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
    };
  }
}

// ---------------------------------------------------------------------------
// Stdio + exit harness (tools.test.ts precedent)
// ---------------------------------------------------------------------------

interface StdHarness {
  stdout: string[];
  stderr: string[];
  exits: number[];
  restore: () => void;
}

function captureStdio(): StdHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];

  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number): never => {
    exits.push(code ?? 0);
    throw new Error(`__exit__:${code ?? 0}`);
  }) as never);

  return {
    stdout,
    stderr,
    exits,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    },
  };
}

async function runSafely(promise: Promise<void>): Promise<void> {
  try {
    await promise;
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__exit__:")) throw e;
  }
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function joined(chunks: string[]): string {
  return stripAnsi(chunks.join(""));
}

// ---------------------------------------------------------------------------
// Env isolation (AP_PERSISTENCE / AGENT_TIER / AGENT_MODEL / AP_DB_PATH / XDG_STATE_HOME)
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "AP_PERSISTENCE",
  "AGENT_TIER",
  "AGENT_MODEL",
  "AP_DB_PATH",
  "XDG_STATE_HOME",
] as const;

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

// ---------------------------------------------------------------------------
// Harness lifecycle
// ---------------------------------------------------------------------------

let h: StdHarness;
let envSaved: Record<string, string | undefined>;

beforeEach(() => {
  h = captureStdio();
  envSaved = stashEnv();
  process.exitCode = undefined;
});

afterEach(() => {
  h.restore();
  restoreEnv(envSaved);
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// 1. Happy path (the acceptance path)
// ---------------------------------------------------------------------------

describe("ap eval — happy path", () => {
  it("runs a 2-case bank, all matching, persists eval_run + eval_result + run rows", async () => {
    const bank = writeJsonl("bank.jsonl", [
      { id: "c1", input: "hello", expected: "hello" },
      { id: "c2", input: "world", expected: "world" },
    ]);
    const dbFile = dbPath();
    const target = makeEchoTarget("dealbrain/curator");

    await runSafely(
      runEvalCommand({
        agents: [target],
        set: bank,
        db: dbFile,
        variant: "baseline",
        runner: new MockRunner(),
      }),
    );

    expect(h.exits).toEqual([]);
    expect(process.exitCode).toBeUndefined();

    const out = joined(h.stdout);
    expect(out).toContain("✓");
    expect(out).toContain("cases 2");

    const store = new EvalStore({ path: dbFile, Database });
    try {
      const runs = store.listEvalRuns();
      expect(runs).toHaveLength(1);
      const evalRun = runs[0];
      expect(evalRun).toBeDefined();
      if (!evalRun) throw new Error("unreachable");
      expect(evalRun.setId).toBe("bank");
      expect(evalRun.targetId).toBe("dealbrain/curator");
      expect(evalRun.variant).toBe("baseline");
      expect(evalRun.split).toBeNull();
      expect(evalRun.model).toBeTruthy();
      expect(evalRun.status).toBe("ok");

      const rows = store.evalRunResults(evalRun.id);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.pass).toBe(true);
        expect(row.scores).toBeTruthy();
        expect(row.traceId).toBe(`${evalRun.id}:${row.caseId}`);
        expect(row.finalAnswer).toBeTruthy();

        const runRow = store.getRun(row.runId as string);
        expect(runRow?.metadata?.evalRunId).toBe(evalRun.id);
        expect(runRow?.metadata?.caseId).toBe(row.caseId);
        expect(runRow?.metadata?.variant).toBe("baseline");
      }
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Gate failure — scorer
// ---------------------------------------------------------------------------

describe("ap eval — gate failure: scorer mismatch", () => {
  it("sets process.exitCode = 1; the mismatched case's eval_result.pass = 0", async () => {
    const bank = writeJsonl("bank.jsonl", [
      { id: "c1", input: "hello", expected: "hello" },
      { id: "c2", input: "hello", expected: "nope" },
    ]);
    const dbFile = dbPath();
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({ agents: [target], set: bank, db: dbFile, runner: new MockRunner() }),
    );

    expect(h.exits).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(joined(h.stdout)).toContain("gate FAIL");

    const store = new EvalStore({ path: dbFile, Database });
    try {
      const run = store.listEvalRuns()[0];
      if (!run) throw new Error("unreachable");
      const rows = store.evalRunResults(run.id);
      const failing = rows.find((r) => r.caseId === "c2");
      expect(failing?.pass).toBe(false);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Gate failure — node error
// ---------------------------------------------------------------------------

describe("ap eval — gate failure: node error", () => {
  it("counts errored; run row status:error; eval_result.pass NULL; exitCode 1", async () => {
    const bank = writeJsonl("bank.jsonl", [{ id: "c1", input: "boom" }]);
    const dbFile = dbPath();
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({ agents: [target], set: bank, db: dbFile, runner: new MockRunner() }),
    );

    expect(process.exitCode).toBe(1);

    const store = new EvalStore({ path: dbFile, Database });
    try {
      const run = store.listEvalRuns()[0];
      if (!run) throw new Error("unreachable");
      const rows = store.evalRunResults(run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.runStatus).toBe("error");
      expect(rows[0]?.runError).toContain("boom");
      expect(rows[0]?.pass).toBeNull();
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. --split filters
// ---------------------------------------------------------------------------

describe("ap eval — --split filters cases", () => {
  it("only dev cases run; eval_run.split = 'dev'", async () => {
    const bank = writeJsonl("bank.jsonl", [
      { id: "c1", input: "a", expected: "a", split: "dev" },
      { id: "c2", input: "b", expected: "b", split: "train" },
    ]);
    const dbFile = dbPath();
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({
        agents: [target],
        set: bank,
        db: dbFile,
        split: "dev",
        runner: new MockRunner(),
      }),
    );

    expect(process.exitCode).toBeUndefined();

    const store = new EvalStore({ path: dbFile, Database });
    try {
      const run = store.listEvalRuns()[0];
      if (!run) throw new Error("unreachable");
      expect(run.split).toBe("dev");
      const rows = store.evalRunResults(run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.caseId).toBe("c1");
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Held-out guard
// ---------------------------------------------------------------------------

describe("ap eval — held-out split guard", () => {
  it("refuses the test split without --allow-test — verbatim message + hint", async () => {
    const bank = writeJsonl("bank.jsonl", [{ id: "c1", input: "a", expected: "a", split: "test" }]);
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({
        agents: [target],
        set: bank,
        db: dbPath(),
        split: "test",
        runner: new MockRunner(),
      }),
    );

    expect(h.exits).toEqual([2]);
    const err = joined(h.stderr);
    expect(err).toContain(
      'case-bank: refusing the held-out "test" split — touch once, pre-ship only.',
    );
    expect(err).toContain("pass --allow-test to run it deliberately");
  });

  it("runs when --allow-test is passed", async () => {
    const bank = writeJsonl("bank.jsonl", [{ id: "c1", input: "a", expected: "a", split: "test" }]);
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({
        agents: [target],
        set: bank,
        db: dbPath(),
        split: "test",
        allowTest: true,
        runner: new MockRunner(),
      }),
    );

    expect(h.exits).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Invalid --split
// ---------------------------------------------------------------------------

describe("ap eval — invalid --split", () => {
  it("exits 2, message lists train | dev | test", async () => {
    const bank = writeJsonl("bank.jsonl", [{ id: "c1", input: "a", expected: "a" }]);
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({
        agents: [target],
        set: bank,
        db: dbPath(),
        split: "validate",
        runner: new MockRunner(),
      }),
    );

    expect(h.exits).toEqual([2]);
    expect(joined(h.stderr)).toContain("train | dev | test");
  });
});

// ---------------------------------------------------------------------------
// 7. Target resolution
// ---------------------------------------------------------------------------

describe("ap eval — target resolution", () => {
  it("unknown --target exits 2 with an available: list", async () => {
    const bank = writeJsonl("bank.jsonl", [{ id: "c1", input: "a", expected: "a" }]);
    const target = makeEchoTarget("known-agent");

    await runSafely(
      runEvalCommand({
        agents: [target],
        set: bank,
        db: dbPath(),
        target: "does-not-exist",
        runner: new MockRunner(),
      }),
    );

    expect(h.exits).toEqual([2]);
    const err = joined(h.stderr);
    expect(err).toContain("does-not-exist");
    expect(err).toContain("available:");
    expect(err).toContain("known-agent");
  });

  it("two agents, no --target, exits 2 with an available: list", async () => {
    const bank = writeJsonl("bank.jsonl", [{ id: "c1", input: "a", expected: "a" }]);
    const a = makeEchoTarget("agent-a");
    const b = makeEchoTarget("agent-b");

    await runSafely(
      runEvalCommand({ agents: [a, b], set: bank, db: dbPath(), runner: new MockRunner() }),
    );

    expect(h.exits).toEqual([2]);
    const err = joined(h.stderr);
    expect(err).toContain("multiple agents discovered");
    expect(err).toContain("agent-a");
    expect(err).toContain("agent-b");
  });

  it("single agent, no --target, runs against it", async () => {
    const bank = writeJsonl("bank.jsonl", [{ id: "c1", input: "a", expected: "a" }]);
    const target = makeEchoTarget("solo-agent");

    await runSafely(
      runEvalCommand({ agents: [target], set: bank, db: dbPath(), runner: new MockRunner() }),
    );

    expect(h.exits).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Stored-set mode
// ---------------------------------------------------------------------------

describe("ap eval — stored-set mode", () => {
  it("pre-seeded store: runs from the stored set; expected-less case is un-gated", async () => {
    const dbFile = dbPath();
    const seed = new EvalStore({ path: dbFile, Database });
    seed.upsertEvalSet({ id: "curated", name: "curated" });
    seed.upsertEvalCase("curated", { caseId: "c1", input: "hello", expected: "hello" });
    seed.upsertEvalCase("curated", { caseId: "c2", input: "no-expected" }); // no `expected` key
    seed.close();

    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({ agents: [target], set: "curated", db: dbFile, runner: new MockRunner() }),
    );

    expect(h.exits).toEqual([]);
    expect(process.exitCode).toBeUndefined(); // an ungated case must not fail the gate

    const store = new EvalStore({ path: dbFile, Database });
    try {
      const run = store.listEvalRuns()[0];
      if (!run) throw new Error("unreachable");
      const rows = store.evalRunResults(run.id);
      const ungated = rows.find((r) => r.caseId === "c2");
      expect(ungated?.pass).toBeNull();
      const gated = rows.find((r) => r.caseId === "c1");
      expect(gated?.pass).toBe(true);
    } finally {
      store.close();
    }
  });

  it("unknown stored-set id exits 2 listing available set ids", async () => {
    const dbFile = dbPath();
    const seed = new EvalStore({ path: dbFile, Database });
    seed.upsertEvalSet({ id: "curated", name: "curated" });
    seed.close();

    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({
        agents: [target],
        set: "does-not-exist",
        db: dbFile,
        runner: new MockRunner(),
      }),
    );

    expect(h.exits).toEqual([2]);
    const err = joined(h.stderr);
    expect(err).toContain("does-not-exist");
    expect(err).toContain("curated");
  });
});

// ---------------------------------------------------------------------------
// 9. Mirroring + idempotency
// ---------------------------------------------------------------------------

describe("ap eval — mirroring + idempotency", () => {
  it("file mode mirrors the whole bank; a second run adds a new eval_run, no case dupes", async () => {
    const bank = writeJsonl("bank.jsonl", [
      { id: "c1", input: "a", expected: "a", tags: ["smoke"], split: "dev" },
      { id: "c2", input: "b", expected: "b" },
    ]);
    const dbFile = dbPath();
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({ agents: [target], set: bank, db: dbFile, runner: new MockRunner() }),
    );
    await runSafely(
      runEvalCommand({ agents: [target], set: bank, db: dbFile, runner: new MockRunner() }),
    );

    const store = new EvalStore({ path: dbFile, Database });
    try {
      const cases = store.listEvalCases("bank");
      expect(cases).toHaveLength(2);
      const c1 = cases.find((c) => c.caseId === "c1");
      expect(c1?.split).toBe("dev");
      expect(c1?.tags).toEqual(["smoke"]);

      const runs = store.listEvalRuns();
      expect(runs).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. --gold overlay
// ---------------------------------------------------------------------------

describe("ap eval — --gold overlay", () => {
  it("gold expected wins over inline; the gate reflects gold", async () => {
    const bank = writeJsonl("bank.jsonl", [{ id: "c1", input: "hello", expected: "wrong-inline" }]);
    const gold = writeJsonl("gold.jsonl", [{ id: "c1", expected: "hello" }]);
    const dbFile = dbPath();
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({ agents: [target], set: bank, gold, db: dbFile, runner: new MockRunner() }),
    );

    expect(process.exitCode).toBeUndefined();

    const store = new EvalStore({ path: dbFile, Database });
    try {
      const run = store.listEvalRuns()[0];
      if (!run) throw new Error("unreachable");
      const rows = store.evalRunResults(run.id);
      expect(rows[0]?.pass).toBe(true);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Empty selection
// ---------------------------------------------------------------------------

describe("ap eval — empty split selection", () => {
  it("exits 2 with a 'no cases' message when the split has no matches", async () => {
    const bank = writeJsonl("bank.jsonl", [{ id: "c1", input: "a", expected: "a", split: "dev" }]);
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({
        agents: [target],
        set: bank,
        db: dbPath(),
        split: "train",
        runner: new MockRunner(),
      }),
    );

    expect(h.exits).toEqual([2]);
    expect(joined(h.stderr)).toContain("no cases");
  });
});

// ---------------------------------------------------------------------------
// 12. Missing --set / --gold misuse
// ---------------------------------------------------------------------------

describe("ap eval — usage errors", () => {
  it("missing --set exits 2", async () => {
    const target = makeEchoTarget();
    await runSafely(runEvalCommand({ agents: [target], runner: new MockRunner() }));

    expect(h.exits).toEqual([2]);
    expect(joined(h.stderr)).toContain("--set");
  });

  it("--gold with a stored-set id exits 2", async () => {
    const dbFile = dbPath();
    const seed = new EvalStore({ path: dbFile, Database });
    seed.upsertEvalSet({ id: "curated", name: "curated" });
    seed.close();

    const target = makeEchoTarget();
    await runSafely(
      runEvalCommand({
        agents: [target],
        set: "curated",
        gold: "whatever.jsonl",
        db: dbFile,
        runner: new MockRunner(),
      }),
    );

    expect(h.exits).toEqual([2]);
    expect(joined(h.stderr)).toContain("--gold requires a file --set");
  });
});

// ---------------------------------------------------------------------------
// 13. Per-split printout
// ---------------------------------------------------------------------------

describe("ap eval — per-split printout", () => {
  it("mixed bank prints per-split rows with an x/y pass column + rate; untagged rendered", async () => {
    const bank = writeJsonl("bank.jsonl", [
      { id: "c1", input: "a", expected: "a", split: "dev" },
      { id: "c2", input: "b", expected: "nope", split: "dev" },
      { id: "c3", input: "c", expected: "c" }, // untagged
    ]);
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({ agents: [target], set: bank, db: dbPath(), runner: new MockRunner() }),
    );

    const out = joined(h.stdout);
    expect(out).toContain("dev");
    expect(out).toContain("1/2");
    expect(out).toContain("(untagged)");
  });
});

// ---------------------------------------------------------------------------
// 14. Unpersisted run
// ---------------------------------------------------------------------------

describe("ap eval — unpersisted run (AP_PERSISTENCE=0)", () => {
  it("warns, still runs, still gates, creates no db file", async () => {
    process.env.AP_PERSISTENCE = "0";
    const bank = writeJsonl("bank.jsonl", [{ id: "c1", input: "hello", expected: "nope" }]);
    const dbFile = dbPath("should-not-exist.db");
    const target = makeEchoTarget();

    await runSafely(
      runEvalCommand({ agents: [target], set: bank, db: dbFile, runner: new MockRunner() }),
    );

    expect(joined(h.stderr)).toContain("AP_PERSISTENCE=0");
    expect(process.exitCode).toBe(1); // the gate still runs unpersisted
    expect(existsSync(dbFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. Trace-event capture (integration)
// ---------------------------------------------------------------------------

describe("ap eval — trace-event capture (SQLiteExporter + shared bus)", () => {
  it("events land in the store keyed by trace_id = evalRunId:caseId", async () => {
    const bank = writeJsonl("bank.jsonl", [
      { id: "c1", input: "hi" },
      { id: "c2", input: "yo" },
    ]);
    const dbFile = dbPath();
    const target = makeAgentLikeTarget("lifecycle-agent");

    await runSafely(
      runEvalCommand({
        agents: [target],
        set: bank,
        db: dbFile,
        runner: new LifecycleStubRunner(),
      }),
    );

    const store = new EvalStore({ path: dbFile, Database });
    try {
      const run = store.listEvalRuns()[0];
      if (!run) throw new Error("unreachable");
      const events = store.recent({ limit: 100 });
      const c1Events = events.filter((e) => e.traceId === `${run.id}:c1`);
      const c2Events = events.filter((e) => e.traceId === `${run.id}:c2`);
      expect(c1Events.length).toBeGreaterThan(0);
      expect(c2Events.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
