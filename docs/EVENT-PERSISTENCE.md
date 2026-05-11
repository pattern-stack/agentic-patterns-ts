# Event Persistence

The `ap playground` server persists every UX-profile event (including all `claude_code.hook` frames) to a local SQLite database so the dashboard can render history on cold start instead of starting empty after every restart.

## Architecture

```
                  ┌─────────────────────┐
hook POST ──→ bus ┼─→ SSEExporter ─────→ /admin/events/stream (live)
                  ├─→ InMemoryCollector → aggregates + ring buffer
                  └─→ SQLiteExporter ──→ events.db (durable)
                                        ↑
                       /admin/events/recent
                       /admin/claude-code/sessions
                       /admin/claude-code/sessions/:id
                                        ↑
                                   dashboard hydrates on load,
                                   then layers live SSE on top
```

Three sinks attached to one bus. Events flow through exactly once. The dashboard's "first paint" comes from REST queries against the SQLite store; everything after that is live SSE.

## What's persisted

Every event on the `UX` event profile:

- All `agent.*` lifecycle events (`message.start/complete`, `tool.start/end`, `iteration.*`, `llm.*`, `error`, …)
- All `claude_code.hook` events emitted by the plugin shim

`DEBUG`-only flows and high-cardinality streaming chunks (e.g. `agent.message.chunk`) are not on the UX profile and are not persisted.

## Schema

Single `events` table with denormalized hot columns for Claude Code grouping queries (the dashboard's most common access pattern). Everything else lives in the JSON `data` column.

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,        -- ISO 8601
  trace_id TEXT,
  run_id TEXT,
  span_id TEXT,
  cc_session_id TEXT,             -- = data.session_id for claude_code.hook
  cc_hook_name TEXT,
  cc_cwd TEXT,
  data TEXT NOT NULL              -- full event payload as JSON
);
```

Schema version is tracked via `PRAGMA user_version` for future migrations.

## File location

Default: `~/.local/state/ap/events.db` (XDG-compliant).

Override via env:

| Env var | Effect | Default |
|---|---|---|
| `AP_DB_PATH` | Absolute path to the database file | `${XDG_STATE_HOME:-~/.local/state}/ap/events.db` |
| `AP_PERSISTENCE` | Set to `0` to disable durability entirely | (enabled) |
| `AP_RETENTION_DAYS` | Rows older than this are removed on boot | `30` |
| `AP_MAX_ROWS` | Row cap; oldest beyond cap are removed on boot | `1,000,000` |

## Optional dep

`better-sqlite3` is an **optional peer dependency** of `@agentic-patterns/runtime`. The CLI (`@agentic-patterns/cli`) declares it as a regular dep so `ap playground` users get persistence by default. Library consumers who only use the in-memory bus pay nothing.

If `better-sqlite3` can't load (missing, native binary mismatch, etc.), the playground falls back to memory-only mode and prints a banner like:

```
  storage    memory-only — better-sqlite3 not installed (Cannot find module 'better-sqlite3')
```

## REST endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/admin/events/recent?since=ISO&limit=N&type=...` | Newest-first array of events |
| GET | `/admin/claude-code/sessions?limit=N` | Per-session aggregates (newest first) |
| GET | `/admin/claude-code/sessions/:sessionId` | All events for one session, oldest first |

When persistence isn't configured, each returns `503` with a hint.

## Failure modes

| Scenario | Behavior |
|---|---|
| DB file unwritable | EventStore init throws; CLI banner shows `memory-only` |
| Per-write failure (disk full, locked) | Caught by `SQLiteExporter`, logged to stderr, bus continues |
| Schema mismatch on open | EventStore throws with the actual version in the message |
| Disable for a test run | `AP_PERSISTENCE=0 ap playground` |
