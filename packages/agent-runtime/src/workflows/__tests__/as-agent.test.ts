import {
  Judgment,
  Methodology,
  Persona,
  Recovery,
  RoleBuilder,
  Tone,
} from "@agentic-patterns/core";
import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent } from "../../events/types.js";
import { createEvent } from "../../events/types.js";
import type { AgentLike } from "../../runner/agent-runner.js";
import { AgentRunner } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { AgentStep } from "../agent-step.js";
import { NodeBackedRunner, asAgent, isPromotedAgent } from "../as-agent.js";
import { FunctionStep } from "../function-step.js";
import type { Node, NodeRunContext } from "../node.js";
import { Sequential } from "../sequential.js";

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

// ---------------------------------------------------------------------------
// asAgent() + NodeBackedRunner
// ---------------------------------------------------------------------------

describe("asAgent", () => {
  it("promotes a Sequential pipeline and runs it via NodeBackedRunner, in order", async () => {
    // Non-commutative fixtures (append "-A" then "-B") so a wrong execution
    // order would produce a different, observably wrong string.
    const pipeline = Sequential.start(
      new FunctionStep<string, string>({ name: "appendA", fn: (s) => `${s}-A` }),
    )
      .then(new FunctionStep<string, string>({ name: "appendB", fn: (s) => `${s}-B` }))
      .build("pipe");

    const promoted = asAgent(pipeline, { role: { name: "Pipe" } });
    expect(promoted.role.name).toBe("Pipe");
    expect(isPromotedAgent(promoted)).toBe(true);

    const inner = new MockRunner();
    const runner = new NodeBackedRunner(inner);
    const result = await runner.run(promoted, "hello");

    expect(result.response).toBe("hello-A-B");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCallsCount).toBe(0);
    expect(result.iterations).toBe(1);
  });

  it("sums token totals from the node's rollup", async () => {
    const llm = new MockRunner().addResponse("*", {
      content: "step-out",
      inputTokens: 5,
      outputTokens: 10,
    });

    const pipeline = new AgentStep<string, string>({
      name: "single",
      agent: makeAgent("inner-agent"),
      prompt: (input) => input,
    });

    const promoted = asAgent(pipeline, { role: { name: "Pipe" } });
    const runner = new NodeBackedRunner(llm);
    const result = await runner.run(promoted, "hi");

    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(10);
  });

  it("isPromotedAgent rejects plain AgentLike and non-objects", () => {
    expect(isPromotedAgent(makeAgent())).toBe(false);
    expect(isPromotedAgent(null)).toBe(false);
    expect(isPromotedAgent(42)).toBe(false);
    expect(isPromotedAgent({})).toBe(false);
  });

  it("isPromotedAgent rejects a __promotedNode that isn't Node-shaped (key present, no .run)", () => {
    const fake = {
      ...makeAgent("fake"),
      __promotedNode: { name: "not-a-node" }, // no `run` — must NOT pass
      coerceIn: (m: string) => m,
      renderOut: (o: string) => o,
    };
    expect(isPromotedAgent(fake)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AgentStep round-trip (Agent -> Node -> Agent)
  // -------------------------------------------------------------------------

  it("round-trips an Agent through AgentStep and back via asAgent (nested AgentStep uses inner runner)", async () => {
    const llm = new MockRunner().addResponse("Say hi", {
      content: "hi from inner agent",
      inputTokens: 3,
      outputTokens: 4,
    });

    const wrapped = new AgentStep<string, string>({
      name: "wrapped",
      agent: makeAgent("wrapped-agent"),
      prompt: () => "Say hi",
    });

    const promoted = asAgent(wrapped, { role: { name: "RoundTrip" } });
    const runner = new NodeBackedRunner(llm);
    const result = await runner.run(promoted, "ignored");

    expect(result.response).toBe("hi from inner agent");
    expect(llm.callHistory.length).toBe(1);
    expect(llm.callHistory[0]?.agentName).toBe("wrapped-agent");
  });

  // -------------------------------------------------------------------------
  // Coercion defaults & seams
  // -------------------------------------------------------------------------

  it("defaults coerceIn to identity for a string pipeline", async () => {
    const pipeline = new FunctionStep<string, string>({ fn: (s) => s });
    const promoted = asAgent(pipeline, { role: { name: "Str" } });
    const runner = new NodeBackedRunner(new MockRunner());
    const result = await runner.run(promoted, "raw message");
    expect(result.response).toBe("raw message");
  });

  it("requires and uses a supplied coerceIn for a non-string pipeline", async () => {
    interface Req {
      readonly topic: string;
    }
    const pipeline = new FunctionStep<Req, string>({ fn: (r) => `topic:${r.topic}` });
    const promoted = asAgent(pipeline, {
      role: { name: "NonString" },
      coerceIn: (message) => ({ topic: message }),
    });
    const runner = new NodeBackedRunner(new MockRunner());
    const result = await runner.run(promoted, "widgets");
    expect(result.response).toBe("topic:widgets");
  });

  it("defaults renderOut to JSON.stringify for a non-string TOut", async () => {
    const pipeline = new FunctionStep<string, { n: number }>({ fn: (s) => ({ n: s.length }) });
    const promoted = asAgent(pipeline, { role: { name: "Obj" } });
    const runner = new NodeBackedRunner(new MockRunner());
    const result = await runner.run(promoted, "abc");
    expect(result.response).toBe(JSON.stringify({ n: 3 }, null, 2));
  });

  // -------------------------------------------------------------------------
  // Failure mapping
  // -------------------------------------------------------------------------

  it("maps a failed node result to finishReason: error, surfacing the error in a string response", async () => {
    // The real AgentStep/FunctionStep failure shape: `output: undefined`, not
    // `""` — this is what actually breaks a naive `renderOut(result.output)`.
    const failing: Node<string, string> = {
      name: "boom",
      run: async () => ({
        output: undefined as unknown as string,
        succeeded: false,
        error: new Error("boom"),
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
    };
    const promoted = asAgent(failing, { role: { name: "Failing" } });
    const runner = new NodeBackedRunner(new MockRunner());
    const result = await runner.run(promoted, "go");

    expect(result.finishReason).toBe("error");
    expect(typeof result.response).toBe("string");
    expect(result.response).toContain("boom");
  });

  // -------------------------------------------------------------------------
  // Stream shape
  // -------------------------------------------------------------------------

  it("stream() emits message.start -> chunk -> message.complete", async () => {
    const pipeline = new FunctionStep<string, string>({ fn: (s) => s.toUpperCase() });
    const promoted = asAgent(pipeline, { role: { name: "Streamer" } });
    const runner = new NodeBackedRunner(new MockRunner());

    const events = [];
    for await (const event of runner.stream(promoted, "yo")) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.message.chunk",
      "agent.message.complete",
    ]);
    const chunk = events[1];
    if (chunk?.type === "agent.message.chunk") {
      expect(chunk.delta).toBe("YO");
    } else {
      throw new Error("expected chunk event");
    }
  });

  it("stream() relays a node's intra-run tool.* events LIVE, before the terminal chunk (filtering llm noise)", async () => {
    // A node that publishes stage span events on ctx.eventBus mid-run — the live
    // step-reporting seam. `agent.llm.start` is published too and MUST be filtered
    // (internal-only); the node's output still arrives once, in the terminal chunk.
    const emitting: Node<string, string> = {
      name: "emitter",
      async run(input: string, ctx: NodeRunContext) {
        const bus = ctx.eventBus;
        await bus?.publish(
          createEvent("agent.tool.start", {
            traceId: "t",
            runId: "r",
            toolCallId: "interpret",
            toolName: "interpret",
            arguments: {},
          }),
        );
        await bus?.publish(
          // internal noise — must NOT be relayed to the transport
          createEvent("agent.llm.start", {
            traceId: "t",
            runId: "r",
            model: "m",
            messageCount: 1,
            hasTools: false,
          }),
        );
        await bus?.publish(
          createEvent("agent.tool.end", {
            traceId: "t",
            runId: "r",
            toolCallId: "interpret",
            toolName: "interpret",
            arguments: {},
            result: { ok: true },
            durationMs: 1,
            resultTokens: 0,
          }),
        );
        return {
          output: input.toUpperCase(),
          succeeded: true,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        };
      },
    };

    const promoted = asAgent(emitting, { role: { name: "Emitter" } });
    const runner = new NodeBackedRunner(new MockRunner());

    const events: AgentEvent[] = [];
    for await (const event of runner.stream(promoted, "yo")) events.push(event);
    const types = events.map((e) => e.type);

    // start first, complete last; both stage span events relayed; llm filtered.
    expect(types[0]).toBe("agent.message.start");
    expect(types[types.length - 1]).toBe("agent.message.complete");
    expect(types).toContain("agent.tool.start");
    expect(types).toContain("agent.tool.end");
    expect(types).not.toContain("agent.llm.start");

    // LIVE: the relayed span events precede the terminal answer chunk (not batched after it).
    const chunkIdx = types.indexOf("agent.message.chunk");
    expect(types.indexOf("agent.tool.start")).toBeLessThan(chunkIdx);
    expect(types.indexOf("agent.tool.end")).toBeLessThan(chunkIdx);

    // the answer body still arrives once, in the terminal chunk
    const chunk = events.find((e) => e.type === "agent.message.chunk");
    if (chunk?.type === "agent.message.chunk") expect(chunk.delta).toBe("YO");
    else throw new Error("expected chunk event");
  });

  it("run() throws a clear error when given a non-promoted agent", async () => {
    const runner = new NodeBackedRunner(new MockRunner());
    await expect(runner.run(makeAgent("plain"), "hi")).rejects.toThrow(/requires a PromotedAgent/);
  });

  // -------------------------------------------------------------------------
  // Role identity
  // -------------------------------------------------------------------------

  it("renders a full core Role via the section-composed prompt", () => {
    const role = new RoleBuilder("Pipeline Reviewer")
      .withPersona(new Persona({ identity: "a pipeline reviewer", tone: "terse" }))
      .withJudgment(
        new Judgment({
          domain: "review",
          constraints: ["Never approve failing pipelines"],
          escalationTriggers: ["Unclear ownership"],
        }),
      )
      .withTone(new Tone({ name: "direct", prompt: "Be blunt and specific." }))
      .withMethodology(new Methodology({ name: "checklist", prompt: "Work the checklist." }))
      .withRecovery(new Recovery({ name: "retry", prompt: "Retry once.", maxAttempts: 2 }))
      .build();

    const step = new FunctionStep<string, string>({ name: "noop", fn: (s) => s });
    const promoted = asAgent(step, { role });

    const prompt = promoted.renderInitialPrompt();
    expect(prompt).toContain("# Pipeline Reviewer");
    expect(prompt).toContain("## Identity");
    expect(prompt).toContain("Be blunt and specific.");
    expect(prompt).toContain("## Boundaries");
    expect(prompt).toContain("- Never approve failing pipelines");
    expect(prompt).toContain("### Recovery");
    expect(prompt).toContain("## Methodology");
    expect(prompt).toContain("Work the checklist.");
    // Promoted pipelines deliberately alias both prompt renders.
    expect(promoted.renderInitialPrompt()).toBe(prompt);
  });

  it("falls back to a one-line descriptor when given a minimal role (no full Role)", () => {
    const pipeline = new FunctionStep<string, string>({ name: "n", fn: (s) => s });
    const promoted = asAgent(pipeline, { role: { name: "Minimal" } });
    expect(promoted.renderInitialPrompt()).toContain("Promoted pipeline");
  });

  it("threads a minimal role's description into the descriptor", () => {
    const pipeline = new FunctionStep<string, string>({ name: "n", fn: (s) => s });
    const promoted = asAgent(pipeline, {
      role: { name: "Minimal", description: "does the thing" },
    });
    expect(promoted.renderInitialPrompt()).toContain("does the thing");
    expect(promoted.renderInitialPrompt()).toBe(promoted.renderInitialPrompt());
  });

  it("defaults getModel() to a sensible tier string, overridable via opts.model", () => {
    const pipeline = new FunctionStep<string, string>({ fn: (s) => s });
    const promoted = asAgent(pipeline, { role: { name: "M" } });
    expect(typeof promoted.getModel()).toBe("string");

    const overridden = asAgent(pipeline, { role: { name: "M" }, model: "opus" });
    expect(overridden.getModel()).toBe("opus");
  });

  it("getTools() is always empty", () => {
    const pipeline = new FunctionStep<string, string>({ fn: (s) => s });
    const promoted = asAgent(pipeline, { role: { name: "T" } });
    expect(promoted.getTools()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #102 (m.b) — promoted-pipeline nesting: NodeBackedRunner forwards
// options.traceId/parentSpanId into the inner AgentStep's run, so a promoted
// pipeline invoked as a sub-workflow (the playground acceptance path) roots
// its nested spans under the invoking call instead of an orphan trace.
// ---------------------------------------------------------------------------

describe("asAgent + NodeBackedRunner — trace/span propagation (#102)", () => {
  it("forwards options.traceId/parentSpanId into the inner AgentStep's events", async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "inner done" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
        warnings: [],
      }),
    });

    const bus = new AgentEventBus();
    const inner = new AgentRunner(model, bus);

    const innerAgent: AgentLike = {
      role: { name: "inner-agent" },
      getModel: () => "mock-model",
      getTools: () => [],
      renderInitialPrompt: () => "you are the inner agent",
    };

    const pipeline = new AgentStep<string, string>({
      name: "single",
      agent: innerAgent,
      prompt: (input) => input,
    });

    const promoted = asAgent(pipeline, { role: { name: "Pipe" } });
    const runner = new NodeBackedRunner(inner);

    const captured: AgentEvent[] = [];
    bus.subscribe("agent.message.start", (e) => captured.push(e as AgentEvent));

    const result = await runner.run(promoted, "hello", {
      traceId: "parent-trace",
      parentSpanId: "invoking-tool-call-id",
    });

    expect(result.response).toBe("inner done");
    expect(captured).toHaveLength(1);
    // The inner AgentStep's run() joins the parent trace (not a fresh one)…
    expect(captured[0]?.traceId).toBe("parent-trace");
    // …and its root span nests directly under the invoking call.
    expect(captured[0]?.parentSpanId).toBe("invoking-tool-call-id");
  });

  it("without options.traceId/parentSpanId, the inner run behaves as before (no forced nesting)", async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "inner done" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
        warnings: [],
      }),
    });

    const bus = new AgentEventBus();
    const inner = new AgentRunner(model, bus);

    const innerAgent: AgentLike = {
      role: { name: "inner-agent" },
      getModel: () => "mock-model",
      getTools: () => [],
      renderInitialPrompt: () => "you are the inner agent",
    };

    const pipeline = new AgentStep<string, string>({ agent: innerAgent, prompt: (i) => i });
    const promoted = asAgent(pipeline, { role: { name: "Pipe" } });
    const runner = new NodeBackedRunner(inner);

    const captured: AgentEvent[] = [];
    bus.subscribe("agent.message.start", (e) => captured.push(e as AgentEvent));

    await runner.run(promoted, "hello");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.parentSpanId).toBeUndefined();
  });
});
