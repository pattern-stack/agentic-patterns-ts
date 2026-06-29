import { describe, expect, it } from "vitest";
import { MockRunner } from "../../runner/mock-runner.js";
import { Accumulate } from "../accumulate.js";
import { FunctionStep } from "../function-step.js";

describe("Accumulate", () => {
  it("folds a runtime list in order, threading the accumulator", async () => {
    const runner = new MockRunner();
    const acc = new Accumulate<{ items: number[] }, number, number>({
      name: "sum",
      over: (input) => input.items,
      initial: () => 0,
      step: new FunctionStep({ name: "add", fn: ({ acc: a, item }) => a + item }),
    });

    const result = await acc.run({ items: [1, 2, 3, 4] }, { runner });
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe(10);
  });

  it("threads the accumulator IN ORDER (proves left-to-right fold)", async () => {
    const runner = new MockRunner();
    const acc = new Accumulate<string[], string, string>({
      name: "concat",
      over: (items) => items,
      initial: () => "",
      step: new FunctionStep({
        name: "append",
        fn: ({ acc: a, item, index }) => `${a}${index}:${item};`,
      }),
    });

    const result = await acc.run(["a", "b", "c"], { runner });
    expect(result.output).toBe("0:a;1:b;2:c;");
  });

  it("exposes prior acc + item + index to the step", async () => {
    const runner = new MockRunner();
    const seen: Array<{ acc: number; item: number; index: number }> = [];
    const acc = new Accumulate<number[], number, number>({
      over: (items) => items,
      initial: () => 100,
      step: new FunctionStep({
        name: "track",
        fn: ({ acc: a, item, index }) => {
          seen.push({ acc: a, item, index });
          return a + item;
        },
      }),
    });

    await acc.run([1, 2], { runner });
    expect(seen).toEqual([
      { acc: 100, item: 1, index: 0 },
      { acc: 101, item: 2, index: 1 },
    ]);
  });

  it("stops the fold on a failed step and does not visit later items", async () => {
    const runner = new MockRunner();
    const visited: number[] = [];
    const acc = new Accumulate<number[], number, number>({
      over: (items) => items,
      initial: () => 0,
      step: new FunctionStep({
        name: "add",
        fn: ({ acc: a, item }) => {
          visited.push(item);
          if (item === 3) throw new Error("stop");
          return a + item;
        },
      }),
    });

    const result = await acc.run([1, 2, 3, 4], { runner });
    expect(result.succeeded).toBe(false);
    expect(result.error?.message).toBe("stop");
    // The fold halted at item 3 — item 4 was never visited.
    expect(visited).toEqual([1, 2, 3]);
  });

  it("returns a frozen result", async () => {
    const runner = new MockRunner();
    const acc = new Accumulate<number[], number, number>({
      over: (items) => items,
      initial: () => 0,
      step: new FunctionStep({ name: "add", fn: ({ acc: a, item }) => a + item }),
    });
    const result = await acc.run([1], { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
