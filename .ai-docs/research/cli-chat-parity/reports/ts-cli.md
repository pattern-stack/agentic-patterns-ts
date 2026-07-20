# TypeScript CLI (`packages/agent-cli`, npm `@agentic-patterns/cli`, bin `ap`) — deep read

Slice for the web-chat ↔ terminal-chat parity gap analysis. All paths are relative to
`packages/agent-cli/` unless prefixed. Version at read time: **0.28.1** (`package.json:3`).
The CLI depends on `@agentic-patterns/{core,runtime,server}` as workspace deps, plus
`@hono/node-server`, `@clack/prompts`, `better-sqlite3`, `hono`, `tinyglobby`, `tsx`
(`package.json:32-42`). Node >= 20, ESM (`"type": "module"`).

## TL;DR for the synthesizer

- The CLI **already has a terminal chat**: `ap run <agent> [message]` — one-shot streaming
  mode when a message is given, an interactive REPL (via `@clack/prompts` `text()`) when not
  (`src/commands/run.ts:1-9,192-197,399-433`). It streams token-by-token.
- Everything the CLI does with agents is **in-process** — no HTTP client anywhere. `ap run`
  constructs a runtime `Conversation` + runner directly in the same Node process
  (`src/commands/run.ts:118-190`). `ap playground` *hosts* the HTTP server (Hono via
  `createServer()` from `@agentic-patterns/server`) and mounts the pre-built React dashboard
  SPA as static assets; the browser dashboard is the HTTP/SSE client, never the CLI itself
  (`src/commands/playground.ts:172-232`).
- The terminal chat is deliberately minimal: plain ANSI line rendering of the runtime's
  `AgentEvent` union (message chunks, thinking, tool calls, token footer). No markdown
  rendering, no TUI framework (no ink/blessed), no conversation persistence for `ap run`,
  no history recall, no session resume, no approval/HITL prompt handling, no scope presets
  flag, and only two slash commands: `/exit` and `/quit`.

---

## 1. Command inventory (from the dispatcher `src/cli.ts`)

Single-dispatch: `parseArgs → switch(command) → run<Name>Command(...)` (`src/cli.ts:1-8`).
The full usage text is at `src/cli.ts:27-97`.

| Command | File | What it does |
|---|---|---|
| `ap` (bare) | `src/commands/status.ts:30` | Status dashboard: discovered agents, env-detected runner/provider, config hints. |
| `ap agents` | `src/commands/agents.ts:22` | Table of discovered agents (id, name, source file, description) + load errors. |
| `ap run <agent> [message]` | `src/commands/run.ts:68` | Terminal chat — one-shot or interactive REPL. Supports `--context '<json>'` / `AP_CONTEXT` env for run-scope (SessionScope #308 / instantiate hook #268). |
| `ap tools list <agent>` | `src/commands/tools.ts:91` | Lists every tool across the agent's capabilities' toolboxes (name, capability, description). |
| `ap tools call <agent> <tool> [--field=value …]` | `src/commands/tools.ts:128` | Invokes a single tool directly via `toolbox.execute()` — **no LLM in the loop**; args coerced by introspecting the tool's Zod schema (duck-typed `_def.typeName`, `src/commands/tools.ts:29-33,334-355`). Prints JSON result. |
| `ap playground [<dir>]` | `src/commands/playground.ts:70` | Boots the full HTTP server + React dashboard + observability stack + SQLite persistence; opens the browser. `<dir>` / `--agents-dir` recursively discovers agents under a root (`src/cli.ts:174-186`). |
| `ap eval [<dir>] --set <path\|id> …` | `src/commands/eval.ts:154` | Runs a case-bank eval suite against one agent, persists to EvalStore (same SQLite file as playground), CI gate exit codes (0 pass / 1 gate fail / 2 usage error). Flags: `--target --variant --split --allow-test --gold --db --judge --judge-model --judge-thresholds`. |
| `ap init [<dir>]` | `src/commands/init.ts:65` | Scaffolds a consumer project (package.json, .env.example, tsconfig, `agents/demo/agent.ts`); `--with-plugin` also drops the Claude Code plugin (hooks that POST lifecycle events to the dashboard) and merges `.claude/settings.json` non-destructively (`src/commands/init.ts:177-222,525-575`). `--provider anthropic|openai|ollama`, `--link` (monorepo dogfood). |
| `ap claude-skill [<name>]` | `src/commands/claude-skill.ts:40` | Installs bundled Claude Code skill(s) (today: `build-on-agentic-patterns`) into `.claude/skills` (project or `--global`). |
| `ap update [--check]` | `src/commands/update.ts:49` | Updates `@agentic-patterns/*` deps to latest via the project's own package manager (lockfile-detected); `--check` is CI-friendly exit-1-if-behind. A passive ~24h-cached out-of-date notifier also runs after every other command (`src/cli.ts:291-300`, `src/helpers/versions.ts`). |
| `ap config` / `ap config set` | `src/commands/config.ts:62,89` | Env detection status / interactive `.env` editor over a fixed list of tracked vars (`TRACKED_ENV`, `src/commands/config.ts:30-59`: 8 provider keys, Ollama host, 6 `AP_GATEWAY_*` vars, `AGENT_TIER`, `AGENT_MODEL`). |

Global flags parsed at `src/cli.ts:100-130`: `--port`, `--no-dashboard`, `--no-open`,
`--agents <glob>`, `--agents-dir <dir>`, `--context`, `--with-plugin`, `--provider`,
`--link`, `--global`, `--dir`, plus the eval flag set, `--check`, `--dry-run`.
`strict: false` — unknown flags are tolerated (needed for `tools call`'s dynamic flags).

## 2. The interactive/chat capability today (`ap run`)

### Modes (`src/commands/run.ts:192-197`)
- **One-shot**: message present → `streamOnce(conversation, message)` → print → exit.
- **Interactive REPL**: no message → `runRepl()` (`src/commands/run.ts:399-433`):
  - Banner: `chatting with <role name> · type /exit to quit`.
  - Loop: `@clack/prompts` `text({ message: "you" })` → send → render stream → repeat.
  - Exit paths: `/exit`, `/quit`, or clack cancel (Ctrl+C at the prompt) → prints "bye.".
  - Empty input lines are skipped.
  - Ctrl+C **during a response** aborts just that exchange via `AbortController` +
    `stream.return()` and prints `aborted.` (`src/commands/run.ts:418-431,443-457`).
    Errors mid-stream are caught and printed; the REPL survives.

### Yes, it streams
`conversation.stream(message)` yields the runtime's discriminated `AgentEvent` union;
`renderStream`/`renderEvent` project each event to terminal output as it arrives
(`src/commands/run.ts:443-515`). `agent.message.chunk` deltas are written directly to
stdout with no buffering — real token streaming.

### Event → terminal rendering (`renderEvent`, `src/commands/run.ts:463-515`)
| AgentEvent type | Rendering |
|---|---|
| `agent.message.start` | `assistant: ` (bold) |
| `agent.message.chunk` | raw `event.delta` appended |
| `agent.thinking.start` | dim `💭 thinking…` line |
| `agent.reasoning` | dim `💭 <content>` per line; `isComplete` closes the block |
| `agent.tool.start` | cyan `🔧 toolName(k=v, …)` (args compacted, 120-char cap) |
| `agent.tool.end` | dim `→ <result preview>` (240-char one-line) or red `✗ <error>` |
| `agent.message.complete` | dim footer `model · N↓ M↑` (token counts) |
| `agent.error` | red `⚠ errorType: message` |
| everything else | **ignored** — explicitly `iteration/llm/conversation/tool.intent/tool.rejected/etc.` (`src/commands/run.ts:511-513`) |

The full runtime event union (from `packages/agent-runtime/src/events/types.ts`) is much
larger than what the CLI renders: `agent.message.{start,chunk,complete,cancel}`,
`agent.reasoning`, `agent.thinking.start`, `agent.tool.{intent,rejected,start,end,progress}`,
`agent.step.{start,end}`, `agent.iteration.{start,end}`, `agent.llm.{start,end}`,
`agent.conversation.{start,end}`, `agent.input.request`, `agent.error`, plus state events
(`agent.backpack.{drop,read,absorb}`, `agent.scratchpad.{write,read,fork,join}`). Notably
**`agent.input.request` (human-in-the-loop approval) is ignored by the CLI renderer** —
the approval gate is only wired in the playground server path, so the dashboard chat can do
tool-approval prompts and the terminal chat cannot.

Styling is hand-rolled ANSI escape helpers (`bold/dim/cyan/red/yellow`,
`src/commands/run.ts:560-576`) — an explicit "no chalk dep" convention repeated in every
command file.

### How a `run` chat is wired (in-process, no server)
`src/commands/run.ts:118-190`:
1. `getAgentEventBus()` — process-global bus from the runtime.
2. `ExecutionService.resolveRunner({eventBus, verbose:false}, agents)` → credential
   preflight + `createRunner()` (env-ladder policy). See §4.
3. Promoted agents (`asAgent()` pipelines) get wrapped in `NodeBackedRunner(llmRunner,
   eventBus)`; plain agents use the LLM runner directly (`run.ts:129`).
4. `instantiate` hook (if declared) runs with the resolved context and the **delivered**
   instance is bound (never the declared one) — kind-mismatch between declared/delivered
   (promoted vs plain) fails loud (`run.ts:136-157`, `checkInstantiateKindMatch:335`).
5. `new Conversation(agentToBind, runner, { toolExecutor: deriveToolboxExecutor(agent),
   host: buildScopeHost(scope) })` (`run.ts:186-190`). The runtime `Conversation`
   (`packages/agent-runtime/src/conversation/conversation.ts:77`) is the stateful
   multi-turn engine: it tracks exchanges (user/assistant/toolCalls/tokens) in memory.
   **`ap run` passes no `ConversationStore`** — history lives only in process memory and
   is lost on exit. No resume, no transcript file, no `/history`.

### Run-scope context (#268/#308) — same contract as the server
- Precedence: `--context` flag > `AP_CONTEXT` env > `scope.defaults` >
  `instantiateDefaults` (`resolveRunContext`, `run.ts:235-285`) — documented as mirroring
  `POST /conversations`' `effectiveContext` in `agent-server/src/routes/conversations.ts`.
- `scope.parse()` (Zod) validates BEFORE `instantiate`; failures exit pre-run with a
  formatted issue list (`run.ts:101-116`, `formatScopeValidationError:296`).
- A one-line dim banner `scope: {…}` prints with declared keys redacted
  (`formatScopeBanner:374`, `redactContextForDisplay:355`, union of `scope.redactKeys` +
  deprecated `contextRedactKeys`, `unionRedactKeys:318`).
- **Parity gap**: the server/dashboard also expose **named scope presets**
  (`instantiation.presets` on `GET /agents`, preset picker in the playground form —
  `README.md:95`); `ap run` has no `--preset` flag, only raw JSON.

## 3. Agent discovery & project config (shared by all commands)

- `resolveProjectConfig()` (`src/helpers/config.ts:78`): walk up from CWD to nearest
  `package.json` → project root; parse `.env` into `process.env` (hand-rolled, no dotenv
  dep despite README saying "via dotenv" — `config.ts:56-72`); optional `agentic` block in
  package.json overrides `agents` glob(s), `roles` glob(s) (provenance libraries), `port`.
  Default glob: `agents/**/agent.{ts,js,mjs}` (`config.ts:39`).
- `discoverAgents(root, globs)` (`src/helpers/discover.ts:296`): glob (tinyglobby,
  node_modules/dist ignored) → dynamic-import each file through **tsx registered as ESM
  loader** (`ensureTsxRegistered`, `discover.ts:52` — so user `.ts` agent files import
  transparently) → structurally duck-type every export for Agent shape / AgentLike
  (promoted node) shape / legacy registration wrapper `{id, name, agent, instantiate?,
  instantiateDefaults?, scope?, contextRedactKeys?, evals?}` (`discover.ts:129-192`).
  Never `instanceof` — the src-vs-dist dual-package boundary makes it unreliable
  (documented repeatedly, "decisions.md D4").
- Identity inference: named export / filename / folder → kebab id; nested
  `<domain>/agents/<name>` namespaces the id as `domain/name` (`inferIdentity`,
  `discover.ts:350-372`). Duplicate ids: first wins, rest surface as load errors.
- `DiscoveredAgent` shape (`discover.ts:59-107`): `{id, name, description?, agent(any),
  file, provenance?, instantiate?, instantiateDefaults?, scope?, contextRedactKeys?,
  evals?}` — runner is injected later, per command.
- **Provenance** (`src/helpers/provenance.ts`) — playground-only enrichment
  (`src/cli.ts:187-199`): attributes each role slot (persona/judgments/responsibilities/
  capabilities) to `preset | preset? | library | local | inline` by reference and
  content matching against enumerated registries. Feeds the dashboard's composition-lens
  chips. Failure-isolated; computed only for `playground` because it dynamic-imports and
  executes library/sibling modules.

## 4. Execution service (runner resolution + credential preflight)

`src/services/execution-service.ts` — the single seam between "discovered agents" and a
live runner, used by `run`, `eval`, and `playground`.

- `resolveRunner(runnerOpts, agents)` = credential **preflight** + pass-through to the
  runtime's `createRunner(runnerOpts)` (`execution-service.ts:104-110`). Policy stays per
  command: eval passes `{tier}`, run passes the env-ladder default, playground passes
  `{resolveAgentModel: true}` unless `AGENT_MODEL`/`AGENT_TIER` global override is set
  (`playground.ts:134-141`).
- `inspect(agents)` (`:113-149`): reads each agent's declared model via `getModel()`,
  maps it to a provider via runtime `inferProvider` (`claude-*`→anthropic, `gpt-*`→openai,
  …), checks each provider's env vars (`PROVIDERS`/`PROVIDER_PRIORITY` from runtime),
  and treats `AP_GATEWAY_BASE_URL` as a universal credential.
- No credential at all → loud framed warning that it will **fall back to
  `ClaudeCodeAPIRunner`** (the local `claude` CLI + subscription OAuth — "dev-only, a
  deploy trap") (`:164-186`); in a TTY (unless `AP_NO_PROMPT`/`CI`) it launches an
  interactive clack flow to set an Anthropic/OpenAI key or a Bifrost/OpenAI-compatible
  gateway, writing `.env` via `upsertEnvFile` (`:192-285`).
- Supported model routing (via runtime `createRunner`): per-agent declared models
  (resolver mode), tier ladder (`AGENT_TIER` opus/sonnet/haiku), pinned `AGENT_MODEL`,
  provider keys for anthropic/openai/google/groq/mistral/xai/deepseek/openrouter/ollama,
  and one-gateway mode via `AP_GATEWAY_*` (`src/commands/config.ts:30-59`).

## 5. `ap playground` — how the CLI hosts the web chat (and how it relates to the dashboard)

`src/commands/playground.ts` boots, in order (`runPlaygroundCommand:70-261`):

1. **Observability stack**: fresh `AgentEventBus`, promoted to the process-global default
   via `setAgentEventBus(eventBus)` so user-project code that never threads a bus is still
   observable (`:79-91`); `InMemoryEventCollector` + `InMemoryAdminService` (powers
   `/admin` queries); `SSEExporter` attached to the bus (powers the dashboard's live
   stream at `/admin/events/stream` — `README.md:61`).
   (There is also an unused `buildObservabilityStack()` helper in
   `src/helpers/bootstrap.ts` — dead code; playground wires the stack inline.)
2. **Human-in-the-loop approval gate (opt-in)**: `AP_APPROVAL_TOOLS=<csv>` attaches
   `createHumanInputApprovalGate` + `PendingInputRegistry`; listed tools block until the
   human answers via `POST /conversations/:id/input` (dashboard inline approval prompt)
   (`:93-112`). Optional `AP_APPROVAL_TIMEOUT_MS`. **Server/dashboard-only** — not in `ap run`.
3. **Persistence**: `SQLiteConversationStore` (extends EvalStore ⊂ RunStore ⊂ EventStore —
   one class, one file backs `store`/`eventStore`/`evalStore`/`runStore`) at
   `AP_DB_PATH` or `$XDG_STATE_HOME|~/.local/state/ap/events.db` (`src/helpers/db.ts:16-20`);
   `SQLiteExporter` (durable event log) + `RunStoreExporter` (one `runs` row per chat
   execution; eval-owned traces excluded via `EVAL_TRACE_PREFIX`) attached to the bus;
   orphaned `running` rows swept at boot (`maybeAttachPersistence`, `:576-610`).
   Degrades to memory-only on `AP_PERSISTENCE=0` or missing better-sqlite3.
   Retention knobs: `AP_RETENTION_DAYS` (30), `AP_MAX_ROWS` (1M).
4. **Runner**: resolver mode by default (each agent's declared model dispatches at run
   time); `AGENT_MODEL`/`AGENT_TIER` force one model globally (`:134-141`).
5. **Registrations**: each `DiscoveredAgent` + runner mapped to the server's
   `AgentRegistration` via the explicit field-by-field `toAgentRegistration()` bridge —
   deliberately not a spread; a field missing there silently never reaches the server
   (`:278-296`, guarded by `__tests__/playground.test.ts`). Promoted agents get
   `NodeBackedRunner`.
6. **Hono app**: `createServer({agents, adminService, eventBus, sseExporter,
   inputRegistry, store, eventStore, evalStore, runStore, evalExecution:{runner, model,
   gitSha}, docs:{…}})` from `@agentic-patterns/server` (`:172-192`). API route prefixes
   the CLI knows about (kept in sync manually): `/agents, /roles, /capabilities,
   /conversations, /admin, /health, /eval` (`API_PREFIXES`, `:339-347`) plus `/docs`
   (Scalar API reference, served offline from a vendored bundle when
   `assets/scalar/standalone.js` exists, else CDN — `:168-199`).
7. **Dashboard SPA mount**: static files from `assets/dashboard/` (the built
   `@agentic-patterns/dashboard` React app, copied in at build time by
   `build:dashboard`, `package.json:25`). API routes win; an HTML-navigation shim
   (`Accept: text/html` content negotiation) lets SPA deep links that collide with API
   GETs (`/agents/:id`, `/eval/runs/:id`) reload as pages while `fetch()`/SSE/curl pass
   through to JSON (`withHtmlNavigationShim`, `:381-398`; `mountDashboard`, `:408-441`;
   path-traversal-safe `safeJoin`, `:447`). Missing assets → warning + API-only mode.
8. **Serve** via `@hono/node-server` on port 3456 default (`src/constants.ts:18`),
   print a banner (api/dashboard/agents/runner/storage/approvals lines), and
   auto-open the browser (`openBrowser`, `:514-532`) unless `--no-open`.

**So: "playground" = the React web chat.** The dashboard SPA is the chat UI; the CLI's
role is discovery + wiring + hosting. The web chat's transport contract lives in
`@agentic-patterns/server` (`POST /conversations`, `POST /conversations/:id/input`,
SSE at `/admin/events/stream`, `GET /admin/runs/:runId/events`, `GET /agents` with
`instantiation.schema`/`instantiation.presets` for the typed scope form — `README.md:95`);
the CLI only references these contracts in comments and the `API_PREFIXES` list.

Claude Code plugin tie-in: projects scaffolded `--with-plugin` POST all 26 Claude Code
lifecycle hooks to `${AP_DASHBOARD_URL}/hooks/:eventType` (default
`http://localhost:3456`, `src/constants.ts:21`); the server publishes them onto the bus
and the dashboard's `/claude-code` page renders them per-session (`README.md:109-113`).

## 6. `ap eval` specifics (`src/commands/eval.ts`)

- `--set` is a jsonl file path (file mode, loaded via `loadCasesJsonl`/`loadGold`) or a
  stored set id (requires persistence; `store.listEvalCases`) (`eval.ts:234-261`).
- File-mode banks are mirrored into the store (upsert set + cases) so the dashboard sees
  them (`:269-280`). Split filter with held-out `test` guard (`--allow-test`).
- Fresh `AgentEventBus` per eval (not the global), `SQLiteExporter` attached; the same
  bus goes to `createRunner` and `runEval`'s ctx (anti-rebind, #133) (`:300-316`).
- Persists suite row (`startEvalRun`) + per-case rows via `createEvalResultRecorder` —
  the exact recorder the server's `POST /eval/runs` route uses, so CLI evals and
  dashboard-launched evals land identically in the same `events.db` (`:327-397`).
- Scorers: expected-gated exact-match default; `--judge` appends `setMembership()` +
  `judgeScorer` (5-axis LLM rubric: accuracy/completeness/grounding/hazard-avoidance/
  calibration, thresholds `axis=n` 0-5 or `mean=`) on the same runner (`:365-375`).
- Live per-case line (✓/✗/•/⚠ + scores + token counts), aggregate, per-split table,
  gate verdict; exit 0/1/2 (`printCaseLine:526`, `printAggregateAndGate:543`).

## 7. State management summary

| Surface | State | Where |
|---|---|---|
| `ap run` chat | Conversation exchanges (in-memory only; **not persisted**, no store passed) | runtime `Conversation` instance (`run.ts:187`) |
| Playground chats | Events + runs + conversations + eval data in SQLite `events.db` | `AP_DB_PATH` / `~/.local/state/ap/events.db` (`db.ts:16`); memory-only fallback |
| Eval runs | Same SQLite file (EvalStore layer) | `eval.ts:223-229` |
| Env/config | `.env` at project root (read on every command, written by `config set` + credential preflight) | `config.ts:56`, `config.ts:142` |
| Version-notify cache | ~24h on-disk cache | `helpers/versions.ts` (notifier: `cli.ts:291-300`) |

## 8. Maturity signals

- **Tests**: 10 test files, ~140 test cases (vitest). Heavy coverage on `run.ts`'s pure
  context/scope helpers (43 tests in `__tests__/run.test.ts`), discovery (26), eval (25+1
  parity), playground bridge field-survival (13), versions (12), tools arg-parsing (6),
  init merge (5), claude-skill (5), provenance (4). Fixture agents under
  `src/helpers/__tests__/__fixtures__/agents/*` (15 variants incl. session-scoped,
  promoted, multi-export). **The interactive REPL loop and event rendering are untested**
  (only the exported pure helpers are).
- **TODO/stubs**: exactly one TODO — `init.ts:217` `TODO(phase-2)` about plugin-template
  packaging, which appears **already resolved** in practice (`resolvePluginSource` checks
  the bundled `assets/plugin-template/` first, `init.ts:596-606`, and `build:plugin-template`
  copies it in, `package.json:27`) — the TODO branch is now a near-dead path.
- **Dead code**: `src/helpers/bootstrap.ts` (`buildObservabilityStack`) is imported nowhere;
  `void createToolboxExecutor` in `playground.ts:160` is a deliberate "imported for
  discoverability" no-op.
- **README drift** (`README.md`): says `.env` is read "via dotenv" (actually hand-rolled,
  `config.ts:56-72`); the command table omits `run`'s `--context`, `tools`, `eval`,
  `claude-skill`, `update` (all in `--help` and code); `init`'s generated package.json
  pins `@agentic-patterns/*` at `^0.1.0` (`init.ts:281`) while actual published versions
  are 0.13.x/0.28.x — likely stale scaffold pin.
- Overall: this package is **well-maintained and heavily commented** (issue-numbered
  decision references #268/#308/#132-141 throughout), with deliberate exit-code taxonomy
  and failure-isolation. It is production-shaped for `run`/`playground`/`eval`; the
  *terminal chat UX itself* is the thin part.

## 9. Terminal-chat capability gaps vs the web chat (for the parity MVP)

What the dashboard/web chat gets (via server + SPA) that `ap run` lacks today:

1. **No persistence/resume** — web chats land in `events.db` via exporters + conversation
   store; `ap run` passes no store and loses history on exit.
2. **No HITL approvals** — `agent.input.request` events are silently ignored in the CLI
   renderer (`run.ts:511-513`); the approval gate is only attached in playground
   (`playground.ts:99-112`).
3. **No scope presets** — server exposes `instantiation.presets` and the dashboard renders
   a preset picker; CLI accepts only raw `--context` JSON.
4. **No rich rendering** — raw ANSI lines; no markdown, no reasoning fold/expand, no run/
   trace links (dashboard can jump to `GET /admin/runs/:runId/events`).
5. **No agent switching / listing inside the chat** — one agent per invocation; no slash
   commands beyond `/exit`,`/quit`; no multi-line input (clack single-line `text()`).
6. **No remote mode** — the CLI cannot chat *against* a running playground server over
   HTTP/SSE; `ap run` always spins its own in-process runner (fresh credentials preflight,
   fresh conversation), even if a playground with the same agents is already running.
7. **Ignored event classes** — step/iteration/llm/state (scratchpad/backpack) events that
   the dashboard visualizes are dropped in the terminal.

Existing assets that make a terminal-chat MVP cheap: the event-union renderer seam
(`renderEvent`) is a single switch; `Conversation` already supports stores and streaming;
scope/context resolution already mirrors the server; `SSEExporter`/`toSSEMapping`
(`agent-runtime/src/transport/sse-formatter.ts`, imported by `Conversation`) already
define the wire mapping if a remote (HTTP/SSE) CLI chat is wanted.
