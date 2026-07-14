import { describe, expect, it } from "vitest";
import { type ZodType, z } from "zod";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type {
  AgentEvent,
  ScratchpadReadEvent,
  ScratchpadWriteEvent,
  StepEndEvent,
  StepStartEvent,
} from "../../events/types.js";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type {
  RunOptions,
  RunResult,
  RunnerProtocol,
  StructuredRunResult,
} from "../../runner/types.js";
import type { PatternHooks } from "../base.js";
import { FunctionStep } from "../function-step.js";
import type { Node, NodeResult, NodeRunContext } from "../node.js";
import { ObservedScratchpad } from "../observed-scratchpad.js";
import { renderSharedState, sequentialAgent } from "../sequential-agents.js";
import { createScratchpad, slot } from "../slot.js";
import { createStateEmitter } from "../state-events.js";

function makeAgent(name: string): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    renderInitialPrompt: () => `init:${name}`,
  };
}

describe("sequentialAgent", () => {
  it("shares context implicitly: a later stage's prompt carries the earlier emission", async () => {
    const runner = new MockRunner()
      // Registered FIRST (substring matching is insertion-ordered): fires ONLY when the
      // implicit render carried stage 1's emission — i.e. proves the context flowed.
      .addResponse("PRIOR STAGE ESTABLISHED (finder)", { content: "BETA-CONCLUSION" })
      .addResponse("the task", { content: "ALPHA-FINDING" });

    const node = sequentialAgent([makeAgent("finder"), makeAgent("concluder")]);
    const res = await node.run("the task", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.outputs).toEqual({ finder: "ALPHA-FINDING", concluder: "BETA-CONCLUSION" });
    expect(res.output.stopped).toBeNull();
  });

  it("writes each emission to its slot on the shared pad (caller-provided pad)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const pad = createScratchpad();
    const mySlot = slot<string | null>({ key: "custom.finding", scope: "run", init: () => null });

    const node = sequentialAgent([{ agent: makeAgent("finder"), slot: mySlot }]);
    const res = await node.run("go", { runner, scratchpad: pad });

    expect(res.succeeded).toBe(true);
    expect(pad.get(mySlot)).toBe("OUT");
  });

  it("routes structured stages through runStructured (typed emission)", async () => {
    const Shape = z.object({ verdict: z.string() }).strict();
    const runner = new MockRunner().addResponse("*", {
      content: "ignored",
      object: { verdict: "yes" },
    });

    const node = sequentialAgent([{ agent: makeAgent("judge"), output: Shape }]);
    const res = await node.run("judge it", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.outputs.judge).toEqual({ verdict: "yes" });
  });

  it("stop() short-circuits: later stages never run and the result carries the reason", async () => {
    const runner = new MockRunner()
      .addResponse("*", { content: "AMBIGUOUS" })
      .addResponse("AMBIGUOUS", { content: "SHOULD-NEVER-RUN" });

    const node = sequentialAgent([
      {
        agent: makeAgent("interpret"),
        stop: (out) => (out === "AMBIGUOUS" ? "clarify: which one?" : null),
      },
      makeAgent("resolve"),
    ]);
    const res = await node.run("q", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.stopped).toEqual({ stage: "interpret", reason: "clarify: which one?" });
    expect(res.output.outputs).toEqual({ interpret: "AMBIGUOUS" });
  });

  it("onEmit runs the stage's deterministic follow-through and may stop by returning a reason", async () => {
    const runner = new MockRunner().addResponse("*", { content: "big-universe" });
    const derived = slot<number | null>({ key: "derived.count", scope: "run", init: () => null });
    const pad = createScratchpad();

    const node = sequentialAgent([
      {
        agent: makeAgent("resolve"),
        onEmit: (out, p) => {
          p.set(derived, String(out).length);
          return "over-budget: narrow the ask";
        },
      },
      makeAgent("curate"),
    ]);
    const res = await node.run("q", { runner, scratchpad: pad });

    expect(res.succeeded).toBe(true);
    expect(pad.get(derived)).toBe("big-universe".length);
    expect(res.output.stopped).toEqual({ stage: "resolve", reason: "over-budget: narrow the ask" });
    expect(res.output.outputs.curate).toBeUndefined();
  });

  it("a custom prompt renders from the pad instead of the implicit state", async () => {
    const runner = new MockRunner()
      .addResponse("first", { content: "windowed-content" })
      .addResponse("WINDOW[windowed-content]", { content: "done" });
    const view = slot<string | null>({ key: "view", scope: "run", init: () => null });

    const node = sequentialAgent([
      { agent: makeAgent("a"), onEmit: (out, p) => void p.set(view, String(out)) },
      { agent: makeAgent("b"), prompt: (state) => `WINDOW[${state.get(view)}]` },
    ]);
    const res = await node.run("first", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.outputs.b).toBe("done");
  });

  it("a failed stage fails the sequence with token rollup intact", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "",
      error: new Error("provider down"),
    });
    const node = sequentialAgent([makeAgent("a")]);
    const res = await node.run("anything", { runner });
    expect(res.succeeded).toBe(false);
    expect(res.error?.message).toContain("provider down");
  });

  it("build-time guards: empty stages, duplicate names, undeclared reads", () => {
    expect(() => sequentialAgent([])).toThrow(/at least one stage/);
    expect(() => sequentialAgent([makeAgent("same"), makeAgent("same")])).toThrow(
      /duplicate stage name/,
    );
    expect(() =>
      sequentialAgent([{ agent: makeAgent("x"), reads: [{ key: "never.written" }] }]),
    ).toThrow(/reads 'never.written'/);
    // Declared write → the read is satisfied.
    expect(() =>
      sequentialAgent([
        { agent: makeAgent("w"), writes: [{ key: "later.read" }] },
        { agent: makeAgent("r"), reads: [{ key: "later.read" }] },
      ]),
    ).not.toThrow();
  });

  it("default visibility follows the CHAIN: stage 3 does NOT implicitly see stage 1", async () => {
    const runner = new MockRunner()
      .addResponse("ONE-OUT", { content: "LEAKED" }) // fires only if stage 1's emission leaks forward
      .addResponse("TWO-OUT", { content: "CHAIN-OK" }) // stage 3: sees the PRIOR (stage 2) emission
      .addResponse("the task", { content: "ONE-OUT" }) // stage 1
      .addResponse("isolated", { content: "TWO-OUT" }); // stage 2 (custom prompt, isolated)
    const node = sequentialAgent([
      makeAgent("one"),
      { agent: makeAgent("two"), prompt: () => "isolated" },
      makeAgent("three"),
    ]);
    const res = await node.run("the task", { runner });
    expect(res.succeeded).toBe(true);
    expect(res.output.outputs.three).toBe("CHAIN-OK");
  });

  it("opts.render = renderSharedState opts into all-prior visibility", async () => {
    const runner = new MockRunner()
      .addResponse("## one", { content: "SAW-EVERYTHING" })
      .addResponse("*", { content: "X" });
    const node = sequentialAgent([makeAgent("one"), makeAgent("two"), makeAgent("three")], {
      render: renderSharedState,
    });
    const res = await node.run("task", { runner });
    expect(res.succeeded).toBe(true);
    expect(res.output.outputs.three).toBe("SAW-EVERYTHING"); // stage 1's section reached stage 3
  });

  it("a TYPED stage spec seats without casts (AgentStage variance)", async () => {
    const Shape = z.object({ verdict: z.string() }).strict();
    const runner = new MockRunner().addResponse("*", { content: "x", object: { verdict: "ok" } });
    // The point of this test is the TYPES: a fully-typed spec in the stages array
    // must compile with no `as` casts (TOut is contravariant in the callbacks).
    const typed = {
      agent: makeAgent("typed"),
      output: Shape,
      stop: (out: { verdict: string }) => (out.verdict === "stop" ? "stopped" : null),
      onEmit: (out: { verdict: string }) => {
        void out.verdict;
      },
    };
    const res = await sequentialAgent([typed]).run("go", { runner });
    expect(res.succeeded).toBe(true);
    expect(res.output.outputs.typed).toEqual({ verdict: "ok" });
  });

  it("renderSharedState: the task alone, then task + prior sections", () => {
    expect(renderSharedState("do it", [])).toBe("do it");
    const two = renderSharedState("do it", [{ name: "a", output: { k: 1 } }]);
    expect(two).toContain("do it");
    expect(two).toContain("## a");
    expect(two).toContain('"k": 1');
  });

  it("nests like any node: run-scoped slots persist across Loop-style re-entry", async () => {
    const runner = new MockRunner().addResponse("*", { content: "x" });
    const counter = slot<number>({ key: "n", scope: "run", init: () => 0 });
    const pad = createScratchpad();
    const node = sequentialAgent([
      { agent: makeAgent("inc"), onEmit: (_o, p) => void p.update(counter, (n) => n + 1) },
    ]);
    await node.run("a", { runner, scratchpad: pad });
    await node.run("b", { runner, scratchpad: pad });
    expect(pad.get(counter)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Stage-level retry (#201)
// ---------------------------------------------------------------------------

/**
 * A stateful runner that FAILS its first `failFirst` calls (by throwing — the
 * shape a provider error or a starved tool loop takes at the runner boundary,
 * which `AgentStep` catches into `succeeded:false`), then succeeds. Needed
 * because `MockRunner` is stateless: the same prompt always yields the same
 * response, so it cannot model fail-once-then-succeed on an UNCHANGED render —
 * which is exactly the fresh-transcript retry path under test.
 */
class FlakyRunner implements RunnerProtocol {
  calls = 0;
  constructor(
    private readonly failFirst: number,
    private readonly success: { content?: string; object?: unknown },
    private readonly makeError: () => Error = () => new Error("provider flake"),
  ) {}

  async run(_agent: AgentLike, _message: string, _options?: RunOptions): Promise<RunResult> {
    this.calls += 1;
    if (this.calls <= this.failFirst) throw this.makeError();
    return {
      response: this.success.content ?? "OK",
      inputTokens: 1,
      outputTokens: 1,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
    };
  }

  async runStructured<T>(
    _agent: AgentLike,
    _message: string,
    schema: ZodType<T>,
    _options?: RunOptions,
  ): Promise<StructuredRunResult<T>> {
    this.calls += 1;
    if (this.calls <= this.failFirst) throw this.makeError();
    const object = schema.parse(this.success.object);
    return {
      response: JSON.stringify(object),
      inputTokens: 1,
      outputTokens: 1,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
      object,
    };
  }
}

describe("sequentialAgent: stage retry (#201)", () => {
  it("retry: N re-runs a pre-emission failure on a fresh transcript until it emits", async () => {
    const runner = new FlakyRunner(1, { content: "RECOVERED" });
    const events: string[] = [];
    const hooks: PatternHooks = {
      onPatternStart: (e) => void events.push(`start:${e.patternName}`),
      onIterationStart: (e) => void events.push(`iter:${e.iteration}`),
      onPatternComplete: (e) => void events.push(`complete:${e.patternName}`),
    };

    const node = sequentialAgent([{ agent: makeAgent("resolve"), retry: 1 }]);
    const res = await node.run("go", { runner, hooks });

    expect(res.succeeded).toBe(true);
    // Identical emission to a clean run — the retry is invisible to downstream shape.
    expect(res.output.outputs).toEqual({ resolve: "RECOVERED" });
    expect(res.output.stopped).toBeNull();
    expect(runner.calls).toBe(2); // failed once, then succeeded
    // Observable on the bus: the wrapper emitted its lifecycle, one iteration per attempt.
    expect(events).toContain("start:resolve:retry");
    expect(events).toContain("iter:0");
    expect(events).toContain("iter:1");
    expect(events).toContain("complete:resolve:retry");
  });

  it("retry omitted: a pre-emission failure aborts the sequence AND emits no pattern events", async () => {
    const runner = new FlakyRunner(1, { content: "unreachable" });
    const events: string[] = [];
    const hooks: PatternHooks = {
      onPatternStart: (e) => void events.push(e.patternName),
      onPatternComplete: (e) => void events.push(e.patternName),
    };
    const node = sequentialAgent([makeAgent("resolve")]);
    const res = await node.run("go", { runner, hooks });

    expect(res.succeeded).toBe(false);
    expect(res.error?.message).toContain("provider flake");
    expect(runner.calls).toBe(1); // no retry — one attempt, then abort
    expect(events).toEqual([]); // byte-identical: no Retry wrapper => zero extra bus events
  });

  it("exhausted retries surface the stage's ORIGINAL failure (not a retry-wrapper error)", async () => {
    const runner = new FlakyRunner(5, { content: "unreachable" }, () => new Error("still down"));
    const node = sequentialAgent([{ agent: makeAgent("a"), retry: 2 }]);
    const res = await node.run("go", { runner });

    expect(res.succeeded).toBe(false);
    expect(res.error?.message).toBe("still down"); // the leaf's error verbatim, not wrapped
    expect(runner.calls).toBe(3); // 1 initial + 2 retries
  });

  it("threads token rollup through the wrapper (success attempt's tokens land in the sequence total)", async () => {
    // AgentStep's catch reports 0/0 on a thrown failure (pre-existing contract), so a
    // failed pre-emission attempt contributes 0 tokens; the succeeding attempt's real
    // tokens must still surface in the sequence rollup via Retry's accumulation.
    const runner = new FlakyRunner(1, { content: "OK" }); // success => 1 in / 1 out
    const node = sequentialAgent([{ agent: makeAgent("a"), retry: 1 }]);
    const res = await node.run("go", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.totalInputTokens).toBe(1);
    expect(res.totalOutputTokens).toBe(1);
  });

  it("counts WHOLE agent attempts — it does not multiply runStructured's internal shape retry", async () => {
    const Shape = z.object({ verdict: z.string() }).strict();
    const runner = new FlakyRunner(1, { object: { verdict: "ok" } });
    const node = sequentialAgent([{ agent: makeAgent("judge"), output: Shape, retry: 1 }]);
    const res = await node.run("judge it", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.outputs.judge).toEqual({ verdict: "ok" });
    expect(runner.calls).toBe(2); // one whole-agent retry; NOT an added shape-reprompt layer
  });

  it("tool-loop starvation is retried; stop/onEmit fire once, only on the successful emission", async () => {
    const starve = () =>
      new Error(
        'runStructured: 2-tier fallback got empty tier-1 output (finishReason="max_iterations")',
      );
    const runner = new FlakyRunner(1, { content: "EMITTED" }, starve);
    let stopCalls = 0;
    let emitCalls = 0;
    const node = sequentialAgent([
      {
        agent: makeAgent("a"),
        retry: 1,
        stop: () => {
          stopCalls += 1;
          return null;
        },
        onEmit: () => {
          emitCalls += 1;
        },
      },
    ]);
    const res = await node.run("go", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.outputs.a).toBe("EMITTED");
    expect(runner.calls).toBe(2); // starved once, then emitted
    expect(stopCalls).toBe(1); // NOT 2 — the starved attempt never reaches stop/onEmit
    expect(emitCalls).toBe(1);
  });

  it("build-time guard: retry must be a non-negative integer", () => {
    expect(() => sequentialAgent([{ agent: makeAgent("a"), retry: -1 }])).toThrow(
      /invalid retry -1/,
    );
    expect(() => sequentialAgent([{ agent: makeAgent("a"), retry: 1.5 }])).toThrow(
      /invalid retry 1.5/,
    );
    expect(() => sequentialAgent([{ agent: makeAgent("a"), retry: 0 }])).not.toThrow();
    expect(() => sequentialAgent([{ agent: makeAgent("a"), retry: 3 }])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Step events + innate tagging (#226)
// ---------------------------------------------------------------------------

function captureBus(): { bus: AgentEventBus; events: AgentEvent[] } {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribeAll((e) => void events.push(e as AgentEvent));
  return { bus, events };
}

const stepStarts = (events: AgentEvent[]): StepStartEvent[] =>
  events.filter((e) => e.type === "agent.step.start") as StepStartEvent[];
const stepEnds = (events: AgentEvent[]): StepEndEvent[] =>
  events.filter((e) => e.type === "agent.step.end") as StepEndEvent[];

describe("sequentialAgent: step events (#226)", () => {
  it("publishes one paired agent.step.start/end per stage, in order, on ctx.eventBus", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const { bus, events } = captureBus();

    const node = sequentialAgent([makeAgent("finder"), makeAgent("concluder")]);
    const res = await node.run("the task", {
      runner,
      eventBus: bus,
      traceId: "t-1",
      runId: "r-1",
    });

    expect(res.succeeded).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      "agent.step.start",
      "agent.step.end",
      "agent.step.start",
      "agent.step.end",
    ]);

    const starts = stepStarts(events);
    const ends = stepEnds(events);
    expect(starts.map((s) => s.stepName)).toEqual(["finder", "concluder"]);
    expect(ends.map((e) => e.stepName)).toEqual(["finder", "concluder"]);
    // Pairing: the end shares its start's spanId (the stage's span).
    expect(ends[0]!.spanId).toBe(starts[0]!.spanId);
    expect(ends[1]!.spanId).toBe(starts[1]!.spanId);
    expect(starts[0]!.spanId).not.toBe(starts[1]!.spanId);
    // Identity + payload contract.
    for (const s of starts) {
      expect(s).toMatchObject({ traceId: "t-1", runId: "r-1", arguments: { input: "the task" } });
      expect(s.agentName).toBe(s.stepName); // default stage name = the agent's role name
    }
    expect(ends[0]!.result).toBe("OUT");
    expect(ends[0]!.error).toBeUndefined();
    expect(ends[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits NOTHING when ctx.eventBus is absent (today's silent behavior)", async () => {
    // The pad is observed on its own bus, so pad writes still publish there —
    // but sequentialAgent's OWN step events are gated on ctx.eventBus.
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const { bus, events } = captureBus();
    const pad = new ObservedScratchpad(createStateEmitter(bus, { traceId: "t", runId: "r" }));

    const res = await sequentialAgent([makeAgent("a")]).run("go", { runner, scratchpad: pad });

    expect(res.succeeded).toBe(true);
    expect(events.some((e) => e.type.startsWith("agent.step."))).toBe(false);
    // (The innate emission write still landed on the pad's own bus.)
    expect(events.some((e) => e.type === "agent.scratchpad.write")).toBe(true);
  });

  it("tags the per-stage emission write innate; consumer onEmit writes stay explicit", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const { bus, events } = captureBus();
    const pad = new ObservedScratchpad(createStateEmitter(bus, { traceId: "t-1", runId: "r-1" }));
    const derived = slot<string | null>({ key: "derived.note", scope: "run", init: () => null });

    const node = sequentialAgent([
      { agent: makeAgent("resolve"), onEmit: (_out, p) => void p.set(derived, "follow-through") },
    ]);
    const res = await node.run("q", {
      runner,
      scratchpad: pad,
      eventBus: bus,
      traceId: "t-1",
      runId: "r-1",
    });

    expect(res.succeeded).toBe(true);
    const writes = events.filter(
      (e) => e.type === "agent.scratchpad.write",
    ) as ScratchpadWriteEvent[];
    expect(writes.map((w) => [w.key, w.origin])).toEqual([
      ["agents.resolve", "innate"],
      ["derived.note", "explicit"],
    ]);
    // Step and state events share the run's identity — one correlatable stream.
    for (const e of events) {
      expect(e.runId).toBe("r-1");
      expect(e.traceId).toBe("t-1");
    }
  });

  it("a failed stage still gets its step.end, carrying the error", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "",
      error: new Error("provider down"),
    });
    const { bus, events } = captureBus();

    const res = await sequentialAgent([makeAgent("a")]).run("go", { runner, eventBus: bus });

    expect(res.succeeded).toBe(false);
    const ends = stepEnds(events);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.error).toContain("provider down");
    expect(ends[0]!.result).toBeUndefined();
  });

  it("a stop() short-circuit closes the stopping stage's step and emits nothing for later stages", async () => {
    const runner = new MockRunner().addResponse("*", { content: "AMBIGUOUS" });
    const { bus, events } = captureBus();

    const node = sequentialAgent([
      { agent: makeAgent("interpret"), stop: () => "clarify: which one?" },
      makeAgent("resolve"),
    ]);
    const res = await node.run("q", { runner, eventBus: bus });

    expect(res.succeeded).toBe(true);
    expect(res.output.stopped).toEqual({ stage: "interpret", reason: "clarify: which one?" });
    expect(stepStarts(events).map((s) => s.stepName)).toEqual(["interpret"]);
    const ends = stepEnds(events);
    expect(ends.map((e) => e.stepName)).toEqual(["interpret"]);
    expect(ends[0]!.result).toBe("AMBIGUOUS");
    expect(ends[0]!.error).toBeUndefined();
  });

  it("an onEmit throw still gets a step.end, carrying the error", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const { bus, events } = captureBus();

    const node = sequentialAgent([
      {
        agent: makeAgent("a"),
        onEmit: () => {
          throw new Error("tail exploded");
        },
      },
    ]);
    const res = await node.run("go", { runner, eventBus: bus });

    expect(res.succeeded).toBe(false);
    const ends = stepEnds(events);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.error).toContain("tail exploded");
  });

  it("nested tool/agent activity nests under the stage span (stageCtx.parentSpanId = step spanId)", async () => {
    // The runner records the options it was called with; AgentStep threads
    // ctx.parentSpanId → RunOptions.parentSpanId, so the delegated agent's
    // events attribute to the stage span.
    const seen: (string | undefined)[] = [];
    const recorder: RunnerProtocol = {
      run: async (_a, _m, options?: RunOptions): Promise<RunResult> => {
        seen.push(options?.parentSpanId);
        return {
          response: "OK",
          inputTokens: 0,
          outputTokens: 0,
          toolCallsCount: 0,
          iterations: 1,
          finishReason: "stop",
        };
      },
    };
    const { bus, events } = captureBus();

    await sequentialAgent([makeAgent("a")]).run("go", { runner: recorder, eventBus: bus });

    const starts = stepStarts(events);
    expect(starts).toHaveLength(1);
    expect(seen).toEqual([starts[0]!.spanId]);
  });
});

// ---------------------------------------------------------------------------
// Innate prompt-read frames (#226) — the implicit render's injection of prior
// emissions is the FRAMEWORK's read, reported per injected slot (the design's
// f-read-prompt frame: "→ prompt · renderPriorEmission [auto], exact injected
// text").
// ---------------------------------------------------------------------------

const scratchpadReadsOf = (events: AgentEvent[]): ScratchpadReadEvent[] =>
  events.filter((e) => e.type === "agent.scratchpad.read") as ScratchpadReadEvent[];

describe("sequentialAgent: innate prompt-read frames (#226)", () => {
  it("default render: a later stage's implicit injection publishes one innate scratchpad.read of the prior emission, nested under the stage span", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const { bus, events } = captureBus();
    const pad = new ObservedScratchpad(createStateEmitter(bus, { traceId: "t-1", runId: "r-1" }));

    const node = sequentialAgent([makeAgent("finder"), makeAgent("concluder")]);
    const res = await node.run("q", {
      runner,
      scratchpad: pad,
      eventBus: bus,
      traceId: "t-1",
      runId: "r-1",
    });

    expect(res.succeeded).toBe(true);
    const reads = scratchpadReadsOf(events);
    // Stage 1 has no prior emission → no read; stage 2 injects finder's.
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      key: "agents.finder",
      origin: "innate",
      preview: "OUT", // the EXACT injected text (string emission → verbatim)
      traceId: "t-1",
      runId: "r-1",
    });
    // Nested under the injecting stage's step span, after its step.start.
    const starts = stepStarts(events);
    expect(reads[0]!.parentSpanId).toBe(starts[1]!.spanId);
    expect(events.indexOf(reads[0]!)).toBeGreaterThan(events.indexOf(starts[1]!));
  });

  it("renderSharedState: the render reads EVERY prior emission, in stage order", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const { bus, events } = captureBus();
    const pad = new ObservedScratchpad(createStateEmitter(bus, { traceId: "t", runId: "r" }));

    const node = sequentialAgent([makeAgent("a"), makeAgent("b"), makeAgent("c")], {
      render: renderSharedState,
    });
    const res = await node.run("q", { runner, scratchpad: pad });

    expect(res.succeeded).toBe(true);
    const reads = scratchpadReadsOf(events);
    expect(reads.map((r) => [r.key, r.origin])).toEqual([
      ["agents.a", "innate"], // stage b injects a
      ["agents.a", "innate"], // stage c injects a…
      ["agents.b", "innate"], // …and b
    ]);
  });

  it("a custom opts.render mints NO innate reads (injections are opaque); a custom stage prompt's state reads stay explicit", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const { bus, events } = captureBus();
    const pad = new ObservedScratchpad(createStateEmitter(bus, { traceId: "t", runId: "r" }));
    const kept = slot<string>({ key: "kept.note", scope: "run", init: () => "seed" });

    const node = sequentialAgent(
      [
        makeAgent("first"),
        { agent: makeAgent("second"), prompt: (state) => `use:${state.get(kept)}` },
      ],
      { render: (input) => `CUSTOM:${String(input)}` },
    );
    const res = await node.run("q", { runner, scratchpad: pad });

    expect(res.succeeded).toBe(true);
    const reads = scratchpadReadsOf(events);
    expect(reads.map((r) => [r.key, r.origin])).toEqual([["kept.note", "explicit"]]);
  });
});

// ---------------------------------------------------------------------------
// Node stages — a stage that already IS a Node (CoordinatorStep, FunctionStep,
// a nested sequential) participates without an AgentStep wrap.
// ---------------------------------------------------------------------------

/**
 * A minimal `CoordinatorStep`-shaped spine: a Node that drives an agent through
 * the ctx runner (the real one delegates to a team) and reports its tokens.
 * Enough to prove a coordinator can BE the sequence's spine — the case that
 * previously forced consumers off `sequentialAgent` onto the raw builder.
 */
function miniCoordinator(name: string): Node<unknown, string> {
  return {
    name,
    async run(input: unknown, ctx: NodeRunContext): Promise<NodeResult<string>> {
      const r = await ctx.runner.run(makeAgent(name), `COORDINATE[${String(input)}]`);
      return {
        output: r.response,
        succeeded: true,
        totalInputTokens: r.inputTokens,
        totalOutputTokens: r.outputTokens,
      };
    },
  };
}

describe("sequentialAgent: node stages", () => {
  it("a FunctionStep mid-stage is a first-class stage: pipeline input in, pad readable, emission → slot → onEmit → the next stage's render", async () => {
    const runner = new MockRunner()
      // Registered FIRST: fires ONLY if the node stage's emission reached stage 3's render.
      .addResponse("ENRICHED:FINDING", { content: "SAW-THE-TAIL" })
      .addResponse("the task", { content: "FINDING" });

    const finding = slot<string | null>({ key: "finder.out", scope: "run", init: () => null });
    const enriched = slot<string | null>({ key: "enrich.out", scope: "run", init: () => null });
    const derived = slot<number | null>({ key: "derived.len", scope: "run", init: () => null });
    const pad = createScratchpad();
    const seen: unknown[] = [];

    const enrich = new FunctionStep<unknown, string>({
      name: "enrich",
      // The node gets the PIPELINE input (like every stage) and reads what the
      // chain established off the PAD — it has no prompt render.
      fn: (input, p) => {
        seen.push(input);
        return `ENRICHED:${p.get(finding)}`;
      },
    });

    const node = sequentialAgent([
      { agent: makeAgent("finder"), slot: finding },
      {
        node: enrich,
        slot: enriched,
        onEmit: (out: string, p) => void p.set(derived, out.length),
      },
      makeAgent("concluder"),
    ]);
    const res = await node.run("the task", { runner, scratchpad: pad });

    expect(res.succeeded).toBe(true);
    expect(seen).toEqual(["the task"]); // the pipeline input, not the prior emission
    expect(res.output.outputs).toEqual({
      finder: "FINDING",
      enrich: "ENRICHED:FINDING",
      concluder: "SAW-THE-TAIL",
    });
    expect(pad.get(enriched)).toBe("ENRICHED:FINDING"); // emission landed in its slot
    expect(pad.get(derived)).toBe("ENRICHED:FINDING".length); // onEmit's follow-through ran
  });

  it("a BARE Node in the stages array seats as a node stage (an AgentLike still seats as an agent)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const tail = new FunctionStep<unknown, string>({ name: "tail", fn: () => "TAIL-RAN" });

    const res = await sequentialAgent([makeAgent("lead"), tail]).run("go", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.outputs).toEqual({ lead: "OUT", tail: "TAIL-RAN" });
  });

  it("stop() on a node stage short-circuits: later stages never run", async () => {
    const runner = new MockRunner().addResponse("*", { content: "SHOULD-NEVER-RUN" });
    const gate = new FunctionStep<unknown, { ok: boolean }>({
      name: "gate",
      fn: () => ({ ok: false }),
    });

    const node = sequentialAgent([
      {
        node: gate,
        stop: (out: { ok: boolean }) => (out.ok ? null : "refuse: nothing resolved"),
      },
      makeAgent("curate"),
    ]);
    const res = await node.run("q", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.stopped).toEqual({ stage: "gate", reason: "refuse: nothing resolved" });
    expect(res.output.outputs.curate).toBeUndefined();
  });

  it("a coordinator-shaped Node is the SPINE: it runs its own agent, rolls tokens up, and feeds the deterministic tail", async () => {
    const runner = new MockRunner().addResponse("COORDINATE[", {
      content: "PLAN-DONE",
      inputTokens: 7,
      outputTokens: 3,
    });
    const answer = slot<string | null>({ key: "coord.out", scope: "run", init: () => null });

    const node = sequentialAgent([
      { node: miniCoordinator("coordinate"), slot: answer },
      {
        node: new FunctionStep<unknown, string>({
          name: "render",
          fn: (_i, p) => `ANSWER(${p.get(answer)})`,
        }),
      },
    ]);
    const res = await node.run("who owns it?", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.outputs).toEqual({ coordinate: "PLAN-DONE", render: "ANSWER(PLAN-DONE)" });
    expect(res.totalInputTokens).toBe(7); // the node's tokens roll into the sequence
    expect(res.totalOutputTokens).toBe(3);
  });

  it("output on a node stage ASSERTS the node's result (emission verbatim); a mismatch fails the stage and `retry` re-runs it", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const Shape = z.object({ verdict: z.string() }); // non-strict: extra keys survive the assert

    // Passes the assert — and the emission is the node's OWN output, NOT the
    // zod-parsed value (`extra` would be stripped by a parse).
    const ok = sequentialAgent([
      {
        node: new FunctionStep<unknown, { verdict: string; extra: number }>({
          name: "judge",
          fn: () => ({ verdict: "yes", extra: 1 }),
        }),
        output: Shape,
      },
    ]);
    const okRes = await ok.run("go", { runner });
    expect(okRes.succeeded).toBe(true);
    expect(okRes.output.outputs.judge).toEqual({ verdict: "yes", extra: 1 });

    // Fails the assert → the stage fails BEFORE emitting, so `retry` re-runs the
    // node on a fresh attempt; the second attempt conforms and the run succeeds.
    let attempts = 0;
    const flaky = sequentialAgent([
      {
        node: new FunctionStep<unknown, unknown>({
          name: "judge",
          fn: () => {
            attempts += 1;
            return attempts === 1 ? { verdict: 42 } : { verdict: "recovered" };
          },
        }),
        output: Shape,
        retry: 1,
      },
    ]);
    const retried = await flaky.run("go", { runner });
    expect(attempts).toBe(2);
    expect(retried.succeeded).toBe(true);
    expect(retried.output.outputs.judge).toEqual({ verdict: "recovered" });

    // Exhausted → the schema failure surfaces on the sequence.
    const bad = sequentialAgent([
      {
        node: new FunctionStep<unknown, unknown>({ name: "judge", fn: () => ({ verdict: 42 }) }),
        output: Shape,
      },
    ]);
    const badRes = await bad.run("go", { runner });
    expect(badRes.succeeded).toBe(false);
    expect(badRes.error?.message).toContain("failed its `output` schema");
  });

  it("a failing node stage fails the sequence (leaf contract unchanged)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const boom = new FunctionStep<unknown, never>({
      name: "boom",
      fn: () => {
        throw new Error("tail exploded");
      },
    });
    const res = await sequentialAgent([boom, makeAgent("never")]).run("go", { runner });

    expect(res.succeeded).toBe(false);
    expect(res.error?.message).toContain("tail exploded");
  });

  it("publishes the stage's step.start/end pair and tags its emission write innate — no agentName (there is no agent)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "OUT" });
    const { bus, events } = captureBus();
    const pad = new ObservedScratchpad(createStateEmitter(bus, { traceId: "t-1", runId: "r-1" }));

    const node = sequentialAgent([
      { node: new FunctionStep<unknown, string>({ name: "tail", fn: () => "TAIL" }) },
    ]);
    const res = await node.run("go", {
      runner,
      scratchpad: pad,
      eventBus: bus,
      traceId: "t-1",
      runId: "r-1",
    });

    expect(res.succeeded).toBe(true);
    const starts = stepStarts(events);
    const ends = stepEnds(events);
    expect(starts.map((s) => s.stepName)).toEqual(["tail"]); // default name = the node's name
    expect(starts[0]!.agentName).toBeUndefined();
    expect(ends[0]!.spanId).toBe(starts[0]!.spanId);
    expect(ends[0]!.result).toBe("TAIL");
    const writes = events.filter(
      (e) => e.type === "agent.scratchpad.write",
    ) as ScratchpadWriteEvent[];
    expect(writes.map((w) => [w.key, w.origin])).toEqual([["agents.tail", "innate"]]);
  });

  it("build-time guards: exactly one leaf per stage; the AgentStep-only knobs are rejected on a node stage", () => {
    const fn = new FunctionStep<unknown, string>({ name: "n", fn: () => "x" });

    expect(() => sequentialAgent([{ agent: makeAgent("a"), node: fn }])).toThrow(
      /sets BOTH `agent` and `node`/,
    );
    expect(() => sequentialAgent([{ node: fn, prompt: () => "hi" }])).toThrow(
      /sets `prompt` on a `node` stage/,
    );
    expect(() => sequentialAgent([{ node: fn, maxIterations: 3 }])).toThrow(
      /sets `maxIterations` on a `node` stage/,
    );
    // A stage that seats NO leaf — a `{ name }`-only spec and a stray non-stage
    // object are the same mistake, and get the same message.
    expect(() => sequentialAgent([{ name: "empty" }])).toThrow(/sets NEITHER `agent` nor `node`/);
    expect(() => sequentialAgent([{ nope: true } as unknown as AgentLike])).toThrow(
      /sets NEITHER `agent` nor `node`/,
    );
    // A non-object entry is not a stage at all.
    expect(() => sequentialAgent(["nope" as unknown as AgentLike])).toThrow(/is not a stage/);
    // The emission-level knobs are FINE on a node stage.
    expect(() =>
      sequentialAgent([
        { node: fn, slot: slot<string>({ key: "k", scope: "run", init: () => "" }) },
        { agent: makeAgent("a"), reads: [{ key: "k" }] },
      ]),
    ).not.toThrow();
  });
});
