/**
 * Eval envelopes — `EvalCase`, `Score`, `EvalResult`, `EvalReport`, `EvalSpec`,
 * `EvalRunContext` + their Zod schemas (spec `.ai-docs/stacks/closed-composition/
 * specs/103.md` § Interfaces).
 *
 * The envelope is schema'd; the payloads (`TIn`/`TOut`/`TExpected`) stay generic —
 * the caller owns their shapes, exactly as `AgentConfig` is Zod'd while carrying
 * generic `capabilities: string[]`.
 *
 * Gate-1 binding refinement (issue #103 approval comment) over the spec's proposed
 * "catch-and-record 0": a throwing SCORER (not the node) is recorded as ERRORED —
 * `Score.value: null` + `Score.error` — excluded from aggregate score math, and
 * surfaced in `EvalReport.summary.scoreErrors`. A silent 0 would conflate "couldn't
 * score" with "scored zero".
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// EvalSplit
// ---------------------------------------------------------------------------

export const EvalSplitSchema = z.enum(["train", "dev", "test"]);
/** ML-standard split names (doc §7). Canonical home; storage/eval-store.ts:48 keeps
 *  a structural twin by design (#132 zero-coupling) — drift-guarded by test. */
export type EvalSplit = z.infer<typeof EvalSplitSchema>; // "train" | "dev" | "test"

// ---------------------------------------------------------------------------
// EvalCase
// ---------------------------------------------------------------------------

/** One eval case: typed input + optional expected + metadata. */
export interface EvalCase<TIn, TExpected = unknown> {
  readonly id: string;
  readonly input: TIn;
  readonly expected?: TExpected;
  readonly tags?: readonly string[];
  readonly split?: EvalSplit; // NEW — optional; absent = untagged (pre-#134 behavior)
}

export const EvalCaseSchema = z.object({
  id: z.string(),
  input: z.unknown(), // TIn — caller narrows via z.infer at their seam
  expected: z.unknown().optional(),
  tags: z.array(z.string()).readonly().optional(),
  split: EvalSplitSchema.optional(), // NEW
});

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

/**
 * One scorer's verdict on one case. `value` is `null` (not `0`) when the scorer
 * itself threw — Gate-1 binding refinement, see module doc. `error` is present
 * iff `value === null`.
 */
export interface Score {
  readonly name: string; // scorer id, e.g. "exact-match", "recall@60"
  readonly value: number | null; // normalized numeric (0..1 by convention); null = scorer errored
  readonly passed?: boolean; // optional hard gate
  readonly detail?: Record<string, unknown>; // forensics (dropped-gold, sizes, ...)
  readonly error?: string; // present iff value === null (the scorer threw)
}

export const ScoreSchema = z.object({
  name: z.string(),
  value: z.number().nullable(),
  passed: z.boolean().optional(),
  detail: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// EvalResult
// ---------------------------------------------------------------------------

/** Per-case outcome: the run result + every scorer's Score. */
export interface EvalResult<TIn, TOut, TExpected = unknown> {
  readonly case: EvalCase<TIn, TExpected>;
  readonly output?: TOut; // absent when the node failed
  readonly scores: readonly Score[];
  readonly succeeded: boolean; // node execution succeeded
  readonly error?: string; // error message when it did not
  /** NEW (#133): per-case trace id — present iff `EvalRunContext.eventBus` was set.
   *  Joins this case to its EventStore trace and its RunStore `runs` row(s)
   *  (`runs.trace_id`; a multi-leaf composite yields several rows, one trace). */
  readonly traceId?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const EvalResultSchema = z.object({
  case: EvalCaseSchema,
  output: z.unknown().optional(),
  scores: z.array(ScoreSchema).readonly(),
  succeeded: z.boolean(),
  error: z.string().optional(),
  traceId: z.string().optional(), // NEW (#133)
  inputTokens: z.number(),
  outputTokens: z.number(),
});

// ---------------------------------------------------------------------------
// EvalReport
// ---------------------------------------------------------------------------

export type EvalTargetKind = "node" | "agent" | "promoted";

/** The whole run: per-case results + aggregate summary. Consumable programmatically. */
export interface EvalReport<TIn, TOut, TExpected = unknown> {
  readonly target: EvalTargetKind;
  readonly results: readonly EvalResult<TIn, TOut, TExpected>[];
  readonly summary: {
    readonly cases: number;
    readonly succeeded: number; // node-level successes
    readonly errored: number; // node-level failures
    /** Count of individual Score entries with `value: null` (scorer threw). */
    readonly scoreErrors: number;
    readonly scoreMeans: Readonly<Record<string, number>>; // per scorer name -> mean value (null scores excluded)
    readonly passRate: Readonly<Record<string, number>>; // per scorer name -> fraction passed (when `passed` set)
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
  };
}

export const EvalReportSchema = z.object({
  target: z.enum(["node", "agent", "promoted"]),
  results: z.array(EvalResultSchema).readonly(),
  summary: z.object({
    cases: z.number(),
    succeeded: z.number(),
    errored: z.number(),
    scoreErrors: z.number(),
    scoreMeans: z.record(z.number()),
    passRate: z.record(z.number()),
    totalInputTokens: z.number(),
    totalOutputTokens: z.number(),
  }),
});
