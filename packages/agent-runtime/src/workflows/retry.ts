/**
 * `Retry<TIn, TOut>` — wrap any `Node<TIn,TOut>` and re-run it, up to a bounded
 * number of attempts, when an attempt fails (DESIGN closed-composition §4 item 5).
 *
 * Preserves the wrapped node's exact types. Returns the first success immediately,
 * or the last failure once the attempt budget is spent — it NEVER re-throws.
 * Accumulates token totals honestly across every attempt, including failed ones.
 *
 * `Retry` wraps *any* `Node<TIn,TOut>` — including user-authored nodes and
 * composites that don't honor the leaf catch-and-return convention. Unlike `Loop`
 * and `Sequential` (which trust `res.succeeded` and never `try/catch` a child
 * `run()`), `Retry`'s entire job is absorbing flakes, so it `try/catch`es each
 * attempt: a rejected `run()` and a returned failed `NodeResult` are unified as one
 * logical failure and fed to the same predicate.
 */

import type { PatternHooks } from "./base.js";
import type { Node, NodeResult, NodeRunContext } from "./node.js";
import { createScratchpad } from "./slot.js";

// ---------------------------------------------------------------------------
// Spec + result
// ---------------------------------------------------------------------------

/** A single failed attempt, as seen by the retry predicate. */
export interface RetryFailure<TOut> {
  /** Error for this attempt: a failed NodeResult's `error`, or a normalized throw. */
  readonly error: Error;
  /** Present when the node RETURNED `{succeeded:false}`; absent when it THREW. */
  readonly result?: NodeResult<TOut>;
  /** 1-based number of the attempt that just failed. */
  readonly attempt: number;
}

/** Decide whether to retry after a failure. Default: always retry until maxAttempts. */
export type RetryPredicate<TOut> = (failure: RetryFailure<TOut>) => boolean;

/** Delay policy between attempts. No jitter (explicit follow-on, out of scope). */
export type RetryBackoff =
  | { readonly kind: "fixed"; readonly delayMs: number }
  | {
      readonly kind: "exponential";
      readonly delayMs: number;
      readonly factor?: number;
      readonly maxDelayMs?: number;
    };

export interface RetrySpec<TIn, TOut> {
  readonly name?: string;
  /** The node to run and, on failure, re-run. Types are preserved end-to-end. */
  readonly node: Node<TIn, TOut>;
  /** REQUIRED positive-integer cap on TOTAL attempts (not extra retries). */
  readonly maxAttempts: number;
  /** Gate retries. Default `() => true`. */
  readonly shouldRetry?: RetryPredicate<TOut>;
  /** Optional delay between attempts. Default: none. */
  readonly backoff?: RetryBackoff;
}

export type RetryExitReason = "succeeded" | "predicate_declined" | "attempts_exhausted";

export interface RetryResult<TOut> extends NodeResult<TOut> {
  /** Attempts actually made (1..maxAttempts). */
  readonly attempts: number;
  readonly exitReason: RetryExitReason;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a caught throw to a real `Error` without widening the type. */
function normalizeError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/**
 * Pure backoff-delay calculator: maps the 1-based *failed* attempt to a wait, in
 * milliseconds. `exponential` = `min(delayMs * factor^(attempt-1), maxDelayMs ?? Infinity)`.
 * `factor` default `2`. Exported for pure unit testing (Gate-1 decision C).
 */
export function computeDelay(backoff: RetryBackoff, attempt: number): number {
  if (backoff.kind === "fixed") {
    return backoff.delayMs;
  }
  const factor = backoff.factor ?? 2;
  const raw = backoff.delayMs * factor ** (attempt - 1);
  return backoff.maxDelayMs !== undefined ? Math.min(raw, backoff.maxDelayMs) : raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export class Retry<TIn, TOut> implements Node<TIn, TOut> {
  readonly name?: string;

  constructor(private readonly spec: RetrySpec<TIn, TOut>) {
    if (!Number.isInteger(spec.maxAttempts) || spec.maxAttempts < 1) {
      throw new Error("Retry requires a positive integer `maxAttempts`.");
    }
    this.name = spec.name;
  }

  async run(input: TIn, ctx: NodeRunContext): Promise<RetryResult<TOut>> {
    const hooks: PatternHooks | undefined = ctx.hooks;
    const patternName = this.name ?? "Retry";
    const childCtx: NodeRunContext = { ...ctx, scratchpad: ctx.scratchpad ?? createScratchpad() };
    const shouldRetry: RetryPredicate<TOut> = this.spec.shouldRetry ?? (() => true);

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName,
      timestamp: new Date(),
    });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let attempts = 0;
    let lastFailure: RetryFailure<TOut> | undefined;

    for (let i = 0; i < this.spec.maxAttempts; i++) {
      const attempt = i + 1;
      attempts = attempt;

      await hooks?.onIterationStart?.({
        type: "pattern.iteration.start",
        iteration: i,
        timestamp: new Date(),
      });

      let failure: RetryFailure<TOut> | undefined;
      let successResult: NodeResult<TOut> | undefined;

      try {
        const res = await this.spec.node.run(input, childCtx);
        totalInputTokens += res.totalInputTokens;
        totalOutputTokens += res.totalOutputTokens;

        if (res.succeeded) {
          successResult = res;
        } else {
          failure = {
            error: res.error ?? new Error(`${patternName}: attempt failed`),
            result: res,
            attempt,
          };
        }
      } catch (thrown) {
        // Rejected run() — no result to read totals from, so contributes 0/0,
        // exactly as AgentStep's own catch does.
        failure = {
          error: normalizeError(thrown),
          result: undefined,
          attempt,
        };
      }

      await hooks?.onIterationComplete?.({
        type: "pattern.iteration.complete",
        iteration: i,
        timestamp: new Date(),
      });

      if (successResult) {
        const result: RetryResult<TOut> = Object.freeze({
          ...successResult,
          totalInputTokens,
          totalOutputTokens,
          attempts,
          exitReason: "succeeded" as const,
        });

        await hooks?.onPatternComplete?.({
          type: "pattern.complete",
          patternName,
          result,
          timestamp: new Date(),
        });

        return result;
      }

      // failure is guaranteed set here (success branch returned above).
      lastFailure = failure;

      if (attempt >= this.spec.maxAttempts) {
        break; // attempts_exhausted
      }

      if (!shouldRetry(lastFailure!)) {
        const result = this.buildFailureResult(
          lastFailure!,
          totalInputTokens,
          totalOutputTokens,
          attempts,
          "predicate_declined",
        );
        await hooks?.onPatternComplete?.({
          type: "pattern.complete",
          patternName,
          result,
          timestamp: new Date(),
        });
        return result;
      }

      if (this.spec.backoff) {
        await sleep(computeDelay(this.spec.backoff, attempt));
      }
    }

    const result = this.buildFailureResult(
      lastFailure!,
      totalInputTokens,
      totalOutputTokens,
      attempts,
      "attempts_exhausted",
    );

    await hooks?.onPatternComplete?.({
      type: "pattern.complete",
      patternName,
      result,
      timestamp: new Date(),
    });

    return result;
  }

  private buildFailureResult(
    failure: RetryFailure<TOut>,
    totalInputTokens: number,
    totalOutputTokens: number,
    attempts: number,
    exitReason: RetryExitReason,
  ): RetryResult<TOut> {
    return Object.freeze({
      output: undefined as TOut,
      succeeded: false,
      error: failure.error,
      totalInputTokens,
      totalOutputTokens,
      attempts,
      exitReason,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Ergonomic factory: `retry(node, { maxAttempts: 3 })`. */
export function retry<TIn, TOut>(
  node: Node<TIn, TOut>,
  opts: Omit<RetrySpec<TIn, TOut>, "node">,
): Retry<TIn, TOut> {
  return new Retry({ node, ...opts });
}
