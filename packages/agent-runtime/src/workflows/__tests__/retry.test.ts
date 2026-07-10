import { describe, expect, it, vi } from "vitest";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { RunOptions, RunResult, RunnerProtocol } from "../../runner/types.js";
import { AgentStep } from "../agent-step.js";
import type { PatternHooks } from "../base.js";
import type { Node, NodeResult, NodeRunContext } from "../node.js";
import { Retry, type RetryFailure, computeDelay, retry } from "../retry.js";

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

/** A hand-rolled Node whose behavior per call is scripted via a queue of outcomes. */
class ScriptedNode<TOut> implements Node<unknown, TOut> {
  readonly name = "scripted";
  calls = 0;

  constructor(
    private readonly outcomes: Array<
      { kind: "result"; result: NodeResult<TOut> } | { kind: "throw"; error: unknown }
    >,
  ) {}

  async run(): Promise<NodeResult<TOut>> {
    const outcome = this.outcomes[this.calls];
    this.calls++;
    if (!outcome) {
      throw new Error("ScriptedNode: ran out of scripted outcomes");
    }
    if (outcome.kind === "throw") {
      throw outcome.error;
    }
    return outcome.result;
  }
}

function ok<TOut>(output: TOut, inputTokens = 0, outputTokens = 0): NodeResult<TOut> {
  return {
    output,
    succeeded: true,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
  };
}

function fail<TOut>(error: Error, inputTokens = 0, outputTokens = 0): NodeResult<TOut> {
  return {
    output: undefined as TOut,
    succeeded: false,
    error,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe("Retry", () => {
  it("succeeds on the first attempt — runs exactly once", async () => {
    const runner = new MockRunner();
    const node = new ScriptedNode<string>([{ kind: "result", result: ok("done", 3, 4) }]);
    const r = new Retry({ node, maxAttempts: 3 });

    const result = await r.run(undefined, { runner });

    expect(node.calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.exitReason).toBe("succeeded");
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("done");
    expect(result.totalInputTokens).toBe(3);
    expect(result.totalOutputTokens).toBe(4);
  });

  it("retries then succeeds — accumulates tokens across the failed AND successful attempt (structured-retry.ts use case)", async () => {
    const runner = new MockRunner();
    const node = new ScriptedNode<string>([
      { kind: "result", result: fail(new Error("No object generated"), 5, 7) },
      { kind: "result", result: ok("parsed", 3, 4) },
    ]);
    const r = new Retry({ node, maxAttempts: 3 });

    const result = await r.run(undefined, { runner });

    expect(node.calls).toBe(2);
    expect(result.exitReason).toBe("succeeded");
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("parsed");
    expect(result.totalInputTokens).toBe(8);
    expect(result.totalOutputTokens).toBe(11);
  });

  it("exhausts the budget → resolves (never rejects) with the LAST failure and summed tokens", async () => {
    const runner = new MockRunner();
    const node = new ScriptedNode<string>([
      { kind: "result", result: fail(new Error("attempt-1"), 1, 1) },
      { kind: "result", result: fail(new Error("attempt-2"), 2, 2) },
      { kind: "result", result: fail(new Error("attempt-3"), 3, 3) },
    ]);
    const r = new Retry({ node, maxAttempts: 3 });

    const result = await r.run(undefined, { runner });

    expect(node.calls).toBe(3);
    expect(result.succeeded).toBe(false);
    expect(result.exitReason).toBe("attempts_exhausted");
    expect(result.error?.message).toBe("attempt-3");
    expect(result.totalInputTokens).toBe(6);
    expect(result.totalOutputTokens).toBe(6);
  });

  it("catches a thrown error, retries, and does not let the throw escape", async () => {
    const runner = new MockRunner();
    const node = new ScriptedNode<string>([
      { kind: "throw", error: new Error("boom") },
      { kind: "result", result: ok("recovered", 1, 1) },
    ]);
    const seen: RetryFailure<string>[] = [];
    const r = new Retry({
      node,
      maxAttempts: 3,
      shouldRetry: (f) => {
        seen.push(f);
        return true;
      },
    });

    const result = await r.run(undefined, { runner });

    expect(node.calls).toBe(2);
    expect(result.exitReason).toBe("succeeded");
    expect(result.output).toBe("recovered");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.result).toBeUndefined();
    expect(seen[0]?.error.message).toBe("boom");
  });

  it("predicate declines — stops after one attempt, no second call", async () => {
    const runner = new MockRunner();
    const node = new ScriptedNode<string>([
      { kind: "result", result: fail(new Error("fatal")) },
      { kind: "result", result: ok("never") },
    ]);
    const r = new Retry({
      node,
      maxAttempts: 3,
      shouldRetry: (f) => f.error.message === "retryable",
    });

    const result = await r.run(undefined, { runner });

    expect(node.calls).toBe(1);
    expect(result.succeeded).toBe(false);
    expect(result.exitReason).toBe("predicate_declined");
    expect(result.error?.message).toBe("fatal");
  });

  it("exposes the failure shape to the predicate — 1-based attempt, result present/absent", async () => {
    const runner = new MockRunner();
    const failResult = fail<string>(new Error("nope"), 1, 1);
    const node = new ScriptedNode<string>([
      { kind: "result", result: failResult },
      { kind: "throw", error: new Error("threw") },
      { kind: "result", result: ok("done") },
    ]);
    const seen: RetryFailure<string>[] = [];
    const r = new Retry({
      node,
      maxAttempts: 5,
      shouldRetry: (f) => {
        seen.push(f);
        return true;
      },
    });

    await r.run(undefined, { runner });

    expect(seen.map((f) => f.attempt)).toEqual([1, 2]);
    expect(seen[0]?.result).toBe(failResult);
    expect(seen[1]?.result).toBeUndefined();
  });

  it("throws in the constructor when maxAttempts is not a positive integer", () => {
    const node = new ScriptedNode<string>([{ kind: "result", result: ok("x") }]);
    expect(() => new Retry({ node, maxAttempts: 0 })).toThrow();
    expect(() => new Retry({ node, maxAttempts: 2.5 })).toThrow();
    expect(() => new Retry({ node, maxAttempts: -1 })).toThrow();
  });

  describe("computeDelay (pure)", () => {
    it("fixed backoff returns the same delay regardless of attempt", () => {
      expect(computeDelay({ kind: "fixed", delayMs: 10 }, 1)).toBe(10);
      expect(computeDelay({ kind: "fixed", delayMs: 10 }, 5)).toBe(10);
    });

    it("exponential backoff doubles by default factor", () => {
      const backoff = { kind: "exponential" as const, delayMs: 10 };
      expect(computeDelay(backoff, 1)).toBe(10);
      expect(computeDelay(backoff, 2)).toBe(20);
      expect(computeDelay(backoff, 3)).toBe(40);
    });

    it("exponential backoff respects a custom factor", () => {
      const backoff = { kind: "exponential" as const, delayMs: 5, factor: 3 };
      expect(computeDelay(backoff, 1)).toBe(5);
      expect(computeDelay(backoff, 2)).toBe(15);
      expect(computeDelay(backoff, 3)).toBe(45);
    });

    it("exponential backoff caps at maxDelayMs", () => {
      const backoff = { kind: "exponential" as const, delayMs: 10, factor: 2, maxDelayMs: 15 };
      expect(computeDelay(backoff, 1)).toBe(10);
      expect(computeDelay(backoff, 2)).toBe(15); // would be 20, capped to 15
      expect(computeDelay(backoff, 3)).toBe(15); // would be 40, capped to 15
    });
  });

  it("backoff — one fake-timer integration test proving the sleep seam waits between attempts only", async () => {
    vi.useFakeTimers();
    try {
      const runner = new MockRunner();
      const node = new ScriptedNode<string>([
        { kind: "result", result: fail(new Error("a1")) },
        { kind: "result", result: fail(new Error("a2")) },
        { kind: "result", result: fail(new Error("a3")) },
      ]);
      const r = new Retry({
        node,
        maxAttempts: 3,
        backoff: { kind: "exponential", delayMs: 10, factor: 2 },
      });

      const runPromise = r.run(undefined, { runner });
      // Let the microtask queue flush the first attempt.
      await vi.advanceTimersByTimeAsync(0);
      expect(node.calls).toBe(1);

      // Wait for attempt 1 → 2: 10ms.
      await vi.advanceTimersByTimeAsync(10);
      expect(node.calls).toBe(2);

      // Wait for attempt 2 → 3: 20ms.
      await vi.advanceTimersByTimeAsync(20);
      expect(node.calls).toBe(3);

      const result = await runPromise;
      expect(result.exitReason).toBe("attempts_exhausted");
      // No further delay is awaited after the final (3rd) attempt — run() already resolved.
    } finally {
      vi.useRealTimers();
    }
  });

  it("nested AgentStep reaches the real injected runner across attempts (childCtx.runner threading)", async () => {
    const calls: string[] = [];
    const fakeRunner: RunnerProtocol = {
      async run(_agent, message, _options?: RunOptions): Promise<RunResult> {
        calls.push(message);
        if (calls.length === 1) {
          throw new Error("flaky");
        }
        return {
          response: "ok",
          inputTokens: 2,
          outputTokens: 3,
          toolCallsCount: 0,
          iterations: 1,
          finishReason: "stop",
        };
      },
    };

    const step = new AgentStep<string, string>({
      name: "flaky-step",
      agent: makeAgent(),
      prompt: (input) => `prompt:${input}`,
    });

    const r = retry(step, { maxAttempts: 2 });
    const result = await r.run("hi", { runner: fakeRunner });

    expect(calls).toHaveLength(2);
    expect(result.exitReason).toBe("succeeded");
    expect(result.output).toBe("ok");
    expect(result.totalInputTokens).toBe(2);
    expect(result.totalOutputTokens).toBe(3);
  });

  it("fires PatternHooks once per pattern and once per attempt", async () => {
    const runner = new MockRunner();
    const node = new ScriptedNode<string>([
      { kind: "result", result: fail(new Error("a1")) },
      { kind: "result", result: ok("done") },
    ]);
    const r = new Retry({ node, maxAttempts: 3 });

    const patternStarts: string[] = [];
    const iterationStarts: number[] = [];
    const iterationCompletes: number[] = [];
    const patternCompletes: string[] = [];
    const hooks: PatternHooks = {
      onPatternStart: (e) => {
        patternStarts.push(e.patternName);
      },
      onIterationStart: (e) => {
        iterationStarts.push(e.iteration);
      },
      onIterationComplete: (e) => {
        iterationCompletes.push(e.iteration);
      },
      onPatternComplete: (e) => {
        patternCompletes.push(e.patternName);
      },
    };

    const ctx: NodeRunContext = { runner, hooks };
    await r.run(undefined, ctx);

    expect(patternStarts).toEqual(["Retry"]);
    expect(iterationStarts).toEqual([0, 1]);
    expect(iterationCompletes).toEqual([0, 1]);
    expect(patternCompletes).toEqual(["Retry"]);
  });

  it("returns a frozen result", async () => {
    const runner = new MockRunner();
    const node = new ScriptedNode<string>([{ kind: "result", result: ok("x") }]);
    const r = new Retry({ node, maxAttempts: 1 });
    const result = await r.run(undefined, { runner });
    expect(Object.isFrozen(result)).toBe(true);
  });
});
