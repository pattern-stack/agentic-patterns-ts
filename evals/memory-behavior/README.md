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

- **Isolation**: every family gets a fresh `InMemoryMemoryStore` + freshly built companion —
  deterministic seeds, no cross-family bleed, the user's real memory db untouched.
- **Store-state scorers** are the point: memory behavior is a side effect, so scorers close
  over the family's store and assert what was *written*, not just what was *said*.
- **Persistence** mirrors `ap eval` exactly (`startEvalRun` + `createEvalResultRecorder` into
  `$AP_DB_PATH` | `~/.local/state/ap/events.db`) so runs appear in the dashboard's eval surface.
- Case banks are `loadCasesJsonl`-shaped (`cases/*.jsonl`) and stay CLI-compatible.
- Exit codes: 0 gate pass · 1 gate failure · 2 config error (CI-friendly).

First full live run (2026-08-08, ClaudeCodeAPIRunner): **5/5 families PASS.**
