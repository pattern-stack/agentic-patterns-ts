# Handoff — 2026-07-16

**Branch:** `main` (clean; this handoff + the design doc land via their own PR)
**Last action:** **Playground chat refinement fully landed — [PR #279](https://github.com/pattern-stack/agentic-patterns-ts/pull/279) merged** (merge commit `43bebf1`, 11 commits, CI `check` green, **no version bump → nothing published**). Shipped, each round browser-verified + teammate-reviewed: a cohesive full-height **ConsoleRail** (Tools/Trace/Scratchpad — fixes the "cutoff/floating" rail + makes traces scroll *inside* the panel); **ToolsRail** (replaces `AgentUniverse`) — "Universe"→**Tools**, grouped capabilities with description blurbs, **tool descriptions always inline** + **input params on expand**, and a **Scope/deps readout** ("acting on behalf of…"); a **compact 2-row header** (⚙ Settings menu; no submit-jump); **Copy ▾** (Markdown / Markdown+tool-I/O / JSON, `chat/export-chat.ts`); **agent-in-path** `/chat/:agentId`; removed the typewriter caret. Server: `GET /agents/:id/capabilities` now returns per-capability `description` + per-tool `parameters` (JSON schema via `getToolSchemas()`). New demo agent `examples/agents/workspace` (2 caps + `instantiate` scope) so the deps readout has real data.

**Next action:** **Run the design loop on the menus/popovers spec** — the user's three follow-up asks are captured as a ready-to-consume design reference:

```
/sdlc:design-loop --reference=.ai-docs/design/playground-menus/reference.md --surface=http://localhost:5173/chat
```

In short: (1) the sidebar **theme picker opens off-screen** — popovers must respect page bounds; (2) menus that **open inline and rearrange the page** (Scope context, Capture as eval case) must overlay instead; (3) **one dropdown style everywhere** — `Sessions` + `⚙ Settings` are the bar, the agent picker is a raw macOS `<select>`, the Scope-context panel isn't a popover at all. Locked decisions, the `DropdownMenu` API change (placement + a `close` handle), a full surface inventory, and falsifiable checks are all in the reference. **Use the loop** (build → browser-grade → fix), don't one-shot it.

**Obstacles:** none blocking. Note the keyless-chat limitation below — it does not block the menu work.

## Notes

- **Keyless chat can't complete a turn in this repo** (introspection/UI is fully exercisable without it). Three dead ends, all confirmed: the example agents declare the tier alias `"haiku"`, which `ModelResolver` can't resolve without a gateway/profile; no `ANTHROPIC_/OPENAI_` key is set and `@ai-sdk/openai` isn't installed (only `anthropic` / `gateway` / `openai-compatible`); and the keyless `claude`-CLI fallback (`ClaudeCodeAPIRunner`, reachable only via `AGENT_TIER` with **no** `AGENT_MODEL` — a classifiable `AGENT_MODEL` throws before the ladder reaches it) dies on *"Native CLI binary for darwin-arm64 not found"* because `@anthropic-ai/claude-agent-sdk` was installed `--omit=optional`. Scope-binding still demos (it binds on send, before the stream).
- **Dev loop:** backend `env -u OPENAI_API_KEY -u AGENT_MODEL -u AGENT_TIER bun packages/agent-cli/src/cli.ts playground examples/agents --port 3456 --no-dashboard`; frontend `bun run --filter=@agentic-patterns/dashboard dev` (:5173 → proxies :3456). Agents: `Workspace` (rich), `Toolsmith` (unscoped), `Pipeline2` (no caps).
- **Vite binds IPv6-only** — headless Chrome must hit `http://[::1]:5173`; `localhost` resolves v4 and hangs. Cost a browser teammate a full run.
- **CI `check` ≠ `bun run check`.** The required status runs only build + typecheck + lint + `SKIP_SDK_TESTS=true test` (`.github/workflows/ci.yml`). The root `check` script *additionally* runs `check:model-facing-schemas`, which **fails locally** (`Cannot find module '@agentic-patterns/core' from tools/`) — a pre-existing tooling resolution issue, not a gate. Don't chase it.
- **main protection:** required check `check`, **no approving review required** → once CI is green you can `gh pr merge --merge`. Repo history uses merge commits. `publish` only fires on a version bump, so doc/UI PRs are safe no-ops.
- **Server route changes need a rebuild + backend restart** to show up (`bun run --filter=@agentic-patterns/server build`) — the CLI imports the built dist, not src.
- **Don't edit frontend files while a browser teammate is driving the page** — HMR hot-reloads mid-test and corrupts its run. Batch edits between rounds.
- **The design-loop rhythm that worked:** build → dispatch a `browser-pilot` to verify with *concrete numbers* (geometry rects, computed styles, exact rendered text) **and** an `sdlc:reviewer` over the diff, in parallel → fold both in → commit. The reviewer caught two things the browser couldn't (a dishonest scope state on replay; a lint failure that would have red-lit CI); the browser caught what review couldn't (WCAG contrast, a truncating caption).
