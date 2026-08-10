# Handoff — 2026-08-09

**Branch:** `main` (both repos; every branch from this arc is merged)
**Last action:** Merged 12 PRs across two repos — memory stack (#447→#454), trigger contract (#460→#462), ADR-0009 (#452) in agentic-patterns-ts; upgrade + ignition wire (#360, #361) in sdlc-patterns. Verified merged `main` green (`bun run check` + SQLite memory smoke). All ADR-0009 open questions answered and recorded on #452.
**Next action:** Run the ambient test — `.ai-docs/ambient-test-walkthrough.md`, Test A (schedule → agent run, ~15 min, no API key needed). Then decide the release: `just bump-both` → core 0.18 / lockstep 0.39 (main carries unpublished memory + trigger work; sdlc-patterns#364 is blocked on it).
**Obstacles:**
- Version bump not cut — swe-brain's second pass (sdlc-patterns#364) needs core 0.18/0.39 on npm.
- `bump.sh` footgun: `scripts/publish.sh` **silently** skips already-published versions; `rm bun.lock && bun install` after bumping.
- Frontend data-source ambiguity for the browser pass: `process-compose.yml` says the frontend runs on mock, the generated store binds entities to `api`/`electric`. Unresolved — psql/API is ground truth. Details in the walkthrough §A4.

## Notes
**Decisions of record** (Doug, 2026-08-09, all on #452): default `promotion: locked` (guarded is a fast-follow once HITL reaches the memory lane) · Locked-tier semantic bypass = accepted limit (its real fix is the enforced-sections arc, #465) · no prompt marking of memory fragments · budgets ship as tunable defaults · **widen the instantiate seam to `{agent, report}`** so the overlay report reaches the composition lens — coordinate with `AgentRegistry.resolve()` from #462 · `label` → **`attribute`** · `asAgent()` emits a role-sourced section · section naming = look-before-merge, later renames explicitly acceptable. Trigger contract (on #460/#462): `message` stays distinct from `webhook`, `TriggerSource` stays an atom, `runFromTrigger()` lands in M2.

**Next build arc** is memory Phase B (#434) — ADR-0009 is fully decided, so routing / `Background` reshape / overlay is unblocked. It breaks `buildAgentFromConfig` consumers (ships as core 0.18 / runtime 0.39); breaking swe-brain again is expected and accepted.

**Filed this session:** agentic-patterns-ts #464 (recall preview puts raw memory content on the exporter bus — conflicts with ADR-0009's ids-only telemetry stance) · #465 (idea: behaviorally-enforced prompt sections) · sdlc-patterns #363 (`final_answer` empty on the CC-runner path) · #364 (swe-brain second pass: adopt TriggerSource + runFromTrigger + memory — the gate before the codegen `agents` subsystem extraction).

**Review artifacts:** dossier at https://claude.ai/code/artifact/da17186b-f088-4c8c-b68f-68d8b69f984c (per-PR review paths, Gate 2.5 verdicts, decision queue, merge sequencing). Post-hoc Gate 2.5 reviews landed on #451/#453/#454 — all REVISE, 5 blockers, all fixed before merge. #455 closed as superseded; its salvage list is on the PR.

**M2 (#437) is done except the last checkbox** (codegen `agents` subsystem), which stays gated until sdlc-patterns#364 proves the shape settled. Trigger contract spec: `.ai-docs/stacks/m2-ignition/trigger-contract-spec.md`. Program brief for a cold reader: `.ai-docs/patternstack/ambient-platform-brief.md`.
