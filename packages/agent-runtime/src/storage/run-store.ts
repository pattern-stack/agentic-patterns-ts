/**
 * RunStore — one-row-per-run aggregate, extends EventStore.
 *
 * "Extends" is literal inheritance: same SQLite file, same injected
 * better-sqlite3 constructor, same WAL pragmas (`EventStore`, `./event-store.js`).
 * The subclass adds the `runs` table's prepared statements + query API; the
 * schema itself lands in `EventStore`'s migration ladder as v2 so plain
 * `EventStore` and `RunStore` stay interchangeable on the same file.
 *
 * ConversationStore = the dialogue you replay; RunStore = the execution you
 * analyze. They stay linked (via `StoredMessage.runId`, `conversation/store.ts`),
 * never merged. RunStore is observational — the agent never reads it back.
 *
 * Fed by `RunStoreExporter` (`../exporters/run-store.js`) for bus-driven runs,
 * or directly via `startRun`/`finishRun` for manual producers (e.g. `runEval`'s
 * `onResult`, `../eval/run-eval.js`) — zero coupling either way.
 */

import type { Statement } from "better-sqlite3";
import { EventStore, type EventStoreOptions, type PersistedEvent } from "./event-store.js";

// ---------------------------------------------------------------------------
// ID generation (mirrors conversation/store.ts's local generateId)
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

/** Metadata opening a run row. All optional — the exporter fills from bus events. */
export interface RunMeta {
  /** Omit → generated (manual producers); the exporter passes the bus runId. */
  readonly runId?: string;
  readonly traceId?: string;
  readonly tsStart?: Date;
  readonly agentName?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly agentConfig?: Record<string, unknown>;
  /** Free-form producer meta (JSON) — eval axes / join keys ride here. */
  readonly metadata?: Record<string, unknown>;
}

/** Outcome stamped at finalize. Field-for-field canvas-workstation's RunOutcome. */
export interface RunOutcome {
  readonly finalAnswer: string;
  readonly toolCalls: number;
  readonly iterations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly finishReason: string;
  readonly elapsedMs: number;
  readonly status: "ok" | "error";
  readonly error?: string;
  readonly stepMetrics?: unknown; // JSON-serialized into runs.step_metrics
}

/** Full run row (read side, camelCase like PersistedEvent). */
export interface RunRow {
  readonly runId: string;
  readonly traceId: string | null;
  readonly tsStart: string;
  readonly tsEnd: string | null;
  readonly agentName: string | null;
  readonly model: string | null;
  readonly systemPrompt: string | null;
  readonly agentConfig: Record<string, unknown> | null;
  readonly finalAnswer: string | null;
  readonly toolCalls: number | null;
  readonly iterations: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly finishReason: string | null;
  readonly elapsedMs: number | null;
  readonly status: "running" | "ok" | "error";
  readonly error: string | null;
  readonly stepMetrics: unknown;
  readonly metadata: Record<string, unknown> | null;
}

/** Run-list projection — cheap columns only (no systemPrompt / finalAnswer blobs). */
export interface RunSummary {
  readonly runId: string;
  readonly traceId: string | null;
  readonly tsStart: string;
  readonly tsEnd: string | null;
  readonly agentName: string | null;
  readonly model: string | null;
  readonly status: "running" | "ok" | "error";
  readonly finishReason: string | null;
  readonly toolCalls: number | null;
  readonly iterations: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly elapsedMs: number | null;
  readonly answerLength: number;
  readonly hasPrompt: boolean;
}

/** The run-aggregate query result. */
export interface RunStats {
  readonly runs: number;
  readonly ok: number;
  readonly error: number;
  readonly running: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly meanElapsedMs: number | null;
  readonly meanIterations: number | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class RunStore extends EventStore {
  private readonly _startRunStmt: Statement;
  private readonly _finishRunStmt: Statement;
  private readonly _sweepRunningStmt: Statement;
  private readonly _getRunStmt: Statement;
  private readonly _getRunPrefixStmt: Statement;
  private readonly _listRunsStmt: Statement;
  private readonly _runEventsStmt: Statement;
  private readonly _statsStmt: Statement;

  constructor(opts: EventStoreOptions) {
    super(opts);

    this._startRunStmt = this._db.prepare(`
      INSERT INTO runs (
        run_id, trace_id, ts_start, agent_name, model,
        system_prompt, agent_config, status, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)
    `);

    this._finishRunStmt = this._db.prepare(`
      UPDATE runs SET
        ts_end = ?, final_answer = ?, tool_calls = ?, iterations = ?,
        input_tokens = ?, output_tokens = ?, finish_reason = ?, elapsed_ms = ?,
        status = ?, error = ?, step_metrics = ?
      WHERE run_id = ? AND status = 'running'
    `);

    // First-terminal-wins lives here too: the WHERE ... status = 'running'
    // guard above makes a second finishRun() call for the same runId a no-op.
    this._sweepRunningStmt = this._db.prepare(`
      UPDATE runs SET status = 'error', error = ?, ts_end = COALESCE(ts_end, ?)
      WHERE status = 'running'
    `);

    this._getRunStmt = this._db.prepare("SELECT * FROM runs WHERE run_id = ?");
    this._getRunPrefixStmt = this._db.prepare("SELECT * FROM runs WHERE run_id LIKE ? LIMIT 2");

    this._listRunsStmt = this._db.prepare(`
      SELECT
        run_id         AS runId,
        trace_id       AS traceId,
        ts_start       AS tsStart,
        ts_end         AS tsEnd,
        agent_name     AS agentName,
        model,
        status,
        finish_reason  AS finishReason,
        tool_calls     AS toolCalls,
        iterations,
        input_tokens   AS inputTokens,
        output_tokens  AS outputTokens,
        elapsed_ms     AS elapsedMs,
        LENGTH(COALESCE(final_answer, '')) AS answerLength,
        CASE WHEN system_prompt IS NOT NULL THEN 1 ELSE 0 END AS hasPrompt
      FROM runs
      WHERE (@status    IS NULL OR status = @status)
        AND (@agentName IS NULL OR agent_name = @agentName)
        AND (@since     IS NULL OR ts_start >= @since)
      ORDER BY ts_start DESC
      LIMIT @limit
    `);

    // The run's ordered event stream — inherited `events` table (SCHEMA_V1),
    // filtered by the run_id column already denormalized by EventStore.append().
    this._runEventsStmt = this._db.prepare(`
      SELECT * FROM events WHERE run_id = ? ORDER BY id ASC
    `);

    this._statsStmt = this._db.prepare(`
      SELECT
        COUNT(*)                                                   AS runs,
        COALESCE(SUM(CASE WHEN status = 'ok'      THEN 1 ELSE 0 END), 0) AS ok,
        COALESCE(SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END), 0) AS error,
        COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
        COALESCE(SUM(input_tokens), 0)  AS totalInputTokens,
        COALESCE(SUM(output_tokens), 0) AS totalOutputTokens,
        AVG(elapsed_ms) AS meanElapsedMs,
        AVG(iterations) AS meanIterations
      FROM runs
      WHERE (@since     IS NULL OR ts_start >= @since)
        AND (@agentName IS NULL OR agent_name = @agentName)
        AND (@model     IS NULL OR model = @model)
    `);
  }

  /** Open a run row (status 'running'). Returns the runId (generated when omitted). */
  startRun(meta: RunMeta = {}): string {
    const runId = meta.runId ?? generateId();
    this._startRunStmt.run(
      runId,
      meta.traceId ?? null,
      (meta.tsStart ?? new Date()).toISOString(),
      meta.agentName ?? null,
      meta.model ?? null,
      meta.systemPrompt ?? null,
      meta.agentConfig ? JSON.stringify(meta.agentConfig) : null,
      meta.metadata ? JSON.stringify(meta.metadata) : null,
    );
    return runId;
  }

  /** Stamp the outcome. First finalize wins; re-finalizing is a no-op. */
  finishRun(runId: string, outcome: RunOutcome): void {
    this._finishRunStmt.run(
      new Date().toISOString(),
      outcome.finalAnswer,
      outcome.toolCalls,
      outcome.iterations,
      outcome.inputTokens,
      outcome.outputTokens,
      outcome.finishReason,
      outcome.elapsedMs,
      outcome.status,
      outcome.error ?? null,
      outcome.stepMetrics !== undefined ? JSON.stringify(outcome.stepMetrics) : null,
      runId,
    );
  }

  /** Mark orphaned 'running' rows as errored (process died mid-run). Returns count. */
  sweepRunning(reason = "orphaned: no terminal event before sweep"): number {
    const info = this._sweepRunningStmt.run(reason, new Date().toISOString());
    return Number(info.changes);
  }

  /** Full row by id or unique prefix. */
  getRun(id: string): RunRow | null {
    const exact = this._getRunStmt.get(id) as RawRunRow | undefined;
    if (exact) return rowToRunRow(exact);

    const prefixMatches = this._getRunPrefixStmt.all(`${id}%`) as RawRunRow[];
    return prefixMatches.length === 1 ? rowToRunRow(prefixMatches[0] as RawRunRow) : null;
  }

  /** Newest first. */
  listRuns(
    opts: {
      limit?: number;
      status?: "running" | "ok" | "error";
      agentName?: string;
      since?: Date;
    } = {},
  ): RunSummary[] {
    const rows = this._listRunsStmt.all({
      status: opts.status ?? null,
      agentName: opts.agentName ?? null,
      since: opts.since ? opts.since.toISOString() : null,
      limit: opts.limit ?? 50,
    }) as RawRunSummaryRow[];
    return rows.map((r) => ({
      runId: r.runId,
      traceId: r.traceId,
      tsStart: r.tsStart,
      tsEnd: r.tsEnd,
      agentName: r.agentName,
      model: r.model,
      status: r.status,
      finishReason: r.finishReason,
      toolCalls: r.toolCalls,
      iterations: r.iterations,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      elapsedMs: r.elapsedMs,
      answerLength: r.answerLength,
      hasPrompt: r.hasPrompt === 1,
    }));
  }

  /** The run's ordered event stream — inherited events table, WHERE run_id ORDER BY id. */
  runEvents(runId: string): PersistedEvent[] {
    const rows = this._runEventsStmt.all(runId) as RawEventRow[];
    return rows.map(rowToPersistedEvent);
  }

  /** Aggregate across runs. */
  stats(opts: { since?: Date; agentName?: string; model?: string } = {}): RunStats {
    const row = this._statsStmt.get({
      since: opts.since ? opts.since.toISOString() : null,
      agentName: opts.agentName ?? null,
      model: opts.model ?? null,
    }) as RawStatsRow;
    return {
      runs: row.runs,
      ok: row.ok,
      error: row.error,
      running: row.running,
      totalInputTokens: row.totalInputTokens,
      totalOutputTokens: row.totalOutputTokens,
      meanElapsedMs: row.meanElapsedMs,
      meanIterations: row.meanIterations,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RawRunRow {
  run_id: string;
  trace_id: string | null;
  ts_start: string;
  ts_end: string | null;
  agent_name: string | null;
  model: string | null;
  system_prompt: string | null;
  agent_config: string | null;
  final_answer: string | null;
  tool_calls: number | null;
  iterations: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  finish_reason: string | null;
  elapsed_ms: number | null;
  status: "running" | "ok" | "error";
  error: string | null;
  step_metrics: string | null;
  metadata: string | null;
}

function rowToRunRow(r: RawRunRow): RunRow {
  return {
    runId: r.run_id,
    traceId: r.trace_id,
    tsStart: r.ts_start,
    tsEnd: r.ts_end,
    agentName: r.agent_name,
    model: r.model,
    systemPrompt: r.system_prompt,
    agentConfig: parseJsonRecord(r.agent_config),
    finalAnswer: r.final_answer,
    toolCalls: r.tool_calls,
    iterations: r.iterations,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    finishReason: r.finish_reason,
    elapsedMs: r.elapsed_ms,
    status: r.status,
    error: r.error,
    stepMetrics: parseJsonUnknown(r.step_metrics),
    metadata: parseJsonRecord(r.metadata),
  };
}

interface RawRunSummaryRow {
  runId: string;
  traceId: string | null;
  tsStart: string;
  tsEnd: string | null;
  agentName: string | null;
  model: string | null;
  status: "running" | "ok" | "error";
  finishReason: string | null;
  toolCalls: number | null;
  iterations: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number | null;
  answerLength: number;
  hasPrompt: 0 | 1;
}

interface RawStatsRow {
  runs: number;
  ok: number;
  error: number;
  running: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  meanElapsedMs: number | null;
  meanIterations: number | null;
}

// Duplicated (not imported) from event-store.ts by design — event-store.ts's
// file-level plan is migration-ladder-only; this stays local to run-store.ts.
interface RawEventRow {
  id: number;
  type: string;
  timestamp: string;
  trace_id: string | null;
  run_id: string | null;
  span_id: string | null;
  cc_session_id: string | null;
  cc_hook_name: string | null;
  cc_cwd: string | null;
  data: string;
}

function rowToPersistedEvent(r: RawEventRow): PersistedEvent {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(r.data) as Record<string, unknown>;
  } catch {
    data = { _parseError: true, _raw: r.data };
  }
  return {
    id: r.id,
    type: r.type,
    timestamp: r.timestamp,
    traceId: r.trace_id,
    runId: r.run_id,
    spanId: r.span_id,
    ccSessionId: r.cc_session_id,
    ccHookName: r.cc_hook_name,
    ccCwd: r.cc_cwd,
    data,
  };
}

function parseJsonRecord(s: string | null): Record<string, unknown> | null {
  if (s === null) return null;
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseJsonUnknown(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
