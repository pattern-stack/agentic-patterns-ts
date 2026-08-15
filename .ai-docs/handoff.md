# Handoff — 2026-08-15

**Branch:** `hr/runner-5-timeouts` (worktree `.claude/worktrees/bridge-cse_01X2fKnXgxYKjFCoRXRkT6nk`)
**Last action:** Implemented #521 `RunOptions.timeout` (`feba398`, pushed) — runtime + core, 13 new tests, `bun run check` green. Spec was Gate-1.5-cleared over three critique rounds (`bc06774`).
**Next action:** Gate 2.5 paired diff review on #521 — spawn `sdlc:reviewer` (lens=adherence, against `.ai-docs/specs/521-timeouts.md`), then `sdlc:reviewer` (lens=quality, against quality-canvas), SEQUENTIAL, diff base `hr/runner-4-model-params...HEAD`. Then `sdlc:validator` (posts to the PR), then `gh stack sync && gh stack submit --auto`, `gh pr edit` for title/body. Then start #522 (storage-6, last of the track) from spec-authoring.
**Obstacles:**
- PRs #544 (#504) and #545 (#514) are gate-complete + CI-green but wait on Doug's Gate-2 merge (bottom-up: #544 first). Not blocking #521/#522 work — the stack absorbs it.
- None technical; env gotchas below are all pre-verified.

## Notes — the operating brief for the next agent

**Operator instruction of record (Doug, in chat):** run the *proper* SDLC loop per issue; orchestrate the whole serialized runner track; stack PRs with the `gh stack` CLI; he checks in periodically after natural bodies of work; keep THIS doc updated continuously. Gate 1 is recorded as `gate:auto` + `state:strategy-approved` per that instruction — cite it in the tracker comment each time (see #514/#521 comments for the template).

**The stack (gh stack #546):**
```
main (17b7523 = #496 merged via PR #543)
 └─ hr/runner-2-abort-forwarding  #504 → PR #544  ✅ gates+CI — merge first
     └─ hr/runner-4-model-params  #514 → PR #545  ✅ gates+CI
         └─ hr/runner-5-timeouts  #521 → feba398  ⏳ Gate 2.5 next; no PR yet
             └─ #522 storage-6 (model price table + costUsd) — not started; branch name in issue header
```

**Loop recipe (proven 3×; repeat for #521-remainder and #522):**
1. Spec at `.ai-docs/specs/<n>-<slug>.md`, committed on the issue's stacked branch. Author in-session (context is hot); verify every line anchor + SDK claim by grep/probe first — the critics WILL catch asserted-not-executed claims.
2. Gate 1.5: `sdlc:reviewer` lens=mixed, `skip_tracker_post: true`, appends `## Spec Review` to the spec. REVISE → fix spec in place + `## Design Addendum` → re-run (rerun: true, fold prior verdict into a superseded details block). Iterate to PASS.
3. Gate 1: labels + tracker comment (template in #521's issue comments).
4. Implement: `sdlc:implementer` subagent, existing branch, no PR, push when green. Brief it with the env block below verbatim.
5. Gate 2.5: two `sdlc:reviewer`s SEQUENTIAL (adherence vs spec, then quality vs quality-canvas — never give quality the spec). Diff base = the STACK PARENT, not main. Fix actionable notes, commit, re-run only if a blocker.
6. Gate 3: `sdlc:validator` → posts report to the PR; it commits a spec phase-log locally — push it after.
7. `gh stack sync && gh stack submit --auto`, then `gh pr edit <n>` for real title/body. CI: `gh pr checks <n> --watch` (background; exits early with "no checks reported" if the workflow hasn't attached — re-run).

**Environment (all pre-verified; brief every subagent with this verbatim):**
- `export PATH=/opt/node22/bin:$PATH` before ANY check — default Node 20 breaks the docs-site build AND better-sqlite3 (native module rebuilt for Node 22 ABI this session; it now FAILS under Node 20).
- Exactly two tests in `packages/agent-runtime/src/__tests__/claude-code-runner.test.ts` always fail locally (no live LLM, root + `--dangerously-skip-permissions`); they pass in CI. Any OTHER failure is real.
- `bun run check`'s exit code is always 1 here (the `&&` chain short-circuits at test); the three sub-gates after `test` must be run individually to be verified.
- Local `main` is STALE (checked out in the primary worktree, can't update) — always base diffs on `origin/main` or the stack parent.
- Baseline runner-suite counts after #521: `agent-runner.test.ts` 97 · stream 27 · event-bus 3 · abort-forwarding 8 · model-params 9 · timeouts 13. Reviewers/validators check these exactly.

**Program state:** this is epic #482 (framework hardening), plan-keys `framework-hardening/runner-N` + `storage-6`. After #522, the serialized agent-runner.ts track is done; remaining epic issues (see `gh issue list`) are parallelizable and NOT covered by the standing instruction — check with Doug before starting them.

**Review-surfaced follow-ups (documented in spec phase sections, none blocking, candidates for new issues):** `stream()`'s name-only AbortError catch diverges from `isAbortRejection` both directions; Langfuse `_iterationSpans` retention on cancelled runs; wall-clock timing margins in abort/timeout tests (25–150ms — CI flake risk); the 3× knob declaration in agent-runner (ModelParams/CallParams/spread) isn't compiler-forced; `reasoningEffort` can't express `provider-default`; capable-path `toolMs ≤ modelMs` is guidance, not sufficiency (step budget shared with the model call).

**If resuming cold:** `/prime` loads this file. Then `gh stack view` from any `hr/runner-*` branch, and read the relevant `.ai-docs/specs/*.md` — each carries its full Spec Review / Diff Review / Live Validate history.
