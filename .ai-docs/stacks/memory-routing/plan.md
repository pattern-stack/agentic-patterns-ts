# Stack plan — memory routing and Background composition

**ADR of record:** [`docs/adr/0009-memory-routing-and-background-composition.md`](../../../docs/adr/0009-memory-routing-and-background-composition.md) (PROPOSED · **revised 2026-08-08, compat constraints withdrawn** · 16 decisions · 8 open questions for Doug)
**Program:** #414 · **Epic:** #415 · **Supersedes in part:** ADR-0008 (atom-immutability promise only — D3/D4/D5/D6/D8 survive and are load-bearing here)
**Spec directory:** `.ai-docs/stacks/memory-routing/specs/` — one spec per issue, house format (`.ai-docs/stacks/memory-store/specs/422-recall-surface.md` is the reference shape: Objective / Scope (exact files) / API surface / Implementation strategy / Test plan / Acceptance / Out of scope).
**Issue numbers below are PROVISIONAL** (`#460`–`#476`). They are contiguous and unallocated as of writing; renumber at `sdlc:sync-issues` time and the spec filenames follow.

---

## 0a. Revision status — what has landed, and what the ADR revision changes here

**Landed (do not re-plan).** Stages 0 and 1 have been implemented and are in review:

| Plan issue | PR | State | Note |
|---|---|---|---|
| #460, #461 | #453 | **DONE** — open, awaiting merge | eval instrument + gate tiers + two red families |
| #462, #463 | #454 | **DONE** — open, awaiting merge | shared `tokenize()`, conformance Tier 1 / Tier 2 |
| #464 | #455 | **DONE, but SUPERSEDED** — open, must not merge as-is | see below |

Verified with `gh pr list`: all three are `OPEN` with `mergedAt: null`. Nothing in this stack is on `main` yet. Treat #460–#463 as complete work; do not re-spec them.

**#455 is the one exception and it is a real action item.** It ships the *field-specific* tolerant-`target` machinery — `UnknownMemoryTargetSchema`, `StoredMemoryTargetSchema`, `isKnownTarget()`, `MemoryRecordDegradation`, `readStoredMemoryRecord()` — as six new exported surfaces on `@agentic-patterns/core`. The revised ADR Decision 14 deletes `target` from the record entirely, so that machinery would defend a field that no longer exists and `MemoryRecordDegradation.field` would have zero inhabitants. **Close or rewrite #455 before merge** to the runtime-local form: a private per-row `try`/`catch` around `_rowToRecord` in `SqliteMemoryStore` that skips, counts and reports, with no core export, pinned in the SQLite suite rather than conformance Tier 1 (`InMemoryMemoryStore` never re-parses on read — `memoryRecord()` appears only at `store.ts:150,184,252`, all write paths — so a universal-tier test cannot construct the failure). That is strictly cheaper than what is on the branch, and it keeps the property — one bad row must not blind a partition's recall — which is correctness and survives the revision unchanged.

**What the ADR revision changes in this plan.** The context owner withdrew compatibility as a design criterion. Four structural consequences for the decomposition, each detailed in its issue block below:

1. **#468 is a different issue.** It no longer folds legacy records into new arrays byte-identically; it **deletes** them. `normalizeBackgroundInput`, the mandatory `AgentConfig` ctor pre-normalization, `migrateBackgroundData`, the 24 parity fixtures and the no-`-u` acceptance criterion all go away; the `###` heading fix across three files comes in. It stops being "the single riskiest core change in the stack" because the thing whose risk was being isolated no longer exists.
2. **#466 shrinks to `label` only, and #471 grows.** The `target`/`payload` deletion must land in the *same PR* as the D2 gate rekey — see §2.4a. This is a correctness constraint, not a preference.
3. **#473 is a different issue.** `text` leaves `AgentPromptSectionData`; `renderFragments` becomes required; the server mirror and the `Equals<>` drift guard are deleted in favour of a type-import plus wire-boundary normalization; `renderPath` and `memoryChannel` are both cut.
4. **#476 loses its release ceremony.** Absolute-version computation against npm `latest` and the "`mem/*` stack must merge first" precondition are compat sequencing and are void. Bump once, at the end, with whatever numbers are right then.

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

The ADR revision **closed two** of the original six (the `label?` additive-field question is moot — `label` replaces `target` and the record is a net field smaller; the ADR-0008 status header is settled as `SUPERSEDED IN PART`) and added three. Against the revised list, three block specific issues. Nothing downstream of them should be specced until Doug answers:

| Revised open Q | Blocks | If unanswered |
|---|---|---|
| 1 — default section `promotion`: `locked` or `guarded`? | #467 preset defaults, #470 admission | `guarded` with no `HumanApprovalGate` wired anywhere ships the originating bug as the framework default |
| 2 — semantic Locked bypass: limit or blocker? | #467 (`userBackground.promotion`) | If a blocker, the user-background preset ships `guarded` and Q1 answers itself — and the paraphrase family (§3.3.A) cannot flip to `hard` until an approval gate exists |
| 4 — budget digits | #470 | Ship as tunable defaults with the ~10k worst case stated; do **not** block the stack on measurement |
| 5 — how the overlay report reaches the lens | #473/#474 chips only | If unanswered, #473 ships the partition and #474 ships fragment spans **without** memory chips; the chips are a follow-up, not a blocker |
| 8 — section id/title naming pass | #467 | Now a **hard gate**: ids are persisted addresses and a rename is a stored-placement migration; no preset may re-pick the title `Current State` |

Revised Q3 (visible memory markers), Q6 (`label` vs `attribute` — an eval question) and Q7 (`asAgent()` role-sourced section) block nothing in this stack. Q3 lands in #475; Q6 is answered by running the `route-*` case table against two Manual phrasings; Q7 is a cheap follow-up.

### Preconditions outside this stack

- **B-3 (Decision 15) is a coordination item, not a gate.** Six named greps against `codegen-patterns`, run by someone with repo access. Under the withdrawn-compat ruling a positive hit is a conversation with a sibling team, not a reason to soften a decision. It is **sharper** than before, because three surfaces went from additive to wholesale: an exhaustive switch on `target.primitive` now breaks at the type level (loud — good), and the sixth grep (persisted `background.teamContext`/`projectContext`/`conventions`/`currentState` keys) is the one genuinely **silent** failure in the whole revision, since such a row parses to `{sections: []}` with Zod stripping the rest and no diagnostic. Run grep 6 before #468; run 1–3 before #471; run 5 before #473.
- **`evals/` is not on `main`.** It lives on `mem/m8c-eval-memory` (commit `846c0ac`). #460/#461 were edits *in place on that branch* (PR #453).
- ~~**The `mem/*` release stack must merge to `main`** before #476.~~ **Void.** This was version-sequencing ceremony against npm `latest`. The mechanical footgun remains worth remembering (`scripts/publish.sh:127-131,160-163` skips already-published versions silently), but it is a scripting hazard at bump time, not a precondition on the stack.

---

## 1. Issue list (one line each)

| # | Title | Stage | Depends on |
|---|---|---|---|
| ~~#460~~ | eval harness runs on the shipped SQLite backend, per-family temp db, exit-2 on unavailable | 0 instrument | **DONE — PR #453** |
| ~~#461~~ | eval family gate tiers (`hard` / `xfail-strict`) + `memory-paraphrase` and `memory-portability` families, landing red | 0 instrument | **DONE — PR #453** |
| ~~#462~~ | one shared `tokenize()`; in-memory adopts token semantics; SQLite OR-joins sub-tokens | 1 portability | **DONE — PR #454** |
| ~~#463~~ | conformance Tier 1 / Tier 2 split — shared corpus, match sets, batch-tie pin, multi-token combinator case | 1 portability | **DONE — PR #454** |
| #464 | ~~tolerant stored-`target` read~~ → **per-row read tolerance, runtime-local**: `_rowToRecord` skips + counts + reports, no core export, SQLite suite pin | 1 portability | **PR #455 open — rewrite per §0a before merge** |
| #465 | `molecules/memory-routing.ts` — `Placement` (background arm only), `placementKey`, spec interfaces, no-emit structural test | 2 routing types | #468 |
| #466 | additive `label?` on `MemoryRecordSchema` / `MemoryWriteInputSchema` / `SaveParamsSchema` + Manual guidance. **`label` ONLY** — the `target`/`payload` deletion moved to #471 | 2 routing types | — |
| #467 | `presets/memory/` — user-background + project vocabularies, routing spec instances, resolve-by-name + `memory-routing` and `memory-declaration` eval families | 2 routing types | #465, #466, #468 |
| #468 | **`Background` replaced**: one `sections[]` of nested entries, four legacy records deleted, uniqueness refine, scalar values + newline collapse, `merge()` override, `###` heading fix across `background.ts` / `awareness.ts` / `recall.ts`, `RolesPage` count fix | 3 reshape | — (parallel with #465/#466) |
| #469 | promotion rows: `placement` / `placementKey` / `keySource` / `specKey` / `specVersion` / `promotedAt` / tier + placement-keyed lookup + conformance coverage | 4 overlay | #465, #467 |
| #470 | `applyMemoryOverlay(config, placed, spec)` — authored-wins, newest-wins + id-asc, budgets, drops report, freeze discipline + `memory-overlay` eval family. **No escaping criterion** (#468 closes it structurally) | 4 overlay | #467, #468, #469 |
| #471 | **`target` + `payload` deleted** from record / write input / tool schema / SQLite DDL; `sameTarget` deleted; D2 gate rekeys onto the committed placement; recall candidacy predicate; composed-id dedupe — **all in one PR** | 4 overlay | #469, #470 |
| #472 | instantiate seam applies the overlay; `agent.memory.overlay` event; `memory-paraphrase` flips `xfail` → `hard` | 4 overlay | #470, #471 |
| #473 | `AgentPromptSectionData` = `{name, source, fragments}` (**`text` deleted**), required `renderFragments` on `PromptSection`, `PromptFragment` at layer 0, server type-import + wire normalization, `renderPath` deleted | 5 attribution | #468, #472 |
| #474 | dashboard `PromptFragment` mirror + attributed spans; memory chips gated on ADR open Q5 | 5 attribution | #473 |
| #475 | docs sweep — `guide.md` ×4, `evolution-cookbook.md` ×2 + the `bytesPerPrimitive` sites, **plus the deleted-vocabulary sweep (11 further sites)**, ADR-0008 status header | 6 close-out | #472 |
| #476 | version bump + CHANGELOG. No release ceremony | 6 close-out | #474, #475 |

Every issue is independently green under `bun run check`. Three are green-but-inert on their own (#465, #466, #469 ship types and surfaces nothing calls yet) — that is deliberate; each is a small, reviewable, revertible unit whose consumer is the next issue. **#471 is the one issue that may not be split**, for the reason in §2.4a.

**Dependency edge added by the revision: #468 → #465 → #467.** `RoutingContext.sections` is now `readonly Pick<BackgroundSection, "id"|"title"|"promotion">[]` — a projection of the reshaped atom's type rather than a separate `CompositionSection` — so the atom must exist before the routing types, and the presets follow. Under the old plan #468 was parallel to the whole routing arm; it now leads it, and is parallel to #466 only.

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

### 2.3 Read tolerance is a property, not a release-ordering constraint

The failure is reproduced fact: rewriting one row's `target.section` to an unrecognised value makes **every query-less listing on that partition throw**, because `_rowToRecord` (`sqlite-store.ts:477-495`) runs `MemoryRecordSchema.parse` inside `rows.map`. One bad row kills the partition's recall; it does not skip a record. And the query-less listing is exactly the profile tier (`recall.ts:152-158`) — the phrasing-proof tier this whole program leans on. **That property is correctness and is unchanged by the revision.**

What *is* void is the sequencing argument that used to sit on top of it: "the failure is asymmetric in time — a reader at version N-1 encountering a row written at version N detonates, so the tolerant read must be published and installed before anything writes a value the old reader does not recognise." That is forward-compat across published versions on a disposable db, and it is exactly what the ruling withdraws. #464 therefore has **no ordering constraint** relative to #465–#468; it is a ten-line runtime-local change that can land whenever.

It also shrinks. The version on PR #455 defends one field with six exported core symbols; the revised ADR deletes that field at #471, which removes the failure class at the source rather than absorbing it. What remains is a private per-row `try`/`catch` at `_rowToRecord`'s callers that skips the row, increments a counter and surfaces the count — and it must actually be implemented, not assumed to follow from a seam existing. Pin it in the **SQLite-specific** suite: `InMemoryMemoryStore` holds already-parsed frozen records and never re-parses on read, so a universal Tier-1 test cannot construct the failure. (Not a D-3 breach — D-3 governs search semantics.)

`#462 → #463` stands for the mirror-image reason: the kit cannot pin semantics the two backends do not yet share, and pinning them in the same PR as the behaviour change makes an intentional match-set diff indistinguishable from a bug. Both have landed on PR #454.

### 2.4 Promotion rows precede the gate rekey (the correction from §0.1)

Decision 9's precondition is unimplementable as stated. Under recommendation (a), the rekeyed D2 gate resolves a pending write's address and looks for an existing **committed placement** at that address — which requires the promotion-row surface to exist and to be queryable by `placementKey`. Hence `#469 → #471`, and the placement-keyed lookup is a promotion-row operation rather than a `MemorySearchQuery` field.

This also disposes of the `COLLISION_SCAN_LIMIT` cost the ADR flags as an open risk: the gate stops paying an unfiltered 500-record recency page per write and pays one exact-key lookup instead. The 500-record blind spot (`toolbox.ts:67-75`) disappears with it, for promoted records.

### 2.4a #471 may not be split — the field deletion and the gate rekey are one PR

This is the sharpest new sequencing constraint the revision introduces, and it is correctness, not tidiness.

The ADR-0008 D2 write-time collision gate (`toolbox.ts:307-336`) filters candidates on `record.target !== undefined && sameTarget(record.target, target)`. The revised ADR deletes `target` from `MemoryRecordSchema` and `MemoryWriteInputSchema`. If that deletion lands at #466 (where the record-shape change would naturally go) while the rekey waits for #469/#470, there are two outcomes and both are bad:

- If `SaveParamsSchema.target` is removed at the same time, the gate is **dead code** for three-plus merged PRs.
- If `SaveParamsSchema.target` survives — which it must, if the rekey has not landed — then `args.target` is written but **stripped by the record schema** (`z.object` defaults to `"strip"`), so `record.target` is always `undefined`, the filter never matches, and every targeted save silently succeeds instead of returning the conflict envelope.

The second is exactly the C2 failure class the ADR names: a feature that no-ops in silence because a value is parsed away at a boundary. And the plan requires every issue to be independently green under `bun run check`, which it would be — silently.

**So: #466 adds `label` only.** The record/write-input `target` and `payload` deletion, the `SaveParamsSchema` removals, `sameTarget`'s deletion, the SQLite DDL edit and the gate rekey all land together at #471, after #469's promotion-row lookup exists to rekey onto.

### 2.5 The reshape is parallelisable up to the presets; the overlay is the join point

#468 (the `Background` replacement) touches core atoms and has zero routing dependency — it can land in parallel with #465/#466. But the revision adds an edge: the preset vocabularies (#467) return a projection of the reshaped atom's `BackgroundSection` type, so **#468 must precede #467**. #470 is still where the two arms join: it needs the reshaped atom to write into and the routing spec to be told where.

**The reason for keeping the reshape in its own PR has changed.** It used to be "its entire safety argument is zero rendered bytes change, snapshots pass with **no `-u`**", so any PR that also moved prompt bytes destroyed the claim. Byte identity is dropped as a goal (ADR Decision 3): it bought only in-repo snapshot churn avoidance, and it was self-defeating, because the two rendering bugs it forced into a later PR move the same bytes anyway — scheduling one intentional diff across two review windows. The reason that survives is ordinary: it is one atom, one package, no consumers until #470, and it is trivially revertible.

Consequently the `##`→`###` nesting fix and the `## Current State` collision are **in** this stack, at #468, across all three producers (`background.ts`, `awareness.ts:152`, `recall.ts:79`). Fixing Background alone would leave `## Context` with mixed heading depths, which is worse than uniform depth. The eval re-baseline and prompt-cache invalidation are paid **once, for all three**, which is the main argument for bundling them.

### 2.6 Attribution last

`fragments` (#473) still lands last, but for a smaller reason than before: it no longer widens two hand-mirrored declarations with only one compile-guarded, because the server mirror is **deleted** in favour of a type-import from core and the `Equals<>` drift guard goes with it. What remains is that it depends on the reshape (for `BackgroundEntry.memoryIds` to exist) and on the overlay (for anything to actually be `source: "memory"`), and that deleting `text` from `AgentPromptSectionData` touches every reader — so landing it against a surface that has stopped moving is still worth something.

### 2.7 Version bump last, no ceremony

`#476` is last because it is a bump, not because of a release-ordering constraint. The old argument — `origin/main` disagrees with npm `latest`, so compute absolute versions rather than `minor` — was version-sequencing against published packages and is void under the ruling. The mechanical footgun survives as a note: `scripts/publish.sh:127-131,160-163` skips already-published versions **in silence**, so check what is published at bump time and pass absolute numbers.

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
  2. `section-isolation` — the entry appears in **exactly one** declared section: exactly one `s ∈ config′.background.sections` has an entry with the expected key. (Under the revised nested schema this is a scan over `sections[].entries[]`, not over a flat `entries[]`; an entry belonging to no section is now unrepresentable, so this scorer is purely the "and NOT elsewhere" half.)
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

> **Board status:** the first five families plus `memory-portability`, `memory-paraphrase` and `memory-paraphrase-live` have landed (PRs #453/#454); `memory-portability` has flipped to `hard`. The remaining rows are as planned.

**Three families are expected to fail on landing, and that is the point.** `memory-paraphrase` failing is the reported bug, reproduced as a committed artefact. `memory-portability` failing is D-3's debt, made visible. A family that cannot fail is not a gate; a family that has never been *seen* to fail is a regression test wearing a gate's clothes — which is what `memory-routing`, `memory-declaration` and `memory-overlay` are, honestly labelled.

**Re-baseline obligation at #460.** `memory-budget`'s truncation choice depends on batch-tie order, which is reversed on SQLite; `memory-recall-cite` depends on the model's own search wording surviving token semantics. Either may flip. The PR records the new baseline in the README with the reason. Repairing a flip by loosening an assertion is an explicit review-block.

---

## 4. Issue detail

Each block below is the seed for a full house-format spec at `.ai-docs/stacks/memory-routing/specs/<n>-<slug>.md`.

---

> **#460–#463 are DONE.** The blocks below are retained as the record of what was specced and built; they are **not** to be re-planned. #460/#461 shipped on PR #453, #462/#463 on PR #454. #464's block is superseded — see its note.

### #460 — eval harness runs on the shipped SQLite backend **[DONE — PR #453]**

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

### #461 — family gate tiers + `memory-paraphrase` and `memory-portability`, landing red **[DONE — PR #453]**

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

### #462 — one shared `tokenize()`; both backends change **[DONE — PR #454]**

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

### #463 — conformance Tier 1 / Tier 2 **[DONE — PR #454]**

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

### #464 — per-row read tolerance **[PR #455 open — REWRITE before merge]**

**Objective.** One bad row must degrade one record, not blind a partition's recall. The property is correctness and survives the ADR revision; the field-specific machinery on the branch does not.

**What changed.** PR #455 implements the tolerant `target` union — `UnknownMemoryTargetSchema`, `StoredMemoryTargetSchema`, `type StoredMemoryTarget`, `isKnownTarget()`, `MemoryRecordDegradation`, `StoredMemoryRecordRead`, `readStoredMemoryRecord()` — six new exported surfaces on `@agentic-patterns/core`, with `MemoryRecordDegradation.field` typed as the literal `"target"`. Revised ADR Decision 14 deletes `target` from the record at #471, which removes the failure class **at the source** rather than absorbing it: `StoredMemoryTargetSchema` would describe a shape nothing can store, `isKnownTarget()` would narrow three call sites that no longer exist, and the degradation channel would have zero v1 inhabitants. A zero-inhabitant public surface kept for an undated future is exactly the dead weight this revision deletes elsewhere.

**Scope (rewritten).** `packages/agent-runtime/src/memory/sqlite-store.ts` (`_rowToRecord`'s callers at `:477-495`), `memory/__tests__/sqlite-store.test.ts`. **No `agent-core` change. No new export.**

**Acceptance.**
- A private per-row `try`/`catch` around `_rowToRecord`: a row that fails to parse is **skipped**, a counter is incremented, and the count is surfaced on the read result. Never a throw inside `rows.map`.
- Reproduction test: a stored row corrupted in any field is skipped by `get` **and** by `search` (including the query-less listing), the sibling rows are returned, and the skip is reported. Today this kills the partition.
- Pinned in the **SQLite-specific suite**, not conformance Tier 1. `InMemoryMemoryStore` holds already-parsed frozen records and never re-parses on read (`memoryRecord()` appears only at `store.ts:150,184,252`, all write paths), so the universal tier cannot construct the failure. Alternative if a universal pin is wanted: a backend-declared corruption hook in the kit, asserted only for backends that declare it.
- `MemoryWriteInputSchema` stays **strict** — tolerance is a read-path property.
- No SQL migration and no `PRAGMA user_version` bump. (The DDL *does* change at #471, which drops the `target` and `payload` columns from `MEMORY_SCHEMA_V1` in place, keeps `MEMORY_TARGET_SCHEMA_VERSION = 1`, and deletes the disposable db.)

**Depends on.** — (the old "#464 before #465/#466/#467" edge was a forward-compat release-ordering argument; see §2.3).

---

### #465 — `molecules/memory-routing.ts`

**Objective.** The routing vocabulary, in core, calling nothing.

**Scope.** `packages/agent-core/src/molecules/memory-routing.ts` (new), `molecules/index.ts`, `packages/agent-core/src/molecules/__tests__/memory-routing.test.ts` (new).

**Acceptance.**
- `PlacementSchema` — **background arm only** in v1 (Decision 7): `{ primitive: "background", section: z.string().min(1), key: z.string().min(1) }`. The other five arms are deliberately absent, with the reason in the docblock. The `primitive` discriminant is retained on the docblock warrant "future arms differ **structurally** (judgment carries `domain`+`slot`), so a discriminated union is the natural shape even at width one" — **not** on stored-key injectivity across versions, which was forward-compat on data that does not exist yet.
- `placementKey(p): string` — total, injective, stable, `JSON.stringify([section, key])`. **No `\0` sentinel**: the old `${section}\0${key}` form was injective only because section ids happen not to contain NUL, which nothing enforced. Unit-tested for injectivity over an adversarial corpus, and pinned as the replacement for `sameTarget`, whose awareness/recovery discriminant-only collapse (`toolbox.ts:100-101`) is recorded in the docblock as the bug this fixes.
- Type-only declarations for `MemoryRoutingSpec`, `RoutableRecord`, `RoutingContext`, `PlacedRecord`, `RoutingReport`, `OverlayPlan`. All spec hooks pure and synchronous. **No separate `CompositionSection` type** — the revision unifies it with `BackgroundSection`; `RoutingContext.sections` is `readonly Pick<BackgroundSection, "id" | "title" | "promotion">[]`, a **declaration projection** that deliberately excludes `entries`, so `route()` stays a function of declarations only and the committed placement stays reproducible.
- **Structural no-emit test**, ported from `backpack.test.ts:344-351`: the module source contains no `emit`/`publish`.
- Core imports nothing new; no runtime edge.

**Depends on.** #468 (for `BackgroundSection` to project from).

---

### #466 — `label?` **(and nothing else)**

**Objective.** Give the spec a key segment the model can name without giving the model an address.

**Scope.** `packages/agent-core/src/molecules/memory-record.ts`, `packages/agent-runtime/src/memory/store.ts:51-61`, `memory/toolbox.ts` (`SaveParamsSchema`, `MemoryRecordViewSchema`), the memory Manual, tests.

**Acceptance.**
- `label?: z.string().min(1).max(64)` on `MemoryRecordSchema`, `MemoryWriteInputSchema` and `SaveParamsSchema`, with a **control-character and newline** rejection at parse. The warrant is general data hygiene — a ≤64-char scalar *name* has no business containing control characters — **not** a rendering constraint imported from `Background._formatDict`; #468 closes the injection class structurally and this field does not carry that obligation.
- `label` enters `MemoryRecordViewSchema` too: the rewritten D2 conflict guidance tells the model to "supersede it or use a different `label`", and it must be able to see the existing one.
- Slugification stays in the **spec**, not the record, so "Name" and "name " collapse to one address while the record keeps what the model actually said.
- Manual guidance teaches `label` as *a name for the thing learned* — never a section, never a primitive. The Manual, not the schema, is what makes a model write good structural fields (the #451 lesson).
- Tool-schema byte diff recorded in the PR body: this changes the model-facing contract.
- **`target` and `payload` are NOT touched here.** Removing them at this issue silently no-ops the ADR-0008 D2 write-time gate — see §2.4a. They land at #471.

**Depends on.** — (the old edges on #464 and on the `label?`-acceptance open question are both void: the question is closed, since `label` now *replaces* `target` rather than being additive to it, and B-3 is a coordination item, not a gate).

---

### #467 — `presets/memory/` + spec resolution

**Objective.** The vocabularies and the routing spec instances, per D-1. First issue where a memory can actually be routed.

**Scope.** `packages/agent-runtime/src/presets/memory/` (new: `user-background.ts`, `project.ts`, `index.ts`), `presets/index.ts`, spec resolution by name at the instantiate seam mirroring `capabilities` + `CapabilityResolver` (`agent-config.ts:68`, docblock `:13-16`), `presets/__tests__/`, plus the `memory-routing` and `memory-declaration` eval families.

**Acceptance.**
- `userBackgroundSections()` / `projectBackgroundSections()` return frozen `readonly BackgroundSection[]` — vocabularies, not `Background` instances, so they compose (`[...user, ...project]`). Frozen for real (`Object.freeze`), matching the repo's stated convention rather than the word alone. Sections ship with `entries: []`; `RoutingContext.sections` is the `Pick<…, "id"|"title"|"promotion">` projection, so a spec can never read current content.
- Section ids are **persisted addresses** and the naming pass is a **hard gate**, not a nicety (revised ADR open Q8): renaming one later *is* a stored-placement migration, and ids must satisfy `/^[a-z0-9][a-z0-9_-]*$/`. Titles are data now, which means **no preset may re-pick the title `Current State`** — the project preset ships `Project State` / id `project_state`, or the `State`-atom collision #468 deletes returns as data.
- `promotion` defaults per revised ADR open Q1; the user-background preset's value follows revised open Q2. If Q2 says "blocker", the preset ships `guarded` and the paraphrase flip at #472 is blocked on an approval gate — say so in the spec rather than discovering it at #472.
- Routing spec instances with pure sync `route`, keyed on `kind` + `label` + `tags`, with `key` derived from `label` (slugified) or a content-derived fallback.
- Keys are **not** enumerated per section — D-2's capability boundary is the section, and enumerating keys recreates Problem B one level down.
- `memory-routing` and `memory-declaration` eval families land `gate: "hard"` and pass. (`memory-declaration`'s overlay scorers are stubbed against the report shape until #470 — or the family lands whole at #470; the spec picks one and says which.)

**Depends on.** #465, #466, #468.

---

### #468 — `Background` replaced

**Objective.** One `sections[]` of nested entries, the four legacy records deleted, and the Context heading tree fixed. Rewritten by the ADR revision: this is no longer a byte-identical fold, and it is no longer "the single riskiest core change in the stack" — the thing whose risk was being isolated (a normalizer reproducing a hardcoded four-way `if` chain exactly) no longer exists.

**Scope.** `packages/agent-core/src/atoms/background.ts` (replaced), `atoms/awareness.ts:152` (heading), `atoms/index.ts`, `packages/agent-runtime/src/memory/recall.ts:79` (`SCAFFOLD_LINES` heading), `organisms/build-agent-from-config.ts` (verify `:99` needs no change), `packages/agent-dashboard/src/pages/build/RolesPage.tsx:110,120`, the 16 `new Background(...)` sites, core tests, two snapshots.

**Acceptance.**
- Schema per revised ADR Decision 3: `BackgroundSchema = { sections: BackgroundSection[] }`. The four `z.record(z.unknown())` records are **deleted**. `BackgroundSection = {id, title, promotion, entries[]}`; `BackgroundEntry = {key, value, memoryIds}`. `id` matches `/^[a-z0-9][a-z0-9_-]*$/`. `description?` dropped (nothing renders it).
- **Uniqueness enforced**: `superRefine` on the `sections` **array** (not the outer object, so `BackgroundSchema` stays a `ZodObject` and C1 holds; verify `.parse({}) === {sections: []}`) pins unique `section.id` and unique `entry.key` within a section. This is what makes `placementKey` an address rather than a guess, and #469/#470 both depend on it.
- `value: z.union([z.string(), z.number(), z.boolean()])`. The scalar union rather than `z.string()` is a **data-path** decision, not ergonomics: `Background` is built from runtime data at the ADR-0004 instantiate seam (`composition.test.ts:653-665` is the shape), and a string-only schema turns a host handing over a number into an HTTP 500 on a path that took `z.unknown()`.
- Rendering: each entry is exactly one line `- **${collapse(key)}**: ${collapse(String(value))}`, where `collapse` replaces any `\r?\n\s*` run with a single space; `title` goes through the same collapse. **Uniform and provenance-independent** — this replaces the whole escaping layer and its `/m` test, and it is what keeps the fold total against multi-line memory prose (`MemoryRecordSchema.content` is unconstrained). A named test asserts a value containing `\n## Fake Heading` renders on one line.
- An empty section is **skipped, not headed** — the one legacy quirk kept, on its own merit (declared-but-empty is the steady state under D-1, and an empty heading is a slot the model is invited to fill by inference).
- `merge()` overridden: identity on `section.id` then `entry.key`; `this`'s order wins; `other` replaces wholesale including `memoryIds` (never a union — unioning attributes a value to memories that did not produce it); `other` wins on `title`/`promotion`. **3 fixtures**, not 8: new-id append, colliding-id replace, nested entry-key collide. The spec states plainly that this method has **zero in-repo call sites** and survives as public-API hygiene, because with uniqueness enforced the inherited array-concat path throws.
- **Heading fix, all three producers in this PR**: `background.ts` emits `### ${title}`; `awareness.ts:152` emits `### Available Information Sources`; `recall.ts:79` emits `### Recalled Memories`. `## Context` is the only `##`. Document the contract: any text a host injects into Context via `scopeRender`/`recallRender` must be `###`-or-deeper. The `## Current State` / `State`-atom collision resolves by deletion — the heading was hardcoded at `background.ts:41` and titles are data now.
- **`-u` on exactly two snapshots**, with the diff reviewed as intended and quoted in the PR body: `rendering/__tests__/__snapshots__/renderer.test.ts.snap` (`:65,:69`) and `organisms/__tests__/__snapshots__/agent.test.ts.snap` (`:82,:87,:91`). `role.test.ts.snap` and `sections.test.ts.snap` are **unaffected** — verified, neither contains Background output. Inline assertions rewritten: `atoms.test.ts:245-275`, `sections.test.ts:180-210`, `agent.test.ts:333-341`.
- All 16 `new Background(...)` sites rewritten by hand: `integration.test.ts:92`, `composition.test.ts:188,657`, `sections.test.ts:180,205`, `renderer.test.ts:45`, `agent.test.ts:81,563`, `agent.ts:77,84,194`, `atoms.test.ts:242,247,262,271`, `build-agent-from-config.ts:99`. The four wire assertions at `composition.test.ts:321,741,742,759` are rewritten to read `sections[i].entries`.
- Recursive freeze of the array/object spine in the ctor — **no cycle guard needed**, because with scalar leaves a cycle is unrepresentable. A named test asserts post-construction mutation fails (today `(b.data.teamContext as any).team = "MUTATED"` succeeds and changes `toPrompt()` output on a "frozen" atom).
- `renderFragments()` ships as the D3 seam, unconsumed until #473.
- `RolesPage` renders `N sections · M entries`, not `Object.keys(background).length` — which reports a constant `4` today and would report a constant `1` under the new shape. `AgentLensPage.tsx:309` renders the blob opaquely and is checked for the same class of regression.
- Eval re-baseline: prompt bytes move, so provider prompt caches invalidate once and the prompt-level families re-baseline. Recorded in the PR body, **paid once for all three heading producers**.

**Deleted by this issue** (the bulk of the simplification): `normalizeBackgroundInput()` and the runs-in-the-ctor-before-`super()` construction C1 forced; the **mandatory** `AgentConfig` ctor pre-normalization and C2 as a live hazard (verify: `BackgroundSchema.parse(raw)` at `agent-config.ts:63`, `:136` and `organisms/agent.ts:30` returns the authored declaration verbatim); the "declare all four legacy sections in canonical order" corollary; the core-hardcodes-the-runtime-preset's-tiers coupling; `migrateBackgroundData(raw)`; `_formatDict` with its three interpolation arms, its unbounded recursion (a live `RangeError`) and its `[object Object]` array output; the entire escaping layer; the 24 render/merge parity fixtures; the idempotence-under-`replace()` fixpoint test.

**Byte-identity is a throwaway diagnostic, not an acceptance criterion.** A scratch harness rendering old vs new over the 16 call sites is a useful *porting* tool — run it once to confirm the only diffs are the intended ones, then delete it with the branch. It was a development tool that had been promoted to a design constraint.

**Out of scope.** `applyMemoryOverlay` (#470); anything routing.

**Depends on.** — . Leads the routing arm (#468 → #465 → #467); parallel with #466.

---

### #469 — promotion rows + placement-keyed lookup

**Objective.** The ADR-0008 D5 ledger surface, and the lookup the gate rekey actually needs (§0.1 / §2.4).

**Scope.** `packages/agent-runtime/src/memory/store.ts` (protocol), `memory/sqlite-store.ts` (table + migration), `memory/conformance.ts` (Tier 1), tests.

**Acceptance.**
- A promotion row carries `recordId`, `placement`, `placementKey`, **`keySource: "label" | "content"`**, `specKey`, `specVersion`, `promotedAt`, `tier`, `approver?`. It is a **side table**, closing `guide.md:576`'s open question in favour of the option this design requires. `keySource` lives here rather than on the record because of Decision 9's signal/address split — the record carries what the model observed, the row carries what the system decided — not because "no schema change" is cheaper.
- **No host-supplied-promotion path in v1.** The revision's earlier framing treated removing `target` from `MemoryWriteInput` as a capability regression that this surface had to restore; it is not. `memory-record.ts:95-96` documents that nothing acts on `target`, and a repo-wide grep finds no reader in `agent-server`, `agent-dashboard`, `examples/` or `agents/` — there is no host addressing capability today. A host-supplied promotion (record id + placement + tier + approver, bypassing `route()`) is a **new feature** to be scoped on its own merits if a host actually needs it, not a restoration and not a blocker on this issue.
- Exact-equality `placementKey` lookup scoped to a partition, conformance-pinned from day one (D-3: an unpinned match semantic is a divergence).
- Point-in-time reconstruction (`0008:82`) is pinned: the placements valid at time T fully determine the composition at T, *including* `specVersion`.
- Signals from `classifyThenRoute` have a column, unused in v1.
- New Tier-1 coverage for the surface; the options argument stays optional-with-defaults (B-3).

**Depends on.** #465, #467.

---

### #470 — `applyMemoryOverlay`

**Objective.** The pure fold. The join point of the two arms of the stack.

**Scope.** `packages/agent-core/src/organisms/apply-memory-overlay.ts` (new), `organisms/index.ts`, core tests, plus the `memory-overlay` eval family. **No `deepFreeze` hoist**: #468's `Background` ctor already recursively freezes the array/object spine, and with scalar leaves there are no cycles, so `memory-record.ts`'s cycle-guarded `deepFreeze` (`:231-245`) is not needed here.

**Acceptance.**
- Signature `applyMemoryOverlay(config, placed: PlacedRecord[], spec) → { config, report }`. `0008:7`'s `(config, records)` is unimplementable once placement lives on the promotion row; the runtime performs the join.
- **Determinism, pinned in this function's own unit tests** (not the conformance kit — D-3 governs *search* semantics and no backend can diverge on a pure core fold): authored-wins → memory-vs-memory (**newest `createdAt`**, tiebreak **`id` ascending** with raw `<`) → budget. Evaluation *order* is itself pinned, because otherwise the reported drop *reason* depends on write timing.
- Entry lookup is by `entry.key` within the addressed section's `entries[]` array — the flat-record `Object.hasOwn` guidance is moot now that entries are an array, but the underlying rule survives in a different form: never treat a `Record` keyed by user data as a lookup surface.
- **The overlay must NOT be implemented as `background.merge(memoryBackground)`.** That path ignores `promotion` entirely and would launder memory entries past the tier check. Named as an invariant in the module docblock and pinned by a test.
- **Copy/freeze discipline.** `AgenticModel` freezes one level (`base.ts:48`) and TS `Readonly<T>` is shallow, so a naive in-place write would mutate the caller's authored config — which, since one `AgentConfig` is held across conversations, would leak one user's memories into every subsequent instantiate. A **named test** asserts the input config is unmutated. Build a fresh tree; share untouched subtrees; the reconstructed `Background`'s ctor freezes the result.
- **Idempotence** pinned: applying the overlay twice yields the same `config′`, and the second application does not re-report memory entries as `authored-collision`.
- **No markdown-escaping criterion.** #468 closes the injection class structurally: values are scalars, and every interpolated slot goes through a uniform provenance-independent newline collapse, so a value can never begin a line. The escaping layer and its `/m` structural test are deleted, not relocated. Consequently there is also **no `unrenderable-content` decline reason** — Decision 10's outcome list stays three-way, and the fold stays total against unconstrained multi-line memory prose.
- One typed `drops` list (never parallel lists), **ids only, never record content** — the report feeds an SSE event and embedding content would leak user memories into telemetry.
- `ceilingBreached` must be **reachable**: the composition-wide ceiling sits strictly below the sum of per-primitive budgets, or the flag is dead code. Pinned by an eval case (§3.3.E3).
- `memory-declaration` and `memory-overlay` eval families land `gate: "hard"` and pass.

**Depends on.** #467, #468, #469.

---

### #471 — delete `target` + `payload`, rekey the D2 gate, rewire recall candidacy — **one PR, may not be split**

**Objective.** Withdraw the model's addressing authority, delete the field it addressed with, and move the gate onto the derived address — atomically, because doing any two of these in different PRs silently no-ops the gate (§2.4a).

**Scope.** `packages/agent-core/src/molecules/memory-record.ts` (the whole `MemoryTarget` block `:56-167`, the `superRefine` `:206-221`, `target` and `payload` on `MemoryRecordSchema`), `molecules/index.ts` (13 exports), `packages/agent-runtime/src/memory/store.ts:51-61` (`MemoryWriteInputSchema`), `memory/toolbox.ts` (`SaveParamsSchema:137,140-143`, `MemoryRecordViewSchema:128`, `_view():458`, the D2 gate at `:307-336`, `sameTarget:92-107`, `BASELINE_MANUAL`), `memory/sqlite-store.ts` (`MEMORY_SCHEMA_V1` columns, `RawRow`, INSERT, serialize, `JSON.parse`), `memory/recall.ts:163-172`, `memory/conformance.ts:81,92`, tests.

**Acceptance.**
- `target` **deleted** from `MemoryRecordSchema`, `MemoryWriteInputSchema`, `SaveParamsSchema` and `MemoryRecordViewSchema`. `MemoryRecordSchema` reverts from a `ZodEffects` to a plain `ZodObject`.
- `payload` **deleted** from the same four places, on identical evidence: after this PR it has no model writer, no validator (`targetPayloadSchema` and the `superRefine` are gone with the target union) and no reader — every `.payload` site is pass-through persistence (`store.ts:158`, `sqlite-store.ts:280,285,288,491`). Keeping it "as an opaque host/import channel awaiting Phase C" is the exact justification this PR refuses for `target`. Phase C reintroduces it **with** its consumer.
- **13 barrel exports** removed from `molecules/index.ts`: 10 value exports (`:47-53`, `:60`, `:62`, `:65`) and 3 type exports (`:68` `AwarenessTargetPayload`, `:69` `ExampleTargetPayload`, `:78` `MemoryTarget`).
- SQLite: drop the `target` and `payload` columns **from the v1 DDL in place**, keep `MEMORY_TARGET_SCHEMA_VERSION = 1`, delete the disposable db. No bump, no migration, no dead column — `MEMORY_SCHEMA_V1` is `CREATE TABLE IF NOT EXISTS` (`sqlite-store.ts:74-104`, `_migrate` `:448-467`).
- `memory_save` is now `{ kind, content, tags?, label?, supersedes? }` — five flat fields, zero unions, zero nested objects. Tool-schema byte diff quoted in the PR body: **two removals and one addition** (the `label` half landed at #466), and every prompt-level snapshot of the memory capability moves.
- The D2 gate resolves the pending write's address via `route()` and looks up a **committed placement** (§0.1a) rather than scanning an unfiltered 500-record recency page. `COLLISION_SCAN_LIMIT`'s documented blind spot (`toolbox.ts:67-75`) disappears for promoted records; the spec states plainly that unpromoted near-duplicates are no longer gated, and why that is acceptable. **A named test asserts the gate still fires** — the whole point of bundling is that a silently-never-matching filter is the failure mode.
- The gate's guidance string is rewritten in **both** places it appears (`toolbox.ts:333` and `BASELINE_MANUAL`): it currently offers "supersede **or** change the target key", a remedy the model provably cannot execute once `target` leaves. `label` restores a legitimate one — "supersede it or use a different `label`" — and `MemoryRecordViewSchema` carries `label` (from #466) so the model can see the existing one.
- `sameTarget` deleted; `placementKey` is the identity. Its awareness/recovery collapse (`toolbox.ts:100-101`) dies with it.
- Recall candidacy: `record.target !== undefined` (`recall.ts:168`) becomes "routing would place it", computable in-process with no store change.
- Documented, not discovered: a host wanting to import a structured-payload memory now has **no** model-facing or write-input path at all.
- **Composed-id dedupe** in `assembleRecall`, applied at the `visible()` post-filter seam (`recall.ts:149-150`) across **all three** tiers — this fixes a real double-render bug, since the candidate predicate matches promoted records that are already in the system prompt.
- The behaviour delta is measured, not asserted: the PR body records the before/after of the live families.

**Out of scope.** Overlay→recall **spill pinning**. ADR Known-limits names its three unmet requirements (a fetch path re-applying scope + validity filters, a cap so pinned spill cannot starve the hits tier, and the instantiate→first-message staleness window). v1 ships the dedupe and the report; the pinning is Phase C.

**Depends on.** #469, #470.

---

### #472 — instantiate seam applies the overlay

**Objective.** Make composition reach the delivered prompt. The issue that closes the reported bug.

**Scope.** the instantiate seam (ADR-0004), spec resolution by name, `agent.memory.overlay` event emission, `evals/memory-behavior/run.mts` (flip three families).

**Acceptance.**
- `instantiate` reads the store, joins records with promotion rows, resolves the spec by name, applies the overlay, and builds the delivered agent from `config′`. **Skippable when no store is wired** (`0008:106`) — an agent with no memory configured renders exactly as it does without the overlay. (Not "byte-identically to today": #468 already moved the Context heading bytes. The claim is that the overlay contributes zero bytes when there is nothing to compose.)
- The overlay is always applied to the **stored authored config**, never to an already-overlaid one (idempotence is pinned at #470; the seam must not rely on it).
- `agent.memory.overlay` carries record count, `charsPerPrimitive` (**not** `bytesPerPrimitive` — `0008:80` and six cookbook sites contradict the chars pin and are corrected at #475), and per-reason drop counts.
- `memory-paraphrase`, `memory-paraphrase-live` flip `xfail` → `hard` and **pass**. This is the acceptance criterion that matters: the bug that opened the program is closed, measured on the shipped backend, by a family that was committed red.
- If ADR open Q6 resolved as "blocker", the user-background preset is `guarded` and this flip is blocked on an approval gate — in which case the spec must say what ships instead, because "the agent saves a fact and the fact never reaches the agent" is the originating bug as a default.

**Depends on.** #470, #471.

---

### #473 — fragment attribution (core + server)

**Objective.** ADR-0008 D3, expressible for the first time — and `AgentPromptSectionData` reduced to one representation of its bytes.

**Scope.** `packages/agent-core/src/atoms/base.ts` (declare `PromptFragment` at **layer 0**, beside `RenderContext`), `atoms/index.ts`, `rendering/sections/base.ts:11-27` (`render()` → required `renderFragments()`), all 7 `implements PromptSection` sites, `rendering/renderer.ts:42-65` (`renderInitial` collapses; `renderContinuation` joins fragments), `atoms/background.ts` + `atoms/awareness.ts` (`renderFragments()`), `organisms/agent.ts:44-48` + the inline tuple type at `:139-141`, `packages/agent-server/src/routes/composition.ts:112` (mirror **deleted**), `:119-121` (`access_method` shim deleted), `:677-698` (wire normalization, `renderPath` deleted), `agent-server/src/__tests__/composition.test.ts`, core + server tests.

**Acceptance.**
- `AgentPromptSectionData = { name, source: "role" | "instance", fragments: readonly PromptFragment[] }`. **`text` is deleted**, not derived — a "derived" field on a hand-constructible type is still a field two producers can disagree about, and every literal construction site (including the server's own fallback) would have to supply both. Readers join. The partition invariant becomes definitional rather than a test.
- `PromptFragment = { source: "authored" | "memory"; text: string; memoryIds?: readonly string[] }`, declared in **`atoms/base.ts`**. This placement is load-bearing, not stylistic: `Background`/`Awareness` are layer-0 atoms and `PromptSection` is layer 3, so declaring the type in `organisms/agent.ts` (layer 4) would make atoms import upward. `RenderContext`'s own docblock (`atoms/base.ts:20-24`) sets the precedent verbatim.
- Fragment `source` is **two-valued**. Section-level `source` stays `"role" | "instance"` and stays **on `Agent.renderSections`'s table** — source is a fact about the assembly, not about the section class, which is also what answers "what is `StateSection.source`?" (it has none; `atoms/state.ts:31-33` is loop-managed execution state). A three-armed fragment union would duplicate the section source on every non-memory fragment and need a collapse rule no consumer wants.
- **No `memoryChannel` in v1**, and no `RecallResult.recordIds` / `RenderContext.recall` widening. Verified: nothing in the repo sets `RenderContext.recall` (`agent-runner.ts:456-459` returns `scope ? {scope} : undefined`; `ClaudeCodeRunner` uses the same helper), so the false `"instance"` attribution these would cure has zero producers, and introspection is nullary anyway. Widening `RenderContext.recall` would also contradict its docblock guard (`atoms/base.ts:29-32`, "a finished string, never structured data") and ADR-0007 D8a. They land in the PR that first wires recall into a render.
- `PromptSection` has **one** producing method; `render()` is deleted. 6 of the 7 implementers are single-source: `const t = <old body>; return t === "" ? [] : [{ source: "authored", text: t }]`. `PromptRenderer.renderInitial` — a duplicate prompt assembly with no production caller — collapses into the shared join, and `renderContinuation` (`:60-65`) is rewritten too rather than left calling a deleted method.
- Separators fold **into** the slices — no `fragmentSeparator` field, and now by force rather than convention, since there is no glue left.
- Structural text (the `## Context` wrapper at `context.ts:21`, section headings) is `source: "authored"` **by rule**, so the partition is total.
- **The server mirror is deleted.** `AgentIntrospect.renderSections?: (ctx?: RenderContext) => AgentPromptSectionData[]`, type-imported from `@agentic-patterns/core` (already a declared dependency; `AgentPromptSectionData` is already barrel-exported). The `Equals<A,B>` helper, the drift-guard test and the requirement to export `AgentIntrospect` all disappear. The `config.ts:33-45` structural-typing precedent does not reach this member — its hazard is *nominal* identity (`instanceof`) across two core copies, and `import type` is erased at build.
- **The wire is normalized server-side.** The producer is a duck type (`composition.ts:686` branches on `typeof a.renderSections === "function"`) and forwards the result unvalidated, so a hand-rolled `AgentLike` returning the old shape would ship `fragments: undefined` to a dashboard whose type says it is required. `agentCompositionPayload` maps: `s => ({ name: s.name, source: s.source, fragments: s.fragments ?? [{ source: "authored", text: s.text ?? "" }] })`. One site, in the function that already synthesizes the `"unknown"` arm. **A named test constructs an old-shaped duck-typed agent and asserts the payload is well-formed.**
- **`renderPath` deleted** from the payload — it is exactly `sections.some(s => s.source === "unknown")` and `RenderedPromptView.tsx:11`'s own docblock says so. The joined **fallback branch survives** on architecture (`PromotedAgent` has no `renderSections`, `workflows/as-agent.ts:162-175`; `AgentLike` is deliberately minimal, `runner/types.ts:17-32`). `"unknown"` stays at **section** level only and does not enter the fragment union.
- `AwarenessDomainLike.access_method` (`composition.ts:119-121`, read at `:423`) deleted — a pre-ADR-0002-rename shim; core's `AwarenessDomainSchema` has only `accessMethod`.
- `ContextSection` does **not** split and `Background` gets no prompt section of its own — resting on the one argument that survives (`the split's only benefit is what the fragment partition already delivers`). The old supporting argument ("it would emit N `##` headings") is void once #468 makes Background emit `###`, and is dropped.
- The section list stays the exact six entries at `agent.test.ts:333-341`. **Snapshot bytes moved at #468, not here** — the pre-revision "zero snapshot bytes change" claim is void.
- Documented asymmetry, now one line: the composition route calls `renderSections()` **nullary** (`composition.ts:687`), so there is no turn and therefore no recall block to attribute.
- Documented rule: `memoryIds` is authorable schema data, so **the overlay report is the display authority**. See revised ADR open Q5 — the report is currently discarded at the ADR-0004 instantiate seam, so this rule and the chips are in tension until Doug picks a resolution.

**Depends on.** #468, #472.

---

### #474 — dashboard fragment spans

**Scope.** `packages/agent-dashboard/src/api/composition.ts:20-25`, `components/organisms/RenderedPromptView.tsx:5,11,32-38,45-70`, `pages/AgentLensPage.tsx:391`, `AgentLensPage.responsive.test.tsx` fixture.

**Acceptance.** `PromptFragment` mirror added (`"authored" | "memory"`); section `source` mirror keeps `"unknown"`; `SOURCE_TONE` gains `memory`; sections render attributed spans with a per-fragment chip. **No absent-`fragments` fallback** — the server normalizes at the wire boundary (#473), which is what makes the required field true; a client-side `??` would paper over a producer bug instead. `renderPath` deleted from the mirror, from the prop, from the `renderPath === "joined"` chip branch (the per-section `unknown` chip already carries the signal), from `AgentLensPage.tsx:391` and from the responsive-test fixture. `memoryIds` render as chips only for overlay-report-backed attribution (#473's display-authority rule) — gated on revised ADR open Q5; if unanswered, ship the spans without chips.

**Depends on.** #473.

---

### #475 — docs sweep

**Scope.** Previously named: `docs/memory/guide.md:354`, `:536-537`, `:578-586`, `:641`; `docs/memory/evolution-cookbook.md:30-33`, `:835`, and the `bytesPerPrimitive` sites (`:175`, `:181`, `:321`, `:443`, `:571`, `:710`, `:737` — the critic found `:571` missing from the ADR's list); `docs/adr/0008-compositional-memory.md` status header.

**Added by the revision — the deleted-vocabulary sweep.** Deleting the four legacy `Background` records orphans more prose than the original scope accounted for. Live references: `docs/memory/guide.md:196`, `:276-277`, `:306`, `:512`, `:525`; `docs/memory/evolution-cookbook.md:68`, `:87`, `:146`, `:174`, `:739`; `docs/playground-redesign.md:52`. Several are worked examples carrying a `target: { primitive: "background", section: "conventions", key: "deployFreeze" }` payload that will no longer parse against anything. Also sweep for the deleted `payload` field and for `renderPath`.

**Acceptance.** Every corrected line is quoted before/after in the PR body. `guide.md:578-586` — currently stating in bold that "the model *may* propose targets" and that `memory_save` **does** expose `target` — is reworded, not deleted, so a reader following a link lands on the new position. `guide.md` gains the new stated design consequence: `Background` values are a constrained scalar vocabulary, so an instantiate host must render non-scalar values before constructing. ADR-0008's status header reads `SUPERSEDED IN PART (see ADR-0009)` — settled by the revision, no longer an open question.

**Depends on.** #472.

---

### #476 — version bump

**Scope.** `bash scripts/bump.sh` with absolute versions, CHANGELOG.

**Acceptance.** Absolute versions, never `minor` — `publish.sh:127-131,160-163` skips already-published versions **silently**, so check what npm `latest` actually is at bump time. (The old "precondition: the `mem/*` release stack has merged to `main`" is **void** — that was release sequencing against published packages, which the withdrawn-compat ruling removes as a design input.) CHANGELOG names the model-facing contract changes (`target` and `payload` removed from `memory_save`, `label` added), the `Background` schema replacement, the `AgentPromptSectionData` reshape, the composition-payload shape change, and the in-memory search-semantics change — all as breaking, with no migration path offered, per ADR Decision 16.

**Depends on.** #474, #475.

---

## 5. Risk register

| # | Risk | Early warning | Rollback |
|---|---|---|---|
| R1 | **#462's token semantics break existing in-memory-backed tests broadly.** In-memory substring matching has been the de-facto contract for every test that seeds a store; whole-token matching is strictly narrower. | `bun run test` failures concentrated in `memory/__tests__/` and any runtime test that seeds a store — visible within one CI run of #462. | Revert #462 alone (it is self-contained: one new module, two call sites). The stack stalls at #461 with `memory-portability` still `xfail`, which is the honest state. |
| R2 | **The re-baseline at #460 is repaired by loosening an assertion** instead of being recorded, and the harness silently becomes weaker at exactly the moment it becomes authoritative. | Any diff in #460 that touches a `cases/*.jsonl` `expected` field or a scorer predicate. | Explicit review-block: #460 may edit `run.mts` and `README.md` only. A required expectation change means the family was measuring the wrong thing and needs its own issue. |
| R3 | **Routing accuracy is empirical and this stack cannot settle it.** A pure sync spec routes on structural signals and cannot route on prose. Whether `kind:"profile"` + a preset actually catches what a companion saves is unknown, and this design makes a wrong `kind` cost *placement*, not just recall quality. | `memory-paraphrase` stays red at #472 despite the overlay working; or `memory-routing`'s `route-no-label-falls-back` case producing unstable keys against real traffic. | The `label` fallback is the pressure valve: a spec can widen its `kind` mapping without a schema change. If accuracy is the blocker, the answer is a preset revision (a runtime change, no core release), not a stack revert. |
| R4 | **#468's prompt-byte diff is larger or different from what was intended.** Byte identity is no longer the goal, so the guard is no longer "the snapshot must not move" — it is "the snapshot moved *exactly* where we said it would". The risk is an unintended diff hiding inside an intended one. | The `-u` diff on the two snapshots. Anything outside the `## Context` blocks at `renderer.test.ts.snap:65,69` and `agent.test.ts.snap:82,87,91` is unexplained. | Quote the full snapshot diff in the PR body and review it line by line; the throwaway old-vs-new render harness over the 16 call sites is the tool for that. #468 is a single-package change with no consumers until #470, so revert is cheap. |
| R5 | **The §0.1 correction is wrong and the gate rekey needs record-level placement after all** — e.g. a requirement surfaces that unpromoted near-duplicates must be gated. | Discovered while speccing #471: the D2 gate's coverage regression is unacceptable to review. | Either accept the reduced gate coverage (documented) or move the gate to *promotion time* instead of write time — which is additive to #469 and does not touch the record schema. Storing a birth-time `routeKey` remains rejected. |
| R6 | **`guarded` as the default `promotion` ships the originating bug as the framework default.** No agent has a `HumanApprovalGate` wired; a guarded section means the agent saves a fact and the fact never reaches the agent. | `memory-paraphrase` cannot flip to `hard` at #472. This is a *designed* early warning: the family fails for exactly this reason and names it. | Ship the user-background preset as `auto` with the semantic-bypass limit stated (ADR Known-limits bullet 2), and make `guarded` the *documented* posture for anything an author adds. Reversible in a runtime preset, no core release. |
| R7 | **B-3 turns out to have a live external consumer.** Under the revision this is a *coordination* risk, not a design one — breakage is expected and accepted; the risk is that it is discovered late and silently. | The six named greps in revised ADR Decision 15. Five now fail **loudly** (type errors on `MemoryTarget`, on an exhaustive `target.primitive` switch, on the reshaped `AgentPromptSectionData`), which is the good case. Grep 6 is the bad case. | The only genuinely silent failure is a persisted `background.teamContext`/`projectContext`/`conventions`/`currentState` row, which parses to `{sections: []}` with Zod stripping the rest and no diagnostic. Run grep 6 **before #468**, not before acceptance. Same org — the mitigation is a conversation, not a shim. |
| R8 | **Placements go stale.** They freeze at promotion with a `specVersion`; a section rename or a routing fix leaves prior placements pointing at an address that may no longer be declared, and there is no re-route/re-promote/migrate operation. | `memory-declaration`'s `decline-reported` scorer firing for records that were previously composing — visible as a composition that silently shrinks. | v1's answer is a decline with `undeclared-section` plus a lint entry (never a throw — the refuted design would brick instantiate). Section ids are treated as persisted addresses and get a naming pass at #467 precisely to make renames rare. A migration operation is deferred, explicitly. |
| R9 | **The `xfail` tier becomes a graveyard** — families sit red for months and stop being read. | Three or more `xfail` families outstanding for more than one merged issue; or an `xfail` reason string that no longer matches reality. | The `XPASS`-fails-the-run rule already prevents the silent-green half. For the silent-red half: each `xfail` carries `unblockedBy`, and the issue it names has flipping it as an acceptance criterion. If an `xfail` outlives its `unblockedBy` issue, that is a review-block on the issue, not a note. |
| R10 | **The overlay mutates the caller's authored config**, leaking one user's memories into every subsequent instantiate of a shared `AgentConfig`. The type system will not catch it: `AgenticModel.data` returns a *shallow* `Readonly<>` and `Object.freeze` is one level (`base.ts:48`) — confirmed today, `Object.isFrozen(b.data.teamContext) === false` and post-construction mutation of a "frozen" atom succeeds. | Nothing, until it is a cross-tenant data leak in production. This is the highest-severity failure in the stack and it is silent by construction. | Largely **designed out** by #468: with scalar leaves the only unfrozen thing left is the array/object spine, which the `Background` ctor freezes recursively — no cycle guard needed, because a cycle is unrepresentable. #470 still carries a named unmutated-input test as the backstop. |
| R11 | **The stack is 17 issues and the ADR is still `PROPOSED`**, now with eight open questions after the revision. Three gate specific issues (§0). | Speccing #467 or #470 and finding the answer is "it depends on Q1/Q2/Q4/Q8". | #460–#463 have landed and depend on no open question. #468 and #466 are next and depend on **none** either — the reshape is now a pure atom replacement and `label` is a single field — so the stack can keep moving while Q1/Q2/Q8 are answered. Nothing from #467 onward should be specced until they are. |
| R12 | **#471 is split during implementation** — the `target`/`payload` deletion lands separately from the D2 gate rekey, and the gate silently stops firing because `args.target` is written but stripped by the record schema (`z.object` defaults to `"strip"`). | None. `bun run check` is green either way; the family that would catch it (`memory-supersede`) does not exercise a *targeted* collision. | Prevention only: §2.4a states the constraint, #471's acceptance carries a **named test asserting the gate still fires**, and reviewers block any PR that removes `target` from a schema without also rekeying the gate. |
| R13 | **The `###` heading change is made in only two of the three producers.** `background.ts` and `awareness.ts:152` are obvious; `recall.ts:79`'s `SCAFFOLD_LINES` is in a different package and reaches Context through `recallRender`, so it is easy to miss — leaving `## Context` still containing a stray `##` after the full cost (moved bytes, invalidated caches, re-baselined evals) has been paid. | A rendered Context section containing more than one `##`. | #468's acceptance names all three files explicitly and states the contract ("any text a host injects into Context via `scopeRender`/`recallRender` must be `###`-or-deeper"). A structural test asserting `## Context` is the only `##` in the rendered Context section pins it. |

---

## 6. What this plan deliberately does not cover

Phase C, per revised ADR Follow-up 8: `lintComposition` over the overlay report; overlay→recall **spill wiring** with its cap and validity requirements; awareness / judgment / example placement arms with their declaration surfaces; `payload` reintroduced **with** its structured consumer; `memoryChannel` + `RecallResult.recordIds` + a structured `RenderContext.recall` in the PR that first wires recall into a render and first reads the ids; `corroborate` (without which the `earned` tier is inert for background); `classifyThenRoute` enablement (which needs either promotion-only evaluation or a pre-promotion annotation operation on the store protocol — both named in ADR Decision 11, neither solved); a host-supplied-promotion path on #469's surface, if a host is ever shown to need one.

**No longer deferred** (moved into the stack by the revision): the `##`→`###` heading-depth fix and the `## Current State` / `State`-atom collision are now part of **#468**, across all three producers, with the eval re-baseline paid once. The only reason they were deferred was preserving #468's byte-identity proof, which is no longer a goal.
