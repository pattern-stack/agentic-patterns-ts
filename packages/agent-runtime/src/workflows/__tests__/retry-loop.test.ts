import { describe, expect, it } from "vitest";
import { ExponentialBackoff, FixedBackoff, JitteredBackoff, RetryLoop } from "../retry-loop.js";

// ---------------------------------------------------------------------------
// Custom fatal error for testing
// ---------------------------------------------------------------------------

class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

// ---------------------------------------------------------------------------
// Backoff strategies
// ---------------------------------------------------------------------------

describe("FixedBackoff", () => {
  it("returns constant delay", () => {
    const backoff = new FixedBackoff(500);
    expect(backoff.getDelay(0)).toBe(500);
    expect(backoff.getDelay(5)).toBe(500);
  });
});

describe("ExponentialBackoff", () => {
  it("doubles delay each attempt", () => {
    const backoff = new ExponentialBackoff(100, 10000);
    expect(backoff.getDelay(0)).toBe(100);
    expect(backoff.getDelay(1)).toBe(200);
    expect(backoff.getDelay(2)).toBe(400);
    expect(backoff.getDelay(3)).toBe(800);
  });

  it("caps at maxMs", () => {
    const backoff = new ExponentialBackoff(100, 500);
    expect(backoff.getDelay(10)).toBe(500);
  });
});

describe("JitteredBackoff", () => {
  it("returns delay within expected range", () => {
    const backoff = new JitteredBackoff(100, 10000);
    for (let i = 0; i < 20; i++) {
      const delay = backoff.getDelay(0);
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(100);
    }
  });
});

// ---------------------------------------------------------------------------
// RetryLoop
// ---------------------------------------------------------------------------

describe("RetryLoop", () => {
  it("succeeds on first try", async () => {
    const loop = new RetryLoop<string>();
    const result = await loop.run(async () => "ok");

    expect(result.succeeded).toBe(true);
    expect(result.exitReason).toBe("success");
    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(result.lastError).toBeUndefined();
    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
  });

  it("succeeds after retries", async () => {
    let callCount = 0;
    const loop = new RetryLoop<string>({
      maxAttempts: 3,
      backoff: new FixedBackoff(0),
    });
    const result = await loop.run(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error("not yet");
      }
      return "finally";
    });

    expect(result.succeeded).toBe(true);
    expect(result.exitReason).toBe("success");
    expect(result.value).toBe("finally");
    expect(result.attempts).toBe(3);
  });

  it("exits on max attempts", async () => {
    const loop = new RetryLoop<string>({
      maxAttempts: 2,
      backoff: new FixedBackoff(0),
    });
    const result = await loop.run(async () => {
      throw new Error("always fails");
    });

    expect(result.succeeded).toBe(false);
    expect(result.exitReason).toBe("max_attempts");
    expect(result.attempts).toBe(2);
    expect(result.lastError?.message).toBe("always fails");
    expect(result.value).toBeUndefined();
  });

  it("exits immediately on fatal error", async () => {
    const loop = new RetryLoop<string>({
      maxAttempts: 5,
      backoff: new FixedBackoff(0),
      fatalErrors: [FatalError],
    });
    const result = await loop.run(async () => {
      throw new FatalError("unrecoverable");
    });

    expect(result.succeeded).toBe(false);
    expect(result.exitReason).toBe("fatal_error");
    expect(result.attempts).toBe(1);
    expect(result.lastError?.message).toBe("unrecoverable");
  });

  it("exits on timeout", async () => {
    const loop = new RetryLoop<string>({
      maxAttempts: 100,
      backoff: new FixedBackoff(0),
      timeoutMs: 50,
    });
    const result = await loop.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error("slow");
    });

    expect(result.succeeded).toBe(false);
    expect(result.exitReason).toBe("timeout");
  });

  it("calls onRetry callback", async () => {
    const retryCalls: Array<{ attempt: number; message: string }> = [];
    const loop = new RetryLoop<string>({
      maxAttempts: 3,
      backoff: new FixedBackoff(0),
      onRetry: (attempt, error) => {
        retryCalls.push({ attempt, message: error.message });
      },
    });
    await loop.run(async () => {
      throw new Error("fail");
    });

    expect(retryCalls).toHaveLength(2);
    expect(retryCalls[0]?.attempt).toBe(0);
    expect(retryCalls[1]?.attempt).toBe(1);
  });

  it("calls hooks during execution", async () => {
    const events: string[] = [];
    const loop = new RetryLoop<string>({
      maxAttempts: 2,
      backoff: new FixedBackoff(0),
      hooks: {
        onPatternStart: () => {
          events.push("start");
        },
        onIterationStart: () => {
          events.push("iter-start");
        },
        onIterationComplete: () => {
          events.push("iter-complete");
        },
        onPatternComplete: () => {
          events.push("complete");
        },
      },
    });

    let callCount = 0;
    await loop.run(async () => {
      callCount++;
      if (callCount < 2) throw new Error("retry");
      return "ok";
    });

    expect(events).toEqual([
      "start",
      "iter-start",
      "iter-complete",
      "iter-start",
      "iter-complete",
      "complete",
    ]);
  });

  it("returns frozen result", async () => {
    const loop = new RetryLoop<string>();
    const result = await loop.run(async () => "ok");
    expect(Object.isFrozen(result)).toBe(true);
  });
});
