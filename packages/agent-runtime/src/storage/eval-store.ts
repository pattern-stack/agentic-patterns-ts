/**
 * EvalStore — the eval annotation layer, extends RunStore.
 *
 * "Extends" is literal inheritance (same idiom as RunStore extending
 * EventStore, `./run-store.js`): same SQLite file, same injected
 * better-sqlite3 constructor, same WAL pragmas. The subclass adds four new
 * tables' prepared statements + query API; the schema itself lands in
 * `EventStore`'s migration ladder as v3 (`./event-store.js`) so plain
 * `EventStore` / `RunStore` / `EvalStore` stay interchangeable on the same
 * file.
 *
 * Load-bearing semantics (doc Update note 2026-07-04, §16.1 RESOLVED):
 * each eval case's execution IS a RunStore run. Tokens, trace_id, final
 * answer, finish_reason, elapsed, status, error all live on the inherited
 * `runs` row and are JOINed in — NEVER duplicated onto `eval_result`.
 * `eval_result` stores ONLY `scores_json` / `pass` / linkage (`eval_run_id`,
 * `case_id`, `run_id`). `variant`/`split` ride two places by design:
 * suite-level as columns on `eval_run`, and per-run stamped into the run's
 * `metadata` JSON slot (`RunMeta.metadata`, `run-store.ts:49` — the slot
 * #117 reserved for exactly this).
 *
 * Zero coupling to `eval/` is a kept invariant (same as run-store.ts): score
 * input is structurally typed (`EvalScoreLike`, satisfied by `eval/types.ts`
 * `Score`) — no import from `eval/`.
 */

import type { Statement } from "better-sqlite3";
import type { EventStoreOptions } from "./event-store.js";
import { RunStore } from "./run-store.js";

// ---------------------------------------------------------------------------
// ID generation (mirrors run-store.ts's local generateId — deliberately not
// shared; see run-store.ts:26-32 precedent)
// ---------------------------------------------------------------------------

let _counter = 0;
function generateId(): string {
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EvalSplit = "train" | "dev" | "test";

/** Structurally compatible with `eval/types.ts` `Score` — deliberately NOT imported. */
export interface EvalScoreLike {
  readonly name: string;
  readonly value: number | null;
  readonly passed?: boolean;
  readonly detail?: Record<string, unknown>;
  readonly error?: string;
}

export interface EvalSetMeta {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly createdTs?: Date; // omit -> now
}

export interface EvalSetSummary {
  readonly id: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly createdTs: string;
  readonly caseCount: number;
  readonly splitCounts: Readonly<Record<string, number>>; // per-split, "" bucket = untagged
}

export interface StoredEvalCase {
  readonly caseId: string;
  readonly input?: unknown; // JSON-serialized into input_json
  readonly expected?: unknown;
  readonly tags?: readonly string[];
  readonly split?: EvalSplit;
}

export interface EvalCaseRow {
  readonly setId: string;
  readonly caseId: string;
  readonly input: unknown;
  readonly expected: unknown;
  readonly tags: readonly string[] | null;
  readonly split: EvalSplit | null;
}

export interface EvalRunMeta {
  readonly id?: string; // omit -> generated (startRun idiom, run-store.ts:211)
  readonly tsStart?: Date;
  readonly setId?: string;
  readonly targetId?: string;
  readonly variant?: string;
  readonly split?: EvalSplit;
  readonly model?: string;
  readonly gitSha?: string;
}

export interface EvalRunRow {
  readonly id: string;
  readonly tsStart: string;
  readonly tsEnd: string | null;
  readonly setId: string | null;
  readonly targetId: string | null;
  readonly variant: string | null;
  readonly split: EvalSplit | null;
  readonly model: string | null;
  readonly gitSha: string | null;
  readonly status: "running" | "ok" | "error";
}

export interface EvalResultRecord {
  readonly evalRunId: string;
  readonly caseId: string;
  readonly runId?: string; // -> runs.run_id; optional (annotate-later)
  readonly scores?: readonly EvalScoreLike[];
  readonly pass?: boolean | null;
}

/** eval_result LEFT JOIN runs — annotation fields + run-owned fields, never copied. */
export interface JoinedEvalResultRow {
  readonly evalRunId: string;
  readonly caseId: string;
  readonly runId: string | null;
  readonly scores: readonly EvalScoreLike[] | null;
  readonly pass: boolean | null;
  // from the runs row (null when run_id is null / row missing)
  readonly traceId: string | null;
  readonly runStatus: "running" | "ok" | "error" | null;
  readonly finalAnswer: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly finishReason: string | null;
  readonly elapsedMs: number | null;
  readonly runError: string | null;
}

export interface EvalComparisonRow {
  readonly caseId: string;
  readonly a: {
    readonly pass: boolean | null;
    readonly scores: readonly EvalScoreLike[] | null;
  } | null;
  readonly b: {
    readonly pass: boolean | null;
    readonly scores: readonly EvalScoreLike[] | null;
  } | null;
}

export interface EvalComparison {
  readonly a: EvalRunRow;
  readonly b: EvalRunRow;
  readonly rows: readonly EvalComparisonRow[]; // union of case ids; one-sided rows keep the other side null
  readonly summary: {
    readonly bothPassed: number;
    readonly bothFailed: number;
    readonly onlyAPassed: number; // regressions when A = old, B = new
    readonly onlyBPassed: number;
    readonly aOnly: number; // cases missing from B (not-run, not errors)
    readonly bOnly: number;
  };
}

export interface SplitAggregate {
  readonly split: EvalSplit | null; // null = untagged bucket
  readonly results: number;
  readonly passed: number;
  readonly failed: number;
  readonly passRate: number | null; // null when no result carried a pass verdict
}

/**
 * One run that evaluated a given `(setId, caseId)` — the case's annotation
 * (`pass`/`scores`) joined to its `eval_run` metadata and the `runs`-table
 * execution fields. The "cross-run history" for a single case; newest first.
 * `split` is the RUN's label (`eval_run.split`), not the case's bank split.
 */
export interface EvalCaseHistoryRow {
  readonly evalRunId: string;
  readonly tsStart: string;
  readonly targetId: string | null;
  readonly variant: string | null;
  readonly split: EvalSplit | null;
  readonly model: string | null;
  readonly runStatus: "running" | "ok" | "error";
  readonly pass: boolean | null;
  readonly scores: readonly EvalScoreLike[] | null;
  readonly finalAnswer: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly elapsedMs: number | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class EvalStore extends RunStore {
  private readonly _upsertEvalSetStmt: Statement;
  private readonly _upsertEvalCaseStmt: Statement;
  private readonly _deleteEvalCaseStmt: Statement;
  private readonly _caseResultHistoryStmt: Statement;
  private readonly _listEvalSetsStmt: Statement;
  private readonly _caseCountsBySetStmt: Statement;
  private readonly _listEvalCasesStmt: Statement;
  private readonly _startEvalRunStmt: Statement;
  private readonly _finishEvalRunStmt: Statement;
  private readonly _recordEvalResultStmt: Statement;
  private readonly _getEvalRunStmt: Statement;
  private readonly _listEvalRunsStmt: Statement;
  private readonly _evalRunResultsStmt: Statement;
  private readonly _splitAggregatesStmt: Statement;

  constructor(opts: EventStoreOptions) {
    super(opts);

    this._upsertEvalSetStmt = this._db.prepare(`
      INSERT INTO eval_set (id, name, description, created_ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description
    `);

    this._upsertEvalCaseStmt = this._db.prepare(`
      INSERT INTO eval_case (set_id, case_id, input_json, expected_json, tags_json, split)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(set_id, case_id) DO UPDATE SET
        input_json    = excluded.input_json,
        expected_json = excluded.expected_json,
        tags_json     = excluded.tags_json,
        split         = excluded.split
    `);

    this._deleteEvalCaseStmt = this._db.prepare(`
      DELETE FROM eval_case WHERE set_id = ? AND case_id = ?
    `);

    // Cross-run history for one case: every eval_result for (set, case),
    // joined to its run metadata and the runs-table execution fields. Newest
    // first. Scoped by ev.set_id so the same case_id in another set is excluded.
    this._caseResultHistoryStmt = this._db.prepare(`
      SELECT
        ev.id           AS evalRunId,
        ev.ts_start     AS tsStart,
        ev.target_id    AS targetId,
        ev.variant      AS variant,
        ev.split        AS split,
        ev.model        AS model,
        ev.status       AS runStatus,
        er.pass         AS pass,
        er.scores_json  AS scoresJson,
        r.final_answer  AS finalAnswer,
        r.input_tokens  AS inputTokens,
        r.output_tokens AS outputTokens,
        r.elapsed_ms    AS elapsedMs
      FROM eval_result er
      JOIN eval_run ev ON er.eval_run_id = ev.id
      LEFT JOIN runs r ON er.run_id = r.run_id
      WHERE ev.set_id = @setId AND er.case_id = @caseId
      ORDER BY ev.ts_start DESC
    `);

    this._listEvalSetsStmt = this._db.prepare(`
      SELECT id, name, description, created_ts AS createdTs
      FROM eval_set
      ORDER BY created_ts ASC, id ASC
    `);

    this._caseCountsBySetStmt = this._db.prepare(`
      SELECT set_id AS setId, COALESCE(split, '') AS split, COUNT(*) AS n
      FROM eval_case
      GROUP BY set_id, COALESCE(split, '')
    `);

    this._listEvalCasesStmt = this._db.prepare(`
      SELECT
        set_id        AS setId,
        case_id       AS caseId,
        input_json    AS inputJson,
        expected_json AS expectedJson,
        tags_json     AS tagsJson,
        split
      FROM eval_case
      WHERE set_id = @setId
        AND (@split IS NULL OR split = @split)
      ORDER BY case_id ASC
    `);

    this._startEvalRunStmt = this._db.prepare(`
      INSERT INTO eval_run (
        id, ts_start, set_id, target_id, variant, split, model, git_sha, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
    `);

    // First-terminal-wins, same idiom as RunStore.finishRun (run-store.ts:149).
    this._finishEvalRunStmt = this._db.prepare(`
      UPDATE eval_run SET ts_end = ?, status = ?
      WHERE id = ? AND status = 'running'
    `);

    this._recordEvalResultStmt = this._db.prepare(`
      INSERT OR REPLACE INTO eval_result (eval_run_id, case_id, run_id, scores_json, pass)
      VALUES (?, ?, ?, ?, ?)
    `);

    this._getEvalRunStmt = this._db.prepare(`
      SELECT
        id, ts_start AS tsStart, ts_end AS tsEnd, set_id AS setId,
        target_id AS targetId, variant, split, model, git_sha AS gitSha, status
      FROM eval_run WHERE id = ?
    `);

    this._listEvalRunsStmt = this._db.prepare(`
      SELECT
        id, ts_start AS tsStart, ts_end AS tsEnd, set_id AS setId,
        target_id AS targetId, variant, split, model, git_sha AS gitSha, status
      FROM eval_run
      WHERE (@setId    IS NULL OR set_id = @setId)
        AND (@targetId IS NULL OR target_id = @targetId)
        AND (@variant  IS NULL OR variant = @variant)
        AND (@split    IS NULL OR split = @split)
      ORDER BY ts_start DESC
      LIMIT @limit
    `);

    // The join view: eval_result LEFT JOIN runs. Annotation fields
    // (scoresJson/pass) alongside run-owned fields, never copied.
    this._evalRunResultsStmt = this._db.prepare(`
      SELECT
        er.eval_run_id   AS evalRunId,
        er.case_id       AS caseId,
        er.run_id        AS runId,
        er.scores_json   AS scoresJson,
        er.pass          AS pass,
        r.trace_id       AS traceId,
        r.status         AS runStatus,
        r.final_answer   AS finalAnswer,
        r.input_tokens   AS inputTokens,
        r.output_tokens  AS outputTokens,
        r.finish_reason  AS finishReason,
        r.elapsed_ms     AS elapsedMs,
        r.error          AS runError
      FROM eval_result er
      LEFT JOIN runs r ON er.run_id = r.run_id
      WHERE er.eval_run_id = ?
      ORDER BY er.case_id ASC
    `);

    // Per-split rollup: case-level split (eval_case, when the bank is
    // mirrored) wins; run-level label is the fallback for file-first banks.
    this._splitAggregatesStmt = this._db.prepare(`
      SELECT
        COALESCE(ec.split, ev.split)                                        AS split,
        COUNT(*)                                                            AS results,
        COALESCE(SUM(CASE WHEN er.pass = 1 THEN 1 ELSE 0 END), 0)           AS passed,
        COALESCE(SUM(CASE WHEN er.pass = 0 THEN 1 ELSE 0 END), 0)           AS failed
      FROM eval_result er
      JOIN eval_run ev ON er.eval_run_id = ev.id
      LEFT JOIN eval_case ec ON ec.set_id = ev.set_id AND ec.case_id = er.case_id
      WHERE (@setId    IS NULL OR ev.set_id = @setId)
        AND (@targetId IS NULL OR ev.target_id = @targetId)
        AND (@variant  IS NULL OR ev.variant = @variant)
      GROUP BY COALESCE(ec.split, ev.split)
    `);
  }

  // -------------------------------------------------------------------------
  // Case bank (idempotent upserts)
  // -------------------------------------------------------------------------

  /** Upsert a named eval set. Idempotent — re-upserting the same id updates name/description. */
  upsertEvalSet(meta: EvalSetMeta): void {
    this._upsertEvalSetStmt.run(
      meta.id,
      meta.name ?? null,
      meta.description ?? null,
      (meta.createdTs ?? new Date()).toISOString(),
    );
  }

  /** Upsert one case into a set's bank mirror. Idempotent by (setId, caseId). */
  upsertEvalCase(setId: string, c: StoredEvalCase): void {
    this._upsertEvalCaseStmt.run(
      setId,
      c.caseId,
      c.input !== undefined ? JSON.stringify(c.input) : null,
      c.expected !== undefined ? JSON.stringify(c.expected) : null,
      c.tags ? JSON.stringify(c.tags) : null,
      c.split ?? null,
    );
  }

  /** Delete one case from a set's bank. Returns true iff a row was removed. */
  deleteEvalCase(setId: string, caseId: string): boolean {
    return this._deleteEvalCaseStmt.run(setId, caseId).changes > 0;
  }

  /** All eval sets with per-split case counts (the shape `GET /eval/sets` serves). */
  listEvalSets(): EvalSetSummary[] {
    const sets = this._listEvalSetsStmt.all() as RawEvalSetRow[];
    const countRows = this._caseCountsBySetStmt.all() as RawCaseCountRow[];

    const bySet = new Map<string, Record<string, number>>();
    for (const r of countRows) {
      const bucket = bySet.get(r.setId) ?? {};
      bucket[r.split] = r.n;
      bySet.set(r.setId, bucket);
    }

    return sets.map((s) => {
      const splitCounts = bySet.get(s.id) ?? {};
      const caseCount = Object.values(splitCounts).reduce((sum, n) => sum + n, 0);
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        createdTs: s.createdTs,
        caseCount,
        splitCounts,
      };
    });
  }

  /** Cases in a set, optionally filtered by split. */
  listEvalCases(setId: string, opts: { split?: EvalSplit } = {}): EvalCaseRow[] {
    const rows = this._listEvalCasesStmt.all({
      setId,
      split: opts.split ?? null,
    }) as RawEvalCaseRow[];
    return rows.map(rowToEvalCaseRow);
  }

  // -------------------------------------------------------------------------
  // Suite lifecycle (startRun/finishRun idiom; first-terminal-wins)
  // -------------------------------------------------------------------------

  /** Open a suite-level eval_run row (status 'running'). Returns the id (generated when omitted). */
  startEvalRun(meta: EvalRunMeta = {}): string {
    const id = meta.id ?? generateId();
    this._startEvalRunStmt.run(
      id,
      (meta.tsStart ?? new Date()).toISOString(),
      meta.setId ?? null,
      meta.targetId ?? null,
      meta.variant ?? null,
      meta.split ?? null,
      meta.model ?? null,
      meta.gitSha ?? null,
    );
    return id;
  }

  /** Stamp the terminal status. First finalize wins; re-finalizing is a no-op. */
  finishEvalRun(id: string, outcome: { status: "ok" | "error" }): void {
    this._finishEvalRunStmt.run(new Date().toISOString(), outcome.status, id);
  }

  // -------------------------------------------------------------------------
  // Per-case annotation
  // -------------------------------------------------------------------------

  /** Record (or re-record) a case's annotation. INSERT OR REPLACE keyed on (evalRunId, caseId). */
  recordEvalResult(r: EvalResultRecord): void {
    this._recordEvalResultStmt.run(
      r.evalRunId,
      r.caseId,
      r.runId ?? null,
      r.scores ? JSON.stringify(r.scores) : null,
      boolToInt(r.pass ?? null),
    );
  }

  // -------------------------------------------------------------------------
  // Reads / query surface
  // -------------------------------------------------------------------------

  /** Full eval_run row by id. */
  getEvalRun(id: string): EvalRunRow | null {
    const row = this._getEvalRunStmt.get(id) as EvalRunRow | undefined;
    return row ?? null;
  }

  /** Newest first. */
  listEvalRuns(
    opts: {
      setId?: string;
      targetId?: string;
      variant?: string;
      split?: EvalSplit;
      limit?: number;
    } = {},
  ): EvalRunRow[] {
    return this._listEvalRunsStmt.all({
      setId: opts.setId ?? null,
      targetId: opts.targetId ?? null,
      variant: opts.variant ?? null,
      split: opts.split ?? null,
      limit: opts.limit ?? 50,
    }) as EvalRunRow[];
  }

  /**
   * The join view: eval_result LEFT JOIN runs. Proves by construction that
   * run data is joined, not copied — mutating the runs row directly is
   * reflected here without touching eval_result.
   */
  evalRunResults(evalRunId: string): JoinedEvalResultRow[] {
    const rows = this._evalRunResultsStmt.all(evalRunId) as RawJoinedResultRow[];
    return rows.map(rowToJoinedEvalResultRow);
  }

  /** Every run that evaluated `(setId, caseId)`, newest first — the case's
   *  cross-run history. Empty when the case was never run (or is unknown). */
  caseResultHistory(setId: string, caseId: string): EvalCaseHistoryRow[] {
    const rows = this._caseResultHistoryStmt.all({ setId, caseId }) as RawCaseHistoryRow[];
    return rows.map(rowToCaseHistoryRow);
  }

  /** A/B compare: same set, two variants, per-case aligned. Throws if either id is unknown. */
  compareEvalRuns(aId: string, bId: string): EvalComparison {
    const a = this.getEvalRun(aId);
    const b = this.getEvalRun(bId);
    if (!a) throw new Error(`compareEvalRuns: unknown eval run id "${aId}"`);
    if (!b) throw new Error(`compareEvalRuns: unknown eval run id "${bId}"`);

    const aMap = new Map(this.evalRunResults(aId).map((r) => [r.caseId, r]));
    const bMap = new Map(this.evalRunResults(bId).map((r) => [r.caseId, r]));
    const caseIds = Array.from(new Set([...aMap.keys(), ...bMap.keys()])).sort();

    const rows: EvalComparisonRow[] = [];
    let bothPassed = 0;
    let bothFailed = 0;
    let onlyAPassed = 0;
    let onlyBPassed = 0;
    let aOnly = 0;
    let bOnly = 0;

    for (const caseId of caseIds) {
      const ar = aMap.get(caseId);
      const br = bMap.get(caseId);

      rows.push({
        caseId,
        a: ar ? { pass: ar.pass, scores: ar.scores } : null,
        b: br ? { pass: br.pass, scores: br.scores } : null,
      });

      if (ar && !br) {
        aOnly++;
      } else if (br && !ar) {
        bOnly++;
      } else if (ar && br) {
        if (ar.pass === true && br.pass === true) bothPassed++;
        else if (ar.pass === false && br.pass === false) bothFailed++;
        else if (ar.pass === true && br.pass === false) onlyAPassed++;
        else if (ar.pass === false && br.pass === true) onlyBPassed++;
      }
    }

    return {
      a,
      b,
      rows,
      summary: { bothPassed, bothFailed, onlyAPassed, onlyBPassed, aOnly, bOnly },
    };
  }

  /** Per-split rollup — the train-vs-test overfit read. Filterable by setId/targetId/variant. */
  splitAggregates(
    opts: { setId?: string; targetId?: string; variant?: string } = {},
  ): SplitAggregate[] {
    const rows = this._splitAggregatesStmt.all({
      setId: opts.setId ?? null,
      targetId: opts.targetId ?? null,
      variant: opts.variant ?? null,
    }) as RawSplitAggregateRow[];

    return rows.map((r) => {
      const gated = r.passed + r.failed;
      return {
        split: (r.split as EvalSplit | null) ?? null,
        results: r.results,
        passed: r.passed,
        failed: r.failed,
        passRate: gated > 0 ? r.passed / gated : null,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Helper: derivePass
// ---------------------------------------------------------------------------

/** all gating scorers passed -> true; any failed -> false; none gated -> null. */
export function derivePass(scores: readonly EvalScoreLike[]): boolean | null {
  let anyGated = false;
  let allPassed = true;
  for (const s of scores) {
    if (s.passed !== undefined) {
      anyGated = true;
      if (!s.passed) allPassed = false;
    }
  }
  return anyGated ? allPassed : null;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

function boolToInt(pass: boolean | null): 0 | 1 | null {
  if (pass === null) return null;
  return pass ? 1 : 0;
}

function intToBool(v: number | null): boolean | null {
  return v === null ? null : v === 1;
}

interface RawEvalSetRow {
  id: string;
  name: string | null;
  description: string | null;
  createdTs: string;
}

interface RawCaseCountRow {
  setId: string;
  split: string; // "" bucket = untagged (COALESCE'd)
  n: number;
}

interface RawEvalCaseRow {
  setId: string;
  caseId: string;
  inputJson: string | null;
  expectedJson: string | null;
  tagsJson: string | null;
  split: string | null;
}

function rowToEvalCaseRow(r: RawEvalCaseRow): EvalCaseRow {
  return {
    setId: r.setId,
    caseId: r.caseId,
    input: parseJsonUnknown(r.inputJson),
    expected: parseJsonUnknown(r.expectedJson),
    tags: parseStringArray(r.tagsJson),
    split: (r.split as EvalSplit | null) ?? null,
  };
}

interface RawJoinedResultRow {
  evalRunId: string;
  caseId: string;
  runId: string | null;
  scoresJson: string | null;
  pass: number | null;
  traceId: string | null;
  runStatus: "running" | "ok" | "error" | null;
  finalAnswer: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
  elapsedMs: number | null;
  runError: string | null;
}

function rowToJoinedEvalResultRow(r: RawJoinedResultRow): JoinedEvalResultRow {
  return {
    evalRunId: r.evalRunId,
    caseId: r.caseId,
    runId: r.runId,
    scores: parseScores(r.scoresJson),
    pass: intToBool(r.pass),
    traceId: r.traceId,
    runStatus: r.runStatus,
    finalAnswer: r.finalAnswer,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    finishReason: r.finishReason,
    elapsedMs: r.elapsedMs,
    runError: r.runError,
  };
}

interface RawSplitAggregateRow {
  split: string | null;
  results: number;
  passed: number;
  failed: number;
}

interface RawCaseHistoryRow {
  evalRunId: string;
  tsStart: string;
  targetId: string | null;
  variant: string | null;
  split: string | null;
  model: string | null;
  runStatus: "running" | "ok" | "error";
  pass: number | null;
  scoresJson: string | null;
  finalAnswer: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number | null;
}

function rowToCaseHistoryRow(r: RawCaseHistoryRow): EvalCaseHistoryRow {
  return {
    evalRunId: r.evalRunId,
    tsStart: r.tsStart,
    targetId: r.targetId,
    variant: r.variant,
    split: (r.split as EvalSplit | null) ?? null,
    model: r.model,
    runStatus: r.runStatus,
    pass: intToBool(r.pass),
    scores: parseScores(r.scoresJson),
    finalAnswer: r.finalAnswer,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    elapsedMs: r.elapsedMs,
  };
}

function parseJsonUnknown(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseStringArray(s: string | null): readonly string[] | null {
  if (s === null) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as string[]) : null;
  } catch {
    return null;
  }
}

function parseScores(s: string | null): readonly EvalScoreLike[] | null {
  if (s === null) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as EvalScoreLike[]) : null;
  } catch {
    return null;
  }
}
