# Handoff — 2026-08-15

**Branch:** `hr/runner-5-timeouts` (create a fresh worktree off it — the authoring worktree has been reaped)
**Last action:** Implemented #521 `RunOptions.timeout` (`feba398`, pushed) — runtime + core, 13 new tests, `bun run check` green. Spec was Gate-1.5-cleared over three critique rounds (`bc06774`).
**Next action:** Gate 2.5 paired diff review on #521 — spawn `sdlc:reviewer` (lens=adherence, against `.ai-docs/specs/521-timeouts.md`), then `sdlc:reviewer` (lens=quality, against quality-canvas), SEQUENTIAL, diff base **`origin/main...HEAD`** (see the stack note — the old parent is merged). Then `sdlc:validator` (posts to the PR), then open the PR for this branch, `gh pr edit` for title/body. Then start #522 (storage-6, last of the track) from spec-authoring.
**Obstacles:**
- **`gh stack` is NOT installed** (`gh extension list` → only `gh attach`), and **there is no PR #546** — the "gh stack #546" reference below never resolved to anything. Step 7's `gh stack sync && gh stack submit --auto` will fail as written. Either install the extension or open the PR with plain `gh pr create --base main`.
- None technical; env gotchas below are all pre-verified.

## Notes — the operating brief for the next agent

**Operator instruction of record (Doug, in chat):** run the *proper* SDLC loop per issue; orchestrate the whole serialized runner track; stack PRs with the `gh stack` CLI; he checks in periodically after natural bodies of work; keep THIS doc updated continuously. Gate 1 is recorded as `gate:auto` + `state:strategy-approved` per that instruction — cite it in the tracker comment each time (see #514/#521 comments for the template).

**The stack** (as of 2026-08-15 — the first three are all merged; no `gh stack` state exists, see Obstacles):
```
main (7505cb5)
 ├─ #496 per-call event bus   → PR #543  ✅ MERGED
 ├─ #504 abort forwarding     → PR #544  ✅ MERGED 00:40:23Z
 ├─ #514 modelParams          → PR #545  ✅ MERGED 00:46:56Z
 └─ hr/runner-5-timeouts      #521 → 0e74095  ⏳ Gate 2.5 next; NO PR YET
     └─ #522 storage-6 (model price table + costUsd) — not started; branch name in issue header
```
`hr/runner-5-timeouts` is now 2 behind / 14 ahead of `main`. Its old stack parent `hr/runner-4-model-params` still exists on origin (`d072341`) but is merged-and-gone, so **diff against `origin/main`, not the parent** — this is the one place the "diff base = stack parent" rule below no longer applies. Rebase onto `origin/main` before opening the PR.

**Loop recipe (proven 3×; repeat for #521-remainder and #522):**
1. Spec at `.ai-docs/specs/<n>-<slug>.md`, committed on the issue's stacked branch. Author in-session (context is hot); verify every line anchor + SDK claim by grep/probe first — the critics WILL catch asserted-not-executed claims.
2. Gate 1.5: `sdlc:reviewer` lens=mixed, `skip_tracker_post: true`, appends `## Spec Review` to the spec. REVISE → fix spec in place + `## Design Addendum` → re-run (rerun: true, fold prior verdict into a superseded details block). Iterate to PASS.
3. Gate 1: labels + tracker comment (template in #521's issue comments).
4. Implement: `sdlc:implementer` subagent, existing branch, no PR, push when green. Brief it with the env block below verbatim.
5. Gate 2.5: two `sdlc:reviewer`s SEQUENTIAL (adherence vs spec, then quality vs quality-canvas — never give quality the spec). Diff base = the STACK PARENT while the parent is unmerged; once it merges, `origin/main`. Fix actionable notes, commit, re-run only if a blocker.
6. Gate 3: `sdlc:validator` → posts report to the PR; it commits a spec phase-log locally — push it after.
7. Open/refresh the PR — `gh pr create --base main` (or `gh stack sync && gh stack submit --auto` **only if** the `gh stack` extension is actually installed; it is not, as of 2026-08-15), then `gh pr edit <n>` for real title/body. CI: `gh pr checks <n> --watch` (background; exits early with "no checks reported" if the workflow hasn't attached — re-run).

**Environment (all pre-verified; brief every subagent with this verbatim):**
- `export PATH=/opt/node22/bin:$PATH` before ANY check — default Node 20 breaks the docs-site build AND better-sqlite3 (native module rebuilt for Node 22 ABI this session; it now FAILS under Node 20).
- Exactly two tests in `packages/agent-runtime/src/__tests__/claude-code-runner.test.ts` always fail locally (no live LLM, root + `--dangerously-skip-permissions`); they pass in CI. Any OTHER failure is real.
- `bun run check`'s exit code is always 1 here (the `&&` chain short-circuits at test); the three sub-gates after `test` must be run individually to be verified.
- Local `main` is STALE (checked out in the primary worktree, can't update) — always base diffs on `origin/main` or the stack parent.
- Baseline runner-suite counts after #521: `agent-runner.test.ts` 97 · stream 27 · event-bus 3 · abort-forwarding 8 · model-params 9 · timeouts 13. Reviewers/validators check these exactly.

**Program state:** this is epic #482 (framework hardening), plan-keys `framework-hardening/runner-N` + `storage-6`. After #522, the serialized agent-runner.ts track is done; remaining epic issues (see `gh issue list`) are parallelizable and NOT covered by the standing instruction — check with Doug before starting them.

**Review-surfaced follow-ups (documented in spec phase sections, none blocking, candidates for new issues):** `stream()`'s name-only AbortError catch diverges from `isAbortRejection` both directions; Langfuse `_iterationSpans` retention on cancelled runs; wall-clock timing margins in abort/timeout tests (25–150ms — CI flake risk); the 3× knob declaration in agent-runner (ModelParams/CallParams/spread) isn't compiler-forced; `reasoningEffort` can't express `provider-default`; capable-path `toolMs ≤ modelMs` is guidance, not sufficiency (step budget shared with the model call).

**Durability rule (learned the hard way, 2026-08-15):** commit and push everything to the branch as you go — specs, gate trails, and THIS doc. A prior session wrote a full handoff brief and three memory files into a session worktree that was reaped before they landed; the git-side work survived, the local-file side was lost and had to be reconstructed from the transcript. Nothing that matters may live only in a worktree.

**Memory:** `local-check-env-gotchas`, `framework-hardening-program`, and `orchestrate-epic-full-loop-stacked` are written and indexed in `MEMORY.md` (2026-08-15) — they duplicate the env block, program state, and operator instruction above so a cold session gets them before reading this file.

**If resuming cold:** `/prime` loads this file. Then read the relevant `.ai-docs/specs/*.md` — each carries its full Spec Review / Diff Review / Live Validate history. (`gh stack view` is in the original brief but the extension isn't installed; use `git log --oneline origin/main..HEAD` instead.)
