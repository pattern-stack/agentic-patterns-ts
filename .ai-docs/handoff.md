# Handoff — 2026-08-04

**Branch:** `main` (this handoff lands via its own PR). No open work branches — #382 and #392 are both merged.

> **Roll-forward note (08-04):** the 07-27 handoff below is preserved because its epic record is still the best account of the v7 arc. Only the stale claims are corrected, in place, marked `[08-04]`. Two of them were already stale when written — #382 had merged the previous day.

**Last action:** **AI SDK v5 → v7 epic (#384) fully shipped and closed** — six issues through the full SDLC loop in one session (specs → Gate 1.5 critique → implement → paired Gate 2.5 diff review → Gate 3 validation, all logged on issues/PRs):

| Issue | PR | What |
|---|---|---|
| #385 | #391 (0.31.0) | ESM-only output (CJS dropped), `engines.node >= 22`, both no-CJS gates flipped |
| #386 | #393 (0.32.0) | ai@5→ai@7 + provider@2→4; codemods v6+v7; `ResolvedLanguageModel = V2\|V3\|V4` widening; `MockLanguageModelV2`→V3 across 12 suites |
| #387 | #394 | `ClaudeCodeLanguageModel` V2→V4: nested usage w/ anthropic-parity cache formula, `{unified,raw}` finishReason, native `reasoning`→`effort`/`thinking` mapping |
| #388 | #395 (stack-merged @ 0.34.0) | `TokenUsageDetails` through events → SSE → console/Langfuse/OTel → dashboard waterfall |
| #390 | #402 (0.35.0) | Capability map `providers/capabilities.ts`: `{support, verifiedBy, lastVerified}` honesty refines, probe script, monthly CI job, advisory warns in `runStructured()` |
| #389 | #403 (stack-merged @ 0.36.0) | Gates → native `toolApproval` (Option C): `runner/tool-approval-bridge.ts`, gate chain as async approval callback on the capable path; fail-closed on abort + throwing gates; deny continues the loop model-visibly |

Published at the time of writing: `core@0.15.0`, lockstep `0.36.0`. **[08-04] Now `core@0.16.0` (#392/#266) and lockstep `0.37.0` (#408/#406) — all four packages published and in sync with `main`.** Epic #384 + `ai-sdk-v7` milestone closed. Research + decisions: `.ai-docs/stacks/ai-sdk-v7/{understanding,plan}.md`; per-issue specs with all phase logs in `specs/`.

**Superseded from the 07-26 handoff:** #374's `shims: true` fix was removed by #385 (dead once CJS output died); the dist-contract gate #374 added was flipped to assert ESM-only. #285 (justfile→pnpm) still open but note `just` isn't installed in this container — `bash scripts/bump.sh` is the direct path.

---

## Next-action queue

### 1. ~~Resolve #382~~ — **[08-04] DONE.** Merged 2026-07-26. Decision: `.describe()`s kept (they feed `ToolSchema.returns`, which the dashboard tool-workbench renders and the model sees); rationale recorded in the PR body. This item was already stale when the 07-27 handoff was written.

### 2. New from the v7 epic (untracked, in rough priority order)
- **HTTP-reachable HITL** — the approval bridge is `runStructured()`-seam-only; server's `POST /conversations/:id/messages` only calls `runner.stream()`. Deliberate Option-C scoping (spec 389 Open Q + PR #403 "Known asymmetry"). Wiring the route (or a structured-run route) to the bridge is the natural follow-up.
- **Live-key verification wave** — real Anthropic cache numbers (#387/#388 caveat), Langfuse cost view, capability probes (`scripts/probe-capabilities.mjs`). Blocked on secrets: container has neither `pts` nor `op`; `.env.example` (PR #396) defines the 1Password contract (`pts secrets env` → `.env.local`).
- **`scripts/bump.sh` hardening — [08-04] promote this; it is now the single most repeated tax in the repo.** Its `rm bun.lock && bun install` re-resolves every caret-ranged external. Broke `sdk-contract.test.ts` on 3 of 6 v7-epic PRs, then again on #392 — where it also dragged in `@anthropic-ai/sdk`, `@ai-sdk/anthropic`, `@ai-sdk/gateway`, `@hono/node-server`, rollup, and `claude-agent-sdk` 0.3.215→0.3.220, **and the drift detector that caught it was silenced by editing the pinned fixture in the same commit**. Four occurrences, four surgical pin-backs.
  **The fix is known and verified:** touch only the four workspace `version` fields bun.lock caches. CI runs `bun install --frozen-lockfile` (`ci.yml:29`, `:94`), which that satisfies — confirmed by running it. `1335911` (#385) is the reference implementation.
- **Bifrost-native + Presidio** — **[08-04] half done.** #406/#408 shipped gateway injection: virtual keys, guardrail selection, run-correlation headers, `.env.example` + CLI config (lockstep 0.37.0). **Presidio PII is still unscoped** — grep finds zero references repo-wide. The remaining question is whether "native" means more than header injection.

### 3. Carried over from 07-26, still open
- ~~#266 playbook parity~~ — **[08-04] SHIPPED AND CLOSED.** PR #392, published in `core@0.16.0`. `definePlay` + `playbook()` literal + shared `molecules/returns-violation.ts`. Option B as recommended: envelope preserved, violation discriminated and play-named. Spec with all phase logs at `.ai-docs/specs/playbook-authoring-parity.md` (3 Design Addenda + both Gate 2.5 sections).
  **Two design notes worth knowing before touching plays:** (a) validation runs *before* `Playbook.execute`'s JSON round-trip, so "validated" does **not** mean the delivered payload matches `returns` (a `z.date()` validates, then serializes to a string) — this bought the invariant that plain `PlayDefinition`s are completely unchanged; (b) a play calling a definition's `.execute()` **directly** (bypassing `Toolbox`/`Playbook`) still gets its violation misattributed to the outer play — accepted, documented, and pinned by tests; a real fix needs provenance on the violation tag and would touch the tool side too.
  **Correction that came out of it:** the long-standing claim that `toolbox-executor.ts`/`sdk-bridge.ts` *depend* on plays never throwing is **false** — all three `agent-runner.ts` dispatch sites already try/catch, and the MCP SDK converts handler throws to `isError`. The envelope is kept for backward compatibility and payload shape, not necessity. The old comment citing "ADR 0002 D3" pointed at a decision that does not exist.
- **Lint rule 5th construct for #265 — [08-04] FILED as #412.** Two-level `z.union` → Gemini returns zero tokens with no error. Filed without waiting further for the originating agent's measurement (it never arrived across several sessions); the relayed numbers are marked unverified in the issue and whoever picks it up should reproduce locally. Newly more relevant: #266 made `returns` **required** on `definePlay`, widening the model-facing schema surface the linter guards.
- ParallelAgent / fan-out chain — relayed, cross-repo
- Consumer migrations: canvas-workstation (`SessionScope`, kill `ORG_ID` pin) → dealbrain `workspace-agent-v0`; both now also get v7 features (reasoning knob, token detail)
- #234 (dup `Transfer-Encoding: chunked` on SSE under bun), #281 (menu polish), #285 (justfile pnpm)

---

## Obstacles / notes

- **Secrets:** no API keys in container. `.env.example` heads-up: exporting `ANTHROPIC_API_KEY` switches Claude Code subprocess runs from subscription to per-token API billing — prefer `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) for the CC harness path.
- **Tests as root:** 2 `claude-code-runner.test.ts` integration tests fail locally (`--dangerously-skip-permissions` + root). Use `SKIP_SDK_TESTS=true` like CI; suite is then green (2817 tests post-epic).
- **Fresh worktrees:** `bun install` before any build; `git fetch` before trusting local `main`.
- The conductor worktree (`.claude/worktrees/bridge-cse_*`) carries stale staged changes duplicating #385's merged edits — safe to discard.
- Exporter usage semantics are deliberately opposite per platform: Langfuse exclusive (non-cached) buckets, OTel inclusive totals + sub-attributes. Documented bidirectionally in both files — **do not "fix" one to match the other**.
- Capability map: all `reasoningEffort` rows `unverified` (probe reports `UNCERTAIN` — can't distinguish accepted vs ignored); runtime `unknown` advisories are the extend-the-map feedback loop.
- `ai@7` still accepts V2/V3-spec models (verified in d.ts) — third-party V2 providers (`ollama-ai-provider-v2`) keep working. Majors land ~every 6 months; stale `beta`/`canary` dist-tags are v7-cycle leftovers, not a pre-release train.
- Port 5173 held by user's Vite; demos on 5174. `scope-echo` remains the keyless e2e probe.

## Provenance

- **Verified in-repo (07-27 session):** everything in the epic table, npm/CI state, the capability-map and bridge behavior (independent validator spot checks on built dist).
- **[08-04] Verified in-repo this roll-forward:** every `[08-04]` correction — #382/#392 merge state, #266 closed, all four package versions against npm, #406/#408 scope, the absence of any Presidio reference, and the `bun install --frozen-lockfile` claim (run, exits 0).
- **Still unverified, carried:** the `z.union` measurement (now filed as #412 with the numbers explicitly marked relayed) and the ParallelAgent chain (cross-repo).
- **[08-04] Lesson worth keeping:** the 07-27 handoff listed #382 as open when it had merged the day before. Handoffs go stale faster than they get rewritten — check issue/PR state against the tracker before trusting a next-action item, including the ones in this file.
