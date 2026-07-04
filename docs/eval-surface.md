# Eval surface — first-class eval management in the playground

> **Status:** design (proposed stack). Companion to
> [`.ai-docs/stacks/closed-composition/specs/103.md`](../.ai-docs/stacks/closed-composition/specs/103.md)
> (the eval *engine*, shipped in-memory) and the `store-family` stack
> ([#118](../.ai-docs/stacks/store-family/specs/118.md) barrel, #117 `RunStore`). This doc is the
> LOCKED design for the **fast-follows #103 explicitly deferred** — persistence, splits, a CLI,
> a review UI, and the LLM judge — turning the engine into a surface every agency on the
> framework gets for free (Google ADK's `adk web` "Eval" tab, but ours).
>
> Authored 2026-07-03 from a consumer-driven review. All framework `file:line` anchors were
> read at HEAD `main @ 1975ec3` and are marked *(verify at impl)* where an implementer must
> re-confirm before editing.
>
> **Update (2026-07-04) — re-anchored on shipped substrate.** #118 (`stores/` barrel) and
> **#117 `RunStore`** have since **shipped to `main` (`4a3211e`)**; `runtime@0.8.0` is published.
> This **resolves the doc's one open question (§16.1): eval persistence sits *on* RunStore, not
> beside it.** Concretely:
> - **`EvalStore extends RunStore extends EventStore`** — one SQLite file, each layer adds tables,
>   mirroring the *shipped* `RunStore extends EventStore` (`storage/run-store.ts`).
> - **Each eval case's execution IS a RunStore run.** RunStore's code already names the seam —
>   `runEval` as a manual `startRun`/`finishRun` producer — and its `runs` row carries `run_id`,
>   `trace_id`, tokens, `finish_reason`, `elapsed_ms`, `status`, `final_answer`, `step_metrics`.
> - **`eval_result` *annotates* a run by `run_id`** — it does NOT re-store tokens/trace/output/
>   status/error (all already on the `runs` row).
> - **`variant`/`split` ride RunStore's `metadata` JSON column** — the slot the store-family design
>   reserved for exactly "a future eval overlay's join keys, without a schema change."
> - **E2 (trace capture) and run-capture fuse:** attach `RunStoreExporter` to the eval bus and each
>   case yields an EventStore trace **and** a RunStore run row for free.
>
> Sections §2/§3(E1,E2)/§4/§12/§16.1 are updated to this decision; other anchors still read
> `1975ec3` — re-verify at `4a3211e` during impl.

## 1. Motivation — the engine exists; nothing is wired to it

#103 landed the hard part: a typed harness, `runEval(spec, ctx) → EvalReport`, that reduces a
bare `Node`, a bare `Agent`, and an `asAgent`-promoted pipeline to **one** `Node<TIn,TOut>` via
`resolveEvalTarget` — so *one API evaluates a single pipeline step OR a whole agent*. But the
engine is **in-memory and programmatic-only**: it is exported from the runtime barrel and wired
to no store, no CLI, no server route, and no UI (`grep runEval` across `agent-server` /
`agent-cli` / `agent-dashboard` = 0 hits).

#103's own scope note names the deferred work and pre-authorizes this stack:

> *"If Gate-1 review wants any deferred item pulled forward, that is the signal to split #103 into
> #103a (harness) + #103b (judge/store)."* — 103.md §Scope

The four deferred items map one-to-one onto what a real team needs to **build, run, review, and
maintain** evals — and onto the consumer evidence #103 already cites
(`~/retrieval-agent-2.0/canvas-workstation/src/query-surface/{eval,__bench__}`):

| #103 deferred item | User-facing capability | Reference to promote |
|---|---|---|
| persistence / score store | *review* runs; track over time | canvas `eval/store.ts` (SQLite EvalStore) |
| `ap eval` CLI + split discipline | *run* suites; train/dev/test hygiene | canvas `eval/split-discipline.ts` |
| case-bank loaders (jsonl/gold) | *build + maintain* the suite | canvas `eval/gold.ts` |
| LLM-judge scorer | grade **answer quality** (today unmeasured) | v1 `packages/benchmarks/agent-eval/grade.ts` |
| *(new)* review UI | *review* — the "adk web Eval tab" | v1 `src/cli/cockpit.ts`; the `viz.ts` snapshot |

The consumer's five hand-rolled `__bench__/eval-*.ts` harnesses are ~80% copy-paste (per the
review): the per-question loop, `mean()`, the recall helper, the suite-stamp — re-implemented in
each. Promoting the loop into the framework **deletes that duplication**: a consumer harness
collapses to a case-bank + a scorer over `runEval`.

## 2. What already exists (the substrate an implementer builds on)

Do not rebuild these — consume them.

- **Engine** — `packages/agent-runtime/src/eval/`:
  - `run-eval.ts` — `runEval(spec, ctx)` (`:162 verify`). Sequential, never throws (an errored node
    scores 0). **`EvalSpec.onResult(result)` (`:46 verify`) is the persistence seam** — "no built-in
    store in v1" is stated there by design.
  - `EvalRunContext` (`run-eval.ts:34 verify`) carries `runner` (injected), `hooks?`,
    `toolExecutor?`, `traceId?` — but **no `eventBus`** (see §5).
  - `target.ts` — `resolveEvalTarget(target)` (`:67 verify`) → `{ node, kind }`, `kind ∈
    node|agent|promoted`. The one place per-step and e2e targets converge.
  - `scorer.ts` — the `Scorer` contract (async → judge-ready), `exactMatch`, `predicateScorer`.
  - `types.ts` — `EvalCase / Score / EvalResult / EvalReport / EvalSpec` (Zod-schema'd).
- **Persistence pattern** — `packages/agent-runtime/src/storage/event-store.ts` (`:94 verify`):
  SQLite (`better-sqlite3`), append-only, `PRAGMA user_version` migrations. **`EvalStore` mirrors
  this file.** The `store-family` stack ([#118](../.ai-docs/stacks/store-family/specs/118.md))
  establishes `src/stores/index.ts` as the curated store barrel and the naming law: **`<Noun>Store`
  = interface; `InMemory<Noun>Store` / `Sqlite<Noun>Store` = impls.** #117 adds `RunStore`
  (one-row-per-run aggregate over the EventStore substrate) — coordinate (see §12).
- **Server** — `createServer` mounts route groups at `agent-server/src/app.ts:32-38 verify`;
  `ServerConfig` (`config.ts:88 verify`) is the injection seam (already carries an optional
  `eventStore`); two SSE patterns exist (`routes/conversations.ts` streamSSE; `routes/admin.ts`
  exporter).
- **Dashboard** — React 19 + Vite SPA. Tabbed shell nav at `agent-dashboard/src/components/
  templates/AppShell.tsx:5 verify`; routes in `App.tsx`. **`EventStream.tsx` +
  `hooks/useEventStream.ts` + `graph/trace-from-events.ts` are reusable** for per-case trace/replay.
- **CLI** — `ap` bin dispatch switch at `agent-cli/src/cli.ts:143 verify`; agent discovery in
  `helpers/discover.ts`; `ap playground` boot in `commands/playground.ts`.

## 3. The gaps, as a stack (dependency-ordered — judge LAST)

Six issues. Each ships standalone value; the arrows are hard deps. **The LLM judge is last on
purpose** — it is only meaningful once running/reviewing works end-to-end, and it is the one piece
that needs a judge model + threshold tuning.

```
E1 EvalStore (persist)  ─┬─► E4 ap eval CLI ──► E5 Eval tab (review UI)
E2 Trace capture ────────┘                         ▲
E3 Case banks + splits ────────────────────────────┘
                                                    │
E6 LLM-judge scorer  (last — drops in as one Scorer)┘
```

- **E1 · EvalStore (persist).** New `agent-runtime/src/storage/eval-store.ts` — **`EvalStore extends
  RunStore`** (`storage/run-store.ts`, #117): same SQLite file, adds `eval_set` / `eval_case` /
  `eval_run` (suite-level) + the `eval_result` **annotation** table on top of the inherited `runs`.
  Persist per case via `EvalSpec.onResult` → inherited `startRun`/`finishRun` (or a bus with
  `RunStoreExporter`, see E2), then write the `eval_result` row keyed to that `run_id`. Also
  `InMemoryEvalStore` for tests. Schema §4. *Substrate for everything downstream — lighter than a
  parallel store because run persistence is inherited.*
- **E2 · Trace + run capture (fused).** Add `eventBus?` to `EvalRunContext` and thread it + a
  per-case `traceId` into each `node.run` so eval cases flow through the existing `events.db →
  collector → SSE → EventStream` pipeline (§5). **Attach `RunStoreExporter` to that same bus** and
  each case *also* lands a `runs` aggregate row for free — one lever, both a trace and a run record.
  Small runtime change; unlocks free traces **and** run rows in the UI.
- **E3 · Case banks + splits.** `EvalCase.split` field + jsonl/gold loaders + the train/dev/test
  discipline (§7). Loaders are runtime/CLI-side; `split` is a first-class stored column.
- **E4 · `ap eval` CLI.** New `cli.ts` case: discover targets, load a set, `runEval`, persist to
  `EvalStore`, print aggregate + gate. Reuses discovered agents + `createRunner` (§10).
- **E5 · Eval tab (review UI).** `agent-server/src/routes/eval.ts` + a dashboard `EvalPage.tsx`
  (§8–§9). The headline surface: run a set, per-case pass/fail with **side-by-side actual vs
  expected**, the failing trace, **A/B compare (two variants, same case)**, split-aware
  aggregates, and **capture-from-session**.
- **E6 · LLM-judge scorer.** Promote v1 `grade.ts` (5-axis rubric + set-membership citation check)
  as a built-in async `Scorer` (§11). Config-driven thresholds.

## 4. Persistence model — `EvalStore` schema

Generalizes canvas `eval/store.ts` into framework terms and keys for the two views that matter:
**A/B compare** (two runs of the same set, different variant) and **split aggregates** (group by
split). Follows the store-family convention: interface + impls, in the `stores/` barrel.

```sql
-- a named suite of cases (optional; cases may be file-loaded instead of stored)
CREATE TABLE eval_set   (id TEXT PRIMARY KEY, name TEXT, description TEXT, created_ts TEXT);

-- the case bank (optional persistence — enables browsing/authoring in the UI)
CREATE TABLE eval_case  (set_id TEXT, case_id TEXT, input_json TEXT, expected_json TEXT,
                         tags_json TEXT, split TEXT,                 -- 'train'|'dev'|'test'
                         PRIMARY KEY (set_id, case_id));

-- SUITE-level: one invocation of a (target, variant) over a set/split. NOT a per-case run —
-- each case's execution is a RunStore `runs` row (see eval_result.run_id).
CREATE TABLE eval_run   (id TEXT PRIMARY KEY, ts_start TEXT, ts_end TEXT,
                         set_id TEXT, target_id TEXT, variant TEXT,  -- variant = the A/B label
                         split TEXT, model TEXT, git_sha TEXT, status TEXT);

-- per-case outcome — ANNOTATES a RunStore run. run_id FK → runs.run_id (#117, same file).
-- Tokens, trace_id, final answer, finish_reason, status and error live on the `runs` row and
-- are joined in, NOT duplicated here. variant/split are on eval_run (and stamped into the
-- run's `metadata` slot for run-side self-description).
CREATE TABLE eval_result(eval_run_id TEXT, case_id TEXT, run_id TEXT,   -- run_id → runs.run_id
                         scores_json TEXT, pass INTEGER,
                         PRIMARY KEY (eval_run_id, case_id));
```

`variant` is the load-bearing addition over the canvas store — it is **the** mechanism for "run
agent version A vs B against the exact same prompts" (§6). `trace_id` is what makes a per-case row
openable as a full trajectory in the UI (§5).

**`scores_json`** holds the heterogeneous `Score[]` the engine already emits (`{name, value,
passed?, detail?}`) — so mechanical metrics (recall@60, gold-retention) and judge axes (accuracy,
grounding, …) coexist without a schema change.

## 5. Trace capture — the one lever that makes eval observable for free (E2)

Today `EvalRunContext` has no `eventBus`, so eval runs emit nothing to the trace pipeline. The
change is small and high-leverage:

1. Add `readonly eventBus?: AgentEventBus` to `EvalRunContext` (`run-eval.ts:34`).
2. In `runEval`, per case: mint a `traceId` (e.g. `${runId}:${case.id}`), pass the bus +
   `traceId` into the `NodeRunContext` for that `node.run`, and stamp `traceId` onto the
   `EvalResult` (→ `eval_result.trace_id`).
3. In the playground/CLI wiring, pass the **shared** bus (`playground.ts:71 verify`) so events land
   in the same `events.db` the `EventStream` UI already reads.

Result: every eval case gets a full tool/LLM/message trajectory in the existing Live/Graph views,
keyed by `traceId`, with **zero new trace plumbing**. E5's per-case drill-down is then just the
existing `EventStream` filtered to a `traceId`.

## 6. Targets — per-step AND e2e, same API; variants for A/B

The two capabilities the consumer asked for are already latent in `resolveEvalTarget`:

- **Per-step (subagent) eval** — pass a pipeline `Node` (e.g. the interpret step, the curate step).
  `kind: "node"`.
- **End-to-end eval** — pass the whole `Agent` / promoted pipeline. `kind: "agent"|"promoted"`.
- **Same `runEval`, same `cases[]`, same scorers.** Granularity is just which target you hand in.

**"Sub agents in/out against the exact same prompts"** is then: register two targets (two
`agent.ts` files, or two role-slot forks), run each over the identical set, tag each `eval_run`
with a `variant` label, and diff the two reports. The runtime models no agent "version" (confirmed
— no version field on `Agent`/`AgentConfig`), and it should not: **variant is an eval-store label,
not an Agent primitive.** This keeps the Agent clean and matches how ADK works (point eval at a
module) while adding the provenance ADK lacks (ADK stores no link between a result and the agent
version that produced it — our `eval_run.variant` + `target_id` + `git_sha` do).

## 7. Splits — adopt ML-standard names; fix the inherited inversion

The consumer's `split-discipline.ts` has the right *idea* (three roles, held-out refuses without a
flag) but **inverted names** vs ML convention:

| ML-standard (adopt) | Role | Consumer's current name |
|---|---|---|
| `train` | tune freely; read per-case forensics | `train` ✓ |
| `dev` (validation) | pick between versions; score-only | `test` ✗ (rename) |
| `test` | held-out; touch once pre-ship; refuses without an explicit flag | `validate` ✗ (rename) |

Ship the framework primitive with `train / dev / test` and document the mapping so the consumer's
migration is mechanical. `split` is a first-class field on `EvalCase` and a stored column on
`eval_run`/`eval_result` (§4) — which is what makes the **overfit read** (the train-vs-test score
gap) a chart in E5 instead of a guess. The held-out `test` split keeps the consumer's "refuses to
run without an explicit env/flag" guard.

## 8. Server surface (E5)

New `packages/agent-server/src/routes/eval.ts`, mounted with one line at `app.ts:38 verify`; thread
an `evalStore` through `ServerConfig` (`config.ts:88 verify`) exactly like the existing optional
`eventStore`. Proposed endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/eval/sets` | list case banks (+ per-split counts) |
| GET | `/eval/sets/:id/cases` | browse cases (author/inspect) |
| POST | `/eval/runs` | start a run: `{ setId, targetId, variant, split }` |
| GET | `/eval/runs` | run history (filter by set/target/variant/split) |
| GET | `/eval/runs/:id` | one run: per-case results + summary |
| GET | `/eval/runs/:id/stream` | SSE live progress (copy `conversations.ts` streamSSE) |
| POST | `/eval/cases/from-session` | **capture-from-session** — a live conversation → an `EvalCase` |

**Gotcha (must-fix):** the CLI SPA fallback has a hardcoded `API_PREFIXES` allowlist at
`agent-cli/src/commands/playground.ts:211 verify` (`/agents /roles /capabilities /conversations
/admin /health`). **Add `/eval`** or the SPA catch-all swallows `/eval/*` and returns `index.html`.

## 9. UI — the Eval tab (E5)

Additive, matching the "three doors" convention (`docs/playground-redesign.md`): one nav entry at
`AppShell.tsx:5 verify` (a new "Evaluate" group or under Run), one `<Route>` in `App.tsx`, one new
`EvalPage.tsx`. Borrow ADK's Eval-tab UX (the good parts), reuse our components:

- **Set + run list** — pick a set, target, variant, split → run (SSE progress).
- **Per-case pass/fail** with **side-by-side actual vs expected** on failures (ADK's best idea).
- **Trajectory drill-down** — reuse `EventStream.tsx` / `useEventStream` filtered by `trace_id`
  (free via E2); `graph/trace-from-events.ts` for the replay graph.
- **A/B compare** — two `eval_run`s of the same set, different `variant`, aligned per case
  (regression + version bake-off in one view).
- **Split-aware aggregates** — the train/dev/test rollup + the overfit gap. The `viz.ts` snapshot
  (rollup-by-arm/mode, per-run drawer) is the reference for these panels; port its aggregation into
  live React over `/eval/runs`.
- **Capture-from-session** — "Add current conversation as an eval case" (ADK's lowest-friction way
  to grow a gold set), via `POST /eval/cases/from-session`.

Build/ship note: the dashboard is Vite-built into `agent-cli/assets/dashboard` at package-build
time (gitignored) — no runtime dep added.

## 10. `ap eval` CLI (E4)

New case at `cli.ts:143 verify`, reusing the same discovery + runner the playground boots:

```
ap eval <agents-dir> --set <path|id> [--target <id>] [--variant <label>]
        [--split train|dev|test] [--judge] [--db <path>]
```

Loads the set (E3), resolves the target from discovery, runs `runEval` with an `EvalStore`-backed
`onResult`, prints the aggregate + any gate, exits non-zero on gate failure (CI-friendly). The
held-out `test` split refuses without an explicit opt-in flag (§7). This is where the consumer's
five `__bench__` harnesses converge into `ap eval <dir> --set <bank>`.

## 11. The LLM judge (E6 — last)

Promote v1 `grade.ts` as a built-in async `Scorer` (the contract is already async for exactly
this). It carries two graders worth keeping:

- **set-membership** (deterministic, no model): cited-id precision/recall/F1 vs `expected` ids —
  pass = recall ≥ 0.6 ∧ precision ≥ 0.4.
- **5-axis rubric** (judge model): accuracy / completeness / grounding / hazard-avoidance /
  calibration, each 0–5, + a boolean pass. Grounding scores *citation quality* separately from
  truth.

Config-driven thresholds, ADK-style `score ≥ threshold`. **Known bug to fix on port:** the v1
8-char-prefix-vs-full-UUID citation match (flagged in the consumer's `eval-harness-plan.md`).
Judge model is injected (not hardcoded to a vendor) — it is "just a scorer that calls a runner,"
per #103. *Stretch:* v1's `lens.ts` (did a manual rule's text reach the prompt vs get honored —
`rule_ignored` vs `rule_absent`) is a distinctive analysis scorer worth a later issue; not in this
stack.

## 12. Slice order + coordination

| Issue | Depends on | Ships |
|---|---|---|
| **E1** EvalStore | — (aligns w/ #118 barrel, #117 RunStore) | persisted runs/results; `stores/` export |
| **E2** Trace capture | — (touches #103 `EvalRunContext`) | per-case traces in existing pipeline |
| **E3** Case banks + splits | — | jsonl/gold loaders; `split` field + guard |
| **E4** `ap eval` CLI | E1, E3 | run suites from the CLI, persisted |
| **E5** Eval tab | E1, E2, E4 | the review surface (routes + UI) |
| **E6** LLM judge | E1 (+E4 to run it) | answer-quality scoring |

**Thinnest end-to-end slice:** E1 + E3 + E4 + a read-only E5 = "run `ap eval`, review it in the
playground." Then A/B-compare + capture-from-session, then E6.

**Sits on `store-family` (shipped 2026-07-04):** #117 `RunStore` and #118's `stores/` barrel are on
`main`. **Decision (store-family owner):** `EvalStore extends RunStore` — each eval case's execution
*is* a RunStore run; `eval_result` references `runs.run_id`; `variant`/`split` ride RunStore's
`metadata` slot; E2 fuses with run-capture via `RunStoreExporter` on the eval bus. E1 therefore adds
only the case-bank + suite-run + annotation tables — **not** a parallel run store. Follow #118's
`stores/` barrel + naming law (`EvalStore` interface / `InMemory`+`Sqlite` impls; surface via
`stores/index.ts` beside `RunStore`).

## 13. Scope fences (what this is NOT)

- **Not a rewrite of #103.** The engine ships as-is; this stack wires it. The only engine edit is
  E2's additive `eventBus?` field on `EvalRunContext`.
- **No agent "version" primitive.** Variants are eval-store labels; the `Agent`/`AgentConfig` gains
  nothing (§6).
- **No new `@agentic-patterns/eval` package.** Store → `agent-runtime/stores`, routes →
  `agent-server`, tab → `agent-dashboard` — matching every other surface. Split a package out only
  to publish the store standalone.
- **Judge is not gated on this stack landing** — E6 is decoupled and last.
- **Consumer gold stays in the consumer.** The framework ships loaders + the discipline; the
  beanmaxx/dealbrain gold banks remain in canvas-workstation.

## 14. Reference assets to promote (paths)

- Consumer (canvas-workstation, `~/retrieval-agent-2.0/canvas-workstation/`):
  `src/query-surface/eval/{store,gold,split-discipline,trace}.ts` · the five
  `src/query-surface/__bench__/eval-*.ts` (the loop to delete) · `.eval/viz.ts` (the review-UI
  reference; rollups + per-run drawer).
- v1 (`~/Projects/retrieval-agent/`): `packages/benchmarks/agent-eval/{grade,lens,run-lib}.ts` ·
  `src/cli/cockpit.ts` ("adk web, but eval-native" — the review-surface precedent).
- External reference: Google ADK eval (`google.github.io/adk-docs/evaluate/`) — borrow
  session-as-case, capture-from-session, layered metrics, config thresholds, the Eval-tab UX;
  do **not** inherit its ROUGE default, GCP-bound judge, or its missing version provenance.

## 15. How this answers the original ask

1. *"first-class build/maintain/run/review of evals"* → E1–E5 (store, banks, CLI, UI).
2. *"per-step (subagent) AND full e2e evals, visualize + run both easily"* → §6 (`resolveEvalTarget`
   already does both; E5 renders both).
3. *"agents easy to sub in/out, run vs the exact same prompts (versions vs the suite)"* → §6 variant
   labels + E5 A/B compare.
4. *"properly separate train / a 3rd held-out split"* → §7 (`train/dev/test`, held-out guard, the
   overfit gap charted).

## 16. Open questions

1. ~~**`EvalStore` ↔ `RunStore` (#117) overlap** — reference or standalone?~~ **RESOLVED
   (2026-07-04, store-family owner):** `EvalStore extends RunStore`; each case is a RunStore run;
   `eval_result` references `runs.run_id`; `variant`/`split` ride RunStore's `metadata` slot. E1 is
   now the case-bank + annotation layer only. See the Update note (top) + §12.
2. **`variant` identity** — free-string label, or a resolved `{targetId, gitSha, model}` tuple?
   Proposed: free label in the UI, with `git_sha`/`model` stored alongside for provenance.
3. **Split rename blast radius** — adopt `train/dev/test` in the framework and let the consumer
   migrate, or keep the consumer's `train/test/validate` and alias? Proposed: standard names in the
   framework primitive; consumer aliases at its loader seam.
4. **Case-bank storage** — persist cases in `eval_case`, or keep them file-first (jsonl) and store
   only runs/results? Proposed: file-first for authoring, optional `eval_case` mirror for UI browse.
```
