# Stack plan — memory routing and Background composition

**ADR of record:** [`docs/adr/0009-memory-routing-and-background-composition.md`](../../../docs/adr/0009-memory-routing-and-background-composition.md) (PROPOSED · 16 decisions · 6 open questions for Doug)
**Program:** #414 · **Epic:** #415 · **Supersedes in part:** ADR-0008 (atom-immutability promise only — D3/D4/D5/D6/D8 survive and are load-bearing here)
**Spec directory:** `.ai-docs/stacks/memory-routing/specs/` — one spec per issue, house format (`.ai-docs/stacks/memory-store/specs/422-recall-surface.md` is the reference shape: Objective / Scope (exact files) / API surface / Implementation strategy / Test plan / Acceptance / Out of scope).
**Issue numbers below are PROVISIONAL** (`#460`–`#476`). They are contiguous and unallocated as of writing; renumber at `sdlc:sync-issues` time and the spec filenames follow.

---

## 0. What this plan is, and the one thing it changes about the ADR

ADR-0009 settles *what to build*. This plan settles *in what order, in what PR-sized units, and with what instrument measuring it*. Three things it adds beyond re-sequencing the ADR's own landing order:

1. **A correction to Decision 9's stated precondition.** The ADR names "a placement-keyed lookup on `MemorySearchQuery`" as a precondition of the D2 gate rekey. That cannot work as written. Placement is *derived at promotion* and committed to the promotion row (Decision 9), and `MemoryRecord`'s schema is explicitly untouched — so nothing on a record carries a placement, and a store filter over stored placements can only see **promoted** records. Two coherent resolutions exist and the ADR picks neither:
   - **(a) Recommended.** The rekeyed gate compares a pending write only against records that already hold a *committed* placement. Defensible on its own terms: the gate exists to protect *composition*, and only promoted records are composed; an unpromoted near-duplicate costs recall quality, which is the pre-existing untargeted-save behaviour and not a regression. The lookup then lives on the **promotion-row surface** — a store extension `0008:8` already sanctions — not on `MemorySearchQuery`.
   - **(b) Rejected.** Store a derived `routeKey` on the record at birth. This is precisely the birth-time-constant semantics Decision 9 removes, and it reopens the record-schema change Decision 4 avoids.

   Consequence for sequencing: **the promotion-row surface (#469) is the true precondition of the gate rekey (#471)**, not a `MemorySearchQuery` extension. The ADR's landing order implies the reverse. This is stated here rather than discovered during #471.

2. **`gate: "hard" | "xfail"` on eval families** (§3.2). Without it, an eval that honestly fails today cannot be committed — which means the only evals that ever land are ones authored *after* the fix, i.e. regression tests that have never been observed to fail. That is the difference between a gate and a decoration.

3. **A rendered-prompt assertion target for the deterministic paraphrase family.** The obvious deterministic target (`assembleRecall`) is the wrong one: after the fix, identity is *composed*, not *recalled*, so the recall block is legitimately empty and a recall-block assertion would go green for the wrong reason. The assertion must be on the **delivered prompt** (`buildAgentFromConfig` → `renderInitialPrompt`). Specified in §3.3.A.

### Gating open questions

Four of the ADR's six open questions block specific issues. Nothing downstream of them should be specced until Doug answers:

| Open Q | Blocks | If unanswered |
|---|---|---|
| 1 — accept `label?` on `MemoryRecord`? | #466, and key derivation in #467 | #467's spec cannot pick a key rule; the fallback (content-derived key) makes `reconcile` inert and the section append-only |
| 2 — default section `promotion`: `locked` or `guarded`? | #467 preset defaults, #470 admission | `guarded` with no `HumanApprovalGate` wired anywhere ships the originating bug as the framework default |
| 4 — budget digits | #470 | Ship as tunable defaults with the ~10k worst case stated; do **not** block the stack on measurement |
| 6 — semantic Locked bypass: limit or blocker? | #467 (`userBackground.promotion`) | If a blocker, the user-background preset ships `guarded` and Q2 answers itself — and the paraphrase family (§3.3.A) cannot flip to `hard` until an approval gate exists |

Open Q3 (visible memory markers) and Q5 (ADR-0008 status header) are docs-only and land in #475.

### Preconditions outside this stack

- **B-3 (Decision 15).** Five named greps against `codegen-patterns`, run by someone with repo access, **before the ADR is accepted**. Not blocking #460–#464 (none touch an externally-typed surface); blocking #466 (`label` on the record) and #473 (`AgentPromptSectionData`).
- **The `mem/*` release stack must merge to `main`** before #476. `origin/main` reads core 0.16.0 / lockstep 0.37.0 while npm `latest` is core 0.17.0 / runtime 0.38.0, so a relative bump lands on already-published versions that `scripts/publish.sh` skips **silently**.
- **`evals/` is not on `main`.** It lives on `mem/m8c-eval-memory` (commit `846c0ac`). #460 and #461 are edits *in place on that branch* if it has not merged, so that step 1 is a precondition rather than a follow-up.

---

## 1. Issue list (one line each)

| # | Title | Stage | Depends on |
|---|---|---|---|
| #460 | eval harness runs on the shipped SQLite backend, per-family temp db, exit-2 on unavailable | 0 instrument | — |
| #461 | eval family gate tiers (`hard` / `xfail-strict`) + `memory-paraphrase` and `memory-portability` families, landing red | 0 instrument | #460 |
| #462 | one shared `tokenize()`; in-memory adopts token semantics; SQLite OR-joins sub-tokens | 1 portability | #461 |
| #463 | conformance Tier 1 / Tier 2 split — shared corpus, match sets, batch-tie pin, multi-token combinator case | 1 portability | #462 |
| #464 | tolerant stored-`target` read: one bad row degrades instead of killing a partition's recall | 1 portability | #463 |
| #465 | `molecules/memory-routing.ts` — `Placement` (background arm only), `placementKey`, spec interfaces, no-emit structural test | 2 routing types | #464 |
| #466 | additive `label?` on `MemoryRecordSchema` / `MemoryWriteInputSchema` / `SaveParamsSchema` + Manual guidance | 2 routing types | #464, ADR open Q1, B-3 |
| #467 | `presets/memory/` — user-background + project vocabularies, routing spec instances, resolve-by-name + `memory-routing` and `memory-declaration` eval families | 2 routing types | #465, #466 |
| #468 | `Background` gains `sections[]` + `entries[]` — byte-identical, `merge()` override, `AgentConfig` ctor normalization, `RolesPage` key-count fix | 3 reshape | #464 (parallel with stage 2) |
| #469 | promotion rows: `placement` / `specKey` / `specVersion` / `promotedAt` / tier + placement-keyed lookup + Tier-1 coverage | 4 overlay | #465, #467 |
| #470 | `applyMemoryOverlay(config, placed, spec)` — authored-wins, newest-wins + id-asc, budgets, drops report, freeze discipline, markdown escaping + `memory-overlay` eval family | 4 overlay | #467, #468, #469 |
| #471 | `target` leaves `memory_save`; D2 gate rekeys onto the committed placement; recall candidacy predicate; composed-id dedupe | 4 overlay | #469, #470 |
| #472 | instantiate seam applies the overlay; `agent.memory.overlay` event; `memory-paraphrase` flips `xfail` → `hard` | 4 overlay | #470, #471 |
| #473 | `fragments?` on `AgentPromptSectionData`, `renderFragments?` on `PromptSection`, `ContextSection` partition, server mirror + `Equals<>` drift guard | 5 attribution | #468, #472 |
| #474 | dashboard `PromptFragment` mirror + attributed spans and memory chips | 5 attribution | #473 |
| #475 | docs sweep — `guide.md` ×4, `evolution-cookbook.md` ×2 + six `bytesPerPrimitive` sites, ADR-0008 status header | 6 close-out | #472 |
| #476 | `bash scripts/bump.sh --lockstep 0.39.0 --core 0.18.0` + CHANGELOG | 6 close-out | #474, #475 |

Every issue is independently green under `bun run check`. Three are green-but-inert on their own (#465, #466, #469 ship types and surfaces nothing calls yet) — that is deliberate; each is a small, reviewable, revertible unit whose consumer is the next issue.

---

## 2. Sequencing argument

### 2.1 The instrument precedes every retrieval change — non-negotiable

`evals/memory-behavior/run.mts` constructs `new InMemoryMemoryStore()` per family (`:453`) and per case inside `budgetTarget()` (`:355`), while the shipped companion boots `loadMemoryStore()` → `SqliteMemoryStore`. These two backends do not agree on what a match is:

- **In-memory matches substrings** (`store.ts:223-228`, `haystack.includes(token)`) so `"prefer"` hits `"Prefers"` and `"am"` hits `"name"`. FTS5 matches whole tokens and returns zero for both.
- **Batch-tie order is reversed.** Both stores assign one `now` per batch (`store.ts:139`, `sqlite-store.ts:258-259`), so `write([a,b,c])` produces three records with identical `createdAt`; in-memory then resolves by insertion order and SQLite by `seq DESC` — `limit: 2` returns *different records*, which `sqlite-store.ts:243-248` currently blesses as "outside the contract".

So the `memory-recall-cite` family currently scores the substring matcher, and the `memory-budget` family's truncation choice depends on an ordering that is inverted in production. The README's "5/5 PASS" is a true statement about a backend nobody ships.

The consequence is not that the numbers are slightly off. It is that **no claim of the form "routing improved recall" is falsifiable** until the harness runs the shipped backend. #460 is therefore not a chore that can slip to the end — it is the measuring instrument, and it must be calibrated before anything it measures moves.

Acceptance for #460 explicitly includes a **re-baseline**: any of the five existing families that flips status under SQLite must be recorded in the README with the reason, never repaired by loosening the assertion.

### 2.2 The failing eval precedes the fix, not the other way round

A family authored after its feature lands has never been observed to fail. It is a regression test. Doug asked for evals that let this keep being refined, which requires families that are *live tripwires* — and the only proof a tripwire is armed is watching it trip.

`memory-paraphrase` and `memory-portability` therefore land in **#461**, red, before any of the work that fixes them. #461 introduces the `gate: "xfail"` tier precisely so a red family can be committed without bricking `just eval-memory` — with **strict** semantics (§3.2): an `xfail` family that *passes* fails the run, so the tier cannot become a graveyard for permanently-red families nobody re-reads.

### 2.3 Tolerance ships a release before the vocabulary moves

Decision 14 is reproduced fact: rewriting one row's `target.section` to an unrecognised value makes **every query-less listing on that partition throw**, because `_rowToRecord` (`sqlite-store.ts:477-495`) runs `MemoryRecordSchema.parse` inside `rows.map`. One bad row kills the partition's recall; it does not skip a record. And the query-less listing is exactly the profile tier (`recall.ts:152-158`) — the phrasing-proof tier this whole program leans on.

The failure is asymmetric in *time*: a reader at version N-1 encountering a row written at version N detonates. So the tolerant read (#464) must be published and installed **before** anything writes a value the old reader does not recognise. That places #464 ahead of #465/#466/#467 in the stack even though it shares no code with them.

`#462 → #463` for the mirror-image reason: the kit cannot pin semantics the two backends do not yet share, and pinning them in the same PR as the behaviour change makes an intentional match-set diff indistinguishable from a bug.

### 2.4 Promotion rows precede the gate rekey (the correction from §0.1)

Decision 9's precondition is unimplementable as stated. Under recommendation (a), the rekeyed D2 gate resolves a pending write's address and looks for an existing **committed placement** at that address — which requires the promotion-row surface to exist and to be queryable by `placementKey`. Hence `#469 → #471`, and the placement-keyed lookup is a promotion-row operation rather than a `MemorySearchQuery` field.

This also disposes of the `COLLISION_SCAN_LIMIT` cost the ADR flags as an open risk: the gate stops paying an unfiltered 500-record recency page per write and pays one exact-key lookup instead. The 500-record blind spot (`toolbox.ts:67-75`) disappears with it, for promoted records.

### 2.5 The reshape is parallelisable; the overlay is the join point

#468 (the `Background` reshape) touches core atoms, is proven byte-identical, and has zero routing dependency — it can land any time after #464 and in parallel with stage 2. #470 is where the two arms join: it needs the reshaped atom to write into and the routing spec to be told where.

Keeping the reshape in its own PR is not stylistic. Its entire safety argument is "zero rendered bytes change, snapshots pass with **no `-u`**" (`ADR-0005:133-138`). Any PR that also changes prompt bytes destroys the ability to make that claim, and makes an intentional diff indistinguishable from a regression. This is why the `##`-inside-`## Context` fix and the `## Current State` / `State`-atom collision are explicitly **not** in this stack (ADR Rejected alternatives; Follow-ups Phase C).

### 2.6 Attribution last

`fragments` (#473) is the only change in the stack that widens two hand-mirrored declarations across three packages with only one of them compile-guarded. It depends on the reshape (for `BackgroundEntry.memoryIds` to exist) and on the overlay (for anything to actually be `source: "memory"`). Landing it last means the drift guard is written against a surface that has stopped moving.

### 2.7 Version bump last, and only after the release stack merges

`#476` is last for the mechanical reason in §0: `origin/main` disagrees with npm `latest`, and `scripts/publish.sh:127-131,160-163` skips already-published versions in silence. Absolute versions (`--lockstep 0.39.0 --core 0.18.0`), never `minor`.

---

## 3. Eval design

### 3.1 What exists today

`evals/memory-behavior/run.mts` (588 lines, branch `mem/m8c-eval-memory`) — five families, `just eval-memory [ARGS]`, exit `0` gate pass / `1` gate failure / `2` config error. The properties worth preserving verbatim:

- **Store-state scorers.** Memory behaviour is a side effect, so scorers close over the family's store and assert what was *written* (`storeGainedRecord`, `storeSuperseded`, `storeWritesConfined`), not just what was said. This is the pattern every new family extends.
- **The three-term gate** (`:526-530`): node errors, *scorer* errors, and an empty `passRate` map all fail. "No gated scorers" cannot print PASS.
- **Malformed expectations ERROR** rather than passing vacuously (`:99-101`, `:118-124`).
- **Deterministic families are `FunctionStep` targets with no model** and persist under a distinct `targetId` (`:466`), because Phase C keys promotion decisions on `targetId`.
- **Per-family isolation**: fresh store + freshly built companion per family; the budget family builds a fresh store *per case*.

### 3.2 Two harness changes (#461)

**(1) `gate: "hard" | "xfail"` on `Family`, with strict semantics.**

```
hard   family fails  → FAIL, sets anyGateFailed
       family passes → PASS

xfail  family fails  → XFAIL <name> (expected: <reason> · unblocked by <issue>) — does NOT set anyGateFailed
       family passes → XPASS <name> — promote to gate:hard   AND SETS anyGateFailed (exit 1)
```

The `xfail` → *pass* direction failing the run is the whole point: it forces the tier to be emptied as the stack lands, and it catches the case where a family goes green for an accidental reason. Each `xfail` family carries `reason: string` and `unblockedBy: string` (the issue that flips it), both printed on every run so a red family cannot quietly become scenery.

**(2) Per-family SQLite isolation (#460, listed here because it changes the same seam).**

```
loadMemoryStore({ path: join(tmpdir(), `ap-eval-${family}-${randomUUID()}.db`) })
```

Explicit `path`, **never** a process-wide `AP_MEMORY_DB_PATH` — a global would be picked up by any other in-process `loadMemoryStore()` call and one typo points the evals at the user's real `~/.local/state/ap/memory.db`. `store.close()` + `unlink` in the existing `finally`. **Exit 2 if `loadMemoryStore` reports `unavailable`** on either failure path — it silently returns an `InMemoryMemoryStore` when the driver is missing *and* when construction throws, which is exactly the bug being fixed; a soft degrade would re-introduce it under a different name.

A `--store=sqlite|memory|both` matrix flag is the behavioural counterpart to the conformance kit and is a cheap follow-up, not a #460 requirement. The `memory-portability` family (§3.3.B) covers the important half.

### 3.3 New families

Five deterministic, one live. Deterministic wherever the assertion allows it: every assertion below except A2 is about *what the framework composed*, which is a pure function of stored state and needs no model.

---

#### A. `memory-paraphrase` — the reported bug, as a gate

**A1 — `memory-paraphrase` (DETERMINISTIC).** The assertion is on the **delivered prompt**, not on the recall block. This matters: after the fix, identity is *composed*, so the recall block is legitimately empty and a recall-block assertion would go green for the wrong reason (or stay red for the right feature).

- *Target:* a `FunctionStep` that, per case, builds a fresh SQLite store, seeds records, resolves the agent's routing spec, applies the overlay, and returns `{ prompt: agent.renderInitialPrompt({ recall }), report }` — with `recall` produced by `assembleRecall(store, scope, { query: case.input })`. Before #472 the overlay step is absent and the step returns the un-overlaid prompt; this is what makes the family fail honestly rather than error.
- *Seed:* `{ kind: "fact", content: "The user's name is Doug." }` — deliberately **not** `kind: "profile"`. The profile tier already works (ADR-0009 Context); the residue is a `fact`/`preference` whose wording misses the question, and that is what this family pins. A second seed `{ kind: "preference", content: "Uses the metric system." }`.
- *Cases* (`cases/paraphrase.jsonl`), each `{ input: <question>, expected: { promptMustContain: [...] } }`:
  | id | question | expects |
  |---|---|---|
  | `para-who-am-i` | "who am I?" | `["Doug"]` |
  | `para-tell-me-about-myself` | "tell me about myself" | `["Doug"]` |
  | `para-unrelated-still-composed` | "tell me a joke" | `["Doug"]` |
  | `para-units` | "should I use feet or metres?" | `["metric"]` |
  | `para-negative-control` | "who am I?" | `mustNotContain: ["launch code"]` (a foreign-partition seed) |
- *Scorers:* `prompt-contains` (mirrors `responseContains` against `output.prompt`), `prompt-omits` for the negative control, and `overlay-report-nonempty` — `report.composed` must be non-empty, so the family cannot pass because the fact happened to land in the *recall* block instead of the composition.
- *`para-unrelated-still-composed` is the load-bearing case.* It is the one no amount of better search can satisfy — it is only satisfiable by composition, which is the ADR's whole thesis.

**A2 — `memory-paraphrase-live` (LIVE).** The user-visible half. Same seeds, companion as target, `responseContains` scorer, cases `"who am I?"` / `"tell me about myself"` expecting `"Doug"`. Kept separate from A1 so a model regression cannot mask a composition regression and vice versa.

**Status:** both land in **#461** as `gate: "xfail"`, `unblockedBy: "#472"`. Both flip to `hard` in #472.

---

#### B. `memory-portability` — D-3 at the eval layer (DETERMINISTIC)

The conformance kit pins portability at the unit layer; this family pins it at the behaviour layer, and it is the one new family that fails today for a reason other than "the feature does not exist".

- *Target:* a `FunctionStep` that builds **both** an `InMemoryMemoryStore` and a temp-file `SqliteMemoryStore`, writes the identical corpus to each, runs `assembleRecall(store, scope, { query })` against both, and returns `{ inMemoryIds, sqliteIds, inMemoryBlock, sqliteBlock }`.
- *Scorer* `recall-match-set-parity`: the two id **sets** are equal (sorted, never order — total rank order is explicitly not pinned, ADR Decision 13). A second scorer `recall-tie-parity` writes three records in **one** `write([a,b,c])` call and asserts a `limit: 2` listing returns the same two ids from both backends.
- *Cases* (`cases/portability.jsonl`) reuse the Tier-2 corpus from #463 so the two layers cannot drift: `"prefer"` (stemming), `"am"` (substring), `"cafe"` (diacritics), `"dark-mode"` (punctuation split), and — the case the critic found missing — a **multi-token query whose tokens do not co-occur in one record**, which is the only case that distinguishes OR from AND and therefore the only one that would catch a Postgres backend declaring `"keyword"` and defaulting to `plainto_tsquery` AND.

**Status:** lands in **#461** as `gate: "xfail"`, `unblockedBy: "#463"`. Expected **FAIL today** — measured divergences: `"am"` and `"prefer"` return hits in-memory and zero on SQLite; `"cafe"` returns a hit on SQLite and zero in-memory; the batch-tie case returns *different records*. Flips to `hard` in #463.

---

#### C. `memory-routing` — lands where the spec routes it, and nowhere else (DETERMINISTIC)

- *Target:* a `FunctionStep` that resolves the preset spec, evaluates `route(record, ctx)` for the case's record, and — when a placement results — applies the overlay to a fixture config, returning `{ placement, config: config′, report }`.
- *Scorers:*
  1. `route-placement` — `placementKey(placement)` equals the case's `expected.placementKey`, or `placement === null` when `expected.placementKey === null`.
  2. `section-isolation` — the entry appears in **exactly one** declared section of `config′.background.entries`. This is the "and NOT elsewhere" half, and it is what catches a spec that fans out.
  3. `key-stability` — routing the same record twice yields the same `placementKey` (the `label` slugification and the content-derived fallback must both be deterministic).
- *Cases* (`cases/routing.jsonl`) — the family is only a gate because of the last three:
  | id | record | expects |
  |---|---|---|
  | `route-profile-identity` | `kind:"profile"`, `label:"name"`, "The user's name is Doug." | `background/userIdentity/name` |
  | `route-preference-theme` | `kind:"preference"`, `label:"theme"`, "prefers dark mode" | `background/userPreferences/theme` |
  | `route-two-facts-two-keys` | two `kind:"profile"` records, labels `name` / `timezone` | two **distinct** placement keys — the catastrophic-collision case the ADR's Decision 5 exists to prevent |
  | `route-episode-declines` | `kind:"episode"`, "we debugged the parser on Tuesday" | `null` — a spec that routes everything fails here |
  | `route-no-label-falls-back` | `kind:"profile"`, no `label` | a content-derived key, non-empty, stable across two evaluations |
  | `route-project-vocabulary-isolated` | a project-preset record against a user-preset agent | `null` — vocabularies do not leak between presets |

**Status:** lands **with #467**, `gate: "hard"` from birth. It cannot be authored earlier — the module does not exist — so it is a regression gate rather than a bug tripwire, and the plan says so plainly. Its *tripwire* value is against plausible wrong implementations: `route-episode-declines` and `route-project-vocabulary-isolated` both fail against an over-eager spec, and `route-two-facts-two-keys` fails against every fixed-key-per-`kind` design the ADR's Decision 5 rejects.

---

#### D. `memory-declaration` — refused and REPORTED, never silently dropped (DETERMINISTIC)

This is the family that would have caught the design ADR-0009 Decision 10 refutes (undeclared section as a throw), and it is armed against its return.

- *Target:* a `FunctionStep` over a fixture **agent B that declares no user-background section** (D-1: opting out is the supported path). It performs, in order: `memory_save` of a profile fact → `assembleRecall(...)` → `applyMemoryOverlay(config, placed, spec)`, and returns `{ saveResult, recallResult, config: config′, report, searchAfter }`.
- *Scorers* — five, and each is a distinct failure mode:
  1. `no-throw-on-save` — `memory_save` resolved. A throw makes the step error, which the three-term gate turns into a family FAIL.
  2. `no-throw-on-recall` — `assembleRecall` resolved. The refuted design would brick this on the **first-user-message critical path**; this scorer is that specific tripwire.
  3. `decline-reported` — `report.drops` contains exactly one entry for the record with `reason === "undeclared-section"`. Absence *and* silence both fail: this is the "reported, not dropped" assertion, and it is scored on the report, never on the absence of an entry.
  4. `sections-unchanged` — `config′.background.sections` deep-equals `config.background.sections`. Mechanical D-2: memory may fill, never declare. A fold that mints a section fails here.
  5. `still-recall-reachable` — `searchAfter` still returns the record. Declining composition must not remove it from the store (`0008:116` calls a never-promoted candidate staying recall-tier the *correct* failure mode).
- *Cases* (`cases/declaration.jsonl`): `decl-undeclared-section`; `decl-locked-section` (section declared with `promotion: "locked"` → declined with a *different* reason, so the two decline paths cannot be conflated); `decl-authored-collision` (address held by authored config → `reason: "authored-wins"`, and the authored value is what renders).

**Status:** lands **with #470**, `gate: "hard"`.

---

#### E. `memory-overlay` — authored-wins, determinism, marked spill (DETERMINISTIC)

Three case groups, one family, because they share a target and differ only in fixture.

- *Target:* a `FunctionStep` returning `{ config: config′, report, prompt: agent.renderInitialPrompt() }` for a fixture config + a seeded record set.
- **E1 authored-wins.** Authored entry at `(userIdentity, name) = "Douglas"`; a memory record routing to the same address with `"Doug"`. Scorers: `prompt-contains ["Douglas"]`, `prompt-omits ["Doug"]` (as a standalone token), `drop-reason === "authored-wins"`. A fold that lets the newer memory overwrite authored config fails all three.
- **E2 deterministic collision — the B-2 pin.** Two memory records at the same address, written in **one** `store.write([a, b])` call so `createdAt` ties *by construction* (`store.ts:139`, one `now` per batch). Scorers:
  - `fold-stable` — 20 repeated folds over the same input produce byte-identical `config′`.
  - `fold-order-invariant` — folding the **shuffled** record array produces byte-identical `config′`. This is the scorer that fails against any implementation whose order comes from store page order.
  - `tiebreak-id-ascending` — the surviving entry is the one whose record id sorts first with raw `<` (never `localeCompare`).
  - A third case with **distinct** `createdAt` (a `tick()` between writes) asserts **newest-created wins**, which is the direction ADR-0009 Decision 8 settles against `guide.md:354`.
- **E3 marked spill.** A section budget small enough that *k* of *n* entries do not fit. Scorers: `spill-reported` (`report.drops` carries `reason: "budget"` with exactly the expected record ids — never a silent omission), `budget-respected` (rendered background chars ≤ budget), `whole-entry-granularity` (no entry appears partially rendered), `spill-order` (`supports.length` DESC → `createdAt` DESC → `id` ASC, per ADR Known-limits), and `ceiling-reachable` — a fixture that breaches the composition-wide ceiling sets `ceilingBreached: true`, which fails against the arithmetic defect the critic found (per-primitive budgets summing exactly to the ceiling make `ceilingBreached` unreachable dead code).

**Status:** lands **with #470**, `gate: "hard"`.

### 3.4 Isolation, and what "isolation" has to mean here

| Family | Store | Granularity | Why |
|---|---|---|---|
| existing five | temp SQLite | per family (budget: per case) | #460; per-case for budget because a shared closure let case 2 run against case 1's writes |
| `memory-paraphrase` | temp SQLite | **per case** | each case seeds and folds independently; a shared store would let case *n* pass on case *n-1*'s composition |
| `memory-paraphrase-live` | temp SQLite | per family | live; seeds are read-only for the family |
| `memory-portability` | one in-memory **and** one temp SQLite | per case | the whole assertion is a cross-backend comparison over an identical corpus |
| `memory-routing` | none (pure `route()`) + a fixture config for the isolation scorer | per case | `route` is pure; the overlay half needs a virgin config |
| `memory-declaration` | temp SQLite | per case | asserts store state *after* a declined fold |
| `memory-overlay` | temp SQLite | per case | E2's 20-fold stability assertion must not see another case's records |

Every temp db is `join(tmpdir(), \`ap-eval-<family>-<uuid>.db\`)`, closed and unlinked in `finally`. No family ever touches `~/.local/state/ap/memory.db`.

### 3.5 Expected status board

| Family | Mode | Today | Lands at | Gate at landing | Flips to `hard` at |
|---|---|---|---|---|---|
| `memory-recall-cite` | live | PASS (on in-memory) | exists | `hard` | — · **re-baseline at #460** |
| `memory-save-on-instruction` | live | PASS | exists | `hard` | — |
| `memory-supersede` | live | PASS | exists | `hard` | — |
| `memory-scope-confinement` | live | PASS | exists | `hard` | — |
| `memory-budget` | det | PASS (on in-memory) | exists | `hard` | — · **re-baseline at #460** |
| `memory-portability` | det | **FAIL** | #461 | `xfail` | #463 |
| `memory-paraphrase` | det | **FAIL** | #461 | `xfail` | #472 |
| `memory-paraphrase-live` | live | **FAIL** | #461 | `xfail` | #472 |
| `memory-routing` | det | n/a (module absent) | #467 | `hard` | born hard |
| `memory-declaration` | det | n/a (overlay absent) | #470 | `hard` | born hard |
| `memory-overlay` | det | n/a (overlay absent) | #470 | `hard` | born hard |

**Three families are expected to fail on landing, and that is the point.** `memory-paraphrase` failing is the reported bug, reproduced as a committed artefact. `memory-portability` failing is D-3's debt, made visible. A family that cannot fail is not a gate; a family that has never been *seen* to fail is a regression test wearing a gate's clothes — which is what `memory-routing`, `memory-declaration` and `memory-overlay` are, honestly labelled.

**Re-baseline obligation at #460.** `memory-budget`'s truncation choice depends on batch-tie order, which is reversed on SQLite; `memory-recall-cite` depends on the model's own search wording surviving token semantics. Either may flip. The PR records the new baseline in the README with the reason. Repairing a flip by loosening an assertion is an explicit review-block.

---

## 4. Issue detail

Each block below is the seed for a full house-format spec at `.ai-docs/stacks/memory-routing/specs/<n>-<slug>.md`.

---

### #460 — eval harness runs on the shipped SQLite backend

**Objective.** Point every eval family at the backend the companion actually ships on, so the harness can measure a retrieval change. Per-family temp db, explicit path, hard failure on backend unavailability.

**Scope.** `evals/memory-behavior/run.mts` (`:355` budget target, `:453` per-family store, imports), `evals/memory-behavior/README.md`. Branch `mem/m8c-eval-memory` if unmerged.

**Acceptance.**
- No `InMemoryMemoryStore` construction remains in `run.mts` (the `memory-portability` family later reintroduces one *deliberately*, inside its own target).
- Stores come from `loadMemoryStore({ path })` with an explicit per-family/per-case temp path; no `AP_MEMORY_DB_PATH` is read or set.
- `unavailable` from `loadMemoryStore` on **either** failure path → `process.exit(2)` with a message naming the missing driver.
- `store.close()` + `unlink` in the existing `finally`; no temp file survives a run.
- `just eval-memory --dry` exits 0.
- A full live run is recorded in the README with per-family status. Any flip vs the prior in-memory baseline is documented with its cause.

**Out of scope.** New families; the `--store` matrix flag; touching `packages/`.

**Depends on.** —

---

### #461 — family gate tiers + `memory-paraphrase` and `memory-portability`, landing red

**Objective.** Add `gate: "hard" | "xfail"` with strict semantics, then commit the two families that fail honestly today.

**Scope.** `evals/memory-behavior/run.mts` (`Family` type, the gate block at `:526-537`), new `cases/paraphrase.jsonl`, `cases/paraphrase-live.jsonl`, `cases/portability.jsonl`, README.

**Acceptance.**
- `Family` gains `gate`, and `xfail` families additionally require `reason` and `unblockedBy`, both printed every run.
- An `xfail` family that FAILS prints `XFAIL` and does **not** set `anyGateFailed`. An `xfail` family that PASSES prints `XPASS … promote to gate:hard` and **does** set `anyGateFailed`.
- `memory-paraphrase` (det, per-case store), `memory-paraphrase-live` (live), `memory-portability` (det, dual-backend) land per §3.3.A/B with the case tables as specified.
- A run on unmodified `packages/` prints exactly three `XFAIL` lines and exits **0**.
- The negative-control case (`para-negative-control`) and the disjoint-token portability case are present — a family without them is not a gate.

**Out of scope.** Any change under `packages/`.

**Depends on.** #460.

---

### #462 — one shared `tokenize()`; both backends change

**Objective.** Remove the substring/token divergence without creating a new one. `InMemoryMemoryStore` adopts token semantics; `SqliteMemoryStore` stops turning a punctuated query token into an FTS5 adjacency phrase.

**Scope.** `packages/agent-runtime/src/memory/tokenize.ts` (new, exported), `memory/store.ts:223-228`, `memory/sqlite-store.ts:377-385`, `memory/index.ts`, `memory/__tests__/store.test.ts`, `memory/__tests__/sqlite-store.test.ts`.

**Acceptance.**
- One exported `tokenize(text: string): string[]` — lowercase → NFD strip combining marks → split `/[^\p{L}\p{N}]+/u` → drop empties — used by **both** backends for query *and* haystack.
- SQLite OR-joins the resulting sub-tokens **individually**, not as one quoted phrase, so a punctuated query token does not become an adjacency requirement on one backend and an OR on the other.
- In-memory matches whole tokens: `"am"` no longer hits `"name"`, `"prefer"` no longer hits `"Prefers"`; diacritics fold so `"cafe"` hits `"café"`.
- `memory-portability` still `xfail` (it flips at #463 once the kit pins the contract) — but its scorers are expected to go green here; the `XPASS` fail is the signal to flip, and #463 is the flip.
- Every existing in-memory-backed test still green, or its expectation is updated with a one-line note. This is the change with the widest incidental blast radius in the stack.

**Out of scope.** bm25 in-memory (rejected: relocates the divergence to a `ts_rank` backend); total rank order.

**Depends on.** #461.

---

### #463 — conformance Tier 1 / Tier 2

**Objective.** Make the kit the portability contract D-3 says it is: universal tier + a `caps.search`-keyed tier over one shared corpus, asserting match **sets**.

**Scope.** `packages/agent-runtime/src/memory/conformance.ts`, `docs/memory/guide.md:536-537` (bullet deleted), `sqlite-store.ts:243-248` (the "outside the contract" comment corrected).

**Acceptance.**
- Tier 1 (universal) additionally pins: **batch-tie ordering** (`write([a,b,c])` in one call → a limited query-less listing returns the same ids from every backend, retiring the kit's `tick()`-around-every-assertion dodge at `conformance.ts:16-22`); and the placeholder for unknown-target tolerance that #464 fills.
- Tier 2 gated on `caps.search === "keyword"`, one shared corpus, table-driven **id-set** assertions (sorted; never order).
- Tier 2 contains a **multi-token case whose tokens do not co-occur in one record** — the OR-vs-AND combinator. Without it a Postgres backend declaring `"keyword"` passes everything and is still non-conformant.
- Tier 2 contains a **tag-only** match case (`sqlite-store.ts:82-85` stakes a tokenization-parity claim on the tags text that nothing currently tests).
- Total rank order is explicitly documented as **not** pinned, with the reason (pinning it forces bm25 in-memory and then fails `ts_rank`), and the two existing ordering invariants (`conformance.ts:244-260`) are retained.
- `runMemoryStoreConformance`'s new options argument is **optional with defaults**, so an external backend calling the 1-arg form still compiles (B-3 check 4).
- `memory-portability` flips `xfail` → `hard` and passes.

**Out of scope.** Expiry seeding (needs a store-protocol seed hook; flag as a Tier-1 gap in the module docblock).

**Depends on.** #462.

---

### #464 — tolerant stored-`target` read

**Objective.** One bad row must degrade, not detonate. Ships **one release before** any vocabulary change (§2.3).

**Scope.** `packages/agent-core/src/molecules/memory-record.ts:202` (target union), `:146-167` (`targetPayloadSchema` + its `never` guard), a new exported `isKnownTarget()` narrowing helper, `packages/agent-runtime/src/memory/toolbox.ts:128` (`MemoryRecordViewSchema`), `memory/conformance.ts` (Tier 1 pin), `memory/__tests__/`.

**Acceptance.**
- `MemoryRecordSchema.target` accepts a tolerant `{ primitive: string }` passthrough arm alongside `MemoryTargetSchema`.
- Reproduction test: a stored row with an unrecognised `target.section` is returned by `get` **and** by `search` (including the query-less listing) without throwing. Today this kills the partition via `sqlite-store.ts:477-495`.
- The three widened call sites keep exhaustiveness via `isKnownTarget()`, **not** by loosening the `never` guard.
- `MemoryRecordViewSchema` widens too, so a tolerated row can be serialized back to the model in a search hit or a conflict envelope.
- `MemoryWriteInputSchema` stays **strict** — tolerance is a read-path property.
- No SQL migration, no `PRAGMA user_version` bump (`target` is opaque JSON TEXT).

**Depends on.** #463.

---

### #465 — `molecules/memory-routing.ts`

**Objective.** The routing vocabulary, in core, calling nothing.

**Scope.** `packages/agent-core/src/molecules/memory-routing.ts` (new), `molecules/index.ts`, `packages/agent-core/src/molecules/__tests__/memory-routing.test.ts` (new).

**Acceptance.**
- `PlacementSchema` — **background arm only** in v1 (Decision 7): `{ primitive: "background", section: z.string().min(1), key: z.string().min(1) }`. The other five arms are deliberately absent, with the reason in the docblock.
- `placementKey(p): string` — total, injective, stable. Unit-tested for injectivity over a corpus including the `\0`-separator edge cases, and pinned as the replacement for `sameTarget`, whose awareness/recovery discriminant-only collapse (`toolbox.ts:100-101`) is recorded in the docblock as the bug this fixes.
- Type-only declarations for `MemoryRoutingSpec`, `CompositionSection`, `RoutableRecord`, `RoutingContext`, `PlacedRecord`, `RoutingReport`, `OverlayPlan`. All spec hooks pure and synchronous.
- **Structural no-emit test**, ported from `backpack.test.ts:344-351`: the module source contains no `emit`/`publish`.
- Core imports nothing new; no runtime edge.

**Depends on.** #464.

---

### #466 — additive `label?`

**Objective.** Give the spec a key segment the model can name without giving the model an address. **Blocked on ADR open Q1 and on B-3.**

**Scope.** `packages/agent-core/src/molecules/memory-record.ts`, `packages/agent-runtime/src/memory/store.ts:51-61`, `memory/toolbox.ts` (`SaveParamsSchema`), the memory Manual (`memory/toolbox.ts` manual text), tests.

**Acceptance.**
- `label?: z.string().min(1).max(64)` — additive optional on all three schemas. Every existing row parses; no exhaustive switch breaks (unlike a union widening).
- Manual guidance teaches `label` as *a name for the thing learned* — never a section, never a primitive. The Manual, not the schema, is what makes a model write good structural fields (the #451 lesson).
- Tool-schema byte diff recorded in the PR body: this changes the model-facing contract.

**Depends on.** #464 · ADR open Q1 · B-3 checks 1–3.

---

### #467 — `presets/memory/` + spec resolution

**Objective.** The vocabularies and the routing spec instances, per D-1. First issue where a memory can actually be routed.

**Scope.** `packages/agent-runtime/src/presets/memory/` (new: `user-background.ts`, `project.ts`, `index.ts`), `presets/index.ts`, spec resolution by name at the instantiate seam mirroring `capabilities` + `CapabilityResolver` (`agent-config.ts:68`, docblock `:13-16`), `presets/__tests__/`, plus the `memory-routing` and `memory-declaration` eval families.

**Acceptance.**
- `userBackgroundSections()` / `projectBackgroundSections()` return frozen `readonly CompositionSection[]` — vocabularies, not `Background` instances, so they compose (`[...user, ...project]`). Frozen for real (`Object.freeze`), matching the repo's stated convention rather than the word alone.
- Section ids are **persisted addresses** — a naming pass before merge, because renaming one later is a stored-placement migration. Titles are cosmetic; ids are not.
- `promotion` defaults per ADR open Q2; the user-background preset's value follows open Q6. If Q6 says "blocker", the preset ships `guarded` and the paraphrase flip at #472 is blocked on an approval gate — say so in the spec rather than discovering it at #472.
- Routing spec instances with pure sync `route`, keyed on `kind` + `label` + `tags`, with `key` derived from `label` (slugified) or a content-derived fallback.
- Keys are **not** enumerated per section — D-2's capability boundary is the section, and enumerating keys recreates Problem B one level down.
- `memory-routing` and `memory-declaration` eval families land `gate: "hard"` and pass. (`memory-declaration`'s overlay scorers are stubbed against the report shape until #470 — or the family lands whole at #470; the spec picks one and says which.)

**Depends on.** #465, #466.

---

### #468 — `Background` reshape

**Objective.** `sections[]` + `entries[]`, byte-identical rendering, no `-u`. The single riskiest core change in the stack, isolated so its safety claim is provable.

**Scope.** `packages/agent-core/src/atoms/background.ts`, `atoms/agent-config.ts` (ctor normalization — **mandatory**), `atoms/index.ts`, `organisms/build-agent-from-config.ts` (verify `:99` needs no change), `packages/agent-dashboard/src/pages/build/RolesPage.tsx:110,120`, core tests.

**Acceptance.**
- Schema per ADR Decision 3; the four legacy records **retained populated** — clearing them breaks four live non-snapshot wire assertions at `agent-server/src/__tests__/composition.test.ts:321,741,742,759`.
- `normalizeBackgroundInput()` runs in the ctor **before `super()`** (C1: no `ZodEffects`), declares **all four** legacy sections in canonical order whenever any is non-empty (the empirically-found merge-section-order corollary), folds legacy keys into `entries` skipping any `(section,key)` already present, and is **idempotent under `replace()`** (`base.ts:63-67`) — pinned by a fixpoint test.
- `AgentConfig`'s ctor pre-normalizes `data.background`. **Mandatory**: without it, C2's three raw `.parse()` sites (`agent-config.ts:63`, `:136`, `organisms/agent.ts:30`) present `sections: []` and the overlay declines every record — a silent total no-op.
- `merge()` overridden, merging by identity (`section.id`; `${section}\0${key}`) reproducing JS object-spread positioning. Pinned by the 8 merge-parity cases including the section-order flip.
- **`bun run test` green with no `-u`.** `renderer.test.ts.snap`, `agent.test.ts.snap`, `agent.test.ts:333-341`, `sections.test.ts:186`, `atoms.test.ts:245-259` all unchanged.
- `renderFragments()` ships as the D3 seam, unconsumed.
- `RolesPage` counts `entries`, not top-level keys — a regression **this change causes** (constant 4 → constant 6), not a deferrable pre-existing bug. `AgentLensPage.tsx:309` renders the blob opaquely and is checked for the same class of regression.
- An exported `migrateBackgroundData(raw)` helper ships as the deprecation seam for owning apps (no codemod — the equivalent would have to reach another repo's persisted rows).

**Out of scope.** The `##`→`###` nesting fix; the `## Current State` / `State`-atom collision. Both are prompt-*bytes* changes requiring `-u` and an eval re-baseline; bundling either destroys the byte-identity proof that is this PR's entire safety argument.

**Depends on.** #464. Parallelisable with #465–#467.

---

### #469 — promotion rows + placement-keyed lookup

**Objective.** The ADR-0008 D5 ledger surface, and the lookup the gate rekey actually needs (§0.1 / §2.4).

**Scope.** `packages/agent-runtime/src/memory/store.ts` (protocol), `memory/sqlite-store.ts` (table + migration), `memory/conformance.ts` (Tier 1), tests.

**Acceptance.**
- A promotion row carries `recordId`, `placement`, `placementKey`, `specKey`, `specVersion`, `promotedAt`, `tier`, `approver?`. It is a **side table**, closing `guide.md:576`'s open question in favour of the option this design requires.
- Exact-equality `placementKey` lookup scoped to a partition, conformance-pinned from day one (D-3: an unpinned match semantic is a divergence).
- Point-in-time reconstruction (`0008:82`) is pinned: the placements valid at time T fully determine the composition at T, *including* `specVersion`.
- Signals from `classifyThenRoute` have a column, unused in v1.
- New Tier-1 coverage for the surface; the options argument stays optional-with-defaults (B-3).

**Depends on.** #465, #467.

---

### #470 — `applyMemoryOverlay`

**Objective.** The pure fold. The join point of the two arms of the stack.

**Scope.** `packages/agent-core/src/organisms/apply-memory-overlay.ts` (new), `organisms/index.ts`, `molecules/memory-record.ts` (export or hoist the module-private `deepFreeze` at `:231-245` — **reuse, never re-implement**: its cycle-guard comment documents exactly the already-frozen-parent case this hits), core tests, plus the `memory-overlay` eval family.

**Acceptance.**
- Signature `applyMemoryOverlay(config, placed: PlacedRecord[], spec) → { config, report }`. `0008:7`'s `(config, records)` is unimplementable once placement lives on the promotion row; the runtime performs the join.
- **Determinism, pinned in this function's own unit tests** (not the conformance kit — D-3 governs *search* semantics and no backend can diverge on a pure core fold): authored-wins → memory-vs-memory (**newest `createdAt`**, tiebreak **`id` ascending** with raw `<`) → budget. Evaluation *order* is itself pinned, because otherwise the reported drop *reason* depends on write timing.
- Membership test is `Object.hasOwn`, never `key in obj` (prototype-chain false positives silently drop memories keyed `constructor`/`toString`) and never `obj[k] !== undefined`.
- **Copy/freeze discipline.** `AgenticModel` freezes one level (`base.ts:48`) and TS `Readonly<T>` is shallow, so `data.background.conventions[k] = v` typechecks and mutates the caller's authored config — which, since one `AgentConfig` is held across conversations, would leak one user's memories into every subsequent instantiate. A **named test** asserts the input config is unmutated. Build a fresh tree; share untouched subtrees; deep-freeze the result; document that this freezes subtrees shared with the input.
- **Idempotence** pinned: applying the overlay twice yields the same `config′`, and the second application does not re-report memory entries as `authored-collision`.
- **Markdown escaping.** `_formatDict` (`background.ts:47-61`) interpolates both `key` and `String(value)` unescaped on the scalar arm, the array arm **and** the recursive arm. Memory-derived keys reject newlines; memory-derived values are escaped for line-leading `#`, `-`, `*`, `>`. Pinned by a **multiline (`/m`)** structural test — a non-`/m` regex inspects only the first line and, under the fragment separator rule, would miss the injection entirely.
- One typed `drops` list (never parallel lists), **ids only, never record content** — the report feeds an SSE event and embedding content would leak user memories into telemetry.
- `ceilingBreached` must be **reachable**: the composition-wide ceiling sits strictly below the sum of per-primitive budgets, or the flag is dead code. Pinned by an eval case (§3.3.E3).
- `memory-declaration` and `memory-overlay` eval families land `gate: "hard"` and pass.

**Depends on.** #467, #468, #469.

---

### #471 — rewire `memory_save`, the D2 gate, and recall candidacy

**Objective.** Withdraw the model's addressing authority and move the gate onto the derived address.

**Scope.** `packages/agent-runtime/src/memory/toolbox.ts` (`SaveParamsSchema:137`, `MemoryRecordViewSchema:128`, the D2 gate at `:307-336`, `sameTarget:92-107` deleted), `memory/recall.ts:163-172`, tests.

**Acceptance.**
- `target` removed from `SaveParamsSchema` and `MemoryRecordViewSchema`; retained on `MemoryWriteInput` for host/import paths; retained untouched on `MemoryRecord`, reinterpreted as advisory routing **input**.
- The D2 gate resolves the pending write's address via `route()` and looks up a **committed placement** (§0.1a) rather than scanning an unfiltered 500-record recency page. `COLLISION_SCAN_LIMIT`'s documented blind spot (`toolbox.ts:67-75`) disappears for promoted records; the spec states plainly that unpromoted near-duplicates are no longer gated, and why that is acceptable.
- The gate's guidance string is rewritten: it currently offers "supersede **or** change the target key" (`toolbox.ts:333`) and the model can no longer change a key. `label` restores a legitimate remedy; the guidance says so.
- `sameTarget` deleted; `placementKey` is the identity. Its awareness/recovery collapse dies with it.
- Recall candidacy: `record.target !== undefined` (`recall.ts:168`) becomes "routing would place it", computable in-process with no store change.
- **Composed-id dedupe** in `assembleRecall`, applied at the `visible()` post-filter seam (`recall.ts:149-150`) across **all three** tiers — this fixes a real double-render bug, since the candidate predicate matches promoted records that are already in the system prompt.
- The behaviour delta is measured, not asserted: the PR body records the before/after of the live families.

**Out of scope.** Overlay→recall **spill pinning**. ADR Known-limits names its three unmet requirements (a fetch path re-applying scope + validity filters, a cap so pinned spill cannot starve the hits tier, and the instantiate→first-message staleness window). v1 ships the dedupe and the report; the pinning is Phase C.

**Depends on.** #469, #470.

---

### #472 — instantiate seam applies the overlay

**Objective.** Make composition reach the delivered prompt. The issue that closes the reported bug.

**Scope.** the instantiate seam (ADR-0004), spec resolution by name, `agent.memory.overlay` event emission, `evals/memory-behavior/run.mts` (flip three families).

**Acceptance.**
- `instantiate` reads the store, joins records with promotion rows, resolves the spec by name, applies the overlay, and builds the delivered agent from `config′`. **Skippable when no store is wired** (`0008:106`) — an agent with no memory configured renders byte-identically to today.
- The overlay is always applied to the **stored authored config**, never to an already-overlaid one (idempotence is pinned at #470; the seam must not rely on it).
- `agent.memory.overlay` carries record count, `charsPerPrimitive` (**not** `bytesPerPrimitive` — `0008:80` and six cookbook sites contradict the chars pin and are corrected at #475), and per-reason drop counts.
- `memory-paraphrase`, `memory-paraphrase-live` flip `xfail` → `hard` and **pass**. This is the acceptance criterion that matters: the bug that opened the program is closed, measured on the shipped backend, by a family that was committed red.
- If ADR open Q6 resolved as "blocker", the user-background preset is `guarded` and this flip is blocked on an approval gate — in which case the spec must say what ships instead, because "the agent saves a fact and the fact never reaches the agent" is the originating bug as a default.

**Depends on.** #470, #471.

---

### #473 — fragment attribution (core + server)

**Objective.** ADR-0008 D3, expressible for the first time.

**Scope.** `packages/agent-core/src/rendering/sections/base.ts:11-27` (optional `renderFragments?`), `rendering/sections/context.ts`, `organisms/agent.ts:44-48` + the inline tuple type at `:139-141`, `packages/agent-server/src/routes/composition.ts:100` (export `AgentIntrospect`) and `:112` (mirror), `agent-server/src/__tests__/composition.test.ts` (drift guard), core + server tests.

**Acceptance.**
- `AgentPromptSectionData` keeps `name` / `source: "role" | "instance"` / `text` **unchanged** and gains `fragments?`. Section-level `source` stays two-valued: `0008:7` and `0008:65` contradict each other and **D3 governs** (ADR Decision 1).
- The fragment union carries a `"memory"` arm with non-empty `memoryIds` and `memoryChannel: "overlay" | "recall"`.
- **Partition invariant**, pinned in the existing `renderSections` describe block: `(s.fragments ?? [{text: s.text}]).map(f => f.text).join("") === s.text`. Separators fold **into** the slices — no `fragmentSeparator` field, because the two real producers already disagree (`background.ts:44` joins blocks with `\n\n`, `:60` joins lines with `\n`).
- Structural text (the `## Context` wrapper at `context.ts:21`, section headings) is `source: "instance"` **by rule**, so the partition is total.
- `ContextSection` does **not** split; the section list stays the exact six entries at `agent.test.ts:333-341`; zero snapshot bytes change.
- **Drift guard that actually works.** A plain assignability assertion is vacuous in both directions once the new field is optional. The guard is an `Equals<A,B>` conditional-type helper against `AgentPromptSectionData`, in `composition.test.ts` (which already imports core directly), and `AgentIntrospect` is exported to make it possible. The dashboard mirror has **no** cross-package import and stays hand-maintained — the spec says so rather than pretending otherwise.
- Documented asymmetry: the composition route calls `renderSections()` **nullary** (`composition.ts:687`) and never builds a `RenderContext`, so overlay-derived fragments appear in introspection and recall-derived ones do not.
- Documented rule: `source`/`memoryIds` are now authorable schema data, so **the overlay report is the display authority** — the dashboard must not resolve memory chips for attribution that merely appears in stored config.

**Depends on.** #468, #472.

---

### #474 — dashboard fragment chips

**Scope.** `packages/agent-dashboard/src/api/composition.ts:20-25`, `components/organisms/RenderedPromptView.tsx:5,45-70`.

**Acceptance.** `PromptFragment` mirror added with `"unknown"` retained defensively; `SOURCE_TONE` gains `memory`; sections render attributed spans with a per-fragment chip when `fragments` is present and fall back to the current single `<pre>` when absent (an un-upgraded server keeps working); `memoryIds` render as chips only for overlay-report-backed attribution (#473's display-authority rule).

**Depends on.** #473.

---

### #475 — docs sweep

**Scope.** `docs/memory/guide.md:354`, `:536-537`, `:578-586`, `:641`; `docs/memory/evolution-cookbook.md:30-33`, `:835`, and the six `bytesPerPrimitive` sites (`:175`, `:181`, `:321`, `:443`, `:571`, `:710`, `:737` — note the critic found `:571` missing from the ADR's list); `docs/adr/0008-compositional-memory.md` status header per ADR open Q5.

**Acceptance.** Every corrected line is quoted before/after in the PR body. `guide.md:578-586` — currently stating in bold that "the model *may* propose targets" and that `memory_save` **does** expose `target` — is reworded, not deleted, so a reader following a link lands on the new position. ADR-0008 gets at minimum a one-line header pointer: a fresh reader hitting `0008:99` unaided is the failure mode ADR-0009 exists to prevent.

**Depends on.** #472.

---

### #476 — version bump

**Scope.** `bash scripts/bump.sh --lockstep 0.39.0 --core 0.18.0`, CHANGELOG.

**Acceptance.** Absolute versions, never `minor` (a relative bump lands on published 0.17.0/0.38.0, which `publish.sh:127-131,160-163` skips **silently**). Precondition verified in the PR body: the `mem/*` release stack has merged to `main`. CHANGELOG names the two model-facing contract changes (`target` removed from `memory_save`, `label` added) and the in-memory search-semantics change.

**Depends on.** #474, #475.

---

## 5. Risk register

| # | Risk | Early warning | Rollback |
|---|---|---|---|
| R1 | **#462's token semantics break existing in-memory-backed tests broadly.** In-memory substring matching has been the de-facto contract for every test that seeds a store; whole-token matching is strictly narrower. | `bun run test` failures concentrated in `memory/__tests__/` and any runtime test that seeds a store — visible within one CI run of #462. | Revert #462 alone (it is self-contained: one new module, two call sites). The stack stalls at #461 with `memory-portability` still `xfail`, which is the honest state. |
| R2 | **The re-baseline at #460 is repaired by loosening an assertion** instead of being recorded, and the harness silently becomes weaker at exactly the moment it becomes authoritative. | Any diff in #460 that touches a `cases/*.jsonl` `expected` field or a scorer predicate. | Explicit review-block: #460 may edit `run.mts` and `README.md` only. A required expectation change means the family was measuring the wrong thing and needs its own issue. |
| R3 | **Routing accuracy is empirical and this stack cannot settle it.** A pure sync spec routes on structural signals and cannot route on prose. Whether `kind:"profile"` + a preset actually catches what a companion saves is unknown, and this design makes a wrong `kind` cost *placement*, not just recall quality. | `memory-paraphrase` stays red at #472 despite the overlay working; or `memory-routing`'s `route-no-label-falls-back` case producing unstable keys against real traffic. | The `label` fallback is the pressure valve: a spec can widen its `kind` mapping without a schema change. If accuracy is the blocker, the answer is a preset revision (a runtime change, no core release), not a stack revert. |
| R4 | **#468's byte-identity proof does not survive contact with `bun run test`.** The proof was constructed against the real class in a scratch script, not by running vitest, and two `toContain` sites (`sections.test.ts:186`, `atoms.test.ts:245-259`) were never executed. | The first `bun run test` on #468. Snapshot failures are unambiguous. | #468 is a single-package change with no consumers until #470. Revert it; the stack continues on the routing arm (#465–#467) while the reshape is re-proved. |
| R5 | **The §0.1 correction is wrong and the gate rekey needs record-level placement after all** — e.g. a requirement surfaces that unpromoted near-duplicates must be gated. | Discovered while speccing #471: the D2 gate's coverage regression is unacceptable to review. | Either accept the reduced gate coverage (documented) or move the gate to *promotion time* instead of write time — which is additive to #469 and does not touch the record schema. Storing a birth-time `routeKey` remains rejected. |
| R6 | **`guarded` as the default `promotion` ships the originating bug as the framework default.** No agent has a `HumanApprovalGate` wired; a guarded section means the agent saves a fact and the fact never reaches the agent. | `memory-paraphrase` cannot flip to `hard` at #472. This is a *designed* early warning: the family fails for exactly this reason and names it. | Ship the user-background preset as `auto` with the semantic-bypass limit stated (ADR Known-limits bullet 2), and make `guarded` the *documented* posture for anything an author adds. Reversible in a runtime preset, no core release. |
| R7 | **B-3 turns out to have a live external consumer** after #466/#473 land. | The five named greps in ADR Decision 15, run before acceptance. If they are skipped, the warning is a downstream build failure with no local reproduction. | `label` is an *additive optional* field — it does not break an exhaustive switch, unlike a union widening. `fragments?` is likewise optional. The exposure is real but bounded; the mitigation is #464's tolerant read, already shipped, which is what makes a late-discovered consumer survivable. |
| R8 | **Placements go stale.** They freeze at promotion with a `specVersion`; a section rename or a routing fix leaves prior placements pointing at an address that may no longer be declared, and there is no re-route/re-promote/migrate operation. | `memory-declaration`'s `decline-reported` scorer firing for records that were previously composing — visible as a composition that silently shrinks. | v1's answer is a decline with `undeclared-section` plus a lint entry (never a throw — the refuted design would brick instantiate). Section ids are treated as persisted addresses and get a naming pass at #467 precisely to make renames rare. A migration operation is deferred, explicitly. |
| R9 | **The `xfail` tier becomes a graveyard** — families sit red for months and stop being read. | Three or more `xfail` families outstanding for more than one merged issue; or an `xfail` reason string that no longer matches reality. | The `XPASS`-fails-the-run rule already prevents the silent-green half. For the silent-red half: each `xfail` carries `unblockedBy`, and the issue it names has flipping it as an acceptance criterion. If an `xfail` outlives its `unblockedBy` issue, that is a review-block on the issue, not a note. |
| R10 | **The overlay mutates the caller's authored config**, leaking one user's memories into every subsequent instantiate of a shared `AgentConfig`. The type system will not catch it: `AgenticModel.data` returns a *shallow* `Readonly<>`, so `data.background.conventions[k] = v` typechecks. | Nothing, until it is a cross-tenant data leak in production. This is the highest-severity failure in the stack and it is silent by construction. | Prevented, not rolled back: #470's acceptance includes a named unmutated-input test, and `deepFreeze` is **reused** from `memory-record.ts:231-245` rather than re-implemented — its cycle-guard comment documents precisely the already-frozen-parent case this hits, and a copy-paste re-implementation reintroduces that bug. |
| R11 | **The stack is 17 issues and the ADR is still `PROPOSED` with six open questions.** Four of them gate specific issues (§0). | Speccing #467 or #470 and finding the answer is "it depends on Q2/Q4/Q6". | Stage 0 and Stage 1 (#460–#464) depend on **no** open question and contradict **no** merged ADR. They can land as a small stack while the ADR is in review — which is also the sequencing the ADR itself recommends. Nothing after #464 should be specced until Q1, Q2 and Q6 are answered. |

---

## 6. What this plan deliberately does not cover

Phase C, per ADR Follow-ups: `lintComposition` over the overlay report; overlay→recall **spill wiring** with its cap and validity requirements; the `##` heading-depth and `## Current State` PR (deliberate snapshot update, its own eval re-baseline); awareness / judgment / example placement arms with their declaration surfaces; `corroborate` (without which the `earned` tier is inert for background); `classifyThenRoute` enablement (which needs either promotion-only evaluation or a pre-promotion annotation operation on the store protocol — both named in ADR Decision 11, neither solved).
