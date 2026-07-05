# Handoff — 2026-07-05

**Branch:** `main`
**Last action:** Shipped a **lockstep versioning policy** (PR merged to `main` → CI OIDC publishes). `runtime` + `server` + `cli` collapsed to a shared **0.10.0** (was 0.9.2 / 0.6.0 / 0.9.0); `core` **floats** at 0.6.0 (portable algebra, intended ADK-plugin target — runs without the runtime, so it versions independently); `dashboard` `version` field removed (private, ships as cli assets). `scripts/publish.sh` gained a `lockstep` pre-flight gate that hard-fails if runtime/server/cli drift. `bun.lock` refreshed; `bash scripts/publish.sh check` was fully green pre-merge. Rationale in memory [[project_versioning-policy]].
**Next action:** Verify the publish landed — `npm view @agentic-patterns/{runtime,server,cli} versions --json` / dist-tags should show 0.10.0 on `latest` (core stays 0.6.0). Then delete the merged `doug/lockstep-versioning` branch. No forced feature work after that.
**Obstacles:** none.

## Prior context (cli 0.9.0 / runtime 0.9.2 — shipped)
- Live Run constellation (paced replay, node inspector, trace scrubber, dual graph model), real `/composition` provenance, `/graph` retired (→ `/run`) — #168/#169/#172. Runtime 0.9.2 = `provider follows the model id` fix (#170/#171).
- Parked follow-ups (unchanged): (1) rework `asAgent`-Sequential provenance to show the 3 underlying agents (backend must introspect the pipeline's steps); (2) map blast-radius → runtime gates (`composition.ts blastOf()` is a stub); (3) chain-mode live graph is sparse for composed agents under the no-key `claude-cli` runner — Composition mode is the reliable view.

## Notes
- **Release gotcha:** after ANY version bump you MUST `rm bun.lock && bun install` or the publish job fails on the lockfile-sanity gate (`disk=X vs lock=Y`). Confirm a release landed via `npm view <pkg> versions --json` / dist-tags, NOT cached `npm view <pkg> version`.
- **Versioning:** runtime/server/cli are lockstep (one version); core floats; dashboard has no version. `publish.sh` enforces the trio via its `lockstep` gate. See [[project_versioning-policy]].
- **Dashboard verify harness:** `ap playground examples` (deterministic pipeline2, no API key) + `vite dev` + direct Playwright; `graph/sample-run-trace.ts` + `/run` demo mode is the model-free backbone.
- Untracked `docs/build/` + `docs/.docusaurus/` are Docusaurus output (not gitignored).
