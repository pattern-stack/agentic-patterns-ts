# Claude Code Plugin Activation — Known Gap

**Status as of 0.1.4:** `ap init --with-plugin` drops `.claude-plugin/` and `hooks/` into the consumer's project, but Claude Code does **not** automatically fire those hooks just because the files exist. This doc explains the gap and the 0.1.5 fix.

## Symptom

User runs `ap init --with-plugin demo`, `bun install`, `bun run dev`. Dashboard is up at `http://localhost:3000`. User opens Claude Code in `demo/`, runs a command that uses tools. **Nothing appears on `/claude-code`.**

Backend verified working — a direct curl proves the pipe:

```bash
curl -X POST http://localhost:3000/hooks/UserPromptSubmit \
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

## 0.1.5 Fix Plan

`ap init --with-plugin` should drop THREE artifacts, not two:

```
demo/
├── .claude-plugin/plugin.json     # for marketplace/plugin-add flow (current)
├── hooks/                         # emit.mjs + hooks.json (current)
└── .claude/settings.json          # NEW — hooks wired directly, works immediately
```

The `settings.json` references `${CLAUDE_PROJECT_DIR}/hooks/emit.mjs` so the existing script is reused.

### Implementation sketch

In `packages/agent-cli/src/commands/init.ts`, the `--with-plugin` branch already calls `copyDir(pluginSrc.pluginDir, ...)` and `copyDir(pluginSrc.hooksDir, ...)`. Add a third step that generates `.claude/settings.json` by reading `hooks.json` + regex-replacing the env var:

```ts
if (opts.withPlugin && pluginSrc) {
  copyDir(pluginSrc.pluginDir, path.join(targetDir, ".claude-plugin"));
  copyDir(pluginSrc.hooksDir, path.join(targetDir, "hooks"));

  // NEW: mirror hooks into .claude/settings.json for immediate activation
  const hooksSource = fs.readFileSync(path.join(pluginSrc.hooksDir, "hooks.json"), "utf8");
  const settings = hooksSource.replaceAll("${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_PROJECT_DIR}");
  const settingsDir = path.join(targetDir, ".claude");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "settings.json"), settings);
  created.push(".claude/settings.json");
}
```

Tests needed:
1. Scaffold a project with `--with-plugin`, assert all three paths exist
2. Parse the generated `settings.json`, confirm all 26 events present and commands reference `${CLAUDE_PROJECT_DIR}`

## Verifying the Fix End-to-End

After 0.1.5 lands:

```bash
# 1. Fresh scaffold
npx @agentic-patterns/cli@latest init demo --with-plugin --provider=anthropic
cd demo
cp .env.example .env && $EDITOR .env   # add ANTHROPIC_API_KEY
bun install
bun run dev &   # dashboard on :3000

# 2. Non-interactive Claude Code probe (no UI needed)
claude -p --cwd "$(pwd)" "list the files in this directory"
# Claude Code loads .claude/settings.json, hooks fire, events hit the server

# 3. Check the dashboard
open http://localhost:3000/claude-code
# Should show a session card with UserPromptSubmit → PreToolUse → PostToolUse → Stop
```

## Where to look while debugging

- `~/.claude/logs/` — Claude Code's own hook execution logs
- `demo/.claude/settings.json` after `ap init` — must exist with 26 entries, commands must reference `${CLAUDE_PROJECT_DIR}/hooks/emit.mjs`
- Server stdout — every POST to `/hooks/:eventType` logs at debug level
- `curl -N http://localhost:3000/admin/events/stream` — tail what actually reaches the bus
