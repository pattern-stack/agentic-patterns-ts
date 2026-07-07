import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { renderSharedState, sequentialAgent } from "../sequential-agents.js";
import { createScratchpad, slot } from "../slot.js";

function makeAgent(name: string): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    getSystemPrompt: () => `sys:${name}`,
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
