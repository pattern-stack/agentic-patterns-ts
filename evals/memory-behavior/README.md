# Memory-behavior eval set (#446, #460, #461)

Seven families over the shipped Phase 1 memory surface (ADR-0007), with the **companion**
agent (#445) as the subject. **Not throwaway**: ADR-0008 Decision 7's eval-gated promotion
IS this harness pointed at `config` vs `config′` — these families become the Phase C (#435)
promotion gates.

```bash
just eval-memory            # live run (needs a resolvable runner: provider key /
                            # AGENT_MODEL / AGENT_TIER / claude CLI on PATH)
just eval-memory --dry      # deterministic families only
just eval-memory --tiers    # list the families and their gate tiers, run nothing
```

## The backend is the point (#460)

Every family runs on **the backend the companion actually ships on**: a per-family (or
per-case) temp SQLite db, opened with an **explicit `path`** through `loadMemoryStore`.

Before #460 the harness constructed `new InMemoryMemoryStore()` per family while the shipped
companion boots `loadMemoryStore()` → `SqliteMemoryStore`, and the two backends **do not agree
on what a match is**. Measured in this repo, one corpus, both backends:

| query | in-memory | SQLite (FTS5) | why |
|---|---|---|---|
| `"prefer"` | hits `"Prefers dark-mode…"` | no hits | in-memory matches substrings; FTS5 matches whole tokens and does not stem |
| `"am"` | hits `"The user's name is Doug."` | no hits | `"am"` is a substring of `"name"` |
| `"cafe"` | no hits | hits `"…at the café…"` | FTS5's `unicode61` tokenizer folds diacritics; in-memory does not |
| `"dark-mode"` | hits | hits | agree today — kept as a regression tripwire |
| `"espresso Denver"` (disjoint tokens) | both records | both records | agree today — the case that would catch a backend defaulting to AND |
| batch-tie `limit: 2` | `[alpha, bravo]` | `[charlie, bravo]` | one `now` per batch ⇒ every record ties on `createdAt`; in-memory resolves by insertion order, SQLite by `seq DESC` |

So the pre-#460 "5/5 PASS" was a true statement about a backend nobody ships, and **no claim of
the form "this retrieval change improved recall" was falsifiable**. Rules the harness now holds:

- Stores come from `loadMemoryStore({ path })` with a per-family/per-case temp path under
  `os.tmpdir()`. **`AP_MEMORY_DB_PATH` is never read or set** — it is process-wide, and one typo
  would point the evals at the user's real `~/.local/state/ap/memory.db`.
- **`unavailable` ⇒ `process.exit(2)`.** `loadMemoryStore` soft-degrades to an
  `InMemoryMemoryStore` on *both* failure paths (driver unresolvable, and construction throws),
  which is precisely the bug being fixed — a soft degrade would re-introduce it under a different
  name. A preflight open runs before any family, so the error names the missing driver before a
  single status line a reader might believe has printed.
- Every temp db is `close()`d and `unlink`ed (plus `-wal` / `-shm` / `-journal` sidecars) by the
  target that opened it, with a whole-process sweep in the outer `finally` as a backstop. No temp
  file survives a run.
- `InMemoryMemoryStore` is constructed in exactly **one** place: inside the `memory-portability`
  target, where comparing the two backends is the entire assertion.

## Gate tiers (#461)

Every family declares a tier, printed on every run and listable with `--tiers`:

| tier | family fails by assertion | family errors | family passes |
|---|---|---|---|
| `hard` | `FAIL` — fails the run (exit 1) | `FAIL` — fails the run (exit 1) | `PASS` |
| `xfail-strict` | `XFAIL` — reported with `reason` + `unblockedBy`; run **unaffected** | `XFAIL-INVALID` — **fails the run** (exit 1) | `XPASS` — **fails the run** (exit 1) |

The `xfail` → *pass* direction failing the run is the whole point. A green xfail means the thing
it measures got fixed and nobody flipped the tier; making that fail forces the tier to be emptied
as the stack lands, and catches a family that goes green for an accidental reason. Every
`xfail-strict` family carries a `reason` and an `unblockedBy`, both printed on every run, so a red
family cannot quietly become scenery.

An expected failure must fail **by assertion, not by exception**: an `xfail-strict` family whose
target throws or whose scorers error prints `XFAIL-INVALID` and fails the run, because a crashed
target proves nothing about the behaviour the family pins — without this rule a reshape that made
every case throw would keep printing the family's expected red and exit 0. Every failed case
additionally prints its node-level error (`TARGET ERRORED: …`), hard and xfail families alike, so
a thrown target is never indistinguishable from an honest assertion failure.

## Families

| Family | Mode | Tier | Asserts |
|---|---|---|---|
| `memory-recall-cite` | live | `hard` | seeded records → the agent surfaces and uses the right fact |
| `memory-save-on-instruction` | live | `hard` | told a durable preference → a record LANDS in the partition (store-state scorer, not response text) |
| `memory-supersede` | live | `hard` | corrected fact → new record live, seeded record invalidated (audit trail survives), no live record asserting the old fact without the new |
| `memory-scope-confinement` | live | `hard` | foreign-partition secrets never surface in answers; no write escapes the bound partition |
| `memory-budget` | deterministic | `hard` | `assembleRecall` as a FunctionStep node target: over-budget scope → MARKED truncation, never a silent clip |
| `memory-paraphrase` | deterministic | `xfail-strict` | an identity-grade fact recalled under wording that shares no content word with it — asserted on the DELIVERED PROMPT |
| `memory-portability` | deterministic | `xfail-strict` | one corpus, both shipped backends, identical match SETS (ADR-0009 D-3) |

### `memory-paraphrase` — the reported bug, as a gate (`xfail-strict`, unblocked by #472)

Seeds `{ kind: "fact", content: "The user's name is Doug." }` and
`{ kind: "preference", content: "Uses the metric system." }`, plus a foreign-partition
`"The launch code is 4242."`. Each case assembles recall for its question and asserts on the
**delivered system prompt**.

The prompt, not the recall block, is the assertion surface, and that is load-bearing: once
identity is *composed* (ADR-0008/0009), the recall block is legitimately empty for these
questions, so a recall-block assertion would either go green for the wrong reason or stay red for
the right feature. The prompt is the one surface that is correct before and after the fix.

The seeds are deliberately **not** `kind: "profile"`. The profile tier is query-independent and
already works (#451 teaches the model to write profiles). The residue this family pins is a
`fact`/`preference` whose *wording* misses the next question, which no amount of better search can
reach.

| case | question | expects |
|---|---|---|
| `para-who-am-i` | "who am I?" | `Doug` |
| `para-tell-me-about-myself` | "tell me about myself" | `Doug` |
| `para-unrelated-still-composed` | "tell me a joke" | `Doug` |
| `para-units` | "should I use feet or metres?" | `metric` |
| `para-negative-control` | "launch code please" | `Doug`, and never `launch code` / `4242` |

`para-unrelated-still-composed` is the load-bearing case — it is the one no search change can
satisfy, only composition. Scorers: `prompt-contains`, `prompt-omits-foreign` (applied to *every*
case, since the foreign seed is present in all of them), and `overlay-report-composed`, which
requires the fact to arrive by composition rather than by happening to land in the recall block.
Note that `overlay-report-composed` is a **constant-false placeholder** until #472 lands — the
target returns no overlay `report` because `applyMemoryOverlay` does not exist yet, so today the
scorer discriminates nothing; it becomes the live composition check when the #472 overlay slot in
the target is filled.

Note on case wording: the negative control asks `"launch code please"` rather than `"what is the
launch code?"` because **FTS5 ships no stopword list** — a question containing `the` or `is`
retrieves any record sharing only those tokens, which made the case pass for an accidental
lexical reason. The probe questions are deliberately free of tokens that appear in the seeds.

### `memory-portability` — ADR-0009 D-3 at the behaviour layer (`xfail-strict`, unblocked by #462/#463)

One corpus, written in a single `write([...])` call to **both** an `InMemoryMemoryStore` and a
temp-file `SqliteMemoryStore`, then compared on two legs: the raw `store.search` match set, and
the `assembleRecall` block's record lines. Cases: `port-stemming-prefer`, `port-substring-am`,
`port-diacritics-cafe`, `port-punctuation-dark-mode`, `port-disjoint-tokens` and `port-batch-tie`.

Two implementation notes the plan's sketch could not anticipate:

- **Record ids are store-assigned**, so the two backends cannot share them over one corpus. The
  portable identity across backends is the record **content**, unique per corpus entry by
  construction; the family compares content sets, not id sets.
- **Sets, never order.** ADR-0009 Decision 13 pins match semantics and explicitly does *not* pin
  total rank order (in-memory ties at score 1 and falls to recency; FTS5 uses bm25). An
  order-sensitive assertion here would relocate the divergence instead of measuring it.
- **Parity requires a non-empty leg.** Empty-vs-empty is vacuous agreement, not evidence of
  portability — the scorer ERRORs when both backends return nothing, so the family can never
  certify a query on which neither backend retrieves anything.

`port-disjoint-tokens` and `port-punctuation-dark-mode` **pass today**. They are the
future-proofing half: the disjoint case is the only one that distinguishes OR from AND, so a
Postgres backend declaring `"keyword"` and defaulting to `plainto_tsquery` AND would fail it while
passing everything else.

## Re-baseline under SQLite (#460)

The obligation: any family that flips status under the shipped backend is **recorded here with its
cause**, never repaired by loosening an assertion.

**`memory-budget` — still PASS, with one fix to the family.** Its filler content was
`Seeded budget-filler fact #${i}: …`, a **variable-width** index. Both backends assign one `now`
per batch, so every filler ties on `createdAt`, and the recency listing resolves that tie by
insertion order in memory and by `seq DESC` on SQLite — *different* records (`#000…` vs `#039…`),
whose formatted entries differ in length. The block's char count therefore depended on which end
of the batch the tie order picked. The index is now zero-padded to a fixed width, so every filler
costs identical chars and the family measures the budget contract instead of the tie order.
**No assertion was loosened** — `truncated === expected.truncated`, the marker rule, `chars ===
block.length` and `block.length <= budgetChars` are all unchanged; measured on SQLite the family
truncates at 3 records / 572 chars against a 600-char budget, versus 3 records / 569 chars
in-memory.

**`memory-recall-cite` — NOT re-baselined; live run not possible in the authoring container**
(no provider key and no `claude` CLI on PATH). It is the family the ADR flags as at risk, and the
risk is confirmed at the store layer. Measured against its own seeds:

| the query the model might issue | in-memory | SQLite |
|---|---|---|
| `"drink"` | 1 hit (`Drinks espresso…`) | **0 hits** |
| `"drinks"` | 1 hit | 1 hit |
| `"what do I usually drink"` | 2 hits | **0 hits** |
| `"editor"` / `"editor preference"` | 1 hit | 1 hit |
| `"prefer"` | 1 hit | **0 hits** |

So `recall-espresso` now passes only if the model happens to search the *plural* `"drinks"`;
`recall-editor` is robust because `"editor"` is a whole token in the seed. The next live run must
record its result here. If `recall-espresso` flips red, the cause is token semantics and the
remedy is #462's shared tokenizer — **not** a reworded expectation.

The other three live families are structurally safe under the swap: their scorers use the
query-less listing and filter in JS, and the supersede chain (`invalidAt` + `supersededBy`) and
the `scope: {}` whole-store sweep were verified to behave identically on SQLite.

## Design notes

- **Isolation**: no family shares a store with another. `memory-budget`, `memory-paraphrase` and
  `memory-portability` build a fresh store **per case** — a shared closure would let case *n* pass
  on case *n-1*'s writes.
- **Store-state scorers** are the point: memory behavior is a side effect, so scorers close over
  the family's store and assert what was *written*, not just what was *said*. The supersede family
  checks the `supersededBy` chain and forbids duplicates (exactly one live new-fact record);
  scope-confinement sweeps the WHOLE store for any non-seeded record outside the bound partition.
  The contradiction check is substring-grade (lexical window — a record asserting the old fact
  while merely *mentioning* the new one can slip it); Phase C hardening can tighten this.
- **The gate cannot pass vacuously**: node errors, scorer errors, and an empty pass-rate map all
  FAIL the family (`ap eval`'s three-term gate); malformed expectations ERROR instead of passing;
  a runner-resolution failure without `--dry` exits 2 (config error) rather than silently skipping
  the live families.
- **Events are diagnostics, not gates**: `agent.memory.*` counts print per family, but tool-event
  emission is runner-dependent (the claude-CLI fallback executes tools without a
  `ToolExecutionContext`), so gating on them would flake by runner.
- **Persistence** uses `ap eval`'s calls — set/case bank (`upsertEvalSet`/`upsertEvalCase`, so the
  dashboard's eval surface can browse these sets), suite row with `gitSha` provenance, per-case
  rows via `createEvalResultRecorder`, `close()` on exit — into `$AP_DB_PATH` |
  `~/.local/state/ap/events.db`. Not mirrored (follow-up): the `SQLiteExporter` event-trace
  attachment.
- Deterministic families persist under their own `targetId` (`assemble-recall`,
  `paraphrase-prompt`, `backend-parity`) with no model — they never run the companion, and Phase C
  keys promotion decisions on `targetId`.
- Case banks are `loadCasesJsonl`-shaped (`cases/*.jsonl`) and stay CLI-compatible.
- Exit codes: `0` every executed family met its tier · `1` a `hard` family failed, an
  `xfail-strict` family passed, **or** an `xfail-strict` family errored (`XFAIL-INVALID`) · `2`
  config error (no runner without `--dry`, bad `AGENT_TIER`, or no SQLite memory backend).

## Run log

- **2026-08-08, ClaudeCodeAPIRunner, in-memory backend:** 5/5 families PASS. *Superseded* — that
  backend is not the one the companion ships on (see above).
- **2026-08-08, `--dry`, SQLite backend (#460/#461):** `memory-budget` PASS ·
  `memory-paraphrase` XFAIL · `memory-portability` XFAIL · four live families skipped. Exit 0.
  Both XFAILs are the intended landing state: `memory-paraphrase` is the reported bug reproduced
  as a committed artefact, and `memory-portability` is D-3's debt made visible.
- **Live re-baseline on SQLite: still owed.** No runner is resolvable in the authoring container.
