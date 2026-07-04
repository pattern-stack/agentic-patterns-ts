/**
 * `setMembership` — deterministic cited-id precision/recall/F1 scorer, no model
 * (spec `.ai-docs/stacks/eval-surface/specs/141.md` § Interfaces, E6).
 *
 * Ported from v1 `grade.ts`'s `gradeSetMembership` (grade.ts:123-135) with the
 * prefix-vs-UUID citation-match bug FIXED on port — see § The prefix bug below.
 *
 * **Pinned fix semantics — full-id equality, normalized:** an id matches iff the
 * whole strings are equal after `trim()` + `toLowerCase()`. NO prefix matching in
 * either direction — truncating both sides to 8 chars would trade false negatives
 * for false positives (distinct UUIDs sharing a prefix); accepting prefix-of
 * matches makes membership ambiguous. Banks must store full ids — that is the
 * contract. When an expected id fails to match but is a proper prefix of some
 * cited id (the v1 bug shape), it is surfaced in `detail.prefixSuspects` instead
 * of silently scoring 0.
 *
 * ADDITIVE: new file.
 */

import type { Scorer } from "../scorer.js";
import type { EvalCase, Score } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Args mirror of the Scorer callback param — what both resolvers receive. */
export interface SetMembershipArgs<TIn = unknown, TOut = unknown, TExpected = unknown> {
  readonly input: TIn;
  readonly output: TOut;
  readonly expected?: TExpected;
  readonly case: EvalCase<TIn, TExpected>;
}

export interface SetMembershipOptions<TIn = unknown, TOut = unknown, TExpected = unknown> {
  /** Score name. Default "set-membership". */
  name?: string;
  /**
   * Which of the three computed metrics becomes the headline `Score.value`.
   * Default `"f1"` (back-compatible). All three (`recall`/`precision`/`f1`)
   * are always in `Score.detail` regardless — `metric` only picks the scalar
   * a consumer reads without digging into `detail`. Use `"recall"` when recall
   * is the objective (e.g. retrieval gather) and F1 would fold in precision
   * you're grading separately, or on a precision-flattering benchmark where
   * F1-as-headline misleads. The `passed` gate stays recall∧precision either way.
   */
  metric?: "f1" | "recall" | "precision";
  /** Pass requires recall ≥ this. Default 0.6 (doc §11). */
  recall?: number;
  /** Pass requires precision ≥ this. Default 0.4 (doc §11). */
  precision?: number;
  /**
   * Resolve the expected id set. Default: `expected` itself when it is a
   * `string[]`; else `expected.citedIds` when that is a `string[]`; else
   * `undefined`. Returning undefined ⇒ the case is UNSCORED (scorer returns
   * `[]`) — the expected-gated convention (eval.ts:265-267), never an
   * auto-fail.
   */
  expectedIds?: (args: SetMembershipArgs<TIn, TOut, TExpected>) => readonly string[] | undefined;
  /**
   * Extract cited ids from the run output. Default: stringify output (string
   * as-is, else JSON.stringify) and match full UUIDs
   * (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi),
   * lowercased, deduped.
   */
  extractCited?: (args: SetMembershipArgs<TIn, TOut, TExpected>) => readonly string[];
}

// ---------------------------------------------------------------------------
// Default resolvers
// ---------------------------------------------------------------------------

const FULL_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function normalize(id: string): string {
  return id.trim().toLowerCase();
}

/** string as-is; otherwise JSON.stringify (undefined ⇒ ""). */
function stringifyForMatch(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

function defaultExpectedIds<TIn, TOut, TExpected>(
  args: SetMembershipArgs<TIn, TOut, TExpected>,
): readonly string[] | undefined {
  const { expected } = args;
  if (isStringArray(expected)) return expected;
  if (expected !== null && typeof expected === "object") {
    const citedIds = (expected as Record<string, unknown>).citedIds;
    if (isStringArray(citedIds)) return citedIds;
  }
  return undefined;
}

function defaultExtractCited<TIn, TOut, TExpected>(
  args: SetMembershipArgs<TIn, TOut, TExpected>,
): readonly string[] {
  const text = stringifyForMatch(args.output);
  const matches = text.match(FULL_UUID_RE) ?? [];
  return Array.from(new Set(matches.map((m) => m.toLowerCase())));
}

// ---------------------------------------------------------------------------
// setMembership
// ---------------------------------------------------------------------------

/**
 * Pinned math (normalization = trim + lowercase on every id, both sides;
 * membership = whole-string equality — the fix):
 *
 * ```
 * E = normalized expected ids (deduped)   C = normalized cited ids (deduped)
 * hits      = |E ∩ C|
 * recall    = |E| > 0 ? hits/|E| : 1
 * precision = |C| > 0 ? hits/|C| : (|E| === 0 ? 1 : 0)
 * f1        = (precision+recall) > 0 ? 2PR/(P+R) : 0
 * passed    = recall ≥ opts.recall(0.6) ∧ precision ≥ opts.precision(0.4)
 * ```
 *
 * The `|C| = 0 ∧ |E| = 0 ⇒ precision 1` branch is a deliberate improvement over
 * v1 (grade.ts:128 yields precision 0 there, failing a case that correctly
 * cited nothing).
 */
export function setMembership<TIn = unknown, TOut = unknown, TExpected = unknown>(
  opts?: SetMembershipOptions<TIn, TOut, TExpected>,
): Scorer<TIn, TOut, TExpected> {
  const name = opts?.name ?? "set-membership";
  const metric = opts?.metric ?? "f1";
  const recallThreshold = opts?.recall ?? 0.6;
  const precisionThreshold = opts?.precision ?? 0.4;
  const resolveExpectedIds = opts?.expectedIds ?? defaultExpectedIds;
  const resolveCitedIds = opts?.extractCited ?? defaultExtractCited;

  return (args): Score | Score[] => {
    const rawExpected = resolveExpectedIds(args);
    if (rawExpected === undefined) return [];

    const expectedSet = new Set(rawExpected.map(normalize));
    const citedSet = new Set(resolveCitedIds(args).map(normalize));
    const expectedIds = Array.from(expectedSet);
    const citedIds = Array.from(citedSet);

    let hits = 0;
    for (const id of expectedIds) {
      if (citedSet.has(id)) hits++;
    }

    const recall = expectedIds.length > 0 ? hits / expectedIds.length : 1;
    const precision =
      citedIds.length > 0 ? hits / citedIds.length : expectedIds.length === 0 ? 1 : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const passed = recall >= recallThreshold && precision >= precisionThreshold;

    const missing = expectedIds.filter((id) => !citedSet.has(id));
    const unexpected = citedIds.filter((id) => !expectedSet.has(id));

    // The v1 bug shape, surfaced: a missing expected id that is a PROPER prefix
    // of some cited id (e.g. an 8-char-prefix bank vs a full-UUID citation).
    const prefixSuspects = missing.filter((m) =>
      citedIds.some((c) => c.length > m.length && c.startsWith(m)),
    );

    const detail: Record<string, unknown> = {
      precision,
      recall,
      f1,
      expectedCount: expectedIds.length,
      citedCount: citedIds.length,
      hits,
      missing,
      unexpected,
    };
    if (prefixSuspects.length > 0) {
      detail.prefixSuspects = prefixSuspects;
    }

    const value = metric === "recall" ? recall : metric === "precision" ? precision : f1;
    return { name, value, passed, detail };
  };
}
