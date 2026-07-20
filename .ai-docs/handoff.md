# Handoff — 2026-07-19

**Branch:** `docs/harness-cockpit-plan`
**Last action:** **Harness-cockpit arc planned, reviewed, and synced.** Strategy locked (gap-analysis rev 2 at `.ai-docs/research/cli-chat-parity/`): revive Go `chat-patterns` TUI (pin `187411b`) as the cockpit speaking the TS server's live contract. Ultracode pipeline: 13-agent gap audit (incl. live smoke test — all 5 Go client methods fail today; found server bug N5 = torn pre-token SSE stream) → demo artifact (UI verified gorgeous, builds green on Go 1.26) → 6 scout dossiers (`.ai-docs/stacks/harness-cockpit/scout/`) → plan authored + 3-lens opus review, PASS_WITH_NOTES ×3, zero blockers, one round. Synced: **epic #339, leaves #340–#356**, sub-issues wired, `gate:human` all.
**Next action:** Wave 1: `/sdlc:design 340` (N5 fix, TS) and #342→#343 (Go hygiene/CI → charm deps) on a **fresh clone** of `pattern-stack/chat-patterns`. Waves/gates + locked decisions in `.ai-docs/plans/harness-cockpit.yaml` (tracker keys rewritten, `key_original` preserved); narrative in `.ai-docs/stacks/harness-cockpit/plan.md`.
**Obstacles:**
- `conversations.ts` merge barrier: #340 → #341 → #351 strictly serialized; each PR states ordering vs #296/#328 at open time. No TS version bumps outside #355.
- Gate C (#350 HITL e2e) needs a real LLM key; keyless limitation unchanged.
- The scratchpad chat-patterns clone was mutated mid-scout — disposable; do NOT reuse.

## Notes
- Go issues live on THIS repo's board (OD-5) with `go` label; code lands via PR to chat-patterns' own main once #342 adds its `check` CI.
- harness-runners is a live sibling arc (epic #317, #318–#332): R2 builds on TODAY'S input transport; forward-compat seam = requestId alias + availableDecisions rendering only.
- N5 vs #234: same symptom, two defects — #340 closes #234 only if the bun repro passes post-fix.
- Demo artifact (chat-patterns TUI frames): https://claude.ai/code/artifact/8b4b6056-6624-493e-866f-4ce958cbf638
