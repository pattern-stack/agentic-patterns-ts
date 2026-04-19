# @agentic-patterns/cli

`ap` — the command-line entry point for agentic-patterns. Discovers agents in a project, wires runners + event bus, and launches a Hono server with an admin dashboard SPA.

## Installation

```bash
bun add -g @agentic-patterns/cli
# or
npm install -g @agentic-patterns/cli
```

Or use without installing:

```bash
npx @agentic-patterns/cli <command>
```

## Quick Start

Scaffold a new project from scratch:

```bash
ap init my-agents --provider=anthropic --with-plugin
cd my-agents
cp .env.example .env   # add ANTHROPIC_API_KEY
bun install
bun run dev
# → http://localhost:3456
```

The `--with-plugin` flag drops a Claude Code plugin (`.claude-plugin/` + `hooks/`) next to your project — any Claude Code session in that directory streams lifecycle events into your dashboard in real time.

## Commands

| Command | Purpose |
|---|---|
| `ap` | Bare call — status dashboard showing discovered agents, env detection |
| `ap init [<dir>]` | Scaffold a new agent project |
| `ap agents` | List all discovered agents in the current project |
| `ap run <agent> [message]` | Chat with an agent in the terminal — interactive or one-shot |
| `ap playground` | Launch server + dashboard (production mode: SPA mounted at `/`) |
| `ap config` | Show env detection status (which provider keys are present) |
| `ap config set` | Interactive `.env` editor |

### `ap init [<dir>]`

Scaffolds `package.json`, `.env.example`, `tsconfig.json`, and a working `agents/demo/agent.ts`.

Flags:
- `--provider=<p>` — `anthropic` | `openai` | `ollama` (sets the SDK dep + env key)
- `--with-plugin` — also drop `.claude-plugin/` + `hooks/` for Claude Code integration
- `--link` — scaffold into the local monorepo's `examples/` directory using `workspace:*` deps (dogfooding only, pre-publish)

### `ap playground`

Starts a self-contained server + dashboard:
- Hono HTTP routes on port 3456 (override with `--port`)
- Dashboard SPA mounted at `/` (skip with `--no-dashboard`)
- Auto-opens the browser (skip with `--no-open`)
- Wires `AgentEventBus` + `SSEExporter` so every agent interaction streams to the dashboard's `/admin/events/stream` endpoint

### `ap run <agent> [message]`

Terminal chat:
- With a message: one-shot, prints the response and exits
- Without: interactive REPL

## Agent Discovery

The CLI walks `agents/**/agent.ts` (or `agents/**/*.agent.ts`) from your project root. Each file must default-export an `AgentRegistration`:

```typescript
// agents/demo/agent.ts
import { AgentBuilder, RoleBuilder, Persona, Mission } from "@agentic-patterns/core";

const role = new RoleBuilder("demo")
  .withPersona(new Persona({ identity: "a demo assistant", tone: "concise" }))
  .build();

const agent = new AgentBuilder(role)
  .withMission(new Mission({ objective: "Demonstrate the framework" }))
  .build();

export default {
  id: "demo",
  name: "Demo",
  description: "A simple demo agent",
  agent,
};
```

The CLI injects the runner from your environment — you don't construct one yourself.

Override the discovery glob: `ap --agents "src/bots/*/index.ts" playground`

## Environment Detection

`ap` reads `.env` (via dotenv) from your project root. It auto-detects provider credentials:
- `ANTHROPIC_API_KEY` → Anthropic runner
- `OPENAI_API_KEY` → OpenAI runner
- `OLLAMA_HOST` → local Ollama
- `AP_DASHBOARD_URL` → where the Claude Code plugin POSTs hooks (default `http://localhost:3456`)

Run `ap config` to verify detection. Run `ap config set` for an interactive editor.

## Claude Code Plugin

When scaffolded with `--with-plugin`, the plugin wires all 26 Claude Code lifecycle events to a local `hooks/emit.mjs` that POSTs to `${AP_DASHBOARD_URL}/hooks/:eventType`. The server publishes them to the event bus; the dashboard's `/claude-code` page renders them grouped by session.

This means any Claude Code session in a project with the plugin enabled becomes live-observable in your dashboard — tool calls, permission prompts, subagent spawns, compaction, everything.

### What gets scaffolded

`ap init --with-plugin` drops three artifacts:

- `.claude-plugin/plugin.json` — manifest for the marketplace / `/plugin add` install flow
- `hooks/{emit.mjs,hooks.json}` — the shim + event registry
- `.claude/settings.json` — activates the hooks immediately, no marketplace step required

If you already have a `.claude/settings.json` (your own permissions, model, or hooks), `ap init` merges non-destructively: preserves every existing key, adds our hook entries only where not already present. Re-running is idempotent. Malformed existing JSON is backed up rather than replaced.

See [docs/CLAUDE-CODE-PLUGIN-ACTIVATION.md](../../docs/CLAUDE-CODE-PLUGIN-ACTIVATION.md) for the full activation model, the list of captured events, and troubleshooting.

## License

MIT
