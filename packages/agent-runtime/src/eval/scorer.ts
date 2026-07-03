/**
 * `Scorer` contract + built-in pure scorers (spec § Approach step 2).
 *
 * A scorer is a pure(-ish) async function over `{ input, output, expected, case }`.
 * Async so an LLM-judge is a natural drop-in extension later (deferred, see spec
 * § Scope decision) — v1 ships two built-ins:
 *   - `exactMatch` — deep-equals `output` vs `expected`.
 *   - `predicateScorer` — wraps any `(output, expected, input) => boolean|number`
 *     into a `Score`; this is what the consumer's mechanical evals (recall@k, gold
 *     retention, ...) become.
 *
 * ADDITIVE: new file.
 */

import type { EvalCase, Score } from "./types.js";

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/** Pure(-ish) scoring function. Async so an LLM-judge is a natural extension. */
export type Scorer<TIn, TOut, TExpected = unknown> = (args: {
  readonly input: TIn;
  readonly output: TOut;
  readonly expected?: TExpected;
  readonly case: EvalCase<TIn, TExpected>;
}) => Score | Score[] | Promise<Score | Score[]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Structural deep-equality — sufficient for typed eval payloads (objects/arrays/primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

// ---------------------------------------------------------------------------
// Built-in scorers
// ---------------------------------------------------------------------------

/** Deep-equals `output` vs `expected`; `value` 1/0, `passed` set. */
export function exactMatch<TOut>(opts?: { name?: string }): Scorer<unknown, TOut, TOut> {
  const name = opts?.name ?? "exact-match";
  return ({ output, expected }) => {
    const passed = deepEqual(output, expected);
    return { name, value: passed ? 1 : 0, passed };
  };
}

/** Wrap any `(output, expected, input) => boolean|number` into a `Score`. */
export function predicateScorer<TIn, TOut, TExpected>(
  name: string,
  fn: (output: TOut, expected: TExpected | undefined, input: TIn) => boolean | number,
): Scorer<TIn, TOut, TExpected> {
  return ({ output, expected, input }) => {
    const result = fn(output, expected, input);
    const value = typeof result === "boolean" ? (result ? 1 : 0) : result;
    const passed = typeof result === "boolean" ? result : undefined;
    return { name, value, passed };
  };
}
