# Handoff — 2026-08-10

**Branch:** `main` (clean; everything from this session is merged and published)
**Last action:** Ran the ambient test (Test A — **PASS**), then cut and verified the release: **core 0.18.0 / lockstep 0.39.0 published to npm** (#468, dist-tags confirmed). Also shipped two sdlc-plugin versions and corrected two false claims in the walkthrough.
**Next action:** **Memory Phase B (#434)** — ADR-0009 is fully decided, so routing / `Background` reshape / overlay is unblocked and nothing else gates it. Before touching code, read the "widen the instantiate seam to `{agent, report}`" decision on #452 and coordinate it with `AgentRegistry.resolve()` from #462.
**Obstacles:**
- **`bump.sh` re-resolves the lockfile and will trip `sdk-contract.test.ts` on any release cut where `@anthropic-ai/claude-agent-sdk` has moved.** Happened this session (0.3.225 → 0.3.226). This is the test working as designed. Fix = review the `bun.lock` diff, then re-pin `packages/agent-runtime/src/runner/__fixtures__/claude-agent-sdk-contract.json`. Only re-pin if the platform-package *set* and `peerDependencies` are unchanged; if either moved, that is a real upstream repackaging and needs a look.
- **`agent_runs.final_answer` is empty** on the claude-CLI path (answer lives in `agent.message.complete`). sdlc-patterns#363, unchanged.

## Ambient test — Test A PASSED

Evidence, all verified rather than recalled:

- **Loop fires unattended.** Worker log shows the four-line sequence: dispatcher → `agent.run` enqueued → `AgentRunJobHandler` fired → completed run (27 events, 4/726 tokens).
- **Provenance is durable.** `run_context.trigger` carries `kind:schedule`, `scheduleName`, `directiveName`, and the claimed slot.
- **Lineage is right.** `agent-run` on pool `interactive`, parent `schedule-dispatcher` on `batch` — the LLM loop does not squat the concurrency-5 batch pool.
- **The run was real.** `claude-sonnet-5`, six tools bound, substantive answer in `agent.message.complete`.
- Stood down at 292 schedule-triggered runs; `demo-minutely` is **disabled**.

## The finding that matters: ambient runs are invisible

```
schedule-triggered : 292 runs → conversation_id IS NULL  (all)
console-started    :   4 runs → conversation_id set      (all)
```

The agent surface renders activity from `agent_conversations`; the ambient path creates none. So `workspace-analyst` reports `conversations 0 · No conversations yet` **despite 296 runs**. Not a rendering bug and not hidden behind a tab — structural.

This is hard evidence for **#456** (Agent Workspace epic) chunks 2–3, posted there with the query. It also means **psql is the ground truth for A3 — the browser cannot confirm the loop ran.**

## Shipped this session

| What | Where |
|---|---|
| core 0.18.0 / runtime+server+cli 0.39.0 | #468 — **published**, dist-tags verified. Unblocks sdlc-patterns#364 |
| Walkthrough §A4 corrected (2 false claims) | #467 |
| sdlc plugin **0.2.23** — `mcpServers` hoisted out of `components` | claudecode-patterns#114 |
| sdlc plugin **0.2.24** — `guided-tour` capability | claudecode-patterns#115 |
| Evidence comment on the Agent Workspace epic | #456 |

## Notes

**The plugin MCP bug (fixed, but the lesson generalizes).** `plugin.json` nested its component fields under a `components` wrapper, which is not in the Claude Code manifest schema. `skills/`, `agents/`, `commands/` and `output-styles/` all have **default directory scans**, so they loaded anyway and masked the error for many releases — `mcpServers` has no default location, so it alone was fatal, and the three browser MCP servers silently never registered. `claude plugin validate` catches this outright (`Unknown field 'components'`); it is now wired into that repo's CI. **Run `claude plugin validate` on any plugin manifest change.**

**`guided-tour` (new, sdlc plugin 0.2.24).** One tour file, two modes: `narrate` drives a real browser over raw CDP with a visible cursor/highlight/ripple for watchable walkthroughs; `--verify` runs the same steps with assertions and writes `report.json`. Engine ships in the plugin; **tours live in the consuming project at `.claude/tours/<name>.mjs`**, agent-authored and reviewed. Playwright's `connectOverCDP()` **hangs against Arc** — raw CDP on the same endpoint is fine; documented in the plugin's `browser` skill. CI-native use still needs a headless Chromium on `--cdp` (untested).

**swe-brain tour** is on branch `docs/ambient-loop-tour` (pushed, **no PR** — deliberate, Doug wants to iterate on the format first). Its last step is a **deliberate red check** asserting trigger provenance on the agent surface; it goes green when #456 chunks 2–3 land. Login fills **password before email** — 1Password clears the email field when focus enters the password input — and a non-optional `waitFor` after submit is an auth tripwire, because a failed login otherwise cascades into every later step failing for the wrong reason.

**Resolved: the frontend has no mock path.** `SyncMode` is `'api' | 'electric'` only, every entity resolves to `mode:'api'`, and `VITE_DATA_SOURCE` is declared in `vite-env.d.ts` but read nowhere. No `.env.local`, no `VITE_API_URL` needed. The `process-compose.yml` comment claiming mock data is stale.

**Open, unfiled:** four auth-internal collections 404 on every swe-brain page load (`auth_sessions`, `email_verifications`, `password_resets`, `user_credentials`) — the generated frontend binds collections to entities the API withholds. Cosmetic but noisy; not yet filed.

**Untracked in the tree** (pre-existing, not from this session): `docs-site/`, `.ai-docs/patternstack/next-session-prompt.md`, `.ai-docs/research/memory-recall-retrieval-quality.md`. `docs-site/` looks like unlanded work against #458.

## Where the program stands

M1 memory Phase 1 and M2 ignition are **done and published**. What exists is a working *vertical slice* of ambient — a cron minute starts a real agent run and the row records why — **not a full ambient system**. Three gaps, in order of how much they hurt:

1. **The agent cannot tell you anything.** `agent.run` enqueues and returns `{jobRunId, enqueued}`, not the answer, so a downstream `messaging.message.create` has nothing to bind. Scheduled directives also withhold `actuate` by design. Opening that is the pending C1 policy decision (consent-gated DM-to-owner first).
2. **You cannot see what it did** — #456, the finding above.
3. **It has no memory on that path** — swe-brain memory adoption is sdlc-patterns#364, now unblocked by this release.

M3 (AgencyHost daemon), M4 (ChannelAdapter protocol), M5 (identity), M6 (skill synthesis) are all still open. swe-brain has app-level equivalents of M3/M4 (worker split, Slack/Google ingress) but the framework-tier protocols do not exist yet.
