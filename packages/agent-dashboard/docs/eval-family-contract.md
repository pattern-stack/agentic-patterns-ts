# Eval family contract

The single source of truth for how the dashboard's **family-aware** eval surface
(Renderer / SDC / Curation runs; Answer-bank / Question-bundle sets) reads its
data. It is a cross-repo contract: the Dealbrain-side exporter
(`apps/backend/scripts/evals/export-to-ap.ts`) produces these shapes; the
dashboard consumes them. Change it in lockstep on both sides.

## Where each grain lives

| Grain | Carrier | Schema change |
|---|---|---|
| Per-case | `Score.detail` (open blob, `detail.kind` registry) | none — shipped |
| Per-run | `eval_run.meta` (JSON column) | **v5** |
| Per-set | `eval_set.meta` (JSON column) | **v5** |

Family identity is `meta.family`. Absent/unknown ⇒ generic (pre-upgrade) UI.
**Never** a setId-prefix convention — a `/` in a setId breaks fetch/Link paths.
All raw id interpolations are `encodeURIComponent`-wrapped regardless.

## Composite case ids (mandatory)

`eval_result` PK is `(eval_run_id, case_id)`; `INSERT OR REPLACE` collapses
duplicates. So:

- **Renderer:** `case_id = "<fid>#<variantKey>"` (one row per render, not per fixture — else the grid collapses to one render per fid).
- **Curation:** `case_id = "<configId>#<fixtureId>"`.
- **SDC:** `case_id = fixture_id` (clean 1:1).

## Detail payloads (per case, on a `Score.detail`)

`render-grade` (additive extension of the shipped kind — version-note fixture changes):
```
{ kind:"render-grade", fid, variant{shape,verbosity,tone,citationMode,model},
  effective{verbosity,tone,citationMode}, variantKey, regime, status,
  fidelityFailure, retriedForLength, report:RenderGradeReport,
  judge:{readability,faithful_emphasis,tone_differentiation}|null,
  cost{inputTokens,outputTokens,estimatedUsd}, latencyMs,
  renderedText, carriedIds[], coverage }
```
`score-map`:
```
{ kind:"score-map", scores:Record<axis,number>, hybrid, answerMd, dealIds[],
  missingContext, citationCount, retrievedSourceCount, costUsd, latencyMs }
```
(the shipped renderer also accepts the legacy `axes` key.)

`judge-verdicts` (as shipped): `{ kind:"judge-verdicts", verdicts:[{expectationId,passed,reason,evidence}] }`

`curation-facts` — metrics are **FLAT on the payload, not nested under `metrics`**
(the shipped consumers require it: `curationFrontier` reads top-level
`outboundTokens`/`survival.rate`; `CurationFactsDetail` reads top-level
`survival`/`typeCoverage`; only `curationConfigTable` tolerates both):
```
{ kind:"curation-facts", configId, knobs{…},
  survival{…}, outboundTokens, typeCoverage, temporalAlignment,
  temporalSpreadDays, perExpectation[], … }
```

## `eval_run.meta`

```
{ family:"renderer"|"sdc"|"curation",
  benchmark?, judgeModel?, gitBranch?,
  summary?:{ detPassRate, judgeLens:{kind:"mean"|"ratio", value, num?, den?},
             costUsd, judgeCostUsd?, latencyP50, flagsRate?, fallbackRate?,
             retriesRate?, survivalBest?, tokensAtBest?, compressionPct?,
             paretoCount?, configCount?, crashedCount? },
  renderer?:{ bankSetId, orderingChecks[], gridArgs?{states,judgeMode,models} },
  sdc?:{ scores:Record<axis,number>, failures?:[{fixtureId,error}] },
  curation?:{ sourceSetId, frontier?:paretoFront[], scoreboardMd? } }
```
- Home family tables read `meta.summary` (one fetch — `GET /eval/runs` returns pass counts only).
- Canonical run-level artifacts (SDC `scores.json`, declared curation frontier) ride `meta` **verbatim**; client recomputation (`sdcAxisMeans`, `curationFrontier`) is fallback only ("declared-wins-else-compute").
- The **two-lens judge value differs per family**: renderer = readability mean (`kind:"mean"`); SDC = verdict k/n (`kind:"ratio"`); curation uses survival, not a judge lens.

## `eval_set.meta`

- Answer-bank: `{ family:"answer-bank" }`.
- Question-bundle: `{ family:"question-bundle", source:"cache"|"authoring", benchmark, version, dataset, createdAt, families[] }`. Bundle set ids embed the source (`bundle:cache:render-bench@v3`) — cache & authoring can hold the same benchmark@version.

## The ingest seam (`POST /eval/runs/ingest`, slice 2)

One transactional, idempotent call recording a COMPLETE externally-executed run
(full replacement on re-ingest — stale results are removed, not merged):

```
{ run:{ id, setId, targetId, variant?, split?, model?, gitSha?, scorer?,
        tsStart, tsEnd, status:"ok"|"error", meta? },
  results:[ { caseId, pass,
              scores?: [ { name, value:number|null, passed?, detail?, error? } ] } ] }
```

- `tsStart`/`tsEnd` persist **verbatim** — never re-stamped with import time.
- `status` is terminal-only; a `"running"` import would dangle in the SSE
  `run.detached` branch forever.
- **`scores` is an ARRAY of Score objects** (the runtime's `EvalScoreLike`) —
  the same shape native runs write. The read path (`parseScores`) surfaces
  only arrays; record-shaped scores are rejected at the route (400), never
  silently persisted as write-only data. Per-case detail payloads (§ above)
  ride each score's `detail`.
- Body limit 32 MiB; oversize ⇒ 413.

## Cross-links (obsolete the viewer's `/api/bundle-locate`)

- Renderer render → its bank case: `/eval/sets/${run.setId}/cases/${fid}` (join by `detail.fid`).
- SDC fixture → its bundle case: `/eval/sets/${run.setId}/cases/${caseId}`.
- Curation fixture → its bundle case: `/eval/sets/${meta.curation.sourceSetId}/cases/${fixtureId}`.
Cross-link wiring lives at the **wrapper** level; leaf renderers stay pure-presentational.

## The gate-failure rule (defined once, referenced by exporter + `rendererVariantScoreboard`)

A render-grade gate counts as failed when `gate.pass === false` OR (coverageHonesty) `gate.status === "dishonest"`. `coverageHonesty.status === "not_declared"` is a passing/reporting state.

## Known limits (stated, not hidden)

- No `runs` row for ingested cases ⇒ no `traceId` ⇒ TraceSection never renders; answer/rendered text + cost + latency ride detail, not `finalAnswer`/joined columns.
- Cross-run case history works for **SDC only** until a prefix-matching store change (composite ids don't match `case_id = @id`).
- List-level two-lens exists only where `meta.summary` exists (ingested runs); dashboard-launched native runs show det-only at list grain.

## Version hazard

`meta_json` is schema **v5**. `TARGET_SCHEMA_VERSION` mismatch hard-throws, and
multiple checkouts share `events.db` files — ship runtime+server+dashboard
together.
