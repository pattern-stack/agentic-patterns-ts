# Handoff — 2026-07-07

**Branch:** `main` (clean, synced)
**Last action:** **playground-upgrades SHIPPED + PUBLISHED.** 8 slice PRs #191→#198 merged sequentially into `feat/playground-upgrades`; umbrella #199 merged to main (420cded); publish job succeeded — npm dist-tags verified: runtime/server/cli **0.15.0**, core 0.7.0 (unchanged), dashboard private. Ported swe-brain's agentic surfaces (minus Composer, by decision) + board-wide styling level-up.
**Next action:** Nothing mid-flight. Follow-up candidates below, or start fresh.
**Obstacles:** none blocking.

## The stack (all validated: paired opus reviews + browser agents per wave)
| PR | Slice | What |
|---|---|---|
| #191 | S1 | Styling foundation — one atom set on cockpit tokens, shared `components/kit/*`, ~600 dup lines deleted |
| #192 | S3 | `POST /capabilities/:id/tools/:toolName/invoke` — direct tool exec, no model |
| #193 | S5 | Run persistence + `/admin/runs*` routes; `eval:` trace prefix + `shouldTrack` seam (double-write fix); NodeBackedRunner now publishes run lifecycle to the shared bus (promoted agents persist) |
| #194 | S7 | SQLiteConversationStore (schema v5) + real conversation routes (pages were calling phantom endpoints); traceId/runId threading; **exec-based BEGIN/COMMIT** (bun:sqlite shim has no `.transaction()` — silent message loss under bun, caught by browser validation) |
| #195 | S2 | Six themes (blue/earth/chalk × light/dark), family×mode picker, before-paint script, `?theme=` override |
| #196 | S4 | Tool Workbench on /capabilities + FamilyTabs + **Toolsmith** example agent (key-free demo); vite proxy +/roles +/capabilities |
| #197 | S6 | Run picker + persisted-run replay through the constellation; honest "(request not persisted)" |
| #198 | S8 | Agent Console (SessionsMenu, read-only replay, trace rail w/ TraceWaterfall+TraceLog), AgentLensPage Runs lens + HonestyBanner, final sweep (legacy tones + alias bridge + ui/atoms shim deleted) |

Spec of record: `.ai-docs/stacks/playground-upgrades/port-map.md` (rides #191). Plan: `.ai-docs/plans/playground-upgrades.yaml`.

## Notes / follow-up candidates
- **⚠️ A wave-1 browser agent killed the user's canvas playground that was on :3456** (canvas-builder/canvas-workbench agents, separate work). Port freed; relaunch invocation unknown — user must restart it.
- **RunMeta doesn't capture the request text** → run picker/replay show "(request not persisted)". Schema v6 candidate: stamp the user message onto the runs row at `message.start`.
- **Promoted-run replays are thin** (message start/chunk/complete only) — pipeline *stage* steps don't reach the persisted-events path; check whether NodeBackedRunner's relayed step events survive the OBSERVABILITY profile / SQLiteExporter.
- Kit `DropdownMenu` doesn't auto-close on row pick (Sessions + RunPicker, consistent); 320px trace rail wraps step descriptions hard — both cosmetic.
- Parts N+1 on session replay accepted; batch `GET /conversations/:id/full` if it hurts.
- `core Capability.blastRadius` metadata is a separate track (blast UI renders honest-unknown until then).
- **better-sqlite3 ABI**: built for node 22; default node 25 breaks persistence → run the CLI under **bun** (or rebuild). Documented symptom: "EvalStore init failed", memory-only mode.
- `?agent=`/`?since=` filter grammar on /admin/runs is lenient (silently ignores invalid) — deliberate.
- Pre-existing local state left untouched: modified `skills/build-on-agentic-patterns/SKILL.md` in the working tree (not this session's work) + an old stash on `feat/gateway-basic-auth`.
- Untracked leftovers: `.ai-docs/research/adk-plugin.md` (pre-existing). `docs/build/`, `docs/.docusaurus/` were removed this session (generated artifacts that broke repo-root lint).
- biome now ignores `.claude/worktrees/` (#198) — repo-root `bun run check` no longer false-fails while agent worktrees exist.
