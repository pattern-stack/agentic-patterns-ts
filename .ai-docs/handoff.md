# Handoff — 2026-07-27

**Branch:** `main` (this handoff lands via its own PR). Open work branch from 07-26 session: `refactor/adopt-definetool` (**open**, #382).

**Last action:** **AI SDK v5 → v7 epic (#384) fully shipped and closed** — six issues through the full SDLC loop in one session (specs → Gate 1.5 critique → implement → paired Gate 2.5 diff review → Gate 3 validation, all logged on issues/PRs):

| Issue | PR | What |
|---|---|---|
| #385 | #391 (0.31.0) | ESM-only output (CJS dropped), `engines.node >= 22`, both no-CJS gates flipped |
| #386 | #393 (0.32.0) | ai@5→ai@7 + provider@2→4; codemods v6+v7; `ResolvedLanguageModel = V2\|V3\|V4` widening; `MockLanguageModelV2`→V3 across 12 suites |
| #387 | #394 | `ClaudeCodeLanguageModel` V2→V4: nested usage w/ anthropic-parity cache formula, `{unified,raw}` finishReason, native `reasoning`→`effort`/`thinking` mapping |
| #388 | #395 (stack-merged @ 0.34.0) | `TokenUsageDetails` through events → SSE → console/Langfuse/OTel → dashboard waterfall |
| #390 | #402 (0.35.0) | Capability map `providers/capabilities.ts`: `{support, verifiedBy, lastVerified}` honesty refines, probe script, monthly CI job, advisory warns in `runStructured()` |
| #389 | #403 (stack-merged @ 0.36.0) | Gates → native `toolApproval` (Option C): `runner/tool-approval-bridge.ts`, gate chain as async approval callback on the capable path; fail-closed on abort + throwing gates; deny continues the loop model-visibly |

Published: `core@0.15.0`, lockstep `0.36.0`. Epic #384 + `ai-sdk-v7` milestone closed. Research + decisions: `.ai-docs/stacks/ai-sdk-v7/{understanding,plan}.md`; per-issue specs with all phase logs in `specs/`.

**Superseded from the 07-26 handoff:** #374's `shims: true` fix was removed by #385 (dead once CJS output died); the dist-contract gate #374 added was flipped to assert ESM-only. #285 (justfile→pnpm) still open but note `just` isn't installed in this container — `bash scripts/bump.sh` is the direct path.

---

## Next-action queue

### 1. Resolve #382 — keep or strip the discretionary `.describe()`s, then merge (carried from 07-26, full context in git history of this file)

### 2. New from the v7 epic (untracked, in rough priority order)
- **HTTP-reachable HITL** — the approval bridge is `runStructured()`-seam-only; server's `POST /conversations/:id/messages` only calls `runner.stream()`. Deliberate Option-C scoping (spec 389 Open Q + PR #403 "Known asymmetry"). Wiring the route (or a structured-run route) to the bridge is the natural follow-up.
- **Live-key verification wave** — real Anthropic cache numbers (#387/#388 caveat), Langfuse cost view, capability probes (`scripts/probe-capabilities.mjs`). Blocked on secrets: container has neither `pts` nor `op`; `.env.example` (PR #396) defines the 1Password contract (`pts secrets env` → `.env.local`).
- **`scripts/bump.sh` hardening** — its lockfile refresh (`rm bun.lock && bun install`) re-resolves caret-ranged externals; broke `sdk-contract.test.ts` on 3 of 6 epic PRs, each pinned back surgically ("pin bun.lock … without dependency drift" commits are the pattern).
- **Bifrost-native + Presidio** — user asked (2026-07-27) about first-class Bifrost gateway support with Presidio PII. Today Bifrost works via `AP_GATEWAY_BASE_URL` (openai-compatible, `buildFromGateway` in model-resolver); "native" support is unscoped. Research pending at session end.

### 3. Carried over from 07-26, still open
- #266 playbook parity — investigated, not specced; recommendation Option B (envelope-preserving discriminated `returns` violation); two spec traps documented in 07-26 handoff (git history)
- Lint rule 5th construct for #265 (two-level `z.union` → Gemini zero tokens) — relayed, needs measurement from originating agent
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

- **Verified in-repo this session:** everything in the epic table, npm/CI state, the capability-map and bridge behavior (independent validator spot checks on built dist).
- **Carried unverified from 07-26:** the `z.union` lint finding, the ParallelAgent chain.
