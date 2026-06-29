import { describe, expect, it } from "vitest";
import { MockRunner } from "../../runner/mock-runner.js";
import { FanOut } from "../fan-out.js";
import { FunctionStep } from "../function-step.js";

describe("FanOut", () => {
  it("runs one step over a runtime list and collects outputs in item order", async () => {
    const runner = new MockRunner();
    const fan = new FanOut<{ items: number[] }, number, number>({
      name: "double",
      over: (input) => input.items,
      step: new FunctionStep<number, number>({ name: "x2", fn: (n) => n * 2 }),
    });

    const result = await fan.run({ items: [1, 2, 3] }, { runner });
    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual([2, 4, 6]);
  });

  it("applies a consolidate reducer whose result becomes the node output", async () => {
    const runner = new MockRunner();
    const fan = new FanOut<{ items: number[] }, number, number, number>({
      name: "sum-of-squares",
      over: (input) => input.items,
      step: new FunctionStep<number, number>({ name: "sq", fn: (n) => n * n }),
      consolidate: (outs) => outs.reduce((a, b) => a + b, 0),
    });

    const result = await fan.run({ items: [1, 2, 3] }, { runner });
    expect(result.output).toBe(14); // 1 + 4 + 9
  });

  it("collects failures and proceeds", async () => {
    const runner = new MockRunner();
    const fan = new FanOut<{ items: number[] }, number, string>({
      name: "maybe",
      over: (input) => input.items,
      step: new FunctionStep<number, string>({
        name: "guard",
        fn: (n) => {
          if (n === 2) throw new Error("bad item");
          return `ok-${n}`;
        },
      }),
    });

    const result = await fan.run({ items: [1, 2, 3] }, { runner });
    expect(result.succeeded).toBe(false);
    expect(result.error?.message).toBe("bad item");
    expect(result.output[0]).toBe("ok-1");
    expect(result.output[1]).toBeUndefined();
    expect(result.output[2]).toBe("ok-3");
  });

  it("preserves item order under bounded concurrency", async () => {
    const runner = new MockRunner();
    const fan = new FanOut<number[], number, number>({
      over: (items) => items,
      step: new FunctionStep<number, number>({ name: "id", fn: (n) => n }),
      maxConcurrency: 2,
    });

    const result = await fan.run([10, 20, 30, 40], { runner });
    expect(result.output).toEqual([10, 20, 30, 40]);
  });

  it("returns a frozen result", async () => {
    const runner = new MockRunner();
    const fan = new FanOut<number[], number, number>({
      over: (items) => items,
      step: new FunctionStep<number, number>({ name: "id", fn: (n) => n }),
    });
    const result = await fan.run([1], { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
