import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { FunctionStep } from "../function-step.js";
import type { Node } from "../node.js";
import {
  type ParallelAgentBranchSpec,
  type ParallelAgentOpts,
  type ParallelAgentResult,
  parallelAgent,
} from "../parallel-agents.js";
import { sequentialAgent } from "../sequential-agents.js";
import { createScratchpad, slot } from "../slot.js";

function makeAgent(name: string): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    renderInitialPrompt: () => `init:${name}`,
  };
}

/** A deterministic node branch. */
function fnStep(name: string, out: string): FunctionStep<unknown, string> {
  return new FunctionStep<unknown, string>({ name, fn: () => out });
}

describe("parallelAgent", () => {
  it("fans FIXED agent branches out over the shared input and joins by name in DECLARATION order", async () => {
    const runner = new MockRunner()
      .addResponse("draft:overview", { content: "OVERVIEW-TEXT" })
      .addResponse("draft:pricing", { content: "PRICING-TEXT" });

    const node = parallelAgent([
      { agent: makeAgent("overview"), prompt: () => "draft:overview" },
      { agent: makeAgent("pricing"), prompt: () => "draft:pricing" },
    ]);
    const res = await node.run("the canvas task", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.failed).toEqual([]);
    expect(res.output.stopped).toBeNull();
    expect(res.output.branches.overview).toEqual({ succeeded: true, output: "OVERVIEW-TEXT" });
    expect(res.output.branches.pricing).toEqual({ succeeded: true, output: "PRICING-TEXT" });
    // The join is keyed in DECLARATION order — deterministic, like the pad merge.
    expect(Object.keys(res.output.branches)).toEqual(["overview", "pricing"]);
  });

  it("an agent branch's DEFAULT prompt is the task itself (string verbatim; objects render as JSON)", async () => {
    const runner = new MockRunner()
      .addResponse('"q"', { content: "SAW-JSON" })
      .addResponse("the task", { content: "SAW-TASK" });

    const text = await parallelAgent([makeAgent("solo")]).run("the task", { runner });
    expect(text.output.branches.solo).toEqual({ succeeded: true, output: "SAW-TASK" });

    const obj = await parallelAgent([makeAgent("solo")]).run({ q: 1 }, { runner });
    expect(obj.output.branches.solo).toEqual({ succeeded: true, output: "SAW-JSON" });
  });

  it("every branch receives the COMPOSITE's input (there is no 'prior' in a fan-out)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "X" });
    const seen: unknown[] = [];
    const probe = new FunctionStep<unknown, string>({
      name: "probe",
      fn: (input) => {
        seen.push(input);
        return "P";
      },
    });

    const res = await parallelAgent([{ node: probe }, fnStep("other", "O")]).run("shared-input", {
      runner,
    });

    expect(res.succeeded).toBe(true);
    expect(seen).toEqual(["shared-input"]);
    // Bare values duck-type exactly like sequentialAgent's stages.
    expect(res.output.branches.other).toEqual({ succeeded: true, output: "O" });
  });

  it("LEAF-NEVER-THROWS, lifted into the join: a failed branch is an outcome, not a composite failure", async () => {
    const runner = new MockRunner().addResponse("*", { content: "X" });
    const boom = new FunctionStep<unknown, never>({
      name: "boom",
      fn: () => {
        throw new Error("branch exploded");
      },
    });

    const res = await parallelAgent([{ node: boom }, fnStep("ok", "OK")]).run("go", { runner });

    expect(res.succeeded).toBe(true); // the composite JOINED — that is its contract
    expect(res.output.failed).toEqual(["boom"]);
    const outcome = res.output.branches.boom!;
    expect(outcome.succeeded).toBe(false);
    if (!outcome.succeeded) expect(outcome.error.message).toContain("branch exploded");
    expect(res.output.branches.ok).toEqual({ succeeded: true, output: "OK" }); // sibling untouched
  });

  it("a failed AGENT branch takes the same outcome lane, with sibling tokens still rolled up", async () => {
    const runner = new MockRunner()
      .addResponse("draft:bad", { content: "", error: new Error("provider down") })
      .addResponse("draft:good", { content: "FINE", inputTokens: 7, outputTokens: 3 });

    const res = await parallelAgent([
      { agent: makeAgent("bad"), prompt: () => "draft:bad" },
      { agent: makeAgent("good"), prompt: () => "draft:good" },
    ]).run("go", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.failed).toEqual(["bad"]);
    expect(res.output.branches.good).toEqual({ succeeded: true, output: "FINE" });
    expect(res.totalInputTokens).toBe(7);
    expect(res.totalOutputTokens).toBe(3);
  });

  it("emissions land in per-branch slots (auto agents.<name>, or the caller's)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "X" });
    const pad = createScratchpad();
    const mine = slot<string | null>({ key: "custom.overview", scope: "run", init: () => null });
    const auto = slot<string | null>({ key: "agents.body", scope: "run", init: () => null });

    const res = await parallelAgent([
      { node: fnStep("overview", "O-TEXT"), slot: mine },
      fnStep("body", "B-TEXT"),
    ]).run("go", { runner, scratchpad: pad });

    expect(res.succeeded).toBe(true);
    expect(pad.get(mine)).toBe("O-TEXT");
    expect(pad.get(auto)).toBe("B-TEXT");
  });

  it("STOP POLICY is complete-all: a stop signal never cancels siblings, and the FIRST signal in INDEX order wins — not completion order", async () => {
    const runner = new MockRunner().addResponse("*", { content: "X" });
    // Branch 0 finishes LAST; branch 1 signals first temporally. The recorded
    // signal must still be branch 0's — index order, deterministic.
    const slow = new FunctionStep<unknown, string>({
      name: "slow",
      fn: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return "SLOW";
      },
    });
    let fastRan = false;
    const fast = new FunctionStep<unknown, string>({
      name: "fast",
      fn: () => {
        fastRan = true;
        return "FAST";
      },
    });

    const res = await parallelAgent([
      { node: slow, stop: () => "slow says stop" },
      { node: fast, stop: () => "fast says stop" },
    ]).run("go", { runner });

    expect(fastRan).toBe(true); // complete-all: the sibling settled
    expect(res.output.stopped).toEqual({ branch: "slow", reason: "slow says stop" });
    expect(res.output.branches.slow).toEqual({ succeeded: true, output: "SLOW" });
    expect(res.output.branches.fast).toEqual({ succeeded: true, output: "FAST" });
  });

  it("a branch's stop signal short-circuits its OWN onEmit (the sequentialAgent per-stage order)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "X" });
    let emitRan = 0;

    const res = await parallelAgent([
      {
        node: fnStep("x", "OUT"),
        stop: () => "halt",
        onEmit: () => {
          emitRan += 1;
        },
      },
    ]).run("go", { runner });

    expect(emitRan).toBe(0);
    expect(res.output.stopped).toEqual({ branch: "x", reason: "halt" });
  });

  it("onEmit is the branch's follow-through on the FORKED pad; returning a string raises the stop signal; a throw fails the branch only", async () => {
    const runner = new MockRunner().addResponse("*", { content: "X" });
    const derived = slot<number | null>({ key: "derived.len", scope: "run", init: () => null });
    const pad = createScratchpad();

    const res = await parallelAgent([
      {
        node: fnStep("writer", "PAYLOAD"),
        onEmit: (out: string, p) => {
          p.set(derived, out.length);
          return "follow-through says stop";
        },
      },
      {
        node: fnStep("thrower", "T"),
        onEmit: () => {
          throw new Error("tail exploded");
        },
      },
    ]).run("go", { runner, scratchpad: pad });

    expect(res.succeeded).toBe(true);
    expect(pad.get(derived)).toBe("PAYLOAD".length);
    expect(res.output.stopped).toEqual({ branch: "writer", reason: "follow-through says stop" });
    expect(res.output.failed).toEqual(["thrower"]);
    const thrower = res.output.branches.thrower!;
    if (!thrower.succeeded) expect(thrower.error.message).toContain("tail exploded");
  });

  it("output on an AGENT branch drives runStructured; on a NODE branch it ASSERTS (emission verbatim, mismatch fails the branch only)", async () => {
    const Shape = z.object({ verdict: z.string() }); // non-strict: extra keys survive
    const runner = new MockRunner().addResponse("*", {
      content: "ignored",
      object: { verdict: "yes" },
    });

    const res = await parallelAgent([
      { agent: makeAgent("judge"), output: Shape },
      {
        node: new FunctionStep<unknown, { verdict: string; extra: number }>({
          name: "verbatim",
          fn: () => ({ verdict: "ok", extra: 1 }),
        }),
        output: Shape,
      },
      {
        node: new FunctionStep<unknown, unknown>({ name: "bad", fn: () => ({ verdict: 42 }) }),
        output: Shape,
      },
    ]).run("judge it", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output.branches.judge).toEqual({ succeeded: true, output: { verdict: "yes" } });
    // The node's OWN output, not the zod-parsed value — `extra` survives.
    expect(res.output.branches.verbatim).toEqual({
      succeeded: true,
      output: { verdict: "ok", extra: 1 },
    });
    expect(res.output.failed).toEqual(["bad"]);
    const bad = res.output.branches.bad!;
    if (!bad.succeeded) {
      expect(bad.error.message).toContain("parallelAgent: branch 'bad'");
      expect(bad.error.message).toContain("failed its `output` schema");
    }
  });

  it("retry re-runs a pre-emission branch failure on a fresh attempt (exhausted → the branch fails, never the composite)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "X" });
    let attempts = 0;
    const flaky = new FunctionStep<unknown, string>({
      name: "flaky",
      fn: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first attempt flakes");
        return "RECOVERED";
      },
    });

    const res = await parallelAgent([{ node: flaky, retry: 1 }, fnStep("steady", "S")]).run("go", {
      runner,
    });

    expect(attempts).toBe(2);
    expect(res.output.branches.flaky).toEqual({ succeeded: true, output: "RECOVERED" });
    expect(res.output.failed).toEqual([]);

    const exhausted = await parallelAgent([
      {
        node: new FunctionStep<unknown, never>({
          name: "down",
          fn: () => {
            throw new Error("still down");
          },
        }),
        retry: 1,
      },
    ]).run("go", { runner });
    expect(exhausted.succeeded).toBe(true);
    expect(exhausted.output.failed).toEqual(["down"]);
    const outcome = exhausted.output.branches.down!;
    if (!outcome.succeeded) expect(outcome.error.message).toBe("still down");
  });

  it("the caller-declared record types the join per branch (the sequentialAgent<TOut> convention)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "X" });

    const node = parallelAgent<{ overview: string; score: { value: number } }>([
      fnStep("overview", "O"),
      {
        node: new FunctionStep<unknown, { value: number }>({
          name: "score",
          fn: () => ({ value: 9 }),
        }),
      },
    ]);
    const res = await node.run("go", { runner });

    const overview = res.output.branches.overview;
    if (overview.succeeded) {
      const typed: string = overview.output; // compiles without a cast
      expect(typed).toBe("O");
    }
    const score = res.output.branches.score;
    expect(score.succeeded && score.output.value).toBe(9); // narrow → typed access, no cast
  });

  it("THE CANVAS SHAPE: parallelAgent seats as a sequentialAgent stage, feeding a typed tail via input:'prior' + emit", async () => {
    const runner = new MockRunner().addResponse("*", { content: "X" });
    type Sections = { intro: string; body: string };

    const sections = parallelAgent<Sections>([fnStep("intro", "INTRO"), fnStep("body", "BODY")]);
    const assemble = new FunctionStep<ParallelAgentResult<Sections>, string>({
      name: "assemble",
      fn: (join) => {
        const i = join.branches.intro;
        const b = join.branches.body;
        return `${i.succeeded ? i.output : "?"}|${b.succeeded ? b.output : "?"}`;
      },
    });

    // PR 1 + PR 2 vocabulary composing, typed end to end, zero casts.
    const pipeline: Node<string, string> = sequentialAgent<string, string>(
      [
        { node: sections, name: "sections" },
        { node: assemble, input: "prior" },
      ],
      { emit: "assemble" },
    );
    const res = await pipeline.run("draft the canvas", { runner });

    expect(res.succeeded).toBe(true);
    expect(res.output).toBe("INTRO|BODY");
  });

  it("build-time guards: leaves, names, knobs with no parallel analogue, slot races, retry", () => {
    const a = fnStep("a", "A");
    const b = fnStep("b", "B");

    expect(() => parallelAgent([])).toThrow(/at least one branch/);
    expect(() => parallelAgent([{ agent: makeAgent("x"), node: a }])).toThrow(
      /sets BOTH `agent` and `node`/,
    );
    expect(() => parallelAgent([{ name: "empty" }])).toThrow(/sets NEITHER `agent` nor `node`/);
    expect(() => parallelAgent(["nope" as unknown as AgentLike])).toThrow(/is not a branch/);
    expect(() => parallelAgent([makeAgent("same"), { node: a, name: "same" }])).toThrow(
      /duplicate branch name/,
    );
    expect(() => parallelAgent([{ node: a, prompt: () => "hi" }])).toThrow(
      /sets `prompt` on a `node` branch/,
    );
    expect(() => parallelAgent([{ node: a, maxIterations: 3 }])).toThrow(
      /sets `maxIterations` on a `node` branch/,
    );
    // sequentialAgent vocabulary with NO parallel analogue — rejected, not ignored.
    expect(() =>
      parallelAgent([{ node: a, input: "prior" } as unknown as ParallelAgentBranchSpec]),
    ).toThrow(/a fan-out has no 'prior'/);
    expect(() =>
      parallelAgent([{ node: a, emit: true } as unknown as ParallelAgentBranchSpec]),
    ).toThrow(/there is no designated branch/);
    expect(() =>
      parallelAgent([{ node: a }], { emit: "a" } as unknown as ParallelAgentOpts),
    ).toThrow(/there is no designated branch/);
    // Concurrent same-key writes are a race by construction.
    const k1 = slot<string | null>({ key: "same.key", scope: "run", init: () => null });
    const k2 = slot<string | null>({ key: "same.key", scope: "run", init: () => null });
    expect(() =>
      parallelAgent([
        { node: a, slot: k1 },
        { node: b, slot: k2 },
      ]),
    ).toThrow(/duplicate emission slot key 'same.key'/);
    // Cross-branch reads are a race: declared writes AND sibling emission slots.
    expect(() =>
      parallelAgent([
        { node: a, writes: [{ key: "shared.k" }] },
        { node: b, reads: [{ key: "shared.k" }] },
      ]),
    ).toThrow(/cross-branch read is a RACE/);
    expect(() => parallelAgent([{ node: a }, { node: b, reads: [{ key: "agents.a" }] }])).toThrow(
      /cross-branch read is a RACE/,
    );
    // A read nothing in the fan-out writes is fine — established before it.
    expect(() => parallelAgent([{ node: a, reads: [{ key: "seeded.before" }] }])).not.toThrow();
    expect(() => parallelAgent([{ node: a, retry: -1 }])).toThrow(/invalid retry -1/);
  });
});
