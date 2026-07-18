# Handoff — 2026-07-17

**Branch:** `feat/playground-menus` — **PR #282 open**, awaiting CI `check` (no review required; `gh pr merge 282 --merge` once green; no version bump → nothing publishes)
**Last action:** Menus design loop round 1 graded **READY** (`4dd273b`), then two live-polish commits from user feedback: typewriter font retired from chat UI text (`d5e8975` — mono survives only in literal code/JSON: `.chat-code`, scope JSON editor, `JsonBlock`), and Tools-rail tool name + description made one hover/click block (`50dc15b`). All rounds: root typecheck + lint green, dashboard 383/383.
**Next action:** Merge PR #282 when CI is green, then pick up **#281** (menu polish follow-ups: native-select sweep, app-wide mono retirement, optional role=menu a11y) or feature work: **#268** (run-scope visibility, `state:strategy-approved`) / **#157** (capture UI — its "chat reorg" blocker looks satisfied by PR #279).
**Obstacles:**
- Port 5173 was taken mid-session by the user's `~/Projects/dealbrain-sdc-fix` Vite server; this repo's dev servers are DOWN. Relaunch backend as before; if 5173 is still busy, Vite auto-bumps to 5174 (headless browsers then need `http://[::1]:5174`).

## Notes
- Grader evidence screenshots are **untracked** at `.ai-docs/design/playground-menus/iterations/1/` (9 PNGs, light+dark) — regenerable; left out of the PR on purpose. Delete or keep at will.
- Design-loop rhythm that worked again: builder (sonnet) + independent grader (opus) as named teammates; grader verifies with its own Playwright probes (rect deltas, computed styles), not the builder's report.
- Typography rule now in force on chat surface (user preference, see memory `no-mono-ui-text`): UI text = `--font-sans`; mono ONLY for literal code/JSON.
- Dev-loop commands, IPv6-only Vite gotcha, keyless-chat limitation, and CI-vs-local `check` mismatch: unchanged from the 2026-07-16 handoff (see git history of this file if needed).
