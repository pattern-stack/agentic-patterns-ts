import { describe, expect, it, vi } from "vitest";
import { MockRunner } from "../../runner/mock-runner.js";
import { FunctionStep } from "../function-step.js";
import { AccumulatingLoop, type AccumulatingLoopStepInput } from "../loop.js";

describe("AccumulatingLoop", () => {
  it("exits with predicate_met when `until` on the folded acc first holds", async () => {
    const runner = new MockRunner();
    const loop = new AccumulatingLoop<number, number>({
      name: "sum-until-6",
      body: new FunctionStep<AccumulatingLoopStepInput<number, number>, number>({
        name: "inc",
        fn: ({ state }) => state + 1,
      }),
      initial: (input) => input,
      fold: (acc, output) => acc + output,
      until: (acc) => acc >= 6,
      maxIterations: 10,
    });

    const result = await loop.run(0, { runner });
    expect(result.succeeded).toBe(true);
    expect(result.exitReason).toBe("predicate_met");
    // state: 0->1->2->3; fold: acc0=0, +1=1, +2=3, +3=6 -> until(6) true, stop
    expect(result.output).toBe(6);
    expect(result.state).toBe(3);
    expect(result.iterations).toBe(3);
  });

  it("exits with max_iterations and folds the last iteration's output before exit", async () => {
    const runner = new MockRunner();
    const loop = new AccumulatingLoop<number, number>({
      name: "never-satisfied",
      body: new FunctionStep<AccumulatingLoopStepInput<number, number>, number>({
        name: "inc",
        fn: ({ state }) => state + 1,
      }),
      initial: () => 0,
      fold: (acc, output) => acc + output,
      until: () => false,
      maxIterations: 3,
    });

    const result = await loop.run(0, { runner });
    expect(result.exitReason).toBe("max_iterations");
    expect(result.iterations).toBe(3);
    // state: 1,2,3 folded each pass -> acc = 1+2+3 = 6 (cap-hit fold: final iteration IS folded)
    expect(result.output).toBe(6);
    expect(result.state).toBe(3);
    expect(result.succeeded).toBe(true);
  });

  it("exits with error and keeps last-good acc + state — the failing iteration is NOT folded", async () => {
    const runner = new MockRunner();
    const loop = new AccumulatingLoop<number, number>({
      name: "fails-at-2",
      body: new FunctionStep<AccumulatingLoopStepInput<number, number>, number>({
        name: "inc-or-throw",
        fn: ({ state }) => {
          if (state >= 2) throw new Error("boom");
          return state + 1;
        },
      }),
      initial: () => 0,
      fold: (acc, output) => acc + output,
      until: () => false,
      maxIterations: 10,
    });

    const result = await loop.run(0, { runner });
    expect(result.exitReason).toBe("error");
    expect(result.succeeded).toBe(false);
    expect(result.error?.message).toBe("boom");
    // iteration 1: state 0->1, fold acc=1. iteration 2: state 1->2, fold acc=3.
    // iteration 3: body throws on state=2 -> NOT folded, last-good acc=3, state=2.
    expect(result.output).toBe(3);
    expect(result.state).toBe(2);
    expect(result.iterations).toBe(3);
  });

  it("exposes the growing acc to the body — body branches on it", async () => {
    const runner = new MockRunner();
    const seen: number[] = [];
    const loop = new AccumulatingLoop<number, number>({
      body: new FunctionStep<AccumulatingLoopStepInput<number, number>, number>({
        name: "observe-acc",
        fn: ({ state, acc }) => {
          seen.push(acc);
          return state + 1;
        },
      }),
      initial: () => 100,
      fold: (acc, output) => acc + output,
      until: (acc) => acc >= 106,
      maxIterations: 10,
    });

    const result = await loop.run(0, { runner });
    // acc seen by body BEFORE this iteration's fold: 100, 101, 103
    expect(seen).toEqual([100, 101, 103]);
    expect(result.output).toBe(106);
  });

  it("calls fold once per successful iteration with the correct (acc, output, iteration)", async () => {
    const runner = new MockRunner();
    const foldCalls: Array<{ acc: number; output: number; iteration: number }> = [];
    const loop = new AccumulatingLoop<number, number>({
      body: new FunctionStep<AccumulatingLoopStepInput<number, number>, number>({
        fn: ({ state }) => state + 1,
      }),
      initial: () => 0,
      fold: (acc, output, iteration) => {
        foldCalls.push({ acc, output, iteration });
        return acc + output;
      },
      until: (_acc, _state, iteration) => iteration >= 2,
      maxIterations: 10,
    });

    const result = await loop.run(0, { runner });
    expect(result.iterations).toBe(3);
    expect(foldCalls).toEqual([
      { acc: 0, output: 1, iteration: 0 },
      { acc: 1, output: 2, iteration: 1 },
      { acc: 3, output: 3, iteration: 2 },
    ]);
  });

  it("shallow-freezes acc between iterations — top-level reassignment attempts throw, prior fold output is untouched by later mutation attempts", async () => {
    const runner = new MockRunner();
    const loop = new AccumulatingLoop<number, { readonly items: readonly number[] }>({
      body: new FunctionStep<
        AccumulatingLoopStepInput<number, { readonly items: readonly number[] }>,
        number
      >({
        fn: ({ acc, state }) => {
          expect(Object.isFrozen(acc)).toBe(true);
          // Shallow freeze: reassigning a top-level property throws in strict mode.
          expect(() => {
            // @ts-expect-error - intentional violation to prove the freeze
            acc.items = [];
          }).toThrow();
          return state + 1;
        },
      }),
      initial: () => Object.freeze({ items: [] as number[] }),
      fold: (acc, output) => Object.freeze({ items: [...acc.items, output] }),
      until: (acc) => acc.items.length >= 2,
      maxIterations: 10,
    });

    const result = await loop.run(0, { runner });
    // Each fold returns a NEW array (immutable replacement) — prior acc.items
    // references are never mutated in place, so iteration 1's array still reads [1].
    expect(result.output.items).toEqual([1, 2]);
    expect(Object.isFrozen(result.output)).toBe(true);
  });

  it("throws if maxIterations is not a positive integer", () => {
    const body = new FunctionStep<AccumulatingLoopStepInput<number, number>, number>({
      fn: ({ state }) => state + 1,
    });
    expect(
      () =>
        new AccumulatingLoop<number, number>({
          body,
          initial: () => 0,
          fold: (acc, output) => acc + output,
          until: () => true,
          maxIterations: 0,
        }),
    ).toThrow();
    expect(
      () =>
        new AccumulatingLoop<number, number>({
          body,
          initial: () => 0,
          fold: (acc, output) => acc + output,
          until: () => true,
          maxIterations: -1,
        }),
    ).toThrow();
  });

  it("sums tokens across iterations and fires pattern + iteration hooks in Loop's cadence", async () => {
    const runner = new MockRunner();
    const onPatternStart = vi.fn();
    const onPatternComplete = vi.fn();
    const onIterationStart = vi.fn();
    const onIterationComplete = vi.fn();

    const loop = new AccumulatingLoop<number, number>({
      body: new FunctionStep<AccumulatingLoopStepInput<number, number>, number>({
        fn: ({ state }) => state + 1,
      }),
      initial: () => 0,
      fold: (acc, output) => acc + output,
      until: (_acc, _state, iteration) => iteration >= 1,
      maxIterations: 10,
    });

    const result = await loop.run(0, {
      runner,
      hooks: {
        onPatternStart,
        onPatternComplete,
        onIterationStart,
        onIterationComplete,
      },
    });

    expect(result.iterations).toBe(2);
    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
    expect(onPatternStart).toHaveBeenCalledTimes(1);
    expect(onPatternComplete).toHaveBeenCalledTimes(1);
    expect(onIterationStart).toHaveBeenCalledTimes(2);
    expect(onIterationComplete).toHaveBeenCalledTimes(2);
  });

  it("returns a frozen result", async () => {
    const runner = new MockRunner();
    const loop = new AccumulatingLoop<number, number>({
      body: new FunctionStep<AccumulatingLoopStepInput<number, number>, number>({
        fn: ({ state }) => state + 1,
      }),
      initial: () => 0,
      fold: (acc, output) => acc + output,
      until: () => true,
      maxIterations: 1,
    });
    const result = await loop.run(0, { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });

  describe("escalate.ts mirror — navigate -> gap-check -> merge pool -> re-check once, bounded 2", () => {
    interface Pool {
      readonly items: readonly number[];
    }
    interface Decision {
      readonly done: boolean;
      readonly supplements: readonly number[];
    }

    function makeLoop(
      decisions: readonly (Decision | "throw")[],
    ): AccumulatingLoop<Decision, Pool> {
      let call = 0;
      return new AccumulatingLoop<Decision, Pool>({
        name: "escalate-mirror",
        body: new FunctionStep<AccumulatingLoopStepInput<Decision, Pool>, Decision>({
          name: "gap-check",
          fn: () => {
            const next = decisions[call];
            call += 1;
            if (next === "throw") throw new Error("navigate failed");
            return next as Decision;
          },
        }),
        initial: () => Object.freeze({ items: [] as number[] }),
        fold: (acc, output) => Object.freeze({ items: [...acc.items, ...output.supplements] }),
        until: (_acc, state) => state.done,
        maxIterations: 2,
      });
    }

    it("done on iteration 1 -> predicate_met, one body run, acc = first merge", async () => {
      const runner = new MockRunner();
      const loop = makeLoop([{ done: true, supplements: [1, 2] }]);

      const result = await loop.run({ done: false, supplements: [] }, { runner });
      expect(result.exitReason).toBe("predicate_met");
      expect(result.iterations).toBe(1);
      expect(result.output.items).toEqual([1, 2]);
      expect(result.succeeded).toBe(true);
    });

    it("not-done -> escalate -> re-check -> cap at 2 -> max_iterations, folds the capped iteration", async () => {
      const runner = new MockRunner();
      const loop = makeLoop([
        { done: false, supplements: [1] },
        { done: false, supplements: [2, 3] },
      ]);

      const result = await loop.run({ done: false, supplements: [] }, { runner });
      expect(result.exitReason).toBe("max_iterations");
      expect(result.iterations).toBe(2);
      // Cap-hit fold semantics (Gate 1 resolution): the final iteration's output
      // IS folded before the max_iterations exit — the fold runs on every
      // successful body regardless of cap; escalate's "supplements not executed"
      // at the bound is a body-internal concern, not the fold's.
      expect(result.output.items).toEqual([1, 2, 3]);
      expect(result.succeeded).toBe(true);
    });

    it("body failure mid-loop -> error, acc = last-good pool", async () => {
      const runner = new MockRunner();
      const loop = makeLoop([{ done: false, supplements: [1] }, "throw"]);

      const result = await loop.run({ done: false, supplements: [] }, { runner });
      expect(result.exitReason).toBe("error");
      expect(result.succeeded).toBe(false);
      expect(result.error?.message).toBe("navigate failed");
      // iteration 1 merged [1]; iteration 2's failed body is NOT folded.
      expect(result.output.items).toEqual([1]);
      expect(result.iterations).toBe(2);
    });
  });
});
