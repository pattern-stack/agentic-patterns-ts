/**
 * RetryLoop — Generic async retry wrapper with pluggable backoff strategies.
 *
 * Not agent-specific — wraps any `() => Promise<T>`.
 *
 * Ported from Python: workflows/loops/retry.py
 */

import type { PatternHooks, PatternResult } from "./base.js";

// ---------------------------------------------------------------------------
// Backoff strategies
// ---------------------------------------------------------------------------

/** Backoff strategy: given an attempt number (0-based), return delay in ms. */
export interface BackoffStrategy {
  getDelay(attempt: number): number;
}

/** Fixed delay between retries. */
export class FixedBackoff implements BackoffStrategy {
  constructor(private readonly delayMs: number) {}
  getDelay(_attempt: number): number {
    return this.delayMs;
  }
}

/** Exponential backoff: baseMs * 2^attempt, capped at maxMs. */
export class ExponentialBackoff implements BackoffStrategy {
  constructor(
    private readonly baseMs: number = 1000,
    private readonly maxMs: number = 60000,
  ) {}
  getDelay(attempt: number): number {
    return Math.min(this.baseMs * 2 ** attempt, this.maxMs);
  }
}

/** Jittered exponential backoff: adds random jitter to exponential delay. */
export class JitteredBackoff implements BackoffStrategy {
  private readonly exponential: ExponentialBackoff;
  constructor(baseMs = 1000, maxMs = 60000) {
    this.exponential = new ExponentialBackoff(baseMs, maxMs);
  }
  getDelay(attempt: number): number {
    const base = this.exponential.getDelay(attempt);
    return Math.floor(base * (0.5 + Math.random() * 0.5));
  }
}

// ---------------------------------------------------------------------------
// RetryResult
// ---------------------------------------------------------------------------

/** Exit reason for a retry loop. */
export type RetryExitReason = "success" | "max_attempts" | "fatal_error" | "timeout";

/** Result of a retry loop execution. */
export interface RetryResult<T> extends PatternResult {
  readonly exitReason: RetryExitReason;
  readonly attempts: number;
  readonly value?: T;
  readonly lastError?: Error;
}

// ---------------------------------------------------------------------------
// RetryLoop options
// ---------------------------------------------------------------------------

export interface RetryLoopOptions {
  readonly maxAttempts?: number;
  readonly backoff?: BackoffStrategy;
  readonly timeoutMs?: number;
  readonly fatalErrors?: ReadonlyArray<abstract new (...args: never[]) => Error>;
  readonly onRetry?: (attempt: number, error: Error) => void | Promise<void>;
  readonly hooks?: PatternHooks;
}

export interface RetryRunOptions {
  readonly hooks?: PatternHooks;
}

// ---------------------------------------------------------------------------
// RetryLoop
// ---------------------------------------------------------------------------

/**
 * Generic async retry wrapper with pluggable backoff.
 *
 * Example:
 *   const loop = new RetryLoop<string>({ maxAttempts: 3 });
 *   const result = await loop.run(async () => fetchData());
 */
export class RetryLoop<T> {
  private readonly maxAttempts: number;
  private readonly backoff: BackoffStrategy;
  private readonly timeoutMs: number | undefined;
  private readonly fatalErrors: ReadonlyArray<abstract new (...args: never[]) => Error>;
  private readonly onRetry: ((attempt: number, error: Error) => void | Promise<void>) | undefined;
  private readonly defaultHooks: PatternHooks | undefined;

  constructor(options: RetryLoopOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoff = options.backoff ?? new ExponentialBackoff();
    this.timeoutMs = options.timeoutMs;
    this.fatalErrors = options.fatalErrors ?? [];
    this.onRetry = options.onRetry;
    this.defaultHooks = options.hooks;
  }

  async run(fn: () => Promise<T>, options?: RetryRunOptions): Promise<RetryResult<T>> {
    const hooks = options?.hooks ?? this.defaultHooks;
    const startTime = Date.now();

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName: "RetryLoop",
      timestamp: new Date(),
    });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      await hooks?.onIterationStart?.({
        type: "pattern.iteration.start",
        iteration: attempt,
        timestamp: new Date(),
      });

      // Check timeout before each attempt
      if (this.timeoutMs !== undefined && Date.now() - startTime >= this.timeoutMs) {
        const result = this.buildResult("timeout", attempt, undefined, lastError);
        await hooks?.onPatternComplete?.({
          type: "pattern.complete",
          patternName: "RetryLoop",
          result,
          timestamp: new Date(),
        });
        return result;
      }

      try {
        const value = await fn();

        await hooks?.onIterationComplete?.({
          type: "pattern.iteration.complete",
          iteration: attempt,
          timestamp: new Date(),
        });

        const result = this.buildResult("success", attempt + 1, value, undefined);
        await hooks?.onPatternComplete?.({
          type: "pattern.complete",
          patternName: "RetryLoop",
          result,
          timestamp: new Date(),
        });
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err;

        // Check for fatal errors
        if (this.isFatal(err)) {
          const result = this.buildResult("fatal_error", attempt + 1, undefined, err);
          await hooks?.onPatternComplete?.({
            type: "pattern.complete",
            patternName: "RetryLoop",
            result,
            timestamp: new Date(),
          });
          return result;
        }

        await hooks?.onIterationComplete?.({
          type: "pattern.iteration.complete",
          iteration: attempt,
          timestamp: new Date(),
        });

        // Don't retry after the last attempt
        if (attempt < this.maxAttempts - 1) {
          await this.onRetry?.(attempt, err);
          const delayMs = this.backoff.getDelay(attempt);
          await sleep(delayMs);
        }
      }
    }

    const result = this.buildResult("max_attempts", this.maxAttempts, undefined, lastError);
    await hooks?.onPatternComplete?.({
      type: "pattern.complete",
      patternName: "RetryLoop",
      result,
      timestamp: new Date(),
    });
    return result;
  }

  private isFatal(error: Error): boolean {
    return this.fatalErrors.some((cls) => error instanceof cls);
  }

  private buildResult(
    exitReason: RetryExitReason,
    attempts: number,
    value: T | undefined,
    lastError: Error | undefined,
  ): RetryResult<T> {
    return Object.freeze({
      exitReason,
      attempts,
      value,
      lastError,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      succeeded: exitReason === "success",
      finalContent: "",
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
