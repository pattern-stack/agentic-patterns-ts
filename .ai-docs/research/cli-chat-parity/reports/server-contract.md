# Server HTTP/SSE Contract — `@agentic-patterns/server` + feeding runtime pieces

Reader slice for the web-chat vs terminal-chat parity gap analysis. Everything below is read
from source in this worktree (`packages/agent-server`, `packages/agent-runtime`), whole files,
with file:line anchors. This is **the exact wire contract a CLI/TUI chat client must speak** to
reach parity with the React dashboard chat.

Package: `@agentic-patterns/server` v0.28.1 (`packages/agent-server/package.json`), Hono-based,
ESM+CJS, zod peer `^3.25 || ^4.1.8`. Public exports are only `createServer`, config types, and
`agentEventToSSE` (`packages/agent-server/src/index.ts:1-11`).

---

## 1. Server assembly and configuration

`createServer(config)` (`packages/agent-server/src/app.ts:26-81`) builds one Hono app:

- Creates a **fresh in-memory conversation registry** `Map<string, ConversationEntry>` per
  server instance (`app.ts:28`) — live conversations are process-local, NOT persisted, NOT
  resumable after restart (persistence is a separate read-only history, see §5).
- Mounts, in order: health, agents, composition, conversations, admin, hooks, events, runs,
  eval, then docs LAST (docs introspects `app.routes` so every route self-documents,
  `app.ts:69-78`).
- Store fallback rule: `runStore ?? evalStore` is used for both the runs routes and the chat
  run-metadata stamp (`app.ts:46-57`) — an `EvalStore` literally IS a `RunStore` by class
  inheritance (see §7).

`ServerConfig` (`packages/agent-server/src/config.ts:199-256`) — capability slots and their
degradation when absent:

| Slot | Enables | When absent |
|---|---|---|
| `agents: AgentRegistration[]` | everything | required |
| `adminService` | `/admin/dashboard|agents|tools|tokens` | required |
| `eventBus: AgentEventBus` | event fan-out, gates | required |
| `sseExporter` | `GET /admin/events/stream` | required |
| `inputRegistry?` | `POST /conversations/:id/input` (human-in-the-loop return leg) | 501 |
| `store?: ConversationStore` | conversation persistence + 4 read routes | 503 "persistence not configured" |
| `eventStore?` | `/admin/events/recent`, `/admin/events/trace/:id`, CC session routes | 503 |
| `evalStore?` | all `/eval/*` reads/writes | 503 |
| `runStore?` | `/admin/runs*` (falls back to evalStore) | 503 |
| `evalExecution?` | `POST /eval/runs` launch | 503 "eval execution not configured" |
| `staticDir?` | **claimed** static SPA mount — see §10 (dead config) | — |
| `cors?`, `docs?` | CORS options (default `origin: "*"`), docs metadata | defaults |

`AgentRegistration` (`config.ts:63-153`): `id`, `name`, `description?`, `file?`, `provenance?`,
`agent: AgentLike` (declared instance), `instantiate?(context)` (delivered-instance factory,
ADR-0004), `scope?: SessionScopeLike` (#308 validated session scope: `schema`, `parse()`,
`redactKeys`, `defaults?`, `presets?`, `toJsonSchema()` — structurally duck-typed, never
`instanceof` across module boundaries, `config.ts:36-54`), deprecated `instantiateDefaults?` and
`contextRedactKeys?`, `evals?: AgentEvalRef[]` (code-declared eval↔agent grading links,
`config.ts:24-33`), and `runner` (must support `run`, optionally `stream`).

How the real embedder wires it (`packages/agent-cli/src/commands/playground.ts:172-190`): the
CLI `ap playground` passes ONE `SQLiteConversationStore` object into `store`, `eventStore`,
`evalStore`, AND `runStore` (single SQLite ladder, §7), plus `inputRegistry`, plus
`evalExecution: { runner, model, gitSha }`. Approval gating only exists when
`AP_APPROVAL_TOOLS` is set (`playground.ts:100-112`); persistence is on unless
`AP_PERSISTENCE=0`.

---

## 2. Route inventory (complete)

### Health
- `GET /health` → `{status:"ok"}` (`routes/health.ts:9`).

### Agents / composition (read-only introspection — the playground "BUILD doors")
- `GET /agents` → array of `{id, name, description, role:{id,name}|null, readiness:{ready,
  missing:["model"]?}, instantiation:{available, defaults, schema, presets}}`
  (`routes/agents.ts:65-98`). `instantiation.available = hasHook || hasScope`; `schema` is
  `scope.toJsonSchema()` wrapped in try/catch (one bad registration never 500s the roster,
  `agents.ts:53-60`).
- `GET /agents/:id/capabilities` → `{id, name, description, model, capabilities:[{name,
  description, toolbox, tools:[{name,description,parameters}], plays:[...]}]}`
  (`routes/agents.ts:103-145`).
- `GET /agents/:id/composition` → full two-tier payload: `role` (persona/judgments/
  responsibilities/capabilities with per-slot provenance chips), `instance` (background/
  awareness/mission/modelOverride), `prompt` (`renderPath:"sections"|"joined"` + rendered
  sections), `coherence:{heuristic:true, warnings[]}`, `instantiation`, `evals`
  (`routes/composition.ts:677-740`).
- `POST /agents/:id/composition/delivered` — body `{context?}`; runs `scope.parse` (same
  validation as conversation-create, D10) then `instantiate(effectiveContext)` and introspects
  the delivered instance; echoes redacted `context`/`context_redacted`; 501 when no hook, 502
  `instantiate failed: …` (`composition.ts:747-819`).
- `GET /roles`, `GET /roles/:id` — role identity catalog grouped by reference identity, with
  per-slot `usedBy`/`similar` edges (`composition.ts:822-877`).
- `GET /capabilities`, `GET /capabilities/:id` — capability catalog with `usedBy`,
  `sharesToolboxWith`, enriched manual sections + playbook schemas on detail
  (`composition.ts:880-914`).
- `POST /capabilities/:id/tools/:toolName/invoke` — Tool Workbench direct invoke; body
  `{args}`; **bypasses agent loop AND the gate chain entirely** (explicit design note,
  `composition.ts:922-928`); mints synthetic `runId = "workbench:<uuid>"` and publishes
  `agent.tool.start`/`agent.tool.end` on the bus so it shows on /live; returns
  `{ok, result, ms}` or `{ok:false, error, ms}` (`composition.ts:929-1010`).

### Conversations (the chat spine — `routes/conversations.ts`)
- `POST /conversations` — create (§3).
- `POST /conversations/:id/messages` — send message; response is an SSE stream (§4).
- `POST /conversations/:id/input` — human-in-the-loop answer (§4.3).
- Read routes (need `store`, else 503): `GET /admin/conversations` (summaries),
  `GET /conversations/:id` (detail), `GET /conversations/:id/messages`,
  `GET /messages/:id/parts` (`conversations.ts:229-328`).

### Admin analytics (`routes/admin.ts`)
- `GET /admin/dashboard`, `GET /admin/agents`, `GET /admin/tools`,
  `GET /admin/tokens?group_by=agent|model` — thin passthroughs to `AdminServiceProtocol`
  (`packages/agent-runtime/src/admin/service.ts:25-35`; in-memory impl backed by
  `InMemoryEventCollector`).
- `GET /admin/events/stream` — global SSE broadcast of ALL bus events (§4.4).

### Events (`routes/events.ts`)
- `POST /events` — cross-process ingest: accepts a single AgentEvent, an array, or
  `{events:[...]}`, republishes on this server's bus; optional shared secret via
  `AP_INGEST_TOKEN` env (Bearer auth, 401) (`events.ts:20-47`). Pairs with the runtime's
  `HttpEventExporter` (batched fire-and-forget POST, `exporters/http.ts:32-91`).
- `GET /admin/events/recent?since&limit(1000,max 10000)&type` → `{events: PersistedEvent[]}`.
- `GET /admin/events/trace/:id` → `{traceId, events}`.
- `GET /admin/claude-code/sessions?limit` and `/admin/claude-code/sessions/:sessionId` —
  Claude Code hook-session history (all 503 without `eventStore`).

### Runs (`routes/runs.ts`)
- `GET /admin/runs?status=running|ok|error&since&limit(50,max 500)&agent` → `{runs:
  RunSummary[]}` (cheap projection, no prompt/answer blobs, `run-store.ts:90-106`).
- `GET /admin/runs/:id` → `{run: RunRow}` — `:id` accepts a **unique run-id prefix**
  (`run-store.ts:275-281`).
- `GET /admin/runs/:id/events` → `{runId, events: PersistedEvent[]}` — the run's full ordered
  event stream for trace replay.

### Eval (`routes/eval.ts` — the largest route file, 1089 lines)
- Reads: `GET /eval/sets`, `GET /eval/sets/:id/cases?split=`, `GET
  /eval/sets/:id/cases/:caseId` (case + cross-run history), `GET /eval/runs?set&target&
  variant&split&limit` (with per-run pass-rollup `summary`), `GET /eval/runs/:id` (run +
  joined results + handler-computed summary incl. tokens), `GET /eval/aggregates/splits`,
  `GET /eval/scorers` (static registry: `exact-match` (default), `set-membership`, `none` —
  `eval.ts:994-1013`).
- Writes: `POST /eval/sets` (upsert, 201/200), `PATCH /eval/sets/:id`, `PUT
  /eval/sets/:id/cases/:caseId`, `DELETE /eval/sets/:id/cases/:caseId`.
- `POST /eval/runs` — body `{setId, targetId, variant?, split?, allowTest?, scorer?}`;
  guard ladder: 400 validation → 403 held-out `test` split without `allowTest:true` → 503
  store/exec → 404 unknown target/set → 202 `{runId, total, scorer}`; suite runs detached
  after the response; crash finalizes the run row as `"error"` (`eval.ts:423-599, 1039-1049`).
- `GET /eval/runs/:id/stream` — attachable SSE progress view over an in-process live-run
  registry. Frames: `run.snapshot {runId,status,completed,total|null}`, `case.result
  {caseId,pass,succeeded,error,scores,finalAnswer,inputTokens,outputTokens,traceId,
  completed,total}`, `run.finished {status}`, `run.detached {status:"running"}` (row is
  running but no runner in this process), terminator `done {}` (`eval.ts:747-835,
  1071-1088`).
- `POST /eval/cases/from-session` — capture a live chat exchange as an eval case: body
  `{conversationId, setId, exchange?(1-based), expected?, split?, tags?, caseId?,
  createSet?}`; reads the **in-process** conversation registry (404 with hint if the
  conversation isn't live in this server), deterministic caseId
  `session-<convId>-<n>` for idempotent re-capture, default tags `["captured",
  "agent:<id>"]`, default split `train` (`eval.ts:605-741, 857-859`).

### Claude Code hook bridge (`routes/hooks.ts`)
- `POST /hooks/:eventType` — validates against the 26 known lifecycle hook names
  (`packages/agent-runtime/src/events/claude-code.ts:21-48`: SessionStart …​ SessionEnd),
  publishes a `claude_code.hook` event preserving the raw payload, then derives
  `agent.tool.start`/`agent.tool.end` from PreToolUse/PostToolUse — UNLESS the request
  carries `x-ap-runner-correlation-id` (runner already emits tool events; skip to avoid
  double-counting) (`hooks.ts:30-75`). Returns `{ok:true}`.

### Docs (auto-generated, mounted last — `docs/index.ts`)
- `GET /openapi.json` (OpenAPI 3.1, built by introspecting live `app.routes` + a described
  catalog; logs "catalog drift" warnings for described-but-unmounted routes,
  `docs/index.ts:76-86`), `GET /docs` (Scalar UI, CDN by default / vendored offline via
  `scalarJsUrl`), `GET /llms.txt` (LLM-oriented markdown map), `GET /mcp/tools.json`
  (MCP-shaped manifest of REST ops + capability tools).

---

## 3. Conversation creation contract (`POST /conversations`)

`routes/conversations.ts:63-226`. Body: `{agent_id, scope?, context?}`.

1. 404 unknown agent. `scope` supersedes deprecated `context` alias; `scope` wins when both
   sent (`:75-77`). Non-object (incl. `null`, arrays) → 400 `` `scope` must be a JSON object ``.
2. Supplying scope/context to a registration with neither `instantiate` nor `scope` → 400.
3. Effective value = body value ?? `scope.defaults` ?? deprecated `instantiateDefaults`
   (shallow-copied — defaults may be frozen / shared) (`:115-118`).
4. If registration declares `scope`: `scope.parse(effective ?? {})` — zod defaults/coercions
   applied; failure → **400 `{error:"scope validation failed", issues:[...]}`** (issues
   duck-typed off `err.issues`, never `instanceof ZodError` — works across zod v3/v4 module
   boundaries, `:128-143`); non-object parse result → 502 "malformed scope". A registration
   with required scope fields and no defaults makes a bare create a deliberate 400.
5. If `instantiate` exists: called with the PARSED value; rejection → **502 `instantiate
   failed: <msg>`**, no fallback to the declared agent (`:152-159`).
6. Redaction: union of `scope.redactKeys` + deprecated `contextRedactKeys`; matched top-level
   keys become `"[redacted]"` (shallow only — `routes/redact.ts:14-28`). Redacted echo is
   what's held in the registry entry and later stamped onto run metadata; the UNREDACTED
   parsed scope reaches tools/prompt via `RunOptions.host.scope`.
7. A `Conversation` (runtime class, §6) is constructed with: the bound agent, the
   registration's runner, a derived `ToolExecutor` (`deriveToolboxExecutor(agentToBind)` —
   returns `undefined` for capability-less/promoted agents so nested AgentSteps arm their own
   tools, `:184-186`), the `ConversationStore` (arms persistence), and — only for
   scope-declaring registrations — `host = buildScopeHost(parsedScope)` (`:193`).
8. Response 201: hook-less AND scope-less → byte-pinned `{id, agent_id}`. Otherwise
   `{id, agent_id, context: <redacted>|null, scope?: <same, only when scope declared>,
   context_redacted?: [keys]}` (`:208-225`). The dashboard chip depends on `context` staying
   populated.

`ConversationEntry` registry value: `{conversation, agentId, context?, contextRedacted?}`
(`conversations.ts:35-50`). Scope is **immutable for the conversation's lifetime**.

---

## 4. The chat streaming contract

### 4.1 `POST /conversations/:id/messages` (`conversations.ts:331-445`)

Body: `{content: string, maxIterations?: number}` (maxIterations clamped 1..50; omitted →
runner default). Errors: 404 unknown/not-live conversation id, 400 missing content, 501 when
the registration's runner has no `stream`.

Response: **SSE over the POST response body** (Hono `streamSSE`). Important for a CLI:
this is NOT `EventSource`-compatible (EventSource is GET-only) — the client must POST and
incrementally parse `event:`/`data:` frames off the response stream. Frames are produced by
`agentEventToSSE` (`src/sse.ts:36-40`) = the runtime's canonical `toSSEMapping`
(§4.2) with `data = JSON.stringify(payload)`. **The FULL event vocabulary is forwarded** —
including `iteration.*`, `llm.*`, `step.*`, `backpack.*`, `scratchpad.*`; curation is the
client reducer's job, not the transport's (`sse.ts:12-19`).

Per-turn mechanics:
- The route captures the turn's `traceId` from the first event and the turn's **top-level
  runId from the first `agent.message.start`** (`:392-396`).
- Terminator: `event: done` with `data: {"run_id": "<turnRunId>"}` (or `{}` if no
  message.start was seen) (`:403-406`) — lets the client deep-link to
  `/admin/runs/:id/events` / `/run?run=<id>` immediately.
- Human-in-the-loop delivery: a bus subscription on `agent.input.request`, filtered to the
  turn's traceId, writes `input.request` frames into THIS stream while the runner generator
  is parked inside a blocking gate (`:363-389`).
- `finally` block: (a) stamps `runStore.updateRunMetadata(turnRunId, {context,
  context_redacted?})` — deliberately in `finally` so errored/disconnected turns still get
  stamped (`:407-432`); (b) unsubscribes; (c) **fail-closed**: any still-pending input
  requests from this turn are resolved `deny` on stream teardown (`:436-442`).

Note the frame payloads on the chat stream are the RAW mapping payloads — no
traceId/timestamp enrichment (contrast §4.4).

### 4.2 Canonical SSE event vocabulary (the single source of truth)

`toSSEMapping` in `packages/agent-runtime/src/transport/sse-formatter.ts:74-352` maps every
`AgentEvent` (discriminated union, `events/types.ts:415-447`) to a wire name + snake_case
payload, with a compile-time exhaustiveness check. Full table (internal type → wire `event:`
name → payload keys):

| Internal type | Wire name | Payload |
|---|---|---|
| agent.conversation.start | `conversation.start` | `conversation_id, agent_name` |
| agent.conversation.end | `conversation.end` | `conversation_id, reason` ("completed"\|"error"\|"cancelled") |
| agent.message.start | `message.start` | `agent_name` (NOTE: `systemPrompt`/`agentConfig` on the internal event are NOT forwarded) |
| agent.message.chunk | `message.delta` | `delta, chunk_index` |
| agent.message.complete | `message.complete` | `content, input_tokens, output_tokens, model` (internal `finishReason` NOT forwarded) |
| agent.message.cancel | `message.cancel` | `reason` |
| agent.input.request | `input.request` | `correlation_id, kind ("approval"\|"select"\|"text"), prompt, options?, tool_name?, tool_call_id?, arguments?` |
| agent.thinking.start | `thinking.start` | `{}` |
| agent.reasoning (isComplete=false) | `thinking` | `content` |
| agent.reasoning (isComplete=true) | `thinking.complete` | `content` |
| agent.tool.intent | `tool.intent` | `tool_call_id, tool_name, arguments` |
| agent.tool.start | `tool.start` | `tool_call_id, tool_name, arguments` |
| agent.tool.progress | `tool.progress` | `tool_call_id, progress, status_text` |
| agent.tool.end | `tool.end` | `tool_call_id, tool_name, result, duration_ms, error?` |
| agent.tool.rejected | `tool.rejected` | `tool_name, reason, gate_name` |
| agent.step.start | `step.start` | `span_id, parent_span_id, step_name, agent_name, arguments` |
| agent.step.end | `step.end` | same + `result, duration_ms, error?` |
| agent.iteration.start | `iteration.start` | `iteration, max_iterations` |
| agent.iteration.end | `iteration.end` | `iteration, tool_calls_count, has_more` |
| agent.llm.start | `llm.start` | `model, message_count, has_tools` |
| agent.llm.end | `llm.end` | `model, input_tokens, output_tokens, duration_ms, finish_reason` |
| agent.error | `error` | `error_type, message, recoverable` |
| claude_code.hook | `claude_code.hook` | `hook_name, session_id, cwd, tool_name, tool_input, tool_response, tool_use_id, permission_mode, transcript_path, runner_correlation_id, payload` |
| agent.backpack.drop | `backpack.drop` | `key, origin, ordinal, accepted, merged, skipped, indexes, size_before, size_after, previews, previews_omitted, tool_call_id?, tag?, display?` |
| agent.backpack.read | `backpack.read` | `key, origin, ordinal, memo_hit, size, preview, tool_call_id?, display?` |
| agent.backpack.absorb | `backpack.absorb` | `key, origin, ordinal, child_size, accepted, merged, size_before, size_after, appended_indexes, tool_call_id?, display?` |
| agent.scratchpad.write | `scratchpad.write` | `key, origin, ordinal, op, had_value, after, before?, tool_call_id?` |
| agent.scratchpad.read | `scratchpad.read` | `key, origin, ordinal, preview, tool_call_id?` |
| agent.scratchpad.fork | `scratchpad.fork` | `origin, ordinal, shared_keys` |
| agent.scratchpad.join | `scratchpad.join` | `origin, ordinal, merged_keys, discarded_keys` |
| — | `done` | stream terminator (`{run_id?}` on chat, `{}` elsewhere) |

`SSE_EVENT_NAMES` const map at `sse-formatter.ts:365-395`. Every internal event carries
BaseEvent trace fields `traceId, runId, spanId, parentSpanId?, timestamp`
(`events/types.ts:30-37`); state-delta events add `origin ("innate"|"explicit")` and a
monotonic per-run `ordinal`, with byte-capped previews (512B/row, 2KB/frame)
(`types.ts:277-409`).

### 4.3 Human-in-the-loop round trip

- Outbound: an approval gate (`createHumanInputApprovalGate`,
  `packages/agent-runtime/src/interaction/approval-gate.ts:52-91`) blocks the guarded
  `agent.tool.intent` inside `AgentEventBus.publish` (gate chain,
  `events/agent-event-bus.ts:54-79`), publishes `agent.input.request` with
  `correlationId = toolCallId` (double gate-check deduped by memo), and awaits the
  `PendingInputRegistry` promise (optional timeout → auto-DENY,
  `interaction/pending-input-registry.ts:60-89`).
- The chat route surfaces the `input.request` frame on the live turn stream (§4.1).
- Return leg: `POST /conversations/:id/input` body `{correlation_id, decision?:
  "approve"|"deny", value?}` (`conversations.ts:454-491`). Semantics: explicit decision wins;
  a supplied `value` implies approve; a bare call denies. Responses: 200
  `{ok, correlationId, decision}`, 404 no pending input, 400 missing correlation_id, **501
  when no `inputRegistry` configured** (hint mentions `AP_APPROVAL_TOOLS`). The `:id` in the
  URL is addressing sugar — the registry key is the globally unique correlation_id.
- Denied intents surface as `tool.rejected` frames (bus emits `agent.tool.rejected`,
  `agent-event-bus.ts:81-96`).

### 4.4 Global admin stream — `GET /admin/events/stream`

`routes/admin.ts:32-46` returns `sseExporter.connect()`'s ReadableStream with
`text/event-stream` headers; disconnects on request abort. `SSEExporter`
(`packages/agent-runtime/src/exporters/sse.ts:28-83`) subscribes to the **UX profile**
(`events/event-profiles.ts:29-65` — everything incl. chunks, step/state-delta events,
`claude_code.hook`) and broadcasts every event to all clients, formatted by
`SSEFormatter.format` which **enriches each payload with `traceId` and `timestamp`**
(`sse-formatter.ts:408-419`) — unlike the per-turn chat stream. This one IS
`EventSource`-compatible (GET). A CLI could drive its whole live view from this single
firehose (it carries ALL conversations' events; filter by traceId/runId).

---

## 5. Session/conversation persistence and read-back

Two separate layers, linked by `runId`, never merged:

**ConversationStore** (dialogue replay) — protocol at
`packages/agent-runtime/src/conversation/store.ts:80-115`: `createConversation(agentName,
model)`, `addMessage(convId, kind "request"|"response", parts[], {runId, inputTokens,
outputTokens})`, `getMessages`, `getMessageParts`, `listConversations` (summary projection).
`StoredMessagePart` = `{id, messageId, type, content?, metadata, position?, createdAt?}`.
In-memory impl in the same file; durable impl `SQLiteConversationStore` extends `EvalStore`
(schema v5 of the single SQLite ladder,
`packages/agent-runtime/src/storage/conversation-store.ts:54`).

What gets persisted per chat turn (`Conversation._persistExchange`,
`conversation/conversation.ts:359-390`): a `request` message with one `user_prompt` part, and
a `response` message with `state_delta` parts (one per backpack/scratchpad event, metadata =
the SSE wire payload + `event` name; innate scratchpad-read previews are redacted with
`preview_redacted: true`, `conversation.ts:453-464`) followed by a terminal `text` part, plus
tokens and the captured `runId`. **Tool calls are NOT persisted as parts** (`toolCalls: []`
always, `conversation.ts:290-300`) — tool history is only recoverable from the event log via
`GET /admin/runs/:id/events`.

Server read routes (`conversations.ts:229-328`) shape to the dashboard's mirrored types and
"honest degradation": `agentConfigId: null`, `status: "active"` constant (no lifecycle
tracking exists), message `metadata: null`, `updatedAt` mirrors `createdAt`, `content` is a
derived preview joining text parts (`conversations.ts:520-526`).

**Run history** (execution analysis): `RunStoreExporter`
(`packages/agent-runtime/src/exporters/run-store.ts:96-257`) folds bus events into one
`runs` row per runId: opened on `message.start` (status `running`, captures systemPrompt +
agentConfig), accumulates `llm.end`/`tool.end`/`iteration.end` into per-iteration
step-metrics, finalized by `message.complete` (status ok) or non-recoverable `error`
(first-terminal-wins). `RunStore` (`storage/run-store.ts:124-341`) adds
`listRuns/getRun(prefix-capable)/runEvents/stats/updateRunMetadata/sweepRunning` over
SQLite; schema ladder v1 events → v2 runs → v3/v4 eval → v5 conversations
(`storage/event-store.ts:68-150`).

The **join key a CLI needs**: chat `done` frame `run_id` == `StoredMessage.runId` ==
`runs.run_id` == `events.run_id`. The scope/context of the conversation is stamped into
`runs.metadata` (`{context, context_redacted}`) per turn.

---

## 6. `Conversation` runtime semantics (`conversation/conversation.ts`)

- In-memory `Exchange[]` history (`{number, invocationId, user, assistant, toolCalls,
  inputTokens, outputTokens, timestamp, runId?}`); history is replayed to the runner as
  canonical messages each turn (`:395-417`). `clear()`, `rollback(n)`, `fork(atExchange?)`
  exist on the class (`:159-343`) but **no server route exposes them** — web chat doesn't
  have branch/rollback either; a CLI could only get them by embedding the runtime directly.
- `stream()` emits its own `agent.conversation.start`/`.end` envelope events (traceId =
  invocationId, passed down to the runner so all turn events share one trace,
  `:230-266`), accumulates `message.chunk`/`message.complete` into the exchange, captures
  the runner's runId off the first event, and **re-throws errors only after yielding
  `conversation.end` (reason:"error")** (`:309-321`).
- `send()` (non-streaming) exists but has no runId capture and no state-delta persistence;
  the server chat path uses only `stream()`.

---

## 7. Storage class hierarchy (one SQLite file, literal inheritance)

`EventStore` (append-only `events` log; retention/row-cap pruning; CC-session
denormalized columns) ← `RunStore` (adds `runs`) ← `EvalStore` (adds
`eval_set`/`eval_case`/`eval_run`/`eval_result`; the eval result row stores ONLY
scores/pass/linkage — execution facts are JOINed from `runs`, never duplicated,
`storage/eval-store.ts:12-25`) ← `SQLiteConversationStore` (adds conversation tables +
implements `ConversationStore`). This is why the server's `runStore ?? evalStore` fallback
and the CLI's pass-one-object-into-four-slots wiring are sound.

---

## 8. Event bus + exporters (what feeds the wire)

- `AgentEventBus extends EventBus` with a **gate chain applied only to `*.intent` events**;
  blocked intents become `agent.tool.rejected` (`events/agent-event-bus.ts:12-97`). Global
  singleton via `getAgentEventBus()`.
- Event profiles (`events/event-profiles.ts:28-114`): UX = everything (incl. chunks,
  step/state-delta, claude_code.hook); OBSERVABILITY = no chunks/step/state-delta; TOOLS;
  STREAMING; DEBUG.
- Exporters (`packages/agent-runtime/src/exporters/`): `SSEExporter` (UX → SSE broadcast),
  `SQLiteExporter` (UX → EventStore.append, best-effort), `RunStoreExporter` (OBSERVABILITY →
  runs rows, with `metadataFor`/`shouldTrack` seams — playground skips eval-owned traces to
  avoid double-writing), `HttpEventExporter` (subscribeAll → batched POST to another server's
  `/events` ingest), plus Console/Langfuse/OTel (out of chat scope).

---

## 9. Maturity signals

**Strong**: 17 server test files, ~7,700 lines (`src/__tests__/`), covering: app/CORS, SSE
frame shapes (`sse.test.ts`), approval round-trip with a real gate
(`approval-round-trip.test.ts`), conversation context/scope ladders (400/502/redaction/
metadata stamping — `conversation-context.test.ts` 906 lines, `conversation-scope.test.ts`
579), composition + delivered parity, eval run/capture/stream ladders, promoted-agent
regressions, docs generation incl. drift. **Zero TODO/FIXME markers in server src.** Byte-
pinned back-compat responses are explicitly tested ("pinned-shape survivals"). Error grammar
is uniform: 503 `{error:"persistence not configured", hint:"start \`ap playground\` with
AP_PERSISTENCE != 0 …"}`; 501 for unwired capability; 502 for registration bugs.

**Weak/absent (parity-relevant gaps)**:
1. **No cancel/stop endpoint.** `agent.message.cancel` exists in the vocabulary
   (`events/types.ts:203-206`) but nothing server-side emits it and there is no
   `POST /conversations/:id/cancel`; the only way to stop a turn is dropping the HTTP
   connection (which also auto-denies pending approvals).
2. **Conversations are not resumable.** The live registry is in-memory
   (`app.ts:28`); persisted history is read-only — there is no route to rehydrate a stored
   conversation into a live one after restart (`Conversation` supports a `history` ctor
   option, but no route uses it).
3. **No conversation delete/clear/rollback/fork routes** despite runtime support (§6).
4. **`message.start` drops `systemPrompt`** on the wire; a client wanting the rendered
   prompt must fetch `GET /admin/runs/:id` (`systemPrompt` column) or `/agents/:id/composition`.
5. **`staticDir` is dead config**: declared in `ServerConfig` (`config.ts:237`) and promised
   in the README ("pass staticDir and the server will mount it at /", `README.md:172`), but
   `createServer` never reads it — the CLI mounts the dashboard itself
   (`agent-cli/src/commands/playground.ts:408`). README-vs-code drift.
6. README's SSE example shows `claude_code.hook` frames on `/admin/events/stream` with no
   traceId enrichment shown (`README.md:60-73`) — actual frames carry `traceId` +
   `timestamp` extra keys; minor doc drift.
7. Auth: **none anywhere** except the optional `AP_INGEST_TOKEN` bearer check on
   `POST /events`. CORS defaults to `*`.
8. Scorer id persisted on `eval_run` (schema v4) but `POST /eval/runs`' body comment at
   `eval.ts:70-73` still says "NOT persisted" while the registry comment at `eval.ts:991-992`
   says it IS — the code persists it (`eval.ts:535-543` passes `scorer: chosenScorer.id`);
   stale inline comment.

---

## 10. Minimal contract a terminal chat MUST implement (checklist)

1. `GET /agents` → pick agent; read `instantiation.{available,schema,defaults,presets}` to
   drive an optional scope form (presets materialize client-side; no `preset` wire key).
2. `POST /conversations {agent_id, scope?}` → hold `id`; render redacted `context` echo;
   handle 400 scope-validation (`issues[]`) and 502 instantiate-failure.
3. `POST /conversations/:id/messages {content, maxIterations?}` → parse SSE off the POST
   body (NOT EventSource). Reducer must at minimum handle `message.delta` (append),
   `message.complete` (finalize + tokens/model), `tool.start`/`tool.end` (activity),
   `input.request` (render approval/select/text prompt), `tool.rejected`, `error`,
   `conversation.end`, `done` (capture `run_id`). Everything else (`thinking*`, `llm.*`,
   `iteration.*`, `step.*`, `backpack.*`, `scratchpad.*`) is optional richness.
4. On `input.request`: `POST /conversations/:id/input {correlation_id, decision|value}`;
   handle 501 (approvals unconfigured) and 404 (already resolved/timed out).
5. History panes: `GET /admin/conversations`, `/conversations/:id/messages`,
   `/messages/:id/parts` (503-aware); trace drill-down: `GET /admin/runs/:id/events` using
   the `done` frame's `run_id`.
6. Optional parity features the web chat has beyond the basics: eval capture from a live
   exchange (`POST /eval/cases/from-session`), eval launch + live progress
   (`POST /eval/runs` + `GET /eval/runs/:id/stream`), tool workbench
   (`POST /capabilities/:id/tools/:toolName/invoke`), composition/roles/capabilities lenses,
   admin analytics, live global firehose (`GET /admin/events/stream`).
