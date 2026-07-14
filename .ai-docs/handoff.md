# Handoff — 2026-07-14

**Branch:** `main` (clean after the handoff-docs PR lands)
**Last action:** **Playground trace-surface session fully landed.** Lockstep **0.22.0** published (#233 full SSE vocabulary to chat + done-frame run_id + `/run?run=` deep link + collapsible nav; #235 narrow trace-rail waterfall via builder↔grader design loop, spec at `.ai-docs/specs/trace-rail-narrow-waterfall.md`; bump #236). Then #244 fixed via **#247** (merged, **unpublished**): `toGatewayModelId` in `model-resolver.ts` — tier aliases resolve through the shared tier map (`AP_GATEWAY_TIER_PROVIDER`), `AP_GATEWAY_MODEL_PREFIX="auto"` infers `«vendor»/«id»`, bare-id path unchanged. Note: 0.23.0 ("coordinator-host batch", #242) shipped from a parallel session mid-day.
**Next action:** Pick from the board — **#243** (AGENT_MODEL override dead under a gateway; smallest, composes with #247's translation layer), **#248** (tier aliases on the resolver's direct branch, same family), or **#234** (conversation SSE stalls under bun). The #247 fix ships with whoever bumps lockstep next.
**Obstacles:** none. User has deliberately NOT formed opinions on #234/#243/#248 — the issues are self-contained briefs; don't assume a priority.

## Notes
- Dev Bifrost (`AP_GATEWAY_*` in `.env`): catalog is `gemini/` + `openai/` segments only (NO Claude); accepts bare canonical ids and `google/…` spelling. Basic-auth password was echoed into a session log 2026-07-13 — **rotation recommended**, tracked nowhere else on purpose.
- Playground verify harness: run the CLI under `mise exec node@22.22.0` for sqlite persistence (node 25 = ABI mismatch, bun = SSE stall #234). Light-theme captures: `?theme=blue` query override.
- Multi-session workspace hazard: parallel sessions dirty the shared tree — check `git status` against session-start snapshot before committing; this session excluded two not-mine SKILL.md edits from its PRs (they land with this handoff commit instead).
