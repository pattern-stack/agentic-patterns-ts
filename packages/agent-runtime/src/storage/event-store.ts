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

const TARGET_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class EventStore {
  private readonly _db: Database;
  private readonly _appendStmt: Statement;
  private readonly _recentStmt: Statement;
  private readonly _sessionEventsStmt: Statement;
  private readonly _sessionListStmt: Statement;
  private readonly _deleteByDateStmt: Statement;
  private readonly _deleteByCapStmt: Statement;

  constructor(opts: EventStoreOptions) {
    this._db = new opts.Database(opts.path);
    this._db.pragma("journal_mode = WAL");
    this._db.pragma("synchronous = NORMAL");
    this._db.pragma("foreign_keys = ON");

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
    const row = this._db.pragma("user_version", { simple: true }) as number;
    let version = typeof row === "number" ? row : 0;

    if (version < 1) {
      this._db.exec(SCHEMA_V1);
      version = 1;
    }

    // future: if (version < 2) { ... apply v2 migration ... ; version = 2; }

    if (version !== TARGET_SCHEMA_VERSION) {
      throw new Error(
        `event-store schema version mismatch: db is ${version}, expected ${TARGET_SCHEMA_VERSION}`,
      );
    }
    this._db.pragma(`user_version = ${TARGET_SCHEMA_VERSION}`);
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
