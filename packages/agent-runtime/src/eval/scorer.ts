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

/**
 * Structural deep-equality — sufficient for typed eval payloads (objects/arrays/
 * primitives), with explicit handling for the built-in collection types that a
 * generic "compare own enumerable keys" walk gets wrong:
 *   - `Date` — compared by `getTime()`, not own-key structure (a `Date` has no
 *     enumerable own keys, so two distinct dates would otherwise both look like
 *     `{}` and false-positive as equal).
 *   - `Map` / `Set` — compared by size + entry-wise structural equality (same
 *     reason: iterable state isn't own-enumerable-key state).
 *   - Any OTHER non-plain-object class instance (prototype isn't `Object.prototype`
 *     or `null`, and it isn't an `Array`) is compared by REFERENCE ONLY — i.e. it
 *     only "matches" via the `Object.is` fast path above. This is deliberate: a
 *     generic own-key walk over an arbitrary class instance (custom equality
 *     semantics, private fields, getters) is more likely to silently mis-score
 *     than a strict reference check. Document this on `exactMatch` at the call
 *     site if a scorer needs custom-class structural equality — write a
 *     `predicateScorer` instead.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }

  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    }
    return true;
  }

  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    for (const value of a) {
      let found = false;
      for (const other of b) {
        if (deepEqual(value, other)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  // Any other non-plain-object instance (custom class) — reference equality
  // only, already checked via Object.is() above. See module doc.
  const aProto = Object.getPrototypeOf(a);
  const bProto = Object.getPrototypeOf(b);
  const aIsPlain = aProto === Object.prototype || aProto === null;
  const bIsPlain = bProto === Object.prototype || bProto === null;
  if (!aIsPlain || !bIsPlain) return false;

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

/**
 * Deep-equals `output` vs `expected`; `value` 1/0, `passed` set.
 *
 * `Date`/`Map`/`Set` are compared structurally (by time / size+entries, not
 * own-key walk); any OTHER class instance is compared by reference only — see
 * `deepEqual`'s doc comment. Use `predicateScorer` for custom-class equality.
 *
 * A case with no `expected` (undefined) never matches a defined `output` —
 * `deepEqual(output, undefined)` is `false` unless `output` is also `undefined`.
 * Don't use `exactMatch` on expected-less cases; write a `predicateScorer` instead.
 */
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
