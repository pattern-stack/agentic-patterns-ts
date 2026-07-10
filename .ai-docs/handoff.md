# Handoff — 2026-07-09

**Branch:** `main` (clean, synced)
**Last action:** **Primitive-knowledge rework SHIPPED + PUBLISHED.** Stack #216 → #217 → #218 merged sequentially to main (c264e69); publish job succeeded — npm dist-tags verified: **core 0.9.0**, runtime/server/cli **0.21.0** (dashboard untouched). Old PR #90 closed with a pointer. The stack: camelCase atom keys + `scripts/migrate-to-camelcase.ts` codemod (#216) → Tone/Methodology/Recovery wired into Role/rendering/AgentConfig + one section-composed prompt path (#217) → `getSystemPrompt`/`renderSystemPrompt` removed from core + the `AgentLike` contract, release bump (#218).
**Next action:** Nothing mid-flight. Follow-up candidates below, or start fresh.
**Obstacles:** none blocking.

## Records of the work
- **ADR 0002** (`docs/adr/0002-primitive-knowledge-rework.md`) — why + what shipped + full key-rename table + migration one-liner.
- **Spec of record + Gate 2.5 review** (`.ai-docs/stacks/primitive-knowledge/specs/primitive-knowledge.md`) — approved plan + paired-lens diff review: Adherence PASS_WITH_NOTES / Quality PASS_WITH_NOTES, 0 blockers total.
- `build-on-agentic-patterns` SKILL.md (repo + plugin-template mirror) now teaches the three knowledge slots + single prompt path.

## Notes / follow-up candidates
- **`AgentConfig.toPrompt()` is a fourth render path** (quality review's real finding, `agent-config.ts:99`): renders persona without the Tone object then appends flat tone/methodology/recovery blocks — a config with both `persona.tone` and `rt.tone` double-renders tone in that preview. Small reconcile-onto-sections change; shifts preview text + tests.
- **Consumer migration when upgrading** swe-brain / query-agent-poc / retrieval-agent (all pin old versions): `bun scripts/migrate-to-camelcase.ts --keys --methods --write <dir>`.
- Nits from review: vestigial `getSystemPrompt` in two backward-compat discover fixtures (legitimate; could carry a comment); `Persona.toPrompt(opts)` is the only atom `toPrompt` taking an argument.
- `as-agent.ts` `DEFAULT_MODEL = "sonnet"` for promoted agents still brushes the #179 no-framework-default philosophy — candidate issue.
- `State`/`Roster` atoms: keys renamed but still unwired — wiring them is its own decision.
- Open board items unchanged: #205 (z.infer enum leak root cause), #206 (better-sqlite3 ABI), #158, #157, #120/#119, #110, #54, #43, #42.
- **Stacked-merge gotcha (process):** `gh pr merge --delete-branch` on the bottom PR **closes** dependent stacked PRs instead of retargeting them. Recovery: `git push origin <sha>:refs/heads/<base-branch>` to restore the ref → `gh pr reopen` → `gh pr edit --base main` → merge without `--delete-branch` → delete branches at the end.
- Untracked leftover: `.ai-docs/research/adk-plugin.md` (pre-existing, ADK plugin design — unimplemented, targets core; still relevant).
