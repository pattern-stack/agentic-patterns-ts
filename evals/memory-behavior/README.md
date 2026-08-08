# Memory-behavior eval set (#446)

Five families over the shipped Phase 1 memory surface (ADR-0007), with the **companion**
agent (#445) as the subject. **Not throwaway**: ADR-0008 Decision 7's eval-gated promotion
IS this harness pointed at `config` vs `config′` — these families become the Phase C (#435)
promotion gates.

```bash
just eval-memory            # live run (needs a resolvable runner: provider key /
                            # AGENT_MODEL / AGENT_TIER / claude CLI on PATH)
bun x tsx evals/memory-behavior/run.mts --dry    # deterministic families only
```

| Family | Mode | Asserts |
|---|---|---|
| `memory-recall-cite` | live | seeded records → the agent surfaces and uses the right fact |
| `memory-save-on-instruction` | live | told a durable preference → a record LANDS in the partition (store-state scorer, not response text) |
| `memory-supersede` | live | corrected fact → new record live, seeded record invalidated (audit trail survives), no live record asserting the old fact without the new |
| `memory-scope-confinement` | live | foreign-partition secrets never surface in answers; no write escapes the bound partition |
| `memory-budget` | deterministic (no model) | `assembleRecall` as a FunctionStep node target: over-budget scope → MARKED truncation, never a silent clip |

Design notes:

- **Isolation**: every family gets a fresh `InMemoryMemoryStore` + freshly built companion, and
  the budget family's `FunctionStep` builds a fresh store PER CASE — no cross-family or
  cross-case bleed, the user's real memory db untouched.
- **Store-state scorers** are the point: memory behavior is a side effect, so scorers close
  over the family's store and assert what was *written*, not just what was *said*. The
  supersede family checks the `supersededBy` chain and forbids duplicates (exactly one live
  new-fact record); scope-confinement sweeps the WHOLE store for any non-seeded record outside
  the bound partition. The contradiction check is substring-grade (lexical window — a record
  asserting the old fact while merely *mentioning* the new one can slip it); Phase C hardening
  can tighten this.
- **The gate cannot pass vacuously**: node errors, scorer errors, and an empty pass-rate map
  all FAIL the family (`ap eval`'s three-term gate); malformed expectations ERROR instead of
  passing; a runner-resolution failure without `--dry` exits 2 (config error) rather than
  silently skipping four families.
- **Events are diagnostics, not gates**: `agent.memory.*` counts print per family, but
  tool-event emission is runner-dependent (the claude-CLI fallback executes tools without a
  `ToolExecutionContext`), so gating on them would flake by runner.
- **Persistence** uses `ap eval`'s calls — set/case bank (`upsertEvalSet`/`upsertEvalCase`, so
  the dashboard's eval surface can browse these sets), suite row with `gitSha` provenance,
  per-case rows via `createEvalResultRecorder`, `store.close()` on exit — into
  `$AP_DB_PATH` | `~/.local/state/ap/events.db`. Not mirrored (follow-up): the
  `SQLiteExporter` event-trace attachment.
- The budget family persists under `targetId: "assemble-recall"` with no model — it never runs
  the companion, and Phase C keys promotion decisions on `targetId`.
- Case banks are `loadCasesJsonl`-shaped (`cases/*.jsonl`) and stay CLI-compatible.
- Exit codes: 0 gate pass · 1 gate failure · 2 config error (CI-friendly).

First full live run (2026-08-08, ClaudeCodeAPIRunner): **5/5 families PASS.**
