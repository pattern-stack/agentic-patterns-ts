import { describe, expect, it } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { AgentStep } from "../agent-step.js";
import { NodeBackedRunner, asAgent, isPromotedAgent } from "../as-agent.js";
import { FunctionStep } from "../function-step.js";
import type { Node } from "../node.js";
import { Sequential } from "../sequential.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(name = "test-agent"): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    getSystemPrompt: () => "You are a test agent.",
    renderInitialPrompt: () => "Initial prompt",
  };
}

// ---------------------------------------------------------------------------
// asAgent() + NodeBackedRunner
// ---------------------------------------------------------------------------

describe("asAgent", () => {
  it("promotes a Sequential pipeline and runs it via NodeBackedRunner", async () => {
    const pipeline = Sequential.start(
      new FunctionStep<string, string>({ name: "upper", fn: (s) => s.toUpperCase() }),
    )
      .then(new FunctionStep<string, string>({ name: "exclaim", fn: (s) => `${s}!` }))
      .build("pipe");

    const promoted = asAgent(pipeline, { role: { name: "Pipe" } });
    expect(promoted.role.name).toBe("Pipe");
    expect(isPromotedAgent(promoted)).toBe(true);

    const inner = new MockRunner();
    const runner = new NodeBackedRunner(inner);
    const result = await runner.run(promoted, "hello");

    expect(result.response).toBe("HELLO!");
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

  it("maps a failed node result to finishReason: error without throwing", async () => {
    const failing: Node<string, string> = {
      name: "boom",
      run: async () => ({
        output: "",
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

  it("run() throws a clear error when given a non-promoted agent", async () => {
    const runner = new NodeBackedRunner(new MockRunner());
    await expect(runner.run(makeAgent("plain"), "hi")).rejects.toThrow(/requires a PromotedAgent/);
  });

  // -------------------------------------------------------------------------
  // Role identity
  // -------------------------------------------------------------------------

  it("falls back to a one-line descriptor when given a minimal role (no full Role)", () => {
    const pipeline = new FunctionStep<string, string>({ name: "n", fn: (s) => s });
    const promoted = asAgent(pipeline, { role: { name: "Minimal" } });
    expect(promoted.getSystemPrompt()).toContain("Promoted pipeline");
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
