# @agentic-patterns/dashboard

Internal React SPA — admin dashboard for `@agentic-patterns/server`. Published only as part of the `@agentic-patterns/cli` bundle; not available as a standalone npm package.

## Usage

This package is **private**. Consumers don't install it directly. It ships as a built static bundle inside `@agentic-patterns/cli` at `assets/dashboard/`, mounted by `ap playground` at `http://localhost:3456/`.

## Pages

| Route | Purpose |
|---|---|
| `/` | Dashboard overview — agent stats, recent activity |
| `/agents` | Registered agents list |
| `/live` | Live event stream from `/admin/events/stream` |
| `/claude-code` | Claude Code sessions grouped by `session_id` — real-time SSE feed of all 26 lifecycle events per session (tool calls, permission prompts, subagents, compaction), each timeline collapsible with full payloads on expand |
| `/conversations` | Conversation history |
| `/conversations/:id` | Conversation detail with message parts |

## Development

From the monorepo root:

```bash
bun run --filter=@agentic-patterns/dashboard dev   # Vite dev server
bun run --filter=@agentic-patterns/dashboard build # produces dist/
```

The Vite dev server proxies API calls to an external NestJS backend on port 3100 (separate branch/service). For end-to-end testing with the Hono server, use `ap playground` — the CLI bundles the built SPA and serves it directly from the Hono app on port 3456, bypassing the proxy.

## Architecture

- **Event stream**: `useEventStream("/admin/events/stream")` — type-agnostic SSE consumer with reconnect + backoff
- **Session grouping**: `lib/claudeCodeSessions.ts` groups `claude_code.hook` events by `session_id` into `SessionState` shapes for the `/claude-code` page
- **Components**: atom/molecule/organism structure under `src/components/`
- **Styling**: CSS variables (no Tailwind), inline styles, existing Badge/Card/Button/Spinner atoms

## License

MIT
