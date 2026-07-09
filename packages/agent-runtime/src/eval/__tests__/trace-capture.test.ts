/**
 * E2 test suite — `eventBus` on `EvalRunContext`, per-case `traceId` minting,
 * and the RunStoreExporter fusion (spec `.ai-docs/stacks/eval-surface/specs/133.md`).
 *
 * `run-eval.test.ts` stays untouched — its unmodified pass is the no-bus
 * back-compat evidence for every OTHER existing behavior; this file covers
 * only the NEW #133 surface.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import { createEvent } from "../../events/types.js";
import { RunStoreExporter } from "../../exporters/run-store.js";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { RunOptions, RunResult, RunnerProtocol } from "../../runner/types.js";
import { RunStore } from "../../storage/run-store.js";
import { AgentStep } from "../../workflows/agent-step.js";
import type { Node, NodeResult, NodeRunContext } from "../../workflows/node.js";
import { EVAL_TRACE_PREFIX, runEval } from "../run-eval.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(name = "test-agent"): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    renderInitialPrompt: () => "Initial prompt",
  };
}

/** Spy `Node` — captures the `NodeRunContext` it receives per case, no runner involved. */
class SpyNode implements Node<string, string> {
  readonly name = "spy";
  readonly seenCtx: NodeRunContext[] = [];

  async run(input: string, ctx: NodeRunContext): Promise<NodeResult<string>> {
    this.seenCtx.push(ctx);
    return { output: input, succeeded: true, totalInputTokens: 0, totalOutputTokens: 0 };
  }
}

let _runCounter = 0;
function freshRunId(): string {
  return `stub-run-${++_runCounter}`;
}

/** Publishes exactly the lifecycle `AgentRunner` emits (agent-runner.ts:308/:476) —
 *  `MockRunner.run`/`runStructured` emit nothing (mock-runner.ts:105-143), so the
 *  fusion tests need a real emitter. `failing` mode emits `message.start` + a
 *  non-recoverable `agent.error` then throws (mirrors agent-runner.ts:389). */
async function runLifecycle(
  agent: AgentLike,
  options: RunOptions | undefined,
  opts: {
    readonly failing?: boolean;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  },
): Promise<RunResult> {
  const runId = freshRunId();
  const traceId = options?.traceId ?? runId;
  const bus = options?.eventBus;
  if (bus) {
    await bus.publish(
      createEvent("agent.message.start", { traceId, runId, agentName: agent.role.name }),
    );
  }
  if (opts.failing) {
    if (bus) {
      await bus.publish(
        createEvent("agent.error", {
          traceId,
          runId,
          errorType: "Error",
          message: "stub failure",
          recoverable: false,
          context: {},
        }),
      );
    }
    throw new Error("stub failure");
  }
  const inputTokens = opts.inputTokens ?? 1;
  const outputTokens = opts.outputTokens ?? 1;
  if (bus) {
    await bus.publish(
      createEvent("agent.message.complete", {
        traceId,
        runId,
        content: "ok",
        inputTokens,
        outputTokens,
        model: agent.getModel() ?? "",
        finishReason: "stop",
      }),
    );
  }
  return {
    response: "ok",
    inputTokens,
    outputTokens,
    toolCallsCount: 0,
    iterations: 1,
    finishReason: "stop",
  };
}

/** `run`-only stub (NO `runStructured`) — used for tests 1-7. */
class LifecycleStubRunner implements RunnerProtocol {
  readonly runOptionsSeen: RunOptions[] = [];

  constructor(
    private readonly opts: {
      readonly failing?: boolean;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    } = {},
  ) {}

  async run(agent: AgentLike, _message: string, options?: RunOptions): Promise<RunResult> {
    this.runOptionsSeen.push(options ?? {});
    return runLifecycle(agent, options, this.opts);
  }
}

// ---------------------------------------------------------------------------
// 1. No-bus back-compat (shape)
// ---------------------------------------------------------------------------

describe("runEval — no eventBus (back-compat, byte-identical)", () => {
  it("every nodeCtx.traceId stays ctx.traceId unchanged, and no result carries a traceId key", async () => {
    const spy = new SpyNode();
    const report = await runEval(
      {
        target: spy,
        cases: [
          { id: "a", input: "x" },
          { id: "b", input: "y" },
        ],
        scorers: [],
      },
      { runner: new MockRunner(), traceId: "t-0" },
    );

    expect(spy.seenCtx).toHaveLength(2);
    for (const ctx of spy.seenCtx) {
      expect(ctx.traceId).toBe("t-0");
    }
    for (const result of report.results) {
      expect("traceId" in result).toBe(false);
    }
    expect(report.summary.cases).toBe(2);
  });

  it("no traceId either, when ctx.traceId itself is absent", async () => {
    const spy = new SpyNode();
    const report = await runEval(
      { target: spy, cases: [{ id: "a", input: "x" }], scorers: [] },
      { runner: new MockRunner() },
    );

    expect(spy.seenCtx[0]?.traceId).toBeUndefined();
    expect("traceId" in (report.results[0] as object)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Bus set, caller-supplied traceId base
// ---------------------------------------------------------------------------

describe("runEval — eventBus set, caller traceId base", () => {
  it("per-case ids are `eval:${base}:${case.id}` (EVAL_TRACE_PREFIX marker), threaded into nodeCtx and stamped on the result", async () => {
    const spy = new SpyNode();
    const bus = new AgentEventBus();
    const report = await runEval(
      {
        target: spy,
        cases: [
          { id: "a", input: "x" },
          { id: "b", input: "y" },
        ],
        scorers: [],
      },
      { runner: new MockRunner(), eventBus: bus, traceId: "run-7" },
    );

    expect(spy.seenCtx.map((c) => c.traceId)).toEqual(["eval:run-7:a", "eval:run-7:b"]);
    expect(report.results[0]?.traceId).toBe("eval:run-7:a");
    expect(report.results[1]?.traceId).toBe("eval:run-7:b");
    expect(report.results[0]?.traceId).not.toBe(report.results[1]?.traceId);
    // The marker is the documented convention (EVAL_TRACE_PREFIX) hosts use to
    // recognize eval-owned runs on a shared bus (RunStoreExporter.shouldTrack).
    expect(report.results[0]?.traceId?.startsWith(EVAL_TRACE_PREFIX)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Bus set, base minted when ctx.traceId absent
// ---------------------------------------------------------------------------

describe("runEval — eventBus set, no ctx.traceId (minted base)", () => {
  it("both case ids share one non-empty prefix; a second run mints a different prefix", async () => {
    const bus = new AgentEventBus();

    const report1 = await runEval(
      {
        target: new SpyNode(),
        cases: [
          { id: "a", input: "x" },
          { id: "b", input: "y" },
        ],
        scorers: [],
      },
      { runner: new MockRunner(), eventBus: bus },
    );

    const id0 = report1.results[0]?.traceId;
    const id1 = report1.results[1]?.traceId;
    expect(id0).toBeDefined();
    expect(id1).toBeDefined();
    expect(id0?.endsWith(":a")).toBe(true);
    expect(id1?.endsWith(":b")).toBe(true);
    const base0 = (id0 as string).slice(0, (id0 as string).length - ":a".length);
    const base1 = (id1 as string).slice(0, (id1 as string).length - ":b".length);
    expect(base0.length).toBeGreaterThan(0);
    expect(base0).toBe(base1);

    const report2 = await runEval(
      { target: new SpyNode(), cases: [{ id: "a", input: "x" }], scorers: [] },
      { runner: new MockRunner(), eventBus: bus },
    );
    const id2 = report2.results[0]?.traceId as string;
    const base2 = id2.slice(0, id2.length - ":a".length);
    expect(base2).not.toBe(base0);
  });
});

// ---------------------------------------------------------------------------
// 4. Events keyed by case traceId
// ---------------------------------------------------------------------------

describe("runEval — bus events keyed by per-case traceId", () => {
  it("agent target: message.start/message.complete traceId equals the case's EvalResult.traceId", async () => {
    const agent = makeAgent("lifecycle-agent");
    const bus = new AgentEventBus();
    const seenTraceIdsByType = new Map<string, string[]>();
    bus.subscribeAll((event) => {
      const list = seenTraceIdsByType.get(event.type) ?? [];
      list.push(event.traceId);
      seenTraceIdsByType.set(event.type, list);
    });

    const stub = new LifecycleStubRunner();
    const report = await runEval(
      {
        target: agent,
        cases: [
          { id: "a", input: "hi" },
          { id: "b", input: "yo" },
        ],
        scorers: [],
      },
      { runner: stub, eventBus: bus },
    );

    const starts = seenTraceIdsByType.get("agent.message.start") ?? [];
    const completes = seenTraceIdsByType.get("agent.message.complete") ?? [];
    const resultTraceIds = report.results.map((r) => r.traceId);

    expect(resultTraceIds).toHaveLength(2);
    expect(starts.sort()).toEqual([...resultTraceIds].sort());
    expect(completes.sort()).toEqual([...resultTraceIds].sort());
    expect(stub.runOptionsSeen).toHaveLength(2);
    expect(stub.runOptionsSeen.every((o) => o.eventBus === bus)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Fusion — runs row per case
// ---------------------------------------------------------------------------

describe("runEval — fusion: RunStoreExporter on the bus", () => {
  it("each case lands a runs row keyed by its own traceId, status ok, tokens folded", async () => {
    const agent = makeAgent("fusion-agent");
    const bus = new AgentEventBus();
    const store = new RunStore({ path: ":memory:", Database });
    const exporter = new RunStoreExporter({ store });
    exporter.attach(bus);

    try {
      const stub = new LifecycleStubRunner({ inputTokens: 3, outputTokens: 4 });
      const report = await runEval(
        {
          target: agent,
          cases: [
            { id: "a", input: "hi" },
            { id: "b", input: "yo" },
          ],
          scorers: [],
        },
        { runner: stub, eventBus: bus },
      );

      const rows = store.listRuns({ limit: 10 });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.traceId).sort()).toEqual(
        report.results.map((r) => r.traceId).sort(),
      );
      for (const row of rows) {
        expect(row.status).toBe("ok");
      }
      const totalInputTokens = rows.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
      const totalOutputTokens = rows.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
      expect(totalInputTokens).toBe(6);
      expect(totalOutputTokens).toBe(8);
    } finally {
      exporter.detach(bus);
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Fusion — error case
// ---------------------------------------------------------------------------

describe("runEval — fusion: error case", () => {
  it("EvalResult is succeeded:false with traceId still stamped; the runs row is status:error", async () => {
    const agent = makeAgent("failing-agent");
    const bus = new AgentEventBus();
    const store = new RunStore({ path: ":memory:", Database });
    const exporter = new RunStoreExporter({ store });
    exporter.attach(bus);

    try {
      const stub = new LifecycleStubRunner({ failing: true });
      const report = await runEval(
        { target: agent, cases: [{ id: "a", input: "hi" }], scorers: [] },
        { runner: stub, eventBus: bus },
      );

      expect(report.results[0]?.succeeded).toBe(false);
      expect(report.results[0]?.traceId).toBeDefined();

      const rows = store.listRuns();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("error");
      expect(rows[0]?.traceId).toBe(report.results[0]?.traceId);
    } finally {
      exporter.detach(bus);
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Wrapper preserves method absence
// ---------------------------------------------------------------------------

describe("runEval — wrapper preserves optional-method absence", () => {
  it("a runner without runStructured still fails loud on a non-string AgentStep output, bus or not", async () => {
    const bus = new AgentEventBus();
    const agent = makeAgent("no-structured-agent");
    const step = new AgentStep({
      agent,
      prompt: () => "hi",
      output: z.object({ answer: z.string() }),
    });
    const stub = new LifecycleStubRunner(); // no runStructured defined at all

    const report = await runEval(
      { target: step, cases: [{ id: "a", input: "x" }], scorers: [] },
      { runner: stub, eventBus: bus },
    );

    expect(report.results[0]?.succeeded).toBe(false);
    expect(report.results[0]?.error).toMatch(/runStructured/);
  });
});

// ---------------------------------------------------------------------------
// 8. runStructured passthrough
// ---------------------------------------------------------------------------

describe("runEval — runStructured passthrough", () => {
  it("wrapper forwards eventBus + case traceId through RunOptions when runStructured is called", async () => {
    const bus = new AgentEventBus();
    const agent = makeAgent("structured-agent");
    const schema = z.object({ answer: z.string() });
    const step = new AgentStep({ agent, prompt: () => "hi", output: schema });

    const structuredOptionsSeen: RunOptions[] = [];
    const stub: RunnerProtocol = {
      run: (a, _m, o) => runLifecycle(a, o, {}),
      runStructured: async (a, _m, s, o) => {
        structuredOptionsSeen.push(o ?? {});
        const base = await runLifecycle(a, o, {});
        return { ...base, object: s.parse({ answer: "ok" }) };
      },
    };

    const report = await runEval(
      { target: step, cases: [{ id: "a", input: "x" }], scorers: [] },
      { runner: stub, eventBus: bus },
    );

    expect(report.results[0]?.succeeded).toBe(true);
    expect(report.results[0]?.output).toEqual({ answer: "ok" });
    expect(structuredOptionsSeen).toHaveLength(1);
    expect(structuredOptionsSeen[0]?.eventBus).toBe(bus);
    expect(structuredOptionsSeen[0]?.traceId).toBe(report.results[0]?.traceId);
  });
});
