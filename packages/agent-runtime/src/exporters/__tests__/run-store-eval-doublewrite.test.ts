/**
 * S5 acceptance criterion — empirical double-write check (spec `.ai-docs/
 * stacks/playground-upgrades/port-map.md` § 3.1): does attaching
 * `RunStoreExporter` (wired in `agent-cli/commands/playground.ts`, beside
 * `SQLiteExporter`) cause an eval-case execution to write TWO `runs` rows
 * instead of one — the bus-driven `_onMessageStart`/`_onMessageComplete` row
 * PLUS the `createEvalResultRecorder`-driven row `ap eval` (and `POST
 * /eval/runs`) already write?
 *
 * Ground truth, traced from the actual runner:
 *   - `MockRunner.run()` (used by every existing eval route/CLI test) never
 *     touches `options.eventBus` — it just returns a `RunResult`. Existing
 *     eval tests are therefore structurally blind to this question; a real
 *     `AgentRunner.run()` DOES rebind its instance bus to `options.eventBus`
 *     when present (`runner/agent-runner.ts` ~line 283) and unconditionally
 *     emits `agent.message.start` / `agent.message.complete` on it. This
 *     suite's `BusEmittingRunner` fixture reproduces exactly that rebind-and-
 *     emit behavior (not MockRunner's silence), so the scenarios below are
 *     faithful to production, not to the existing eval test doubles.
 *   - `run-eval.ts`'s `withEvalBus` wraps `ctx.runner` and injects
 *     `RunOptions.eventBus` + a per-case traceId
 *     (`eval:${evalRunId}:${caseId}` — `EVAL_TRACE_PREFIX` marks eval-owned
 *     activity) into every `runner.run()` call the resolved Node makes — this
 *     is how a bare `AgentLike` eval target (routed through the real
 *     `AgentStep` bridge, exactly as `resolveEvalTarget` does) reaches the bus.
 *
 * Scenarios, matching the two real callers of `createEvalResultRecorder`:
 *
 *   1. `ap eval` (CLI) shape — `runEval`'s `ctx.eventBus` is the CLI's OWN
 *      private `AgentEventBus` (`commands/eval.ts`), which the playground's
 *      `RunStoreExporter` (a different process/bus entirely) never observes.
 *      RESULT: exactly one row (the recorder's) — no double-write is
 *      *reachable* by construction.
 *
 *   2. `POST /eval/runs` (dashboard-launched) shape — `routes/eval.ts` passes
 *      `eventBus: config.eventBus`, THE SAME shared bus `createServer()`
 *      wires everywhere, including where `RunStoreExporter` is attached.
 *      Without a guard this double-writes (a metadata-less shadow row beside
 *      the recorder's row — proven by the third test below, which pins the
 *      un-guarded behavior). THE FIX: `playground.ts` attaches the exporter
 *      with `shouldTrack: (e) => !e.traceId?.startsWith(EVAL_TRACE_PREFIX)`,
 *      so eval-owned lifecycles never open a row and the recorder's row stays
 *      the only one. RESULT (with the playground predicate): exactly one row.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVAL_TRACE_PREFIX, runEval } from "../../eval/run-eval.js";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import { createEvent } from "../../events/types.js";
import type { AgentLike } from "../../runner/agent-runner.js";
import type { RunOptions, RunResult, RunnerProtocol } from "../../runner/types.js";
import { createEvalResultRecorder } from "../../storage/eval-recorder.js";
import { EvalStore } from "../../storage/eval-store.js";
import { RunStoreExporter } from "../run-store.js";

// ---------------------------------------------------------------------------
// Fixture: a runner that reproduces AgentRunner.run()'s REAL bus behavior —
// rebinds to `options.eventBus` and emits a full message.start -> .complete
// lifecycle, unlike MockRunner.run() (which is silent on the bus).
// ---------------------------------------------------------------------------

class BusEmittingRunner implements RunnerProtocol {
  async run(agent: AgentLike, message: string, options?: RunOptions): Promise<RunResult> {
    const bus = options?.eventBus;
    const runId = `real-run-${Math.random().toString(36).slice(2)}`;
    const effectiveTraceId = options?.traceId ?? runId;

    if (bus) {
      await bus.publish(
        createEvent("agent.message.start", {
          traceId: effectiveTraceId,
          runId,
          agentName: agent.role.name,
          agentConfig: { role: agent.role.name, model: "test-model", tools: [] },
          systemPrompt: agent.renderInitialPrompt(),
        }),
      );
      await bus.publish(
        createEvent("agent.message.complete", {
          traceId: effectiveTraceId,
          runId,
          content: `echo: ${message}`,
          inputTokens: 1,
          outputTokens: 1,
          model: "test-model",
        }),
      );
    }

    return {
      response: `echo: ${message}`,
      inputTokens: 1,
      outputTokens: 1,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
    };
  }
}

const fixtureAgent: AgentLike = {
  role: { name: "eval-fixture-agent" },
  getModel: () => "test-model",
  getTools: () => [],
  getSystemPrompt: () => "You are a test agent.",
  renderInitialPrompt: () => "You are a test agent.",
};

/** The exact predicate `playground.ts` wires. */
const playgroundShouldTrack = (e: { traceId?: string }): boolean =>
  !e.traceId?.startsWith(EVAL_TRACE_PREFIX);

describe("RunStoreExporter + eval recorder — double-write check", () => {
  let store: EvalStore;

  beforeEach(() => {
    store = new EvalStore({ path: ":memory:", Database });
  });

  afterEach(() => {
    store.close();
  });

  it("ap eval CLI shape — isolated bus — produces exactly ONE row (no double-write is reachable)", async () => {
    // RunStoreExporter attached to a bus the CLI's own eval run NEVER touches
    // — mirrors commands/eval.ts building its own private `bus`.
    const playgroundBus = new AgentEventBus();
    const runStoreExporter = new RunStoreExporter({
      store,
      shouldTrack: playgroundShouldTrack,
    });
    runStoreExporter.attach(playgroundBus);

    const cliBus = new AgentEventBus(); // commands/eval.ts's own `const bus = new AgentEventBus()`
    const evalRunId = store.startEvalRun({ targetId: "eval-fixture-agent" });
    const recorder = createEvalResultRecorder(store, {
      evalRunId,
      targetId: "eval-fixture-agent",
    });

    await runEval(
      {
        target: fixtureAgent,
        cases: [{ id: "c1", input: "hi" }],
        scorers: [],
        onResult: recorder,
      },
      { runner: new BusEmittingRunner(), eventBus: cliBus, traceId: evalRunId },
    );

    const rows = store.listRuns();
    expect(rows).toHaveLength(1);
    const row = store.getRun(rows[0]!.runId);
    expect(row?.metadata?.evalRunId).toBe(evalRunId);
    expect(row?.metadata?.caseId).toBe("c1");

    runStoreExporter.detach(playgroundBus);
  });

  it("POST /eval/runs shape — SHARED bus + playground shouldTrack — exactly ONE row (the recorder's, with metadata)", async () => {
    // The playground's single shared bus — RunStoreExporter attached exactly
    // as `playground.ts` wires it (eval-excluding predicate), AND handed to
    // `routes/eval.ts` as `config.eventBus`, exactly as the real server does.
    const sharedBus = new AgentEventBus();
    const runStoreExporter = new RunStoreExporter({
      store,
      shouldTrack: playgroundShouldTrack,
    });
    runStoreExporter.attach(sharedBus);

    const evalRunId = store.startEvalRun({ targetId: "eval-fixture-agent" });
    const recorder = createEvalResultRecorder(store, {
      evalRunId,
      targetId: "eval-fixture-agent",
    });

    await runEval(
      {
        target: fixtureAgent,
        cases: [{ id: "c1", input: "hi" }],
        scorers: [],
        onResult: recorder,
      },
      { runner: new BusEmittingRunner(), eventBus: sharedBus, traceId: evalRunId },
    );

    const rows = store.listRuns();
    expect(rows).toHaveLength(1); // the recorder's row only — the S5 fix
    const row = store.getRun(rows[0]!.runId);
    expect(row?.metadata?.evalRunId).toBe(evalRunId);
    expect(row?.metadata?.caseId).toBe("c1");
    expect(row?.traceId).toBe(`${EVAL_TRACE_PREFIX}${evalRunId}:c1`);

    runStoreExporter.detach(sharedBus);
  });

  it("regression pin: WITHOUT shouldTrack the shared-bus shape still double-writes (why the predicate exists)", async () => {
    const sharedBus = new AgentEventBus();
    const unguarded = new RunStoreExporter({ store }); // no predicate
    unguarded.attach(sharedBus);

    const evalRunId = store.startEvalRun({ targetId: "eval-fixture-agent" });
    const recorder = createEvalResultRecorder(store, {
      evalRunId,
      targetId: "eval-fixture-agent",
    });

    await runEval(
      {
        target: fixtureAgent,
        cases: [{ id: "c1", input: "hi" }],
        scorers: [],
        onResult: recorder,
      },
      { runner: new BusEmittingRunner(), eventBus: sharedBus, traceId: evalRunId },
    );

    const rows = store.listRuns();
    expect(rows).toHaveLength(2); // recorder row + metadata-less shadow row

    const withMeta = rows.filter((r) => store.getRun(r.runId)?.metadata?.evalRunId === evalRunId);
    const withoutMeta = rows.filter((r) => store.getRun(r.runId)?.metadata == null);
    expect(withMeta).toHaveLength(1);
    expect(withoutMeta).toHaveLength(1);

    // Both rows share the SAME eval:-prefixed traceId — two representations
    // of the SAME case execution, which is exactly what shouldTrack prevents.
    const traceIds = new Set(rows.map((r) => r.traceId));
    expect(traceIds).toEqual(new Set([`${EVAL_TRACE_PREFIX}${evalRunId}:c1`]));

    unguarded.detach(sharedBus);
  });
});
