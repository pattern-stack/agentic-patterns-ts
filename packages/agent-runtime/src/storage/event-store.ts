/**
 * EventStore — SQLite-backed durable log of bus events.
 *
 * Append-only event log with hot-path denormalization for Claude Code hook
 * grouping (cc_session_id / cc_hook_name / cc_cwd). Everything else lives in
 * the JSON `data` column.
 *
 * Single-table v1. Schema versioning via `PRAGMA user_version` so future
 * migrations have a place to land without surprising rewrites.
 *
 * Consumers should not import this module unless `better-sqlite3` is
 * installed — see `loadEventStore()` in `./load.js` for the optional-dep
 * helper used by the CLI playground.
 */

import type DatabaseConstructor from "better-sqlite3";
import type { Database, Statement } from "better-sqlite3";
import type { BaseEvent } from "../events/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Row shape returned from queries. `data` is the original event JSON. */
export interface PersistedEvent {
  readonly id: number;
  readonly type: string;
  readonly timestamp: string;
  readonly traceId: string | null;
  readonly runId: string | null;
  readonly spanId: string | null;
  readonly ccSessionId: string | null;
  readonly ccHookName: string | null;
  readonly ccCwd: string | null;
  readonly data: Record<string, unknown>;
}

/** One row of the per-session aggregate. */
export interface SessionSummary {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly eventCount: number;
}

export interface EventStoreOptions {
  /**
   * Path to the SQLite file. `:memory:` is supported for tests.
   * Parent directories are created automatically.
   */
  readonly path: string;
  /** Retention in days. Events older than this are removed at construction. */
  readonly retentionDays?: number;
  /** Row cap. The N most recent rows are kept; older ones are deleted. */
  readonly maxRows?: number;
  /**
   * Injected better-sqlite3 constructor. Lets callers ship their own copy
   * without forcing a hard runtime dep on this package.
   */
  readonly Database: typeof DatabaseConstructor;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  trace_id TEXT,
  run_id TEXT,
  span_id TEXT,
  cc_session_id TEXT,
  cc_hook_name TEXT,
  cc_cwd TEXT,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_cc_session ON events(cc_session_id, timestamp) WHERE cc_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id, timestamp) WHERE trace_id IS NOT NULL;
`;

/**
 * v2 — adds the `runs` table (#117 RunStore): one row per run, folded from
 * the bus's message.start/llm.end/tool.end/iteration.end/message.complete
 * lifecycle. Purely additive — a v1 events-only DB migrates in place and
 * `EventStore`/`RunStore` stay interchangeable on the same file.
 *
 * Downgrade caveat (accepted, not fixed): a v2 DB opened by a pre-#117
 * runtime's `EventStore` throws the version-mismatch error below (its
 * `TARGET_SCHEMA_VERSION` is still 1). These DBs are retention-pruned dev
 * telemetry, and `EventStore`/`RunStore` ship in lockstep in one package.
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  trace_id TEXT,
  ts_start TEXT NOT NULL,
  ts_end TEXT,
  agent_name TEXT,
  model TEXT,
  system_prompt TEXT,
  agent_config TEXT,
  final_answer TEXT,
  tool_calls INTEGER,
  iterations INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  finish_reason TEXT,
  elapsed_ms INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  step_metrics TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_ts_start ON runs(ts_start);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_trace ON runs(trace_id) WHERE trace_id IS NOT NULL;
`;

/**
 * v3 — adds the eval annotation layer (#132 EvalStore): `eval_set` / `eval_case`
 * (the optional case-bank mirror), `eval_run` (one row per SUITE invocation —
 * NOT per case), and `eval_result` (one row per case outcome, annotating a
 * RunStore run by `run_id` — tokens/trace_id/final answer/status all live on
 * the `runs` row and are JOINed in, never duplicated here). Purely additive —
 * a v2 (events+runs) DB migrates in place and `EventStore`/`RunStore`/
 * `EvalStore` stay interchangeable on the same file.
 *
 * No hard `FOREIGN KEY (run_id) REFERENCES runs(run_id)`: `foreign_keys = ON`
 * is live (see constructor), and a hard FK would make insert ordering
 * load-bearing (the run row would have to exist before the eval_result row),
 * breaking annotate-later flows (e.g. bus-driven runs landing asynchronously
 * via `RunStoreExporter`). `run_id` is a plain indexed TEXT column — the join
 * is by convention, matching how `runs.trace_id` references `events` without
 * an FK.
 *
 * Downgrade caveat (accepted, same as v2's): a v3 DB opened by a pre-#132
 * runtime throws the version-mismatch error below (its `TARGET_SCHEMA_VERSION`
 * is still 2). Dev telemetry, single-package lockstep — accepted, not fixed.
 */
const SCHEMA_V3 = `
-- a named suite of cases (optional; cases may stay file-loaded)
CREATE TABLE IF NOT EXISTS eval_set (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  description TEXT,
  created_ts  TEXT NOT NULL
);

-- the case-bank mirror (optional persistence — enables UI browse/authoring)
CREATE TABLE IF NOT EXISTS eval_case (
  set_id        TEXT NOT NULL,
  case_id       TEXT NOT NULL,
  input_json    TEXT,
  expected_json TEXT,
  tags_json     TEXT,
  split         TEXT,              -- 'train' | 'dev' | 'test' (enforced at the API, not DDL)
  PRIMARY KEY (set_id, case_id)
);

-- SUITE-level: one invocation of a (target, variant) over a set/split.
-- NOT per-case — each case's execution is a RunStore runs row (eval_result.run_id).
CREATE TABLE IF NOT EXISTS eval_run (
  id        TEXT PRIMARY KEY,
  ts_start  TEXT NOT NULL,
  ts_end    TEXT,
  set_id    TEXT,
  target_id TEXT,
  variant   TEXT,                  -- the A/B label; free string, provenance beside it
  split     TEXT,                  -- run-level split filter label (NULL = all splits)
  model     TEXT,
  git_sha   TEXT,
  status    TEXT NOT NULL          -- 'running' | 'ok' | 'error'
);

-- per-case outcome — ANNOTATES a RunStore run. run_id -> runs.run_id (same file).
-- Tokens/trace_id/final answer/finish_reason/status/error live on the runs row,
-- JOINed in — NOT duplicated here. No hard FK: insert order must not be
-- load-bearing (foreign_keys=ON is live; bus-driven runs land asynchronously).
CREATE TABLE IF NOT EXISTS eval_result (
  eval_run_id TEXT NOT NULL,
  case_id     TEXT NOT NULL,
  run_id      TEXT,                -- -> runs.run_id
  scores_json TEXT,                -- the engine's heterogeneous Score[]
  pass        INTEGER,             -- 1 | 0 | NULL (NULL = no gating scorer ran)
  PRIMARY KEY (eval_run_id, case_id)
);

CREATE INDEX IF NOT EXISTS idx_eval_run_set    ON eval_run(set_id, variant);
CREATE INDEX IF NOT EXISTS idx_eval_run_ts     ON eval_run(ts_start);
CREATE INDEX IF NOT EXISTS idx_eval_result_run ON eval_result(run_id) WHERE run_id IS NOT NULL;
`;

/**
 * v4 — adds `eval_run.scorer`: the scorer id a server-launched run graded
 * with (routes/eval.ts previously only echoed it on the 202 — historical runs
 * couldn't say how they were scored, making cross-run pass-rate comparisons
 * ambiguous). NULL = unrecorded (pre-v4 rows, or a caller that didn't say).
 * Same downgrade caveat as v2/v3: a v4 DB opened by an older runtime throws
 * the version-mismatch error below. Dev telemetry, lockstep — accepted.
 */
const SCHEMA_V4 = `
ALTER TABLE eval_run ADD COLUMN scorer TEXT;
`;

/**
 * v5 — adds the conversation-persistence layer (#S7 `SQLiteConversationStore`):
 * `conversations` (one row per multi-turn session), `conversation_messages`
 * (request/response turns, `run_id` linking a message to its `runs` row —
 * same no-hard-FK convention as `eval_result.run_id`), and
 * `conversation_message_parts` (the structured content of a message, with an
 * explicit `position` int the dashboard sorts by — the in-memory
 * `ConversationStore` protocol has no such column, `conversation/store.ts`).
 * Purely additive, same downgrade caveat as v2/v3/v4: a v5 DB opened by a
 * pre-#S7 runtime throws below (its `TARGET_SCHEMA_VERSION` is still 4).
 * `seq` (not the public `id`) is the ordering key — an autoincrement int
 * mirrors `events.id`'s ordering role, kept separate from the public UUID
 * `id` TEXT column so it never leaks into the wire API.
 */
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  agent_name  TEXT NOT NULL,
  model       TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_agent   ON conversations(agent_name);

CREATE TABLE IF NOT EXISTS conversation_messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  kind            TEXT NOT NULL,
  run_id          TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_conv_messages_run  ON conversation_messages(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_message_parts (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  content    TEXT,
  metadata   TEXT NOT NULL DEFAULT '{}',
  position   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_parts_message ON conversation_message_parts(message_id, position);
`;

const TARGET_SCHEMA_VERSION = 5;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class EventStore {
  // protected (not private): RunStore extends EventStore literally — same
  // SQLite file, same handle — and prepares its own `runs` statements against
  // this._db in its constructor.
  protected readonly _db: Database;
  private readonly _appendStmt: Statement;
  private readonly _recentStmt: Statement;
  private readonly _traceEventsStmt: Statement;
  private readonly _sessionEventsStmt: Statement;
  private readonly _sessionListStmt: Statement;
  private readonly _deleteByDateStmt: Statement;
  private readonly _deleteByCapStmt: Statement;

  constructor(opts: EventStoreOptions) {
    this._db = new opts.Database(opts.path);
    // Driver-agnostic PRAGMAs: `.exec("PRAGMA …")` is supported by every SQLite
    // binding (better-sqlite3 AND bun:sqlite), whereas `.pragma()` is a
    // better-sqlite3-only method. Using `.exec` makes the injected-`Database`
    // seam (EventStoreOptions.Database) honestly driver-agnostic — a Bun
    // consumer can inject `bun:sqlite`'s Database with no native dep.
    this._db.exec("PRAGMA journal_mode = WAL");
    this._db.exec("PRAGMA synchronous = NORMAL");
    this._db.exec("PRAGMA foreign_keys = ON");

    this._migrate();

    this._appendStmt = this._db.prepare(`
      INSERT INTO events (
        type, timestamp, trace_id, run_id, span_id,
        cc_session_id, cc_hook_name, cc_cwd, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._recentStmt = this._db.prepare(`
      SELECT * FROM events
      WHERE (@since IS NULL OR timestamp >= @since)
        AND (@type  IS NULL OR type = @type)
      ORDER BY timestamp DESC
      LIMIT @limit
    `);

    this._traceEventsStmt = this._db.prepare(`
      SELECT * FROM events
      WHERE trace_id = ?
      ORDER BY timestamp ASC, id ASC
    `);

    this._sessionEventsStmt = this._db.prepare(`
      SELECT * FROM events
      WHERE cc_session_id = ?
      ORDER BY timestamp ASC, id ASC
    `);

    this._sessionListStmt = this._db.prepare(`
      SELECT
        cc_session_id    AS sessionId,
        MAX(cc_cwd)      AS cwd,
        MIN(timestamp)   AS firstSeen,
        MAX(timestamp)   AS lastSeen,
        COUNT(*)         AS eventCount
      FROM events
      WHERE type = 'claude_code.hook' AND cc_session_id IS NOT NULL
      GROUP BY cc_session_id
      ORDER BY lastSeen DESC
      LIMIT ?
    `);

    this._deleteByDateStmt = this._db.prepare(`
      DELETE FROM events WHERE timestamp < ?
    `);

    this._deleteByCapStmt = this._db.prepare(`
      DELETE FROM events
      WHERE id NOT IN (
        SELECT id FROM events ORDER BY id DESC LIMIT ?
      )
    `);

    if (opts.retentionDays !== undefined) {
      this.purgeOlderThanDays(opts.retentionDays);
    }
    if (opts.maxRows !== undefined) {
      this.purgeBeyondCap(opts.maxRows);
    }
  }

  /** Append one event. Synchronous; better-sqlite3 + WAL is fast enough. */
  append(event: BaseEvent): void {
    const data = event as unknown as Record<string, unknown>;
    const cc = extractClaudeCodeFields(event.type, data);

    this._appendStmt.run(
      event.type,
      timestampToIso(event.timestamp),
      event.traceId ?? null,
      event.runId ?? null,
      event.spanId ?? null,
      cc.sessionId,
      cc.hookName,
      cc.cwd,
      JSON.stringify(event, jsonReplacer),
    );
  }

  /**
   * Most recent events, optionally filtered.
   * Results are ordered DESC by timestamp (newest first).
   */
  recent(opts: { since?: Date; type?: string; limit?: number } = {}): PersistedEvent[] {
    const rows = this._recentStmt.all({
      since: opts.since ? opts.since.toISOString() : null,
      type: opts.type ?? null,
      limit: opts.limit ?? 1000,
    }) as RawRow[];
    return rows.map(rowToPersisted);
  }

  /** All events for one trace, ASC by timestamp — the full history of a single run. */
  eventsForTrace(traceId: string): PersistedEvent[] {
    const rows = this._traceEventsStmt.all(traceId) as RawRow[];
    return rows.map(rowToPersisted);
  }

  /** All events for one Claude Code session, ASC by timestamp. */
  sessionEvents(sessionId: string): PersistedEvent[] {
    const rows = this._sessionEventsStmt.all(sessionId) as RawRow[];
    return rows.map(rowToPersisted);
  }

  /** Recent CC sessions with per-session aggregate counts. */
  sessions(limit = 50): SessionSummary[] {
    const rows = this._sessionListStmt.all(limit) as {
      sessionId: string;
      cwd: string | null;
      firstSeen: string;
      lastSeen: string;
      eventCount: number;
    }[];
    return rows.map((r) => ({
      sessionId: r.sessionId,
      cwd: r.cwd,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      eventCount: r.eventCount,
    }));
  }

  /** Delete events older than N days from now. Returns rows removed. */
  purgeOlderThanDays(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const info = this._deleteByDateStmt.run(cutoff);
    return Number(info.changes);
  }

  /** Keep only the most recent `cap` rows. Returns rows removed. */
  purgeBeyondCap(cap: number): number {
    const info = this._deleteByCapStmt.run(cap);
    return Number(info.changes);
  }

  /** Total row count. Cheap (uses sqlite_stat). */
  count(): number {
    const row = this._db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    return row.n;
  }

  /** Close the underlying database handle. */
  close(): void {
    this._db.close();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _migrate(): void {
    // `PRAGMA user_version` read via prepare/get (portable across both drivers);
    // `.pragma("…", { simple: true })` is better-sqlite3-only. Both drivers
    // return a single `{ user_version: N }` row.
    const row = this._db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    let version = typeof row?.user_version === "number" ? row.user_version : 0;

    if (version < 1) {
      this._db.exec(SCHEMA_V1);
      version = 1;
    }

    if (version < 2) {
      this._db.exec(SCHEMA_V2);
      version = 2;
    }

    if (version < 3) {
      this._db.exec(SCHEMA_V3);
      version = 3;
    }

    if (version < 4) {
      this._db.exec(SCHEMA_V4);
      version = 4;
    }

    if (version < 5) {
      this._db.exec(SCHEMA_V5);
      version = 5;
    }

    if (version !== TARGET_SCHEMA_VERSION) {
      throw new Error(
        `event-store schema version mismatch: db is ${version}, expected ${TARGET_SCHEMA_VERSION}`,
      );
    }
    this._db.exec(`PRAGMA user_version = ${TARGET_SCHEMA_VERSION}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RawRow {
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

function rowToPersisted(r: RawRow): PersistedEvent {
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

function extractClaudeCodeFields(
  eventType: string,
  data: Record<string, unknown>,
): { sessionId: string | null; hookName: string | null; cwd: string | null } {
  if (eventType !== "claude_code.hook") {
    return { sessionId: null, hookName: null, cwd: null };
  }
  return {
    sessionId: str(data.sessionId) ?? str(readPayload(data)?.session_id) ?? null,
    hookName: str(data.hookName) ?? str(readPayload(data)?.hook_event_name) ?? null,
    cwd: str(data.cwd) ?? str(readPayload(data)?.cwd) ?? null,
  };
}

function readPayload(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const p = data.payload;
  return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function timestampToIso(t: Date | string | undefined | null): string {
  if (t instanceof Date) return t.toISOString();
  if (typeof t === "string") return t;
  return new Date().toISOString();
}

// JSON.stringify replacer that turns Date instances into ISO strings.
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
