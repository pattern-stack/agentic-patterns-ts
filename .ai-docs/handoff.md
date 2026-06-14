# Handoff — 2026-06-14

**Branch:** `dug/release-0.1.14` (agentic-patterns-ts — the framework repo)
**Last action:** Framed up the framework gap-register + release plan in `.ai-docs/research/eval-multimodel-dogfood-gaps.md` — gaps **G1** (per-step runner), **G2** (RunContext / state-into-tools), **G3** (structured step result), **G4** (Workflow-as-config), plus the **model→runner factory** and **eval-as-framework**, all surfaced by the `retrieval-agent` eval/multi-model dogfood, with decisions + a sequenced plan.
**Next action:** Execute the critical path — **Phase 0** model→runner factory (`runnerFor(modelId)`, reuse `create-runner.ts` provider detection) → **G1** (`Step.runner?` + `maxIterations?` on `workflows/base.ts:28`; `(step.runner ?? runner)` in sequential/parallel/evaluator-loop) → **G4** (`WorkflowConfig` schema in `agent-core` + `buildWorkflowFromConfig` in `agent-runtime` + tests). G2/G3 ride alongside.
**Obstacles:**
- G2 changes `ToolDefinition.execute` signature (`molecules/toolbox.ts:21`) — keep `ctx` optional (back-compat); bigger blast radius → can be fast-follow.
- G4 must NOT conflate with `Agency` (`agency.ts` = team/messaging; `WorkflowConfig` = pipeline) — document the boundary.

## Notes
- **Plan/breakdown source:** `.ai-docs/research/eval-multimodel-dogfood-gaps.md` (companion to `dogfood-readiness-audit.md`). Every gap has framework `file:line` + the `retrieval-agent` workaround it replaces (PRs #26–#34).
- **Why G4 is the keystone:** completes the declarative stack — Roles (extraction/synthesis/presentation) → Agents (DealExtraction/DealContextValidator/DealSummaryAgent) → Workflows (config, per-step override). Doug wants it ASAP.
- **Decisions:** G1–G4 + model→runner factory all IN; **eval ships in the framework** (fast-follow, built from the `retrieval-agent` harness); dual-renderer + forgotten-executor = **capture only** (already in the readiness audit).
- **Consumer thread (gated on this release):** sibling `retrieval-agent` will then delete its hacks — two-runner orchestration → `Sequential`/per-step runners; pipeline → `WorkflowConfig`; `EvidenceSet` closure → `RunContext` — and re-run its eval suite. Its env is parked on GPT (`gpt-5.4-nano`, OpenAI-direct); the paid Gemini key depleted mid-session.
- **Horizon:** trigger-dependent workflows (`"Transcript received"` → run a `WorkflowConfig`).
- **Uncommitted:** this handoff + the gap doc are untracked on `dug/release-0.1.14`.
