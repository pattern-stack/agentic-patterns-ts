# Spec 419 — runtime: SqliteMemoryStore — FTS5 reference backend + loadMemoryStore()

**Issue:** #419 · **Branch:** `dugshub/memory-store/3-sqlite-fts5` · **Size:** M · **Package:** `@agentic-patterns/runtime` (+ root `package.json`, `.github/workflows/ci.yml`, one docs snippet fix)
**Depends on:** #418 (merged on this stack branch — `packages/agent-runtime/src/memory/` ships `MemoryStore`, `MemoryWriteInput{,Schema}`, `InMemoryMemoryStore`, `runMemoryStoreConformance`).
**Sources of record:** ADR-0007 Decisions 1 and 5 (`docs/adr/0007-memory-store.md`), plus D3/D4/D6 semantics already pinned by the conformance kit. ADR-0008 is context only — NO promotion ops, NO overlay.
**Precedent to mirror:** `packages/agent-runtime/src/storage/event-store.ts` (driver-agnostic `.exec`/`.prepare` mechanics, `PRAGMA user_version` ladder, `_migrate()` shape), `packages/agent-runtime/src/storage/conversation-store.ts` + its test (explicit `BEGIN`/`COMMIT` via `.exec`, bun shim-surface test), `packages/agent-runtime/src/storage/load.ts` (loader template + `wrapBunDatabase` named-param adapter), `packages/agent-cli/src/helpers/db.ts` (XDG default-path discipline).

## Objective

Ship the durable SQLite reference backend for memory: `SqliteMemoryStore` on its **own SQLite file** (never the `events.db` EventStore ladder file) with its **own** `PRAGMA user_version` ladder starting at 1, FTS5 external-content search over `content` + `tags` with bm25 relevance ordering for query searches and recency ordering for query-less listings. Plus `loadMemoryStore()` in `storage/load.ts` following the existing `load*` template, soft-degrading to `InMemoryMemoryStore` with a reason. The store must pass the exported conformance kit under BOTH drivers — better-sqlite3 (vitest) and bun:sqlite (a hermetic bun smoke script wired into `check` and CI) — through the driver contract: `.exec`/`.prepare` only, explicit `BEGIN`/`COMMIT`, bare-`@` named params (the bun adapter path in `load.ts` normalizes them).

## Scope (exact files)

| File | Action |
|---|---|
| `packages/agent-runtime/src/memory/sqlite-store.ts` | **Create** — `SqliteMemoryStore`, `SqliteMemoryStoreOptions`, `resolveMemoryDbPath()`, `MEMORY_TARGET_SCHEMA_VERSION` |
| `packages/agent-runtime/src/memory/index.ts` | **Edit** — add sqlite-store exports |
| `packages/agent-runtime/src/storage/load.ts` | **Edit** — add `loadMemoryStore()`, `LoadMemoryStoreOptions`, `LoadMemoryStoreResult` |
| `packages/agent-runtime/src/storage/index.ts` | **Edit** — export the three new names from `./load.js` |
| `packages/agent-runtime/src/memory/__tests__/sqlite-memory-store.conformance.test.ts` | **Create** — kit under better-sqlite3, twice (plain + shim-only surface) |
| `packages/agent-runtime/src/memory/__tests__/sqlite-memory-store.test.ts` | **Create** — migration ladder, persistence, FTS edge cases, loader |
| `packages/agent-runtime/scripts/smoke-memory-sqlite.ts` | **Create** — bun:sqlite driver smoke (hermetic, no network/model) |
| `package.json` (repo root) | **Edit** — `smoke:memory` script; append to `check` chain |
| `.github/workflows/ci.yml` | **Edit** — one step in the `check` job running the smoke |
| `docs/memory/guide.md` | **Edit** — fix the two Quickstart drift points (see § Docs fix) |

No other files. NO toolbox, NO recall assembler, NO events/SSE (later stack issues). Nothing in core. NO version bumps (release process handles them).

## API surface (exact TypeScript signatures)

### `memory/sqlite-store.ts`

Module header doc comment: cites ADR-0007 D1 + D5 with the relative link (`../../../../docs/adr/0007-memory-store.md`); states this is a **standalone ladder** — own file, own `user_version` starting at 1, never `TARGET_SCHEMA_VERSION`, never retention-pruned; states the driver contract (`.exec`/`.prepare` only — no `.pragma()`, no `.transaction()` — explicit `BEGIN`/`COMMIT`, bare-`@` named params so `load.ts`'s bun adapter works); points at `loadMemoryStore()` in `../storage/load.js` as the optional-dep entry.

```ts
import type DatabaseConstructor from "better-sqlite3";
import type { Database, Statement } from "better-sqlite3";
// value imports: node:fs (mkdirSync), node:os (homedir), node:path,
// @agentic-patterns/core (memoryRecord, MemorySearchQuerySchema, types),
// ./store.js (MemoryStore, MemoryWriteInput, MemoryWriteInputSchema)

/** `AP_MEMORY_DB_PATH` env override, else `XDG_STATE_HOME|~/.local/state` + `/ap/memory.db`.
 *  Deliberately NOT `events.db` — memory is a system of record, not telemetry (ADR-0007 D1). */
export function resolveMemoryDbPath(): string;

export interface SqliteMemoryStoreOptions {
  /**
   * Path to the memory SQLite file. Defaults to {@link resolveMemoryDbPath}.
   * `:memory:` is supported for tests. Parent directories are created
   * (best-effort) automatically. MUST NOT be the EventStore ladder file.
   */
  readonly path?: string;
  /** Injected SQLite Database constructor — better-sqlite3, or load.ts's wrapped bun:sqlite. */
  readonly Database: typeof DatabaseConstructor;
}

/** The memory ladder's own target version — independent of storage/event-store.ts. */
export const MEMORY_TARGET_SCHEMA_VERSION = 1;

export class SqliteMemoryStore implements MemoryStore {
  constructor(opts: SqliteMemoryStoreOptions);
  write(inputs: MemoryWriteInput[]): Promise<MemoryRecord[]>;
  search(query: MemorySearchQueryInput): Promise<MemoryHit[]>;
  get(id: string): Promise<MemoryRecord | null>;
  invalidate(id: string, reason?: string): Promise<void>;
  delete(id: string): Promise<void>;
  capabilities(): Promise<MemoryStoreCapabilities>; // resolves { search: "keyword" }
  /** Close the underlying database handle. */
  close(): void;
}
```

Method doc comments: copy the contract language from the `MemoryStore` interface in `store.ts` by reference (`@inheritDoc`-style one-liners are fine); do not fork the semantics prose.

### `storage/load.ts` additions (bottom of file, after `loadConversationStore`)

```ts
export interface LoadMemoryStoreOptions {
  /** Memory DB file; defaults to `resolveMemoryDbPath()`. NEVER the events.db ladder file. */
  readonly path?: string;
}

/** Result of {@link loadMemoryStore}: ALWAYS-usable store + diagnostic info. */
export interface LoadMemoryStoreResult {
  /** SqliteMemoryStore when a driver resolved; InMemoryMemoryStore fallback otherwise (soft-degrade, issue pin). */
  store: MemoryStore;
  /** True when the store is the in-memory fallback (no driver, or init failed). */
  unavailable: boolean;
  /** Human-readable reason; surfaced in CLI banners. */
  reason: string;
}

export async function loadMemoryStore(
  opts: LoadMemoryStoreOptions = {},
): Promise<LoadMemoryStoreResult>;
```

Behavior — mirror the `loadConversationStore` template exactly, with two deltas:

1. Reuses the existing `resolveDatabase()` (driver pick + bun named-param adapter — do not duplicate it).
2. On ANY failure path (driver unresolvable OR `new SqliteMemoryStore(...)` throws), return `{ store: new InMemoryMemoryStore(), unavailable: true, reason }` — the store field is never absent. Success: `{ store, unavailable: false, reason: `connected to ${path} via ${driver}` }` where `path` is the resolved path (explicit or default).

Imports: `InMemoryMemoryStore` and `MemoryStore` may be statically imported from `../memory/store.js` (no optional dep there); `SqliteMemoryStore` + `resolveMemoryDbPath` via `await import("../memory/sqlite-store.js")` (template convention — keeps the better-sqlite3 type dep off the static graph). No import cycle: `memory/` does not import `storage/`.

### Barrel edits

- `memory/index.ts`: `export { MEMORY_TARGET_SCHEMA_VERSION, resolveMemoryDbPath, SqliteMemoryStore } from "./sqlite-store.js";` and `export type { SqliteMemoryStoreOptions } from "./sqlite-store.js";`
- `storage/index.ts`: add `loadMemoryStore` to the existing `export { ... } from "./load.js"` value list; add `LoadMemoryStoreOptions`, `LoadMemoryStoreResult` to the type list.

## Implementation strategy

### Schema v1 (one `const MEMORY_SCHEMA_V1` template string)

```sql
CREATE TABLE IF NOT EXISTS memory_records (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,  -- FTS content_rowid + tie-break; never leaves the store
  id            TEXT NOT NULL UNIQUE,               -- public UUID (conversation_messages precedent)
  scope         TEXT NOT NULL,                      -- canonical sorted-key JSON object (ADR-0007 D3)
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT,                               -- JSON array | NULL = absent
  provenance    TEXT,                               -- JSON | NULL
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  invalid_at    TEXT,
  superseded_by TEXT,
  expires_at    TEXT,
  target        TEXT,                               -- JSON | NULL (stored untouched, ADR-0007 D7)
  payload       TEXT,                               -- JSON | NULL
  supports      TEXT                                -- JSON | NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_records_created ON memory_records(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_records_kind    ON memory_records(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content, tags,
  content='memory_records', content_rowid='seq'
);

CREATE TRIGGER IF NOT EXISTS memory_records_ai AFTER INSERT ON memory_records BEGIN
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.seq, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memory_records_ad AFTER DELETE ON memory_records BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.seq, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memory_records_au AFTER UPDATE ON memory_records BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.seq, old.content, old.tags);
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.seq, new.content, new.tags);
END;
```

Notes: external-content FTS5 + triggers is the standard sync pattern and keeps every write path (insert / supersede-update / delete) indexed with zero imperative bookkeeping — the update trigger is belt-and-braces (v1 updates never touch `content`/`tags`, only invalidation columns). `tags` is indexed as its JSON text; the default unicode61 tokenizer treats `[`,`"`,`,` as separators, so `["ui","prefs"]` tokenizes to `ui`, `prefs` — same tokens as the in-memory haystack join. Both bundled SQLites (better-sqlite3 and bun:sqlite) ship FTS5 + JSON1; the bun smoke proves it at CI.

### Constructor

1. Resolve `path = opts.path ?? resolveMemoryDbPath()`; if `path !== ":memory:"`, best-effort `mkdirSync(dirname(path), { recursive: true })` in a try/catch (cli `ensureParentDir` precedent — let the driver surface the real open error).
2. `new opts.Database(path)`; PRAGMAs via `.exec` only (event-store comment applies verbatim): `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`.
3. `this._migrate()` — read `PRAGMA user_version` via `prepare(...).get()` (portable across both drivers — event-store `_migrate` precedent, copy its comment); `if (version < 1) { exec(MEMORY_SCHEMA_V1); version = 1; }`; `if (version !== MEMORY_TARGET_SCHEMA_VERSION) throw new Error(\`memory-store schema version mismatch: db is ${version}, expected ${MEMORY_TARGET_SCHEMA_VERSION}\`)`; `exec(\`PRAGMA user_version = ${MEMORY_TARGET_SCHEMA_VERSION}\`)`.
4. Prepare all statements up front (event-store style), all named params bare-`@` (`@id`, `@now`, …) so the bun adapter path works. The dynamic-shape statements (search) may be prepared lazily/cached if needed, but the fixed set below must be prepared in the constructor: insert, get-by-id, supersede-update, invalidate-update, delete, plus the two search statements (both have fully static SQL — see below).

### write(inputs) — all-or-nothing, one `now` per batch

Phase 1 (validation, NO db writes — mirrors `InMemoryMemoryStore.write` phase 1):
- `const now = new Date().toISOString()` once.
- For each input: `MemoryWriteInputSchema.parse`, then build the frozen record via core's `memoryRecord({ id: generateId(), ...parsed fields via conditional spreads..., createdAt: now, updatedAt: now })`. Reuse the `generateId()` helper pattern from `memory/store.ts` (local copy is fine, or export it from `store.ts` — implementer's call; do not import from `conversation/store.ts`).
- Serialize each JSON column now (`scope` from the record — already canonical sorted-key, `tags`, `provenance`, `target`, `payload`, `supports`; `undefined` → `null` bind). If `payload !== undefined` and `JSON.stringify(payload)` returns `undefined` or throws (function/symbol/cyclic), throw `new Error("memory payload must be JSON-serializable for the SQLite backend")` — before any mutation.

Phase 2 (transaction — explicit, `.exec` only, conversation-store `addMessage` precedent):
```ts
this._db.exec("BEGIN");
try {
  // (a) resolve ALL supersedes ids against PRE-BATCH state first:
  //     SELECT via _getStmt; unknown id → throw `Memory record not found: ${id}`.
  //     (Checking before any insert matches the in-memory store: a record
  //     cannot supersede a sibling created in the same batch.)
  // (b) insert every staged row (insert trigger indexes FTS);
  // (c) for each staged supersedes: UPDATE memory_records
  //       SET invalid_at = COALESCE(invalid_at, @now), superseded_by = @newId, updated_at = @now
  //       WHERE id = @oldId
  //     (already-invalidated old record keeps its original invalidAt — in-memory parity);
  this._db.exec("COMMIT");
} catch (err) {
  try { this._db.exec("ROLLBACK"); } catch { /* already rolled back */ }
  throw err;
}
```
Return the phase-1 frozen records in input order.

### search(query) — parse defaults first, two prepared statements

`const q = MemorySearchQuerySchema.parse(query);` (kit relies on the defaults: `limit` 10, `includeInvalidated` false). `const now = new Date().toISOString();`

Shared filter fragment, fully parameterized — **no string interpolation of user data anywhere** (this is the LIKE-safe/json_each decision the issue leaves to the implementer; take the json_each strategy — it is injection-proof for scope keys containing `.`/`"`/unicode and needs no LIKE escaping):

```sql
AND NOT EXISTS (
  SELECT 1 FROM json_each(@scope) fk
  WHERE NOT EXISTS (
    SELECT 1 FROM json_each(m.scope) sk WHERE sk.key = fk.key AND sk.value = fk.value
  )
)                                                                   -- subset-match (D3); @scope = {} matches all
AND (@kinds IS NULL OR m.kind IN (SELECT value FROM json_each(@kinds)))
AND (@tags IS NULL OR NOT EXISTS (
  SELECT 1 FROM json_each(@tags) tk
  WHERE NOT EXISTS (SELECT 1 FROM json_each(COALESCE(m.tags, '[]')) mt WHERE mt.value = tk.value)
))                                                                  -- record must carry EVERY queried tag
AND (@includeInvalidated = 1 OR m.invalid_at IS NULL)
AND (m.expires_at IS NULL OR m.expires_at > @now)                   -- unconditional expiry exclusion
```

Binds: `@scope = JSON.stringify(q.scope)`, `@kinds = q.kinds ? JSON.stringify(q.kinds) : null`, `@tags = q.tags ? JSON.stringify(q.tags) : null`, `@includeInvalidated = q.includeInvalidated ? 1 : 0` (bind ints, never booleans — better-sqlite3 rejects booleans), `@now`, `@limit = q.limit`.

**Query-less listing** (`q.query === undefined`):
```sql
SELECT m.* FROM memory_records m WHERE 1 = 1 <filters>
ORDER BY m.created_at DESC, m.seq DESC
LIMIT @limit
```
Hits are `{ record }` — no score (in-memory parity). `LIMIT 0` naturally returns `[]` — zero means zero.

**FTS query** (`q.query` present):
- Tokenize exactly like the in-memory store: `q.query.toLowerCase().split(/\s+/).filter(Boolean)`. If the token list is empty (whitespace-only query), return `[]` without touching the db (in-memory parity: zero tokens ⇒ zero score ⇒ no hits).
- Build the MATCH string as OR-joined quoted tokens with internal double quotes doubled: `tokens.map((t) => \`"${t.replaceAll('"', '""')}"\`).join(" OR ")`. OR (not FTS5's implicit AND) is required for kit parity: `"alpha beta"` must return the record containing only `alpha`, ranked below the record containing both. Quoting makes FTS5 operators/punctuation in user text (`NEAR`, `-`, `(`, unbalanced `"`) inert — a query string must never be able to raise an FTS syntax error.
```sql
SELECT m.*, bm25(memory_fts) AS bm25_rank
FROM memory_fts JOIN memory_records m ON m.seq = memory_fts.rowid
WHERE memory_fts MATCH @match <filters>
ORDER BY bm25_rank ASC, m.created_at DESC, m.seq DESC
LIMIT @limit
```
bm25 is smaller-is-better; ASC puts the best first, and a record matching more of the OR'd terms always outranks a subset match (per-term score sums), satisfying the kit's ordering test. Expose `score: -row.bm25_rank` on each hit (higher-is-better, advisory only — the kit never asserts values, only `typeof`).

Ordering-tie note (unpinned by the kit, document in code): same-`created_at` ties resolve by `seq DESC` here vs. insertion order in the in-memory store — the kit `tick()`s around every ordering assertion, so this divergence is outside the contract.

### get / invalidate / delete

- `get(id)`: `SELECT * FROM memory_records WHERE id = @id` → `null` or `rowToRecord(row)`.
- `invalidate(id, _reason)`: `BEGIN`; select the row; missing → `ROLLBACK` + throw `Memory record not found: ${id}` (message parity with in-memory); `invalid_at` already set → `COMMIT`/no-op (updatedAt untouched — the kit pins this); else `UPDATE memory_records SET invalid_at = @now, updated_at = @now WHERE id = @id`; `COMMIT`. `reason` accepted, unrecorded in v1 (events issue) — same doc note as the protocol.
- `delete(id)`: single `DELETE FROM memory_records WHERE id = @id` (delete trigger scrubs FTS). Idempotent — unknown id resolves silently.

### `rowToRecord(row)` (private helper)

`JSON.parse` the non-null JSON columns; rebuild with **conditional spreads** for every optional field (`exactOptionalPropertyTypes` discipline — `null` column ⇒ key absent, never `undefined`-valued); return `memoryRecord({...})` so every read path re-validates + deep-freezes (round-trip equality with the frozen write-side records is what the kit's `toEqual` checks). Type the raw row as a local `RawRow` interface (event-store precedent).

### `resolveMemoryDbPath()`

Copy the `resolveDbPath()` discipline from `packages/agent-cli/src/helpers/db.ts`, with `AP_MEMORY_DB_PATH` as the env override and `memory.db` as the filename: env override, else `XDG_STATE_HOME ?? ~/.local/state` + `/ap/memory.db`. Lives in `sqlite-store.ts` (beside its consumer; the loader reaches it through the same dynamic import).

### Bun smoke — `packages/agent-runtime/scripts/smoke-memory-sqlite.ts`

Hermetic (no network, no model, no env creds — unlike `smoke-coordinator.ts`). Header comment: what it proves (the FTS5 + JSON1 + multi-statement `.exec` + named-param-adapter path under the REAL `bun:sqlite` driver, which vitest cannot reach because vitest runs under Node) and how to run it (`bun packages/agent-runtime/scripts/smoke-memory-sqlite.ts`).

- Guard: if `typeof process.versions.bun !== "string"`, print "must run under bun" and `process.exit(1)`.
- `mkdtemp` a dir; `const { store, unavailable, reason } = await loadMemoryStore({ path: join(dir, "memory.db") })` imported from `../src/storage/load.js` (source import, like the other smoke scripts); assert `unavailable === false` and `reason.includes("bun:sqlite")`.
- Exercise, with a tiny local `assert(cond, msg)` that throws: batch write (2 records, tags + two-key scope) → FTS search `"alpha beta"` ordering (both hits, richer match first) → subset-scope filter → supersede write (old record invalidated, `supersededBy` linked, excluded by default, present with `includeInvalidated`) → standalone `invalidate` idempotency → `get` round-trip → `limit: 0` ⇒ `[]` → `delete` then FTS query finds nothing → `close()`.
- Reopen the same file via a second `loadMemoryStore` and assert the surviving records are still there (durability + ladder reopen under bun).
- `rmSync(dir, { recursive: true, force: true })`; print a one-line PASS summary; any thrown assert fails the process.

### Wiring the smoke into the gate (ci.yml comment precedent: unwired checks rot)

- Root `package.json`: add `"smoke:memory": "bun packages/agent-runtime/scripts/smoke-memory-sqlite.ts"` and append `&& bun run smoke:memory` to the `check` script.
- `.github/workflows/ci.yml`, `check` job, after the "Model-facing schema lint" step:
  ```yaml
  # bun:sqlite cannot be exercised by vitest (Node) — this proves the
  # SqliteMemoryStore driver contract on the real bun driver (#419).
  - name: Bun-driver memory smoke (bun:sqlite)
    run: bun run smoke:memory
  ```

### Docs fix — `docs/memory/guide.md` Quickstart (§ "1. Wire a store")

Two drift points vs. the real API; fix minimally, prose untouched:
1. Replace the `(await loadMemoryStore({...})) ?? new InMemoryMemoryStore()` snippet with the real result-object shape: `const { store, unavailable, reason } = await loadMemoryStore({ path: "./data/memory.sqlite" });` (note in the snippet comment that `store` is already the in-memory fallback when `unavailable`).
2. In the protocol snippet + the `store.capabilities()` comment line, make `capabilities()` return `Promise<MemoryStoreCapabilities>` / `await store.capabilities()` (the shipped protocol is async).

## Test plan

### `sqlite-memory-store.conformance.test.ts`

```ts
import Database from "better-sqlite3";
import { runMemoryStoreConformance } from "../conformance.js";
import { SqliteMemoryStore } from "../sqlite-store.js";

await runMemoryStoreConformance(() => new SqliteMemoryStore({ path: ":memory:", Database }));
await runMemoryStoreConformance(() => new SqliteMemoryStore({ path: ":memory:", Database: shimOnlyDatabase() }));
```
The second run drives the FULL kit through a shim-only `Database` (copy the `shimOnlyDatabase()` Proxy from `conversation-store.test.ts`: exposes ONLY `prepare`/`exec`/`close`, throws `TypeError` on any other member) — mechanical proof that the store never touches `.pragma()`/`.transaction()`/any better-sqlite3-only API. Wrap each run's registration so the two suites get distinct describe labels if the kit's fixed label collides (nesting each `await runMemoryStoreConformance(...)` call is done at module top level; vitest tolerates duplicate describe names — verify, else split into two files).

### `sqlite-memory-store.test.ts` (better-sqlite3, house style)

- **Migration ladder (issue acceptance, house style — hand-build v-prior DB, reopen, assert survival):**
  - *Hand-built v1 file:* `mkdtemp` + raw `better-sqlite3`; execute the v1 DDL by hand (table + FTS + triggers, literal SQL in the test like `conversation-store.test.ts` does — not by importing `MEMORY_SCHEMA_V1`), insert one row through raw SQL (after trigger creation so FTS indexes it), `raw.pragma("user_version = 1")`, close. Reopen via `new SqliteMemoryStore({ path, Database })`: no throw, `get(id)` returns the row, FTS `search({ scope: {}, query: ... })` finds it, `user_version` still 1.
  - *Fresh-file boot:* new store on a fresh tmp path lands at `user_version = 1` directly; write → close → reopen → `get` + FTS search survive (durability).
  - *Future version:* raw file with `user_version = 99` → constructor throws `/memory-store schema version mismatch/`.
  - *Own file, not the ladder:* open an `EventStore` and a `SqliteMemoryStore` on two files in the same tmp dir; assert the memory file's `user_version` is 1 while events is 5 — and that a `SqliteMemoryStore` pointed at a hand-built v1 *memory* file never creates `events`/`runs` tables (`sqlite_master` check).
- **FTS edges beyond the kit:**
  - Operator/punctuation queries never throw and behave as tokens: `search({ scope: {}, query: 'alpha AND -x "unbalanced' })` resolves (no FTS syntax error).
  - Whitespace-only query (`" "`) returns `[]` (in-memory parity).
  - Tag tokens are searchable: record with `tags: ["prefs"]`, content without the word → query `"prefs"` hits it.
  - Delete scrubs the index: write, `delete`, FTS query for its content → `[]`.
  - Supersede leaves FTS consistent: superseded record still findable with `includeInvalidated: true` via FTS query.
- **Scope safety:** scope keys/values containing `.` `"` `%` `_` and unicode round-trip and subset-match correctly (proves the json_each strategy is injection/escape-proof — the "conformance-proven" bar the issue sets for the portability strategy).
- **Payload guard:** `write` with a cyclic payload rejects and stores nothing (`search({scope:{}, includeInvalidated:true})` empty).
- **`resolveMemoryDbPath`:** env override wins; default ends with `/ap/memory.db`; is never `events.db` (stub `process.env` per test, restore after).
- **`loadMemoryStore`:** under vitest/Node with better-sqlite3 installed → `unavailable: false`, `store instanceof SqliteMemoryStore`, reason mentions better-sqlite3; write/search round-trip through the loaded store on a tmp file. (The degrade path's driver-missing branch is exercised by existing `load.ts` behavior; add one test that a constructor throw (e.g. path pointing at a *directory*) yields `unavailable: true` + `store instanceof InMemoryMemoryStore` + a reason.)

### Bun smoke

Covered above; it IS the second-driver conformance evidence (vitest runs Node/better-sqlite3; `bun run smoke:memory` runs the real bun:sqlite + named-param adapter). Runs in `bun run check` and CI.

## Acceptance

1. `bun run check` green (now includes the bun smoke) — build, dist-contract, typecheck, lint, all vitest suites, schema lint, `smoke:memory`.
2. Conformance kit passes against `SqliteMemoryStore` under better-sqlite3 **twice** (plain + shim-only surface) with zero kit modifications.
3. `bun run smoke:memory` passes under Bun (bun:sqlite driver, FTS5 + json_each + explicit BEGIN/COMMIT + named-param adapter all exercised, durability across reopen).
4. Migration-ladder tests in the house style pass: hand-built v1 reopens with data surviving; fresh boot lands v1; future version throws mismatch.
5. Memory data lives in its own file with its own `user_version` ladder — never `events.db`, no `TARGET_SCHEMA_VERSION` involvement, no retention/pruning code paths.
6. `loadMemoryStore()` exported from the runtime barrel; failure paths return a usable `InMemoryMemoryStore` with a reason (never throws, never returns an absent store).
7. `docs/memory/guide.md` Quickstart matches the shipped signatures.
8. No `git add -A`/`.` — stage the ten files listed in Scope explicitly. Commit lands via PR on branch `dugshub/memory-store/3-sqlite-fts5` (stacked on #418).

## Out of scope

- `MemoryToolbox`, recall assembler, `RenderContext.recall` / `Awareness.fromRecall` (later stack issues).
- `agent.memory.*` event types, SSE formatter edits, dashboard union (later stack issue) — `invalidate`'s `reason` stays unrecorded.
- ADR-0008 anything: promotion ops, overlay, promotion rows, capability extensions beyond `{ search: "keyword" }`.
- Postgres backend (codegen-patterns), semantic/vector search, embeddings.
- Expiry sweeping (`expiresAt` is filtered on read only), retention, pruning.
- CLI wiring (`ap` commands / playground banners for memory), server routes.
- Changes to `memory/store.ts`, `memory/conformance.ts`, or the core molecules (if `generateId` is shared, an `export` line in `store.ts` is the only permitted touch).
- Version bumps / CHANGELOG (release flow owns them).
