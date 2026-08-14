# @pattern-stack/agentic-server

Hono HTTP server for agentic-patterns agents. Exposes conversation routes with SSE streaming, admin analytics, and a hook-receiver endpoint that turns Claude Code sessions into first-class events on the runtime event bus.

## Installation

```bash
bun add @pattern-stack/agentic-server @pattern-stack/agentic-runtime @pattern-stack/agentic-core hono @hono/node-server
```

Most consumers don't install this directly — `@pattern-stack/agentic-cli` bundles it. Install standalone when you need a custom server (different framework, custom routes, non-default CORS, reverse proxy, etc.).

## Quick Start

```typescript
import { serve } from "@hono/node-server";
import {
  AgentEventBus,
  InMemoryAdminService,
  InMemoryEventCollector,
  SSEExporter,
} from "@pattern-stack/agentic-runtime";
import { createServer } from "@pattern-stack/agentic-server";

const bus = new AgentEventBus();
const collector = new InMemoryEventCollector();
const sse = new SSEExporter();
collector.attach(bus);
sse.attach(bus);

const app = createServer({
  agents: [
    /* AgentRegistration[] — built from your agents/* files or in-code */
  ],
  adminService: new InMemoryAdminService(collector),
  eventBus: bus,
  sseExporter: sse,
});

serve({ fetch: app.fetch, port: 3456 });
```

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `GET` | `/agents` | List registered agents (`id`, `name`, `description`) |
| `POST` | `/conversations` | Create a new conversation with an agent |
| `POST` | `/conversations/:id/messages` | Send a message; response streams SSE frames |
| `GET` | `/admin/dashboard` | Dashboard stats snapshot |
| `GET` | `/admin/agents` | Per-agent analytics (invocations, tokens, errors) |
| `GET` | `/admin/tools` | Tool-call breakdown |
| `GET` | `/admin/tokens?group_by=agent\|model` | Token usage aggregated |
| `GET` | `/admin/events/stream` | SSE broadcast of all bus events |
| `POST` | `/hooks/:eventType` | Claude Code hook receiver (see below) |

## SSE Event Format

`/admin/events/stream` emits frames for every event published to the bus. Event names map from internal types to canonical wire names via `SSE_EVENT_NAMES`:

```
event: tool.start
data: {"tool_call_id":"...","tool_name":"Read","arguments":{...},"traceId":"...","timestamp":"..."}

event: claude_code.hook
data: {"hook_name":"PreToolUse","session_id":"...","tool_name":"...","tool_input":{...},"payload":{...}}

event: message.complete
data: {"content":"...","input_tokens":42,"output_tokens":128,"model":"claude-sonnet-4-..."}
```

Consumers subscribe via `EventSource("/admin/events/stream")`.

## Session Scope

An `AgentRegistration` can declare `scope: SessionScopeLike` — a validated shape (`.schema`/`.parse()`), redaction (`.redactKeys`), and optional `.defaults`/named `.presets`, superseding ad hoc `context`. A registration with a declared `scope` accepts scope on `POST /conversations` EVEN WITH NO `instantiate` hook — `instantiation.available` (below) widens to `hasHook || hasScope`.

```typescript
export interface SessionScopeLike {
  readonly schema: unknown;
  readonly redactKeys: readonly string[];
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly presets?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  parse(value: unknown): Record<string, unknown>;
  toJsonSchema(): Record<string, unknown>;
}
```

A `SessionScope` instance (`@pattern-stack/agentic-core`) satisfies this structurally — the server never does `instanceof SessionScope` across the module boundary, so a CLI-discovered agent built against a different `@pattern-stack/agentic-core` install still works.

### `POST /conversations`

```jsonc
{ "agent_id": "workspace", "scope": { "workspace": "globex-ops", "user": "li@globex.dev", "region": "eu-west" } }
```

- `scope` is the current wire key; `context` is a deprecated alias — `scope` wins when both are sent.
- When the registration declares `scope`, the effective value (body `scope`/`context`, else `scope.defaults` — falling back to the deprecated `instantiateDefaults` — else `{}`) is parsed against `scope.schema` before it reaches `instantiate`, redaction, or the run-metadata stamp. A registration that declares required fields with no defaults makes a bare `POST /conversations` with no body a deliberate `400` — that's correct, the agent said it needs a scope.
- Validation failure: `400 { "error": "scope validation failed", "issues": [...] }`. `issues` is duck-typed off the thrown error (`Array.isArray(err.issues)`) — never `instanceof ZodError`, never `.flatten()` — so it works across the zod `^3.25 || ^4` peer range.
- The parsed value's response echo lands under both `context` (back-compat — the dashboard's chat client depends on it staying populated) and `scope` (forward-looking name, present only for scope-declaring registrations), redacted identically. Redaction keys are the UNION of `scope.redactKeys` and the deprecated `contextRedactKeys` — this is echo-only: the unredacted parsed scope still reaches tools and prompt rendering via `RunOptions.host.scope`.
- A hook-less, scope-less registration's create response stays byte-identical to before: `{ id, agent_id }`.

### `GET /agents`

Each entry's `instantiation` block widens to describe scope, not just the `instantiate` hook:

```jsonc
{
  "instantiation": {
    "available": true,          // hasHook || hasScope
    "schema": { "...": "JSON Schema (OpenAPI 3 dialect), from scope.toJsonSchema()" },
    "defaults": { "workspace": "acme-sales", "user": "sam@acme.dev", "region": "us-east" },
    "presets": { "sam @ acme": { "...": "..." }, "li @ globex": { "...": "..." } }
  }
}
```

`schema`/`defaults`/`presets` are `null` when the registration declares no `scope`. `toJsonSchema()` is wrapped in try/catch — one bad registration's schema conversion returning `null` never 500s the whole roster. There is no `preset` body key on `POST /conversations`: presets materialize client-side (the dashboard's scope form picks a preset and posts its materialized field values), so the wire only ever carries concrete scope values.

## Claude Code Hook Bridge

`POST /hooks/:eventType` accepts raw Claude Code lifecycle payloads and:

1. Validates the event name against the 26 known lifecycle events
2. Publishes a `ClaudeCodeHookEvent` to the bus, preserving the full raw payload
3. Derives matching `agent.tool.start` / `agent.tool.end` events for `PreToolUse` / `PostToolUse` so standard dashboard views light up automatically
4. If the request carries an `x-ap-runner-correlation-id` header, skips step 3 (runner already emits tool events natively)

Pair with the `hooks/emit.mjs` script shipped at the repo root — a zero-dependency Node script that reads Claude Code hook stdin and POSTs here, always exiting 0 so hooks never block the user.

### Supported events

| Category | Events |
|---|---|
| Session | `SessionStart`, `InstructionsLoaded`, `SessionEnd` |
| Prompt | `UserPromptSubmit` |
| Tools | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` |
| Permissions | `PermissionRequest`, `PermissionDenied` |
| Subagents & tasks | `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle` |
| Stop | `Stop`, `StopFailure` |
| Workspace | `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove` |
| Compaction | `PreCompact`, `PostCompact` |
| Elicitation | `Elicitation`, `ElicitationResult` |
| Notification | `Notification` |

### Troubleshooting

Events not arriving? Check in this order:

1. `curl -X POST http://localhost:3456/hooks/UserPromptSubmit -H "content-type: application/json" -d '{"session_id":"t","hook_event_name":"UserPromptSubmit"}'` returns `{"ok":true}` → server is up
2. `curl -N http://localhost:3456/admin/events/stream` shows the event during step 1 → bus wiring is fine
3. Consumer project has `.claude/settings.json` with 26 entries referencing `${CLAUDE_PROJECT_DIR}/hooks/emit.mjs`
4. `AP_DASHBOARD_URL` in the project's `.env` matches the server's bind address

Full guide: [CLAUDE-CODE-PLUGIN-ACTIVATION.md](../../docs/CLAUDE-CODE-PLUGIN-ACTIVATION.md) — activation model, failure modes, emit.mjs contract.

## Configuration

```typescript
interface ServerConfig {
  agents: AgentRegistration[];
  adminService: AdminServiceProtocol;
  eventBus: AgentEventBus;
  sseExporter: SSEExporterLike;
  store?: ConversationStore;     // optional persistence (@pattern-stack/agentic-runtime)
  staticDir?: string;             // optional static SPA mount
  cors?: CORSConfig;              // defaults to origin: "*"
}
```

For static SPA hosting (e.g., serving the admin dashboard from the same process), pass `staticDir` and the server will mount it at `/`.

## License

MIT
