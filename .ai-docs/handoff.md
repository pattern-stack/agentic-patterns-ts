# Handoff — 2026-06-16

**Branch:** `main` (local is 4 commits BEHIND origin — `git pull` to `95376a8` before any work)
**Last action:** Released **v0.3.0** — core/runtime/server/cli bumped 0.2.0→0.3.0 (PR #73, `95376a8`), CI published all four to npm `latest` via OIDC trusted publishing.
**Next action:** Quick follow-up PR: bump `actions/checkout@v4` + `actions/setup-node@v4` → v5 in `.github/workflows/ci.yml` (GitHub forces Node-20 actions to Node 24 starting 2026-06-16; next CI run at risk).
**Obstacles:**
- CC-vs-API benchmark (the user's real next goal) is unstarted — portable briefing is in the prior chat, nothing written to a file yet.
- Deferred follow-ups: wire `dispose()` into server/`create-runner`; native retry + cross-provider failover; fold in PR #40 (session-resume, tracked by issue #42) on top of the unified CC runner.

## Notes
- This session shipped 3 stacked PRs then a release: #70 CC runner config×nativeTools seams + `dispose()`; #71 removed per-id `openai-compatible` profile kind; #72 re-added gateway as resolver-level `GatewayConfig` (Bifrost = "just the URL", model stays per-agent; env `AP_GATEWAY_BASE_URL`).
- Benchmark path to build: `new AgentRunner(claudeCode("sonnet"))` vs `new AgentRunner(anthropic("claude-sonnet-4-5"))`; gate behind `RUN_LIVE_CLAUDE=1`; watch the auth gotcha (`ANTHROPIC_API_KEY` can hijack the CC subprocess), per-turn history re-flatten, and empty tool-param schemas. Start from `providers/__tests__/claude-code.test.ts`.
- Working agreement this session: fresh worktree off origin/main per change → real PR (not draft) → squash auto-merge + delete branch → clean up worktree.
