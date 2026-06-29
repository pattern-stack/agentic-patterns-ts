import { describe, expect, it } from "vitest";
import { MockRunner } from "../../runner/mock-runner.js";
import { FunctionStep } from "../function-step.js";
import { Loop } from "../loop.js";

describe("Loop", () => {
  it("exits with predicate_met when the predicate first holds", async () => {
    const runner = new MockRunner();
    const loop = new Loop<number>({
      name: "count-to-3",
      body: new FunctionStep<number, number>({ name: "inc", fn: (n) => n + 1 }),
      until: (state) => state >= 3,
      maxIterations: 10,
    });

    const result = await loop.run(0, { runner });
    expect(result.succeeded).toBe(true);
    expect(result.exitReason).toBe("predicate_met");
    expect(result.output).toBe(3);
    expect(result.iterations).toBe(3);
  });

  it("exits with max_iterations and returns the LAST state on cap-hit", async () => {
    const runner = new MockRunner();
    const loop = new Loop<number>({
      name: "never-satisfied",
      body: new FunctionStep<number, number>({ name: "inc", fn: (n) => n + 1 }),
      until: () => false,
      maxIterations: 3,
    });

    const result = await loop.run(0, { runner });
    expect(result.exitReason).toBe("max_iterations");
    expect(result.iterations).toBe(3);
    expect(result.output).toBe(3); // last state produced
    expect(result.succeeded).toBe(true); // cap-hit still yields a usable value
  });

  it("passes the iteration index to the predicate", async () => {
    const runner = new MockRunner();
    const indices: number[] = [];
    const loop = new Loop<number>({
      body: new FunctionStep<number, number>({ name: "inc", fn: (n) => n + 1 }),
      until: (_state, iteration) => {
        indices.push(iteration);
        return iteration >= 1; // exit after the 2nd iteration (index 1)
      },
      maxIterations: 5,
    });

    const result = await loop.run(0, { runner });
    expect(result.exitReason).toBe("predicate_met");
    expect(indices).toEqual([0, 1]);
    expect(result.iterations).toBe(2);
  });

  it("throws if maxIterations is not a positive integer", () => {
    const body = new FunctionStep<number, number>({ name: "inc", fn: (n) => n + 1 });
    expect(() => new Loop<number>({ body, until: () => true, maxIterations: 0 })).toThrow();
    expect(() => new Loop<number>({ body, until: () => true, maxIterations: -1 })).toThrow();
  });

  it("returns a frozen result", async () => {
    const runner = new MockRunner();
    const loop = new Loop<number>({
      body: new FunctionStep<number, number>({ name: "inc", fn: (n) => n + 1 }),
      until: () => true,
      maxIterations: 1,
    });
    const result = await loop.run(0, { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
