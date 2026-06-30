import { describe, expect, it } from "vitest";
import { MockRunner } from "../../runner/mock-runner.js";
import { FanOut } from "../fan-out.js";
import { FunctionStep } from "../function-step.js";
import { Parallel } from "../parallel.js";
import { createScratchpad, slot } from "../slot.js";

// A branch-scoped slot with a `merge` reducer (append). This is the LangGraph-style
// deterministic fan-in: each branch writes its own forked copy; the reducer combines
// them. The fix under test: branches are merged in INDEX order, not completion order.
const acc = slot<number[]>({
  key: "acc",
  scope: "branch",
  init: () => [],
  merge: (parent, child) => [...parent, ...child],
});

describe("Scratchpad merge — deterministic fan-in", () => {
  it("FanOut merges branch slots in index order even when branches finish reversed", async () => {
    // item 0 is the SLOWEST → finishes last; completion order would give [3,2,1,0].
    const step = new FunctionStep<number, number>({
      name: "writeAcc",
      fn: async (n, scratchpad) => {
        await new Promise((r) => setTimeout(r, (4 - n) * 8));
        scratchpad.update(acc, (a) => [...a, n]);
        return n;
      },
    });

    const fanout = new FanOut<{ items: number[] }, number, number>({
      name: "merge-fanout",
      over: (input) => input.items,
      step,
    });

    const pad = createScratchpad();
    await fanout.run({ items: [0, 1, 2, 3] }, { runner: new MockRunner(), scratchpad: pad });

    expect(pad.get(acc)).toEqual([0, 1, 2, 3]); // index order, NOT completion order
  });

  it("Parallel merges branch slots in branch order regardless of finish order", async () => {
    const branch = (n: number) =>
      new FunctionStep<unknown, number>({
        name: `b${n}`,
        fn: async (_input, scratchpad) => {
          await new Promise((r) => setTimeout(r, (3 - n) * 8));
          scratchpad.update(acc, (a) => [...a, n]);
          return n;
        },
      });

    const par = new Parallel<unknown, number>([
      { name: "b0", node: branch(0) },
      { name: "b1", node: branch(1) },
      { name: "b2", node: branch(2) },
    ]);

    const pad = createScratchpad();
    await par.run({}, { runner: new MockRunner(), scratchpad: pad });

    expect(pad.get(acc)).toEqual([0, 1, 2]);
  });
});
