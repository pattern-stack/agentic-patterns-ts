# Claude Code Plugin Activation

**Status as of 0.1.5:** fixed. `ap init --with-plugin` now drops a third artifact — `.claude/settings.json` — that activates hooks immediately for any Claude Code session started in the project directory, without needing a marketplace install. This doc explains the original gap, the fix, and how emission is centrally controlled.

## Symptom

User runs `ap init --with-plugin demo`, `bun install`, `bun run dev`. Dashboard is up at `http://localhost:3456`. User opens Claude Code in `demo/`, runs a command that uses tools. **Nothing appears on `/claude-code`.**

Backend verified working — a direct curl proves the pipe:

```bash
curl -X POST http://localhost:3456/hooks/UserPromptSubmit \
  -H "content-type: application/json" \
  -d '{"session_id":"t","hook_event_name":"UserPromptSubmit","prompt":"hi"}'
# {"ok":true} — and the event shows on /admin/events/stream immediately
```

So the server + bus + SSE are fine. The broken link is **hooks aren't firing inside the Claude Code session.**

## Root Cause

Claude Code discovers hooks from two places:

1. **Marketplace-installed plugins** — `.claude-plugin/plugin.json` + `hooks/hooks.json` are read when the plugin is activated via `/plugin add <org/repo>` or an equivalent install flow.
2. **Project-local `.claude/settings.json`** — hooks declared there fire unconditionally for sessions started in that directory.

`ap init --with-plugin` currently only writes path (1) — the plugin scaffolding. The plugin is **not auto-activated** just by being present on disk. Nothing reads `.claude-plugin/plugin.json` for a session started in that dir unless Claude Code has been told to enable it.

Path (2) — `.claude/settings.json` — is the universal activation mechanism that works without any plugin-system registration step.

## Immediate Workaround (works in 0.1.4)

Drop a `.claude/settings.json` in the consumer project that mirrors `hooks/hooks.json` but swaps `${CLAUDE_PLUGIN_ROOT}` → `${CLAUDE_PROJECT_DIR}`. Example script:

```bash
mkdir -p .claude
node -e "
const fs = require('fs');
const src = JSON.parse(fs.readFileSync('hooks/hooks.json','utf8'));
for (const event of Object.keys(src.hooks)) {
  for (const matcher of src.hooks[event]) {
    for (const h of matcher.hooks) {
      h.command = h.command.replace(/\\\${CLAUDE_PLUGIN_ROOT}/g, '\${CLAUDE_PROJECT_DIR}');
    }
  }
}
fs.writeFileSync('.claude/settings.json', JSON.stringify(src, null, 2) + '\n');
"
```

Then restart Claude Code in the project directory and accept any "allow hooks from .claude/settings.json" prompts.

## 0.1.5 Fix

`ap init --with-plugin` drops THREE artifacts, not two:

```
demo/
├── .claude-plugin/plugin.json     # for marketplace/plugin-add flow
├── hooks/                         # emit.mjs + hooks.json
└── .claude/settings.json          # hooks wired directly, activates immediately
```

The `settings.json` references `${CLAUDE_PROJECT_DIR}/hooks/emit.mjs` so the existing script is reused.

### Non-destructive merge with existing settings

Users often already have a `.claude/settings.json` — their own hooks, permission rules, model overrides. `ap init --with-plugin` never clobbers it:

- **No existing file** → write fresh
- **Existing file** → preserve all top-level keys (`permissions`, `model`, etc.), merge our hook entries per-event, skip entries that already exist (same `type` + `command`). Banner reports `merged N hook entries` or `already up to date`
- **Malformed JSON** → move to `.claude/settings.json.ap-backup-<timestamp>`, write fresh, warn

Re-running `ap init --with-plugin` over an already-initialized project is idempotent — identical re-write, no duplication.

### Tests

`packages/agent-cli/src/commands/__tests__/init.test.ts` covers:
1. All three artifacts exist after scaffold
2. `settings.json` events mirror `hooks.json` count + all commands use `${CLAUDE_PROJECT_DIR}`
3. Without `--with-plugin`, no plugin artifacts created
4. Existing `settings.json` with user `permissions`, `model`, and a user-defined `UserPromptSubmit` hook is preserved alongside our merged entries
5. Re-running is idempotent (byte-identical output)

## Verifying the Fix End-to-End

### Automated harness

`scripts/verify-hooks.mjs` does the whole dance: scaffold → install → start server → subscribe SSE → spawn `claude -p` → assert `SessionStart` + `UserPromptSubmit` + `SessionEnd` arrive.

```bash
bun run --filter=@agentic-patterns/cli build
node scripts/verify-hooks.mjs              # one-shot, tears down on exit
node scripts/verify-hooks.mjs --keep       # leaves tmp project + server alive
```

Requires `claude` on PATH and an `ANTHROPIC_API_KEY` in env (any non-empty key — the prompt is trivial).

### Manual probe

```bash
npx @agentic-patterns/cli@latest init demo --with-plugin --provider=anthropic
cd demo
cp .env.example .env && $EDITOR .env   # add ANTHROPIC_API_KEY
bun install
bun run dev &                          # dashboard on :3456
claude -p --cwd "$(pwd)" "list the files in this directory"
open http://localhost:3456/claude-code # session card should appear
```

## Central Emission Control

There is **one source of truth** for what events exist and how they're shipped:

```
/hooks/hooks.json      # event registry (26 entries)
/hooks/emit.mjs        # the shim that POSTs to AP_DASHBOARD_URL
```

The CLI build step (`packages/agent-cli/package.json` → `build:plugin-template`) copies these into `packages/agent-cli/assets/plugin-template/` at bundle time, so published tarballs always ship the latest. `ap init --with-plugin` copies from the bundled template into the consumer project and also derives `.claude/settings.json` from `hooks.json` via a single `${CLAUDE_PLUGIN_ROOT}` → `${CLAUDE_PROJECT_DIR}` substitution.

### Updating the emission surface

- **Adding an event:** edit `/hooks/hooks.json`, add the matching route handler in `packages/agent-server/src/routes/hooks.ts` if the payload shape needs special handling. Rebuild the CLI. Done — next scaffold picks it up.
- **Changing how events are shipped:** edit `/hooks/emit.mjs`. Keep it tiny and dumb — any real logic (auth, batching, filtering, reshaping) should live server-side at `/hooks/:eventType`, because a copy of `emit.mjs` is frozen into every scaffolded project at init time and will not retroactively update.

### Constraint: emit.mjs is sticky

Once a user runs `ap init --with-plugin`, their `hooks/emit.mjs` is a static copy that won't update until they re-scaffold or manually pull. Treat its public contract (stdin JSON → POST to `${AP_DASHBOARD_URL}/hooks/<EventName>`) as a stable interface. All evolving behavior belongs behind that line on the server.

## Supported Events

All 26 Claude Code lifecycle events are captured. `hooks/hooks.json` is the canonical registry — if it's there, the plugin ships it.

| Category | Events |
|---|---|
| Session (3) | `SessionStart`, `InstructionsLoaded`, `SessionEnd` |
| Prompt (1) | `UserPromptSubmit` |
| Tools (3) | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` |
| Permissions (2) | `PermissionRequest`, `PermissionDenied` |
| Subagents & tasks (5) | `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle` |
| Stop (2) | `Stop`, `StopFailure` |
| Workspace (5) | `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove` |
| Compaction (2) | `PreCompact`, `PostCompact` |
| Elicitation (2) | `Elicitation`, `ElicitationResult` |
| Notification (1) | `Notification` |

Server-side, `PreToolUse` / `PostToolUse` are **additionally** materialized as `agent.tool.start` / `agent.tool.end` events so the standard agent dashboards (Tools, Live) light up automatically without Claude-Code-specific wiring.

## Failure Modes

### Server is down

`emit.mjs` uses a 500ms abort on `fetch()` and always `process.exit(0)`. If the dashboard isn't running:

- Hook fires → emit.mjs attempts POST → connection refused or timeout
- Error logged to `~/.claude/logs/` (Claude Code's stderr capture)
- Hook exits 0 → Claude Code session is unaffected
- **Events are NOT queued** — they're lost. This is deliberate: guaranteeing observability at the cost of blocking the user's session is the wrong trade.

### Server is slow

Same story — 500ms abort. If the server occasionally exceeds 500ms on a hook intake you'll see intermittent dropped events with no other user-visible effect. Fix by speeding up the server intake (the hook route is synchronous on the event-bus publish path, so don't do heavy work in-line).

### AP_DASHBOARD_URL is wrong or unset

`emit.mjs` defaults to `http://localhost:3456`. If your server is on another port, set `AP_DASHBOARD_URL` in `.env`. Hooks inherit the process env via Claude Code's hook runner.

## Troubleshooting: Events Not Arriving

Work the pipe from output to input:

1. **Can the server receive at all?** — `curl -X POST http://localhost:3456/hooks/UserPromptSubmit -H "content-type: application/json" -d '{"session_id":"t","hook_event_name":"UserPromptSubmit"}'` should return `{"ok":true}`. If not, server isn't running or is on a different port.

2. **Does the event reach the bus?** — `curl -N http://localhost:3456/admin/events/stream` in another terminal, then redo the curl above. You should see an SSE frame for `claude_code.hook`. If curl (1) works but stream (2) doesn't show it, check server logs — the event bus may have an exporter exception.

3. **Is `.claude/settings.json` present and correct?** — `cat demo/.claude/settings.json | jq '.hooks | keys | length'` should print `26`. Commands must reference `${CLAUDE_PROJECT_DIR}/hooks/emit.mjs`, not `${CLAUDE_PLUGIN_ROOT}`.

4. **Did Claude Code load the settings file?** — First session in a new project prompts "allow hooks from .claude/settings.json?". If you declined, hooks are disabled. Check `~/.claude/settings.json` for blocklist entries or re-accept by deleting the project's entry under `enabledHooks`.

5. **Is emit.mjs reachable?** — `node demo/hooks/emit.mjs UserPromptSubmit < /dev/null` should exit 0. If Node isn't on PATH in Claude Code's hook runner environment, the hook silently fails. Fix: ensure Node is in the login shell PATH (not just the interactive shell PATH).

6. **Tail Claude Code's own logs** — `tail -f ~/.claude/logs/*.log` during a session. Hook failures are captured there.

## Where to look while debugging

- `~/.claude/logs/` — Claude Code's own hook execution logs
- `demo/.claude/settings.json` after `ap init` — must exist, commands must reference `${CLAUDE_PROJECT_DIR}/hooks/emit.mjs`
- Server stdout — every POST to `/hooks/:eventType` logs at debug level
- `curl -N http://localhost:3456/admin/events/stream` — tail what actually reaches the bus
- `scripts/verify-hooks.mjs` — automated end-to-end harness that checks the whole pipe
