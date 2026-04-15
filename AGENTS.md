# agentic-patterns-ts — Agent Development Guide

Practical guide for building and testing agents on top of this monorepo.

## Dev loop (one command)

```bash
pnpm dev
```

Starts two processes with interleaved colored logs:

| Process | Port | What |
|---|---|---|
| `[server]` (cyan) | `:3000` | Hono HTTP API — `/agents`, `/conversations`, `/admin/*`, SSE streams. Restarts automatically when your agent code changes (`tsx --watch`). |
| `[dashboard]` (magenta) | `:5173` | Vite dev server for the React admin UI. Hot-module-reloads on edit. |

Ctrl+C stops both cleanly. If either process dies, the other is torn down automatically — no orphan dev sessions.

### Run your own agent instead of the math demo

The server's `dev` script watches `DEMO_FILE` (defaults to `examples/live-demo.ts`). Point it at your own:

```bash
DEMO_FILE=examples/my-agent.ts pnpm dev
```

Copy `packages/agent-server/examples/live-demo.ts` as a template — it wires
the full observability stack (EventBus → InMemoryEventCollector →
InMemoryAdminService + SSEExporter) around your agent. Replace the
`buildMathAgent()` function with your own `AgentBuilder` chain, keep the
wiring verbatim.

## Mental model

Three packages, three layers:

1. **`@pattern-stack/agent-core`** — describe the agent declaratively.
   `Role = Persona + Judgment + Capabilities + Responsibilities`.
   `Agent = Role × Background × Awareness × Mission`.

2. **`@pattern-stack/agent-runtime`** — execute it and emit events.
   `AgentEventBus` · `InMemoryEventCollector` · `SSEExporter` ·
   `AgentRunner` (Vercel AI SDK) / `ClaudeCodeAPIRunner` / `MockRunner`.

3. **`@pattern-stack/agent-server` + `@pattern-stack/agent-dashboard`** —
   interact with it. Hono routes + React admin UI.

See `CLAUDE.md` for the layer hierarchy and import rules.

## What to do with the running dashboard

| Intent | Where |
|---|---|
| Try a prompt | `/chat` → pick your agent, send a message |
| See which tools fired | Expand the message's tool-call rows in chat |
| Check token spend | `/tokens` → by-agent or by-model |
| Debug a weird response | `/live` → click any event for full JSON |
| See per-agent tool stats | `/agents` → click a row |
| See which agents use a tool | `/tools` → click a row |
| Stop a runaway response | **Stop** button (or press Escape while streaming) |
| Reset a conversation | `/chat` → **New Chat** |

## Running checks

```bash
pnpm check           # build + typecheck + lint + test
pnpm typecheck       # TypeScript only
pnpm lint            # biome only
pnpm test            # vitest across all packages
```

## Repository conventions

- Zod schemas for all data models (`z.object(...)`, then `z.infer<>` for types)
- Immutability: `Object.freeze()` + `Readonly<>` types on atom data
- ESM-first, `tsup` dual ESM/CJS output
- Strict TypeScript (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`)
- Fluent builders: `.with*()` returns `this`
- Barrel exports (`index.ts`) for each public surface
