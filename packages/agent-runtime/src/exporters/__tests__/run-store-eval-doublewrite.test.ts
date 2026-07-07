/**
 * S5 acceptance criterion — empirical double-write check (spec `.ai-docs/
 * stacks/playground-upgrades/port-map.md` § 3.1): does attaching
 * `RunStoreExporter` (now wired in `agent-cli/commands/playground.ts`, beside
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
 *     emit behavior (not MockRunner's silence), so the two scenarios below
 *     are faithful to production, not to the existing eval test doubles.
 *   - `run-eval.ts`'s `withEvalBus` wraps `ctx.runner` and injects
 *     `RunOptions.eventBus` + a per-case `traceId` (`${evalRunId}:${caseId}`)
 *     into every `runner.run()` call the resolved Node makes — this is how a
 *     bare `AgentLike` eval target (routed through the real `AgentStep`
 *     bridge, exactly as `resolveEvalTarget` does) actually reaches the bus.
 *
 * Two scenarios, matching the two real callers of `createEvalResultRecorder`:
 *
 *   1. `ap eval` (CLI) shape — `runEval`'s `ctx.eventBus` is the CLI's OWN
 *      private `AgentEventBus` (`commands/eval.ts` — `const bus = new
 *      AgentEventBus()`), which `RunStoreExporter` (wired only in
 *      `playground.ts`, a different process/bus entirely) never observes.
 *      RESULT: exactly one row (the recorder's) — no double-write is
 *      *reachable* by construction.
 *
 *   2. `POST /eval/runs` (dashboard-launched) shape — `routes/eval.ts` passes
 *      `eventBus: config.eventBus`, THE SAME shared bus `createServer()`
 *      wires everywhere (including wherever `RunStoreExporter` is attached,
 *      per this slice's `playground.ts` change) — `run-eval.ts`'s own doc
 *      comment says this reuse is deliberate ("pass the runner's own shared
 *      bus (the playground pattern)"), so `/live` and the durable event log
 *      see per-case execution. RESULT: the case's `agent.message.start` /
 *      `.complete` land on the SAME bus `RunStoreExporter` is attached to,
 *      producing a SECOND, metadata-less `runs` row for the same case
 *      alongside the recorder's row.
 *
 * FINDING (see this slice's final report — not fixed here; per this slice's
 * scope, `exporters/run-store.ts` and `storage/run-store.ts` are NOT
 * reshaped): scenario 2 is a genuine double-write for dashboard-launched
 * eval runs. Scenario 1 (the CLI, the dominant/documented eval workflow)
 * cannot double-write by construction. This test locks BOTH behaviors in so
 * a future change to either wiring shows up here rather than surprising
 * someone reading `/admin/runs` output.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEval } from "../../eval/run-eval.js";
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
    const runStoreExporter = new RunStoreExporter({ store });
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

  it("POST /eval/runs shape — SHARED bus — DOES double-write: recorder row + a metadata-less RunStoreExporter shadow row", async () => {
    // The playground's single shared bus — RunStoreExporter attached exactly
    // as `playground.ts` now wires it, AND handed to `routes/eval.ts` as
    // `config.eventBus` (app.ts:45), exactly as the real server does.
    const sharedBus = new AgentEventBus();
    const runStoreExporter = new RunStoreExporter({ store });
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
    // FINDING: two rows for one eval-case execution, not one.
    expect(rows).toHaveLength(2);

    const withMeta = rows.filter((r) => store.getRun(r.runId)?.metadata?.evalRunId === evalRunId);
    const withoutMeta = rows.filter((r) => store.getRun(r.runId)?.metadata == null);
    expect(withMeta).toHaveLength(1); // the recorder's row — the intended one
    expect(withoutMeta).toHaveLength(1); // RunStoreExporter's shadow row — the double-write

    // Both rows share the SAME traceId (`${evalRunId}:${caseId}`) — they are
    // two representations of the SAME case execution, not two unrelated runs.
    const traceIds = new Set(rows.map((r) => r.traceId));
    expect(traceIds).toEqual(new Set([`${evalRunId}:c1`]));

    runStoreExporter.detach(sharedBus);
  });
});
