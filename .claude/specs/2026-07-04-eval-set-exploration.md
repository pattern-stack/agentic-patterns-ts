# Spec — Eval set exploration & editing in the dashboard

**Date:** 2026-07-04
**Branch:** `claude/prime-vesu5h`
**Slug:** `eval-set-exploration`

## Goal

Make eval **sets** and **cases** first-class, browsable, editable objects in the dashboard,
with **split (train/dev/test/untagged)** as a primary navigation axis, and bidirectional
links across sets ↔ cases ↔ runs.

The eval data model, store queries, and read routes for sets/cases already exist
(`EvalStore.listEvalSets`/`listEvalCases`, `GET /eval/sets`, `GET /eval/sets/:id/cases`).
Missing: (1) a store delete + a per-case cross-run history query, (2) server write routes +
a case-detail read route, (3) the entire dashboard navigation/editing surface.

Scope (locked at gates): **full feature**, **inline editing via modal dialogs**,
**dedicated case-detail page** with cross-run history.

---

## Work items & order

```
WI-1 (store)  ──▶ WI-2 (server) ──▶ WI-4 (case page)
                              └────▶ WI-5 (editing)
WI-3 (sets/set pages) ────────┴────▶ (WI-4, WI-5 depend on WI-3 routing)
```

WI-1 → WI-2 sequential. WI-3 parallel (uses existing GETs). WI-4/WI-5 after WI-2+WI-3.

---

## WI-1 — Store: case delete + cross-run case history

**File:** `packages/agent-runtime/src/storage/eval-store.ts` (+ test).

### New type
```ts
/** One run that evaluated a given (setId, caseId) — result annotation joined
 *  to the eval_run metadata and the runs-table execution fields. Newest first. */
export interface EvalCaseHistoryRow {
  readonly evalRunId: string;
  readonly tsStart: string;
  readonly targetId: string | null;
  readonly variant: string | null;
  readonly split: EvalSplit | null;   // the RUN's split label
  readonly model: string | null;
  readonly runStatus: "running" | "ok" | "error";
  readonly pass: boolean | null;
  readonly scores: readonly EvalScoreLike[] | null;
  readonly finalAnswer: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly elapsedMs: number | null;
}
```

### New prepared statements + methods
- `deleteEvalCase(setId, caseId): boolean` — `DELETE FROM eval_case WHERE set_id=? AND case_id=?`;
  return `this._db.changes > 0` (via `stmt.run().changes > 0`) so the caller can 404.
- `caseResultHistory(setId, caseId): EvalCaseHistoryRow[]`
  ```sql
  SELECT ev.id AS evalRunId, ev.ts_start AS tsStart, ev.target_id AS targetId,
         ev.variant, ev.split, ev.model, ev.status AS runStatus,
         er.pass, er.scores_json AS scoresJson,
         r.final_answer AS finalAnswer, r.input_tokens AS inputTokens,
         r.output_tokens AS outputTokens, r.elapsed_ms AS elapsedMs
  FROM eval_result er
  JOIN eval_run ev ON er.eval_run_id = ev.id
  LEFT JOIN runs r ON er.run_id = r.run_id
  WHERE ev.set_id = @setId AND er.case_id = @caseId
  ORDER BY ev.ts_start DESC
  ```
  Map with a `rowToCaseHistoryRow` (parse `scoresJson` like `rowToJoinedEvalResultRow`).

### Tests (`storage/__tests__/eval-store.test.ts`)
- `deleteEvalCase` removes the row, returns `true`; missing → `false`; other cases untouched.
- `caseResultHistory` returns rows across ≥2 runs newest-first; joins run fields;
  empty for an unknown case; scoped to `(setId, caseId)` (not another set's same caseId).

### Barrel
Export `EvalCaseHistoryRow` from `storage/index.ts` and the runtime root `index.ts`
alongside the existing eval-store exports.

---

## WI-2 — Server: write routes + case-detail read

**File:** `packages/agent-server/src/routes/eval.ts` (+ test `__tests__/eval.test.ts`).

All routes: `if (!evalStore) return notConfigured(c)` first (existing helper). Reuse
`parseSplit`, `isStringArray`, `storedCaseToEvalCase`.

### `POST /eval/sets` — create/upsert a set
Body `{ id, name?, description? }`. `id` required non-empty (400 otherwise).
`evalStore.upsertEvalSet({ id, name, description })`. Return `201 { set: <summary> }`
(re-read via `listEvalSets().find`) — idempotent upsert, 200 if it already existed.
Distinguish created vs updated by checking existence before upsert.

### `PATCH /eval/sets/:id` — edit metadata
404 if set unknown. Body `{ name?, description? }`. Upsert with merged values
(read current summary, overlay provided keys). Return `200 { set }`.

### `PUT /eval/sets/:id/cases/:caseId` — create/edit a case
404 if set unknown. Body `{ input, expected?, tags?, split? }`.
- `input` required (any JSON; 400 if key absent).
- validate `tags` (string[] via `isStringArray`), `split` (via `parseSplit`).
- `created = !listEvalCases(setId).some(r => r.caseId === caseId)`.
- `evalStore.upsertEvalCase(setId, { caseId, input, expected, tags, split })`.
- Return `201` (created) / `200` (updated) `{ case: <EvalCaseRow> }`.

### `DELETE /eval/sets/:id/cases/:caseId`
404 if set unknown OR `deleteEvalCase` returns false. Else `200 { deleted: true, caseId }`.

### `GET /eval/sets/:id/cases/:caseId` — case + cross-run history
404 if set unknown. Find the case in `listEvalCases(setId)`; 404 if absent.
`history = evalStore.caseResultHistory(setId, caseId)`.
Return `200 { case: <EvalCaseRow>, history: EvalCaseHistoryRow[] }`.

> Note the existing `GET /eval/sets/:id/cases` currently 404s a *known-but-empty*
> set only when `cases.length === 0 && !known`. The new case-detail route must
> resolve set existence via `listEvalSets()` (not case count), so an empty set
> still 404s the *case*, not the set.

### Tests
Per route: happy path (201/200), 404 (unknown set / unknown case), 400 (missing
`id`/`input`, bad `tags`/`split`), 503 (no store). Delete-then-GET returns 404.
Round-trip: PUT a case → GET case-detail returns it → run history reflects prior runs.

---

## WI-3 — Dashboard: Sets list + Set detail (read nav)

**Files:**
- `packages/agent-dashboard/src/api/types.ts` — add `EvalCaseHistoryRow`,
  `EvalCaseDetailResponse { case: EvalCaseRow; history: EvalCaseHistoryRow[] }`.
- `packages/agent-dashboard/src/lib/evalApi.ts` — `fetchEvalSet(id)` (derive from
  `fetchEvalSets` + find, or add a filtered helper), plus reuse `fetchEvalRuns`
  (already supports set filter server-side? No — client filters via `filterRuns`).
  Actually reuse `fetchEvalRuns({limit})` then `filterRuns(runs,{set:id})` — same
  idiom as `EvalRunsPage`. `fetchEvalCases(id)` already exists.
- `packages/agent-dashboard/src/pages/eval/EvalSetsPage.tsx` — `/eval/sets`.
- `packages/agent-dashboard/src/pages/eval/EvalSetDetailPage.tsx` — `/eval/sets/:id`.
- `packages/agent-dashboard/src/App.tsx` — 2 routes.
- `packages/agent-dashboard/src/components/templates/AppShell.tsx` — nav "Sets".

### `EvalSetsPage`
Mount fetch `fetchEvalSets()`. States: loading / unconfigured / error / ok.
`DataTable<EvalSetSummary>` columns: id (mono, → `/eval/sets/:id`), name, cases,
per-split badge row (train/dev/test/untagged counts from `splitCounts`, `""`→untagged),
created (relative). Empty state: "No eval sets yet — run `ap eval` or capture from a
session." Header action: **New set** button → opens `SetEditModal` (WI-5; render a
stub no-op button in WI-3, wire in WI-5).

Split-count badge helper (page-local, pages never share code — playground-redesign.md):
```ts
const SPLIT_ORDER = ["train","dev","test",""] as const;  // "" renders as "untagged"
```

### `EvalSetDetailPage`
`useParams id`. Sequential: `fetchEvalSets()`→find summary (404 card if absent);
`fetchEvalCases(id)`; `fetchEvalRuns({limit:200})`→`filterRuns({set:id})`.
Layout:
1. Back link `← Eval sets`; `<h1>` set name/id; badges (cases, created, per-split counts).
2. Set-scoped **SplitAggregatesPanel** (reuse existing component with `filters={{set:id}}`).
3. **Cases grouped by split** — one section per `SPLIT_ORDER` bucket that has cases;
   section header `train (n)` etc.; **test** section gets a `Badge tone="amber"` "held-out".
   Each case row (`DataTable` or simple list): caseId (mono, → `/eval/sets/:id/cases/:caseId`),
   input preview (truncated JSON), tags chips, expected preview. Row actions **Edit/Delete**
   (WI-5; omit in WI-3, add in WI-5).
4. **Runs that targeted this set** panel — reuse the runs `DataTable` column shape
   (subset), rows → `/eval/runs/:id`. Empty → "No runs against this set yet."

### Nav
`AppShell.tsx` "Evaluate" group items become:
```ts
[{ to: "/eval/sets", label: "Sets" }, { to: "/eval", label: "Runs" }]
```
(`/eval` is `end`-less; both NavLinks. "Sets" first — the browse entry point.)

### Cross-link
`EvalRunDetailPage` metadata Card: make `target · …`/`split` unchanged but render the
existing `run.setId` value as a `<Link to={`/eval/sets/${run.setId}`}>` when non-null.

### Tests
`__tests__/EvalSetsPage.test.tsx`, `EvalSetDetailPage.test.tsx` (mirror
`EvalRunsPage.test.tsx` idioms: mock `evalApi`, assert rows, split grouping, empty/
unconfigured/error states, navigation targets).

---

## WI-4 — Dashboard: Case detail page + cross-run history

**Files:**
- `evalApi.ts` — `fetchEvalCaseDetail(setId, caseId): Promise<EvalFetch<EvalCaseDetailResponse> | {kind:"not-found"}>` (mirror `fetchEvalRunDetail`'s 503/404 discrimination).
- `pages/eval/EvalCaseDetailPage.tsx` — `/eval/sets/:id/cases/:caseId`.
- `App.tsx` — 1 route.

### `EvalCaseDetailPage`
`useParams { id, caseId }`. Fetch `fetchEvalCaseDetail`. States incl. not-found.
Layout:
1. Back link `← <setId>` (→ `/eval/sets/:id`).
2. Case Card: caseId, split badge (test→held-out amber), tags chips, **input** block
   (pretty JSON, `<pre>` in scrollable container — the `CaseDetail.tsx` precedent),
   **expected** block.
3. **Cross-run history** `DataTable<EvalCaseHistoryRow>`: run (short id, mono, →
   `/eval/runs/:evalRunId`), started (relative), target, variant, split badge, model,
   result (pass/fail/ungated badge — reuse `passTone`/`passLabel` pattern), run status,
   tokens, elapsed. Empty → "This case has not been evaluated in any run yet."
   Expandable row → the run's `finalAnswer` (safeParseAnswer) vs the case `expected`.
4. Header action **Edit** → `CaseEditModal` (WI-5; omit in WI-4).

### Tests
`__tests__/EvalCaseDetailPage.test.tsx`: renders case fields; history rows + nav
targets; empty-history state; not-found; unconfigured.

---

## WI-5 — Dashboard: inline editing (modals)

**Files:**
- `components/atoms/Modal.tsx` — NEW lightweight modal atom (none exists).
- `evalApi.ts` — `createEvalSet`, `updateEvalSet`, `upsertEvalCase`, `deleteEvalCase`
  clients (POST/PATCH/PUT/DELETE from WI-2; `EvalFetch`/throw idioms).
- `pages/eval/SetEditModal.tsx` — create/edit set metadata.
- `pages/eval/CaseEditModal.tsx` — create/edit a case (input JSON textarea, expected,
  tags CSV, split select).
- Wire buttons: `EvalSetsPage` (New set), `EvalSetDetailPage` (New case, per-row Edit/
  Delete with confirm), `EvalCaseDetailPage` (Edit).

### `Modal` atom
```tsx
// createPortal to document.body; overlay + centered Card; Esc + backdrop close;
// role="dialog" aria-modal; focus the panel on open; lock body scroll.
export function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: ReactNode;
}): JSX.Element
```
Uses existing `Card`/`Button` + CSS vars. No new deps.

### Case editor payload
- input textarea → `JSON.parse` with a try/catch; invalid JSON → inline error, block save.
  (If parse fails but the string is non-empty, offer "save as string"? No — keep strict,
  matches loader discipline. Plain strings are valid JSON when quoted.)
- tags CSV → `split(",").map(trim).filter(Boolean)`.
- split select `"" | train | dev | test` → `undefined` for `""`.
- On save: `upsertEvalCase(setId, caseId, body)` → on ok, close + trigger parent reload.

### Delete
Per-row Delete → a confirm (reuse `Modal` as a confirm, or `window.confirm`; prefer
`Modal` for consistency) → `deleteEvalCase` → reload.

### Optimistic refresh
Simplest correct: after any mutation, re-run the parent page's `load()` (no optimistic
cache). Matches the one-shot-fetch idiom already used.

### Tests
`__tests__/Modal.test.tsx` (open/close/esc/backdrop). `CaseEditModal` JSON-validation
+ save-calls-api. `evalApi` write-client tests (mirror `evalApi.test.ts`): status
mapping for POST/PATCH/PUT/DELETE (201/200/400/404/503).

---

## Conventions to honor (all WIs)

- **Zod at loader/route boundaries** only where new (server validates bodies by hand,
  matching the existing `POST /eval/runs` style — no zod in routes today).
- **`EvalFetch<T>` discrimination** for every new client fn; 503 → `unconfigured`.
- **Pages never share code** (playground-redesign.md) — helpers are page-local; only
  atoms/organisms are shared.
- **Layer rules**: dashboard is standalone (no runtime import — mirror row types by hand);
  server imports runtime; runtime store change stays in `storage/`.
- **Strict TS**: `noUncheckedIndexedAccess` (guard array access), no unused.
- **Gates**: `bun run check` green (build + typecheck + lint + test) before done.
- **Commits**: conventional, one WI per commit — e.g.
  `feat(runtime): eval-store case delete + cross-run case history query`,
  `feat(server): eval set/case write routes + case-detail read`,
  `feat(dashboard): eval set browse + set detail with split grouping`,
  `feat(dashboard): eval case detail page + cross-run history`,
  `feat(dashboard): inline eval set/case editing via modals`.

## Out of scope
- No new streaming/live surface (case history is static reads).
- No case-bank file export/import from UI.
- No auth/permissions on writes (matches current admin API posture).
