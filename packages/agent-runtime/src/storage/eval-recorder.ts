/**
 * `createEvalResultRecorder` — the `EvalStore` persistence seam extracted
 * from `ap eval`'s `onResult` (spec `.ai-docs/stacks/eval-surface/specs/
 * 139.md` § Decision 4), so a server-launched run and a CLI-launched run
 * write byte-identical rows by construction rather than by two hand-kept
 * duplicates + a parity test.
 *
 * Body lifted verbatim from `agent-cli/src/commands/eval.ts`'s onResult
 * (startRun -> finishRun -> recordEvalResult). Input is structurally typed
 * (`EvalResultLike`, satisfied by `eval/types.ts`'s `EvalResult` — the
 * `EvalScoreLike` precedent this file already keeps), so `storage/` still
 * never imports `eval/`.
 */

import type { EvalScoreLike, EvalSplit } from "./eval-store.js";
import { derivePass } from "./eval-store.js";
import type { EvalStore } from "./eval-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Structurally compatible with `eval/types.ts`'s `EvalResult` — deliberately NOT imported. */
export interface EvalResultLike {
  readonly case: { readonly id: string; readonly split?: EvalSplit };
  readonly output?: unknown;
  readonly succeeded: boolean;
  readonly error?: string;
  readonly traceId?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly scores: readonly EvalScoreLike[];
}

/** Suite-level context the recorder stamps onto every per-case `runs` row. */
export interface EvalRecorderMeta {
  readonly evalRunId: string;
  readonly targetId: string;
  readonly model?: string;
  readonly variant?: string;
  /** Run-level fallback; `r.case.split` wins when present (CLI eval.ts:284 precedence). */
  readonly split?: EvalSplit;
}

// ---------------------------------------------------------------------------
// createEvalResultRecorder
// ---------------------------------------------------------------------------

/**
 * Build an `onResult`-shaped persistence function: `startRun` -> `finishRun`
 * -> `recordEvalResult`, exactly as `ap eval` writes them (metadata key set,
 * `r.case.split ?? meta.split` precedence, traceId threading, `derivePass`).
 */
export function createEvalResultRecorder(
  store: EvalStore,
  meta: EvalRecorderMeta,
): (r: EvalResultLike) => void {
  return (r: EvalResultLike): void => {
    const runId = store.startRun({
      agentName: meta.targetId,
      model: meta.model,
      ...(r.traceId ? { traceId: r.traceId } : {}),
      metadata: {
        evalRunId: meta.evalRunId,
        caseId: r.case.id,
        ...(meta.variant !== undefined ? { variant: meta.variant } : {}),
        ...((r.case.split ?? meta.split) !== undefined
          ? { split: r.case.split ?? meta.split }
          : {}),
      },
    });
    store.finishRun(runId, {
      finalAnswer: r.output === undefined ? "" : JSON.stringify(r.output),
      toolCalls: 0,
      iterations: 0,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      finishReason: r.succeeded ? "stop" : "error",
      elapsedMs: 0,
      status: r.succeeded ? "ok" : "error",
      ...(r.error !== undefined ? { error: r.error } : {}),
    });
    store.recordEvalResult({
      evalRunId: meta.evalRunId,
      caseId: r.case.id,
      runId,
      scores: r.scores,
      pass: derivePass(r.scores),
    });
  };
}
