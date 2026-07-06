# Handoff — 2026-07-05 (pm)

**Branch:** `main` (clean; all session work merged + published)
**Last action:** Shipped the session — `@agentic-patterns/core@0.7.0`, `runtime`/`server`/`cli@0.11.1` live on npm (verified via dist-tags). PRs #178 (credential preflight / ExecutionService), #179 (no framework-default model), #180 (bump.sh two-track) merged; dashboard work landed as #181/#182.
**Next action:** No work mid-flight. Pick one of the parked items below, or start fresh.
**Obstacles:** none blocking.

## Notes
- **Parked design fork:** should `ap run`/`ap eval` adopt per-agent resolver mode (like `playground`) so agents own their model everywhere? Undecided. Today run/eval use the env-ladder (one global model), so `.withModel()` is honored in playground/gateway but IGNORED in run/eval.
- **Model default removed (breaking, #179):** `Agent.getModel()` / `Role.defaultModel` are now `string | undefined`. Unset ⇒ the runner supplies the model (tier/env/gateway) or fails loud. Declare models explicitly. See [[project_no-framework-model-default]].
- **Credential preflight (#178):** `agent-cli`'s `ExecutionService` wraps `createRunner` for run/eval/playground — loud signal when no key, interactive fix, Bifrost gateway via `AP_GATEWAY_*`. See [[project_runner-credential-preflight]].
- **Gateway (Bifrost):** `.env` has `AP_GATEWAY_BASE_URL=…findtempo.co/v1` + Basic auth. Catalog is **Gemini + OpenAI only, no Claude** — agents run through it must declare a `gemini/*` or `openai/*` id (e.g. `gemini/gemini-3.1-flash-lite`). Needs `@ai-sdk/openai-compatible@1.x` (NOT 3.x — spec-v4, rejected by ai@5). No agents wired to the gateway yet. See [[reference_bifrost-dev-gateway]].
- **Release tooling:** `scripts/bump.sh` is now two-track — `bash scripts/bump.sh --lockstep <spec> [--core <spec>]` (justfile `bump-lockstep`/`bump-core`/`bump-both`). Old all-four positional form is gone. Then `git add packages/*/package.json bun.lock && publish.sh check`. See [[project_versioning-policy]].
- **Untracked artifacts** (not this session's work): `docs/build/`, `docs/.docusaurus/`, `packages/agent-cli/.DS_Store`, `.ai-docs/research/adk-plugin.md` — safe to ignore or gitignore.
