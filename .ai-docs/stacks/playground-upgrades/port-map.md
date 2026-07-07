# Playground Upgrades — Port Map (swe-brain → agentic-patterns playground)

Durable reference for the port of swe-brain agent surfaces + the board-wide styling level-up.
Downstream implementers: work from this document; only re-open swe-brain source when a
mapping below says "copy verbatim" and you need the exact lines.

- **Source repo**: `/Users/dug/Projects/dug/swe-brain` (frontend root `apps/frontend/src`, backend root `apps/backend/src`)
- **Target repo**: `/Users/dug/Projects/dug/agentic-patterns-ts` — `packages/agent-dashboard/src`, `packages/agent-server/src`, `packages/agent-runtime/src`, `packages/agent-cli/src`
- **Excluded by decree**: Agent Composer / authoring UI. Everything else in scope.
- **Do NOT regress** (already in the playground and better than or equal to swe-brain's version):
  constellation with Chain/Composition `GraphSource` seam + subagent nodes (`graph/composition.ts`),
  the full Evaluate console (`pages/eval/*`), Build introspection (declared-vs-delivered, `SlotStack`,
  provenance chips, real `RenderedPromptView`), chat with `agent_step` parts + `CaptureCasePanel`.
- **Conventions**: React Router 7, REST + SSE (no TanStack DB / generated store), cockpit `T.*`
  tokens, atoms→molecules→organisms→templates→pages, strict TS, biome (double quotes, 2-space, 100 cols).
- **Browser-verify baseline**: `ap playground examples` (deterministic pipeline2 agent, no API key)
  + `vite dev` in `packages/agent-dashboard` + Playwright/direct browser. See per-slice notes.

## 0. Slice index (dependency order)

| ID | Title | Pkg surface | Depends on |
|----|-------|-------------|------------|
| S1 | Styling foundation: one atom set, one token vocabulary, shared page kit | dashboard | — |
| S2 | Six-theme system + theme picker | dashboard | S1 |
| S3 | Server: direct tool invoke endpoint | server (+runtime primitive, exists) | — |
| S4 | Tool Workbench on /capabilities + family tabs | dashboard | S1, S3 |
| S5 | Server: run history — RunStore wiring + /admin/runs routes | runtime, server, cli | — |
| S6 | Run picker + persisted-run replay on /run | dashboard | S1, S5 |
| S7 | Server: conversation persistence — SQLite ConversationStore + routes (fix phantom endpoints) | runtime, server, cli | — |
| S8 | Agent Console (sessions + trace rail), Agent Lens run lenses, honesty banners, final polish sweep | dashboard | S1, S2, S4, S6, S7 |

S3, S5, S7 are pure backend and can proceed in parallel with S1/S2.

---

## 1. Architecture decisions (locked for this stack)

1. **Endpoint namespace**: new run/conversation read routes live under `/admin/*` (matches
   existing `/admin/events/*`); the tool invoke lives under `/capabilities/:id/tools/:tool/invoke`
   (capability-centric, matching the playground's composition-derived capability registry — NOT
   swe-brain's `/agents/capabilities/:cap/tools/:tool`). The vite dev proxy already forwards
   `/admin`, `/capabilities` is NOT currently proxied — **add `/capabilities` to
   `packages/agent-dashboard/vite.config.ts` proxy list with the `htmlNavBypass`** (it collides
   with the SPA route `/capabilities`, same treatment as `/agents` + `/conversations`).
2. **Blast radius is honest-degraded**: the framework has no per-capability blast-radius
   registration metadata. Port the presentation family (`BlastDot/BlastChip/BLAST_COLOR/BLAST_NOTE`)
   but treat blast as `BlastRadius | undefined`; undefined renders neutral (no dot color claim, no
   "gated" chip, run-tab note "blast radius unknown — framework does not declare one"). The
   dashboard's `graph/types.ts` already has `BlastRadius`; keep the constants tokenized (S2).
   Do NOT invent blast values. (Open question: add optional `blastRadius` metadata to core
   Capability later — out of scope here.)
3. **One event fold**: the playground's `graph/trace-from-events.ts eventsToSteps` is the canonical
   fold (it already implements swe-brain's tricky bits: 1-based iter, provisional thinking step
   finalized in place, dual-casing, emits backfill, terminal-only finish). New surfaces (run replay,
   dev lenses, console trace rail) feed it — never fork it. Persisted rows adapt via a tiny
   `persistedToEventLike` (see §5.4).
4. **Compiled-spec lens is NOT ported**. The playground's `RenderedPromptView` renders the real
   renderer output with provenance — strictly better than swe-brain's "faithful preview"
   `buildPromptLines`. The Dev Surface port = Trace Waterfall + Event Log lenses + honest-sample
   pattern only.
5. **Ask-agent stub in the Workbench is NOT ported as a stub** — the playground has a real chat.
   The Run tab's `Call tool | Ask agent` segmented links "Ask agent" to `/chat` (navigate) instead
   of rendering a dead note.
6. **Persistence = the existing SQLite ladder**. `EvalStore extends RunStore extends EventStore`,
   one file (`AP_DB_PATH` else `~/.local/state/ap/events.db`). Conversations join the ladder as a
   new `ConversationStore` implementation over the same driver (schema `user_version` bump 4→5).
   `AP_PERSISTENCE=0` → all new routes 503 `{error:"persistence not configured", hint}` — reuse the
   existing 503 grammar; the dashboard renders it as the `unconfigured` discriminated state.
7. **Theme ids are playground-neutral**: `blue`, `blue-dark`, `earth`, `earth-dark`,
   `chalky`, `chalkboard`. Stored under the existing `apdash-theme` localStorage key with value
   migration `"dark"→"blue-dark"`, `"light"→"blue"` (see §7.3).

---

## 2. Feature A — Tool Workbench (S3 server + S4 UI)

### 2.1 Source → target file map

| swe-brain source | Target |
|---|---|
| `apps/frontend/src/pages/agents/ToolWorkbenchSurface.tsx` | `packages/agent-dashboard/src/pages/build/CapabilitiesPage.tsx` (extend detail view with a Build/Run tab pair) + new `pages/build/ToolWorkbench.tsx` (the tree + tab body, if CapabilitiesPage gets too large) |
| `apps/frontend/src/components/surfaces/agents/CapabilityToolRunner.tsx` | new `packages/agent-dashboard/src/components/organisms/ToolRunner.tsx` |
| `apps/frontend/src/components/surfaces/agents/bits.tsx` (BlastDot/BlastChip/ReachLegend/CapabilityCard/MissionPill) | new `packages/agent-dashboard/src/components/molecules/blast.tsx` (only Dot/Chip/note needed; port the rest if free) |
| `apps/frontend/src/components/surfaces/agents/family-tabs.tsx` | new `packages/agent-dashboard/src/components/molecules/FamilyTabs.tsx` (React Router `NavLink`s over `/agents`, `/roles`, `/capabilities`; underline-tab styling per §8 kit `Tabs`) |
| `apps/frontend/src/lib/agents/run-tool.ts` | new fn in `packages/agent-dashboard/src/api/composition.ts` → `invokeTool(capabilityId, toolName, args)` |
| `apps/backend/src/modules/agents/agent-run.controller.ts` `executeTool` + `capability-registry.ts` `extractToolParams` | `packages/agent-server/src/routes/composition.ts` (new invoke route) + client-side param flattening in the dashboard (see 2.3) |

### 2.2 New endpoint (S3)

```
POST /capabilities/:id/tools/:toolName/invoke
  Request : { args: Record<string, unknown> }        (Content-Type: application/json)
  200     : { ok: true,  result: unknown, ms: number }        ms = server-side execution time
  200     : { ok: false, error: string,  ms: number }         tool threw OR Zod arg rejection
  404     : { error: string }                                  unknown capability id / tool name (wiring error only)
```

- Resolve the capability exactly as `GET /capabilities/:id` does (same derivation in
  `routes/composition.ts`); check `capability.toolbox.getToolNames().includes(toolName)` → 404.
- Execute via `capability.toolbox.execute(toolName, body.args ?? {})`
  (`packages/agent-core/src/molecules/toolbox.ts:104` — Zod-parses args, throws on invalid).
- ZodError flattening (copy semantics verbatim from swe-brain `formatToolError`):
  `issues.map(i => `${i.path.join(".") || "(arg)"}: ${i.message}`).join("; ")`.
- HTTP 200 for tool failures (uniform envelope); 404 only for unknown cap/tool.
- Optional (recommended): publish `agent.tool.start` / `agent.tool.end` onto `config.eventBus`
  with a synthetic `runId: "workbench:<uuid>"` so invokes appear on `/live` and in the event log.
  Note: this deliberately bypasses gates — playground tools are read/demo-only; document that in
  the route comment (mirrors swe-brain Hard Rule #7 note).
- Alternative shape considered and rejected: `POST /agents/:id/tools/:tool/invoke` via
  `createToolboxExecutor` — capability-scoped matches the Workbench UI and the existing
  `/capabilities/:id` read path.

### 2.3 Schema→form contract (client-side flattening)

swe-brain flattens server-side; the playground already serves full JSON schema per tool at
`GET /capabilities/:id` → `toolbox.tools[{name, description, parameters: <JSON-schema>, returns?}]`.
Flatten in the dashboard (new `lib/toolParams.ts`):

```ts
type ToolParam = { name: string; type: string; required: boolean; description?: string };
// parameters is {type:"object", properties, required?} — fold each property:
//   { name, type: s.type ?? "unknown", required: required.includes(name), description: s.description }
```

Form generation rules (replicate exactly from `CapabilityToolRunner`):
- widget by `type` string: `boolean` → checkbox (real boolean state); `number|integer` →
  `<input type=number>`; `object|array|unknown` → text input placeholder `"JSON"`; else text input
  placeholder = type name. Label grid `minmax(7rem,10rem) 1fr`; mono name, red `*` if required,
  ` · type` muted, description micro underneath. Field id `param-${tool.name}-${p.name}`.
- **coerce**: numeric → `Number(raw)`; JSON-shaped → `try JSON.parse(raw) catch → raw`
  (invalid JSON passes through raw so server Zod produces the error message — this is deliberate,
  it demos validation).
- **omit-empty-optionals**: only filled fields enter `args`. Booleans: untouched checkbox sends
  nothing; once touched, `false` IS sent.
- Result UX: status line `ok|error · {ms}ms` + `· N rows` when result is an array; error → err-soft
  tinted box; success → `<pre>` `JSON.stringify(result, null, 2)`, mono tiny, `maxHeight: 320px`,
  `overflow: auto`, pre-wrap + break-word, `--fill` bg. `setResult(null)` before each run; button
  disabled + `Running…` label while in flight.
- Forward-compat: render a `Returns` section when `returns` schema is present (the playground
  already serves `returns?` — swe-brain only stubbed this; we can do it for real).

### 2.4 Workbench layout (from ToolWorkbenchSurface — replicate)

- Full-height column; `flex:1` row: left `<aside>` fixed `17rem`, `overflowY:auto`,
  `borderRight: 1px solid var(--line)`, `--paper` bg; right section `flex:1; minWidth:0` with fixed
  head + scrollable body; content columns `maxWidth: 46rem`; glyph tile 34px.
- Left tree = **flat always-expanded grouped list** (NOT a collapsible tree). Per capability:
  header row (icon + mono name + chips: `Toolbox`, `Manual` if manual, `N plays` if playbook);
  tool rows = full-width buttons, mono tiny, selected = `--accent-soft` bg + `--accent-ink`.
  (Blast dot/gated chip: only when blast metadata exists — see decision §1.2; today it doesn't,
  so omit.)
- Selection state `{cap, tool}`; deep link `/capabilities/:id` preselects that cap's first tool,
  else first cap with tools. Selecting a tool resets tab→Construction, mode→Call.
- Tabs: `Construction | Run`. Construction = "What it does" blurb + params `DataTable` (Param mono /
  Type mono accent / Req warn-ink vs `optional` muted / Description) + `Try it` primary button →
  Run tab. Run = segmented `Call tool | Ask agent` (Ask navigates to `/chat`), Call renders
  `ToolRunner`.

### 2.5 Browser validation (S4)

`ap playground examples` + vite dev → `/capabilities` → pick the examples capability → Construction
tab shows param table from real JSON schema → Try it → fill a param → Run → `ok · Nms` + JSON
result; enter invalid JSON in an object param → server Zod error string rendered in err box;
leave optional fields empty → tool defaults apply. Verify 404 path by hitting a bogus tool name
via curl. Family tabs navigate between /agents, /roles, /capabilities with active underline.

---

## 3. Feature B — Run history + run picker replay (S5 server + S6 UI)

### 3.1 Server wiring (S5) — routes exist nowhere today; store exists fully

| Change | File |
|---|---|
| Attach `RunStoreExporter` next to `SQLiteExporter` so chat/playground runs land in the `runs` table (today only eval runs do) | `packages/agent-cli/src/commands/playground.ts` (~line 143 where the stack is assembled) |
| Call `store.sweepRunning()` at boot to close orphaned `running` rows | same |
| Add `runStore?: RunStore` to `ServerConfig` (or narrow-cast the existing `eventStore` — the playground already passes an `EvalStore`, which IS a `RunStore`; prefer the explicit config slot) | `packages/agent-server/src/config.ts`, `app.ts` |
| New routes (503 grammar when unconfigured) | new `packages/agent-server/src/routes/runs.ts`, mounted in `app.ts` |

```
GET /admin/runs?limit&status&agent&since   → { runs: RunSummary[] }        (RunStore.listRuns)
GET /admin/runs/:id                        → { run: RunRow }               (RunStore.getRun — id or unique prefix; 404 if none)
GET /admin/runs/:id/events                 → { runId, events: PersistedEvent[] }  (RunStore.runEvents, ASC by seq/id)
```

Runtime shapes (source of truth `packages/agent-runtime/src/storage/run-store.ts` — mirror by hand
into `api/types.ts`, per house rule):
- `RunSummary`: id, agentName, model?, request, runStatus `running|ok|error`, finishReason?,
  iterations?, toolCallsCount?, inputTokens?, outputTokens?, totalMs?, createdAt, updatedAt,
  answerLength, hasPrompt, metadata? (eval runs carry `{evalRunId, caseId, variant, split}`).
- `RunRow` = RunSummary + systemPrompt?, finalAnswer?, stepMetrics?.
- `PersistedEvent`: `{ id, type, timestamp, traceId, runId, spanId, ccSessionId?, ccHookName?, ccCwd?, data }`
  — `data` is the FULL original camelCase `AgentEvent`. **`agent.message.chunk` IS persisted**
  (UX profile), so full transcript playback is possible; the fold ignores chunks for steps.

### 3.2 Dashboard client (S6)

New in `lib/runsApi.ts` (follow `lib/evalApi.ts` grammar — `{kind:"ok"|"unconfigured"|"not-found"}`):
`fetchRuns({limit, agent?, status?})`, `fetchRun(runId)`, `fetchRunEvents(runId)`.

### 3.3 Persisted-row → EventLike adapter (the load-bearing bit)

The canonical fold `graph/trace-from-events.ts eventsToSteps(events, tools, {terminal})` consumes
`EventLike {type, seq?, ...}`. Adapter (put beside the fold):

```ts
// PersistedEvent.data is the full camelCase AgentEvent; the fold's accessor chains
// (promoted → camelCase → snake_case) already tolerate it.
export function persistedToEventLike(row: PersistedEvent, i: number): EventLike {
  return { type: row.type, seq: i + 1, ...(row.data as Record<string, unknown>) };
}
```

Notes carried over from swe-brain's fold contract (already true in the playground fold — verify,
don't re-implement): persisted `type` carries the `agent.` prefix → `bare()` strips it; persisted
`iteration` is 0-based → contract 1-based (+1, increment fallback); replay rows may lack
`llm.start` → the provisional-thinking path falls through to plain push; `message.delta`/`chunk`
never become steps; only the LAST `message.complete` becomes `finish` and only with
`terminal: true`.

### 3.4 RunSurfacePage integration (S6) — third source state

Current: `isLive = streaming || liveEvents.length > 0`; `events = isLive ? liveEvents : SAMPLE_EVENTS`.
Add `replayRun: {run: RunRow, events: EventLike[]} | null`:

```
source precedence: streaming/live > replayRun > demo(SAMPLE_EVENTS)
events   = live ? liveEvents : replayRun ? replayRun.events : SAMPLE_EVENTS
terminal = !streaming
runKey   = live ? `live:${nonce}` : replayRun ? replayRun.run.id : "demo"
request/answer for LiveTracePanel: replayRun → run.request / run.finalAnswer
```

Everything downstream (buildGraph → eventsToSteps → useRunReplay → ConstellationGraph /
LiveTracePanel / NodeInspector) is already source-agnostic — do not touch the engine.
`useRunReplay` reset-on-runKey-only semantics already handle switching.

**RunPickerMenu** (port from swe-brain `LiveRunSurface.tsx` lines 74–163, local component in
RunSurfacePage): dropdown pattern = fixed transparent full-screen backdrop button (z 25) +
absolute right-anchored panel (w 300, maxH 360, z 30, `--shadow-3`). Row line 1:
`id.slice(0,8) · {iterations}t · {model} · relTime(createdAt)`; line 2 ellipsized `request`.
Topbar shows `MAX_RUN_CHIPS = 2` newest-first inline chips with the selected run force-kept
visible; menu only when overflow. `relTime` comes from the shared kit (§8), not a local copy.
After a live run finishes: refetch the runs list (plain refetch — no query lib here) so the new
run appears; do NOT auto-switch into replay (would reset the cursor and re-dim the finished
constellation — swe-brain-tested behavior).

Picking a run: abort any stream, clear live state, `fetchRunEvents` → `persistedToEventLike` →
set `replayRun`, engine idles at cursor −1 → user presses Play (existing demo controls apply to
replay too).

### 3.5 Browser validation (S6)

`ap playground examples` + vite dev → `/run` → send a message to the pipeline2 agent (no key
needed) → run completes → run picker chip appears with the new run id → click it → constellation
resets to idle → Play → steps replay through the same graph/waterfall at 1100ms/step → seek via
trace rows → request/answer bubbles render from the persisted row. Restart the server → the run
still lists (SQLite). With `AP_PERSISTENCE=0` → picker area renders the unconfigured state, live +
demo modes unaffected.

---

## 4. Feature C — Conversation persistence + Agent Console (S7 server + S8 UI)

### 4.1 The phantom-endpoint fix (S7)

The dashboard already ships pages calling four routes that don't exist. Implement them; the
existing `ConversationsPage` + `ConversationDetailPage` come alive with zero UI work, and the
Console session replay builds on the same rows.

| Change | File |
|---|---|
| `SQLiteConversationStore` implementing the existing `ConversationStore` protocol (`StoredConversation`, `StoredMessage {kind:"request"\|"response", runId?, tokens, parts}`, `StoredMessagePart {type, content?, metadata}`) over the shared driver; schema `user_version` 4→5: `conversations`, `conversation_messages`, `conversation_message_parts` (with an explicit `position` int — the dashboard sorts parts by `position`, which the in-memory protocol lacks; add it to the protocol as optional) | new `packages/agent-runtime/src/storage/conversation-store.ts` (+ protocol touch-up in `conversation/store.ts`) |
| Pass the store: `new Conversation(agent, runner, { toolExecutor, store: config.store })` — `ServerConfig.store` is accepted today and never used | `packages/agent-server/src/routes/conversations.ts:40` |
| Populate `StoredMessage.runId` in `Conversation._persistExchange` (designed link, never written) | `packages/agent-runtime/src/conversation/conversation.ts` |
| **traceId threading fix**: `Conversation.stream` publishes `agent.conversation.*` with `traceId = invocationId` but never passes it to the runner → run events don't join. One-liner: pass `traceId` in runner options (`RunOptions.traceId` exists, `runner/types.ts:123`) | `packages/agent-runtime/src/conversation/conversation.ts:199-215` |
| Wire the store in the playground command | `packages/agent-cli/src/commands/playground.ts` |
| New read routes | new/extended `packages/agent-server/src/routes/conversations.ts` |

```
GET /admin/conversations                → ConversationSummary[]   (store.listConversations; falls back to adminService.getConversations() when no store — mark source in payload? No: 503 grammar when unpersisted, admin fallback dropped for honesty)
GET /conversations/:id                  → ConversationDetail
GET /conversations/:id/messages         → ConversationMessage[]   (ASC by createdAt/sequence)
GET /messages/:id/parts                 → ConversationMessagePart[] (ASC by position)
```

Response fields must match the dashboard's existing hand-mirrored types in `api/types.ts`
(`ConversationSummary {conversationId, agentName, messageCount, tokenCount, startedAt,
lastMessageAt?, status}`, `ConversationDetail`, `ConversationMessage {kind, runId, ...}`,
`ConversationMessagePart {..., position}`) — the types are the contract; shape the SQL reads to
them, not vice versa.

### 4.2 Console UI (S8) — ChatPage upgrade

swe-brain source: `pages/agents/AgentConsoleSurface.tsx` (SessionsMenu, TraceRow, split-pane).
Target: `packages/agent-dashboard/src/pages/ChatPage.tsx` + `chat/*`. The playground chat is
strictly richer (parts model with `agent_step` nesting, CaptureCasePanel) — port ONLY the two
missing capabilities:

1. **SessionsMenu** — `Sessions (N) ▾` ghost button in the ChatPage header; dropdown (same
   backdrop/panel pattern as RunPickerMenu — extract one `DropdownMenu` molecule in the kit, §8)
   listing `GET /admin/conversations` (filtered to the selected agent). Row: title/first-request
   ellipsis, `exchangeCount` chip, status, relTime.
2. **Session replay mode** — picking a session sets `viewingId`; fetch
   `/conversations/:id/messages` + per-message `/messages/:id/parts` (accept the N+1 for now —
   ConversationDetailPage already does; batching is a later server nicety). Map stored parts →
   the existing `Part` union (`user_prompt|text` → text, `tool_call`/`tool_result` pair →
   `tool_call` part fill, `agent_step` metadata → agent_step) → `ChatMessage[]` → render through
   the existing `ChatPanel` with `onSend` omitted (read-only composer-less mode — ChatPanel
   already supports this). "New chat" clears back to live mode. Input disabled while viewing.
3. **Trace rail** — right-side rail (collapsible, like the existing AgentUniverse tab) showing the
   current/selected turn's run trace: `StoredMessage.runId` → `GET /admin/runs/:runId/events` →
   `persistedToEventLike` → `eventsToSteps` → render with the TraceWaterfall organism (§5). Live
   turns: feed the same organism from the live `WireFrame`s via `toEventLike` (normalize with a
   monotonic seq, swe-brain pattern `{runId:"live", seq:++n, type: ev.name, ...}`); it works
   because the fold is dual-casing tolerant. Falls back to the existing raw `EventStream` list if
   waterfall feels heavy for v1 — but waterfall is the target.

### 4.3 Browser validation (S7 via existing pages, S8 for console)

S7: `ap playground examples` → chat a turn on `/chat` → visit `/conversations` (previously a
permanent error state) → the conversation lists → detail page shows messages + parts → restart
server → still there. S8: on `/chat`, Sessions menu lists prior sessions; picking one renders the
transcript read-only with the trace rail showing that turn's waterfall; New chat returns to live;
sending a live message streams normally with the rail updating; abort mid-stream marks the bubble
aborted (regression check).

---

## 5. Feature D — Agent Dev lenses on the Agent Lens page (S8)

swe-brain source: `pages/agents/AgentDevSurface.tsx` (1237 loc — TraceWaterfall, TraceLog,
DevRunBar, DevTabs, DevPanel, DevJson, SampleBanner are module-private) +
`lib/agents/sample-run-trace.ts`.
Target: `packages/agent-dashboard/src/pages/build/AgentLensPage.tsx` grows a lens switcher
(existing declared/delivered chips stay; add `Runs` lens area) OR a sub-tab row. Port:

| swe-brain piece | Target | Notes |
|---|---|---|
| `TraceWaterfall` | new `components/organisms/TraceWaterfall.tsx` | shared with the Console trace rail (§4.2) |
| `TraceLog` | new `components/organisms/TraceLog.tsx` | |
| `DevRunBar` | inline in AgentLensPage runs lens | runId · request · 6-stat strip; `sample` warn chip |
| `SampleBanner` | the standard honesty banner (§6) | |
| `SAMPLE_RUN_TRACE` | NOT ported — the playground's `graph/sample-run-trace.ts` SAMPLE_EVENTS fed through the real fold is the fixture (exercises the true code path) | |
| `ToolCatalog` lens | NOT ported — `/capabilities` + SlotStack already cover it | |
| `CompiledSpec` lens | NOT ported — decision §1.4 | |

Data: `fetchRuns({agent: name, limit: 10})` → latest run's events → fold → trace. No run rows →
render the sample trace + honesty banner ("No persisted runs for this agent yet — this trace is
the demo fixture, not a live run."). Unconfigured persistence → unconfigured card.

### 5.1 TraceWaterfall rendering math (replicate exactly)

- Row grid `30px 150px 1fr 116px` (glyph tile + zero-padded seq · name + KIND label · description +
  duration bar + expandable JSON · right-aligned ms + tokens).
- Iteration grouping is a render-time fold: `let lastIter: number | null = null`; header row when
  `step.iter !== lastIter` (`iter 0` → "setup", else `iteration N`); dashed borderTop except seq 1.
- Bar: `const maxMs = Math.max(...steps.map(s => s.ms)) || 1;` width
  `` `${Math.max(3, (step.ms / maxMs) * 100)}%` `` — 7px track, 4px radius, `--fill` bg. Fill by
  kind: model → `color-mix(in oklch, var(--accent) 55%, var(--paper))`, tool_result → a token
  (add `--category-*` in S2; do not hard-code `oklch(0.7 0.05 255)`), else `--mute`.
- Expand state `useState<Set<number>>` keyed by `seq`; row clickable only when
  `args !== undefined || output !== undefined`; inner `▸ args`/`▸ result (N rows)` button
  stopPropagation-toggles the same seq; expanded body = pretty JSON of `args ?? output`
  (**args wins**).
- Tiles per kind: glyphs `⚙ ◆ → ← ✓`, labels `CTX LLM CALL RES END`; model accent-tinted, finish
  ok-tinted, context fill/mute, tool rows paper.
- Right column: `ms === 0 → "—"`; token line only when `outTokens != null`:
  optional `` `${ctxTokens.toLocaleString()} ctx · ` `` + `{outTokens} out`.

### 5.2 TraceLog row model (replicate exactly)

Cumulative offset fold during render: `let acc = 0; ... const at = acc; acc += step.ms;` →
`` `+${(at/1000).toFixed(2)}s` ``. Grid `56px 36px 1fr auto`. Mono, lineHeight 1.85, 9.5px
uppercase tinted kind badge. Message templates: tool_call → `→ call <b>{tool}</b> {compact args}`
(single-line JSON); tool_result → `← <b>{tool}</b> returned {note} · {status}`; model →
`<b>{label}</b> · {ctx} ctx → {out} out` + `· emits a, b`; default → `label · detail`.

### 5.3 Browser validation (S8)

`/agents/:id` → Runs lens → with no persisted runs: sample banner + fixture trace; run the agent
once via `/chat` or `/run` → revisit → real latest run renders (banner gone), waterfall bars
proportional, iteration headers group, expand args/result JSON, log lens offsets accumulate.

---

## 6. Honest-degradation pattern (standardize in S8, use everywhere from S4 on)

The five mechanisms (from swe-brain, adopted board-wide):
1. **Fixture-until-live** with a warn banner naming the fixture ("This trace is a fixture, not a
   live run") + a `sample` warn chip on data bars. Banner component: new
   `components/molecules/HonestyBanner.tsx {children}` (warn-soft band, warn-ink text).
2. **Fallback-and-say-so**: when an endpoint degrades (e.g. capabilities without param schemas),
   render the degraded data AND a provenance line stating the source + what's missing.
3. **Unknown never drops**: unknown names degrade to a neutral rendering, never disappear.
4. **Disabled-with-reason**: disabled buttons carry `title` explaining the pending slice.
5. **Overlay honesty**: client-side overlays (blast, capability tags) are documented as overlays,
   not framework data.
Plus the house 503 rule: persistence-off is a rendered `unconfigured` state, never an error toast.

---

## 7. Board-wide styling level-up

### 7.1 Atom unification (S1) — kill set A by rewriting it in place

Keep import paths stable (30 importers of `components/atoms/*`). Rewrite each legacy atom on
cockpit tokens; fold `ui/atoms.tsx` and `components/atoms/*` into ONE set — **home =
`components/atoms/` (barrel), `ui/atoms.tsx` becomes re-exports during transition**, deleted in S8.

Tone migration (legacy Badge/Chip → cockpit `Tone = ok|err|warn|accent|mute|run`):

| Legacy | Cockpit |
|---|---|
| `green`, `emerald` | `ok` |
| `red` | `err` |
| `yellow` | `warn` |
| `purple` | `violet` (add `--violet-soft/-ink` derivations; exists as `--violet` already) |
| `accent` | `accent` |
| `neutral`, `muted` | `mute` |

Keep the legacy tone names accepted as deprecated aliases inside Badge for one slice (internal
map), then sweep call sites in S8.

Hard-coded color kill list (S1):

| Offender | Fix |
|---|---|
| `#0d1117` text (Badge filled, legacy Button primary, ConfirmModal destructive) | `--paper` on solid fills, or switch to soft-tint style: `--accent-soft` bg + `--accent-ink` text |
| 5× rgba tints in Badge | `--{tone}-soft` bg + `--{tone}-ink` text |
| `#fff` in ThemeToggle active | `--paper` |
| Modal backdrop `rgba(0,0,0,.5)` + shadow | `color-mix(in oklch, var(--ink) 45%, transparent)` + `--shadow-3` |
| `rgba(248,81,73,0.08)` error tints (DashboardPage, ConversationDetailPage) | `--err-soft` |
| `graph/catalog.ts BLAST_COLOR` raw oklch + `ConstellationNode` blast dot | new tokens `--blast-read/--blast-write/--blast-external` (or `--category-*` slots, §7.3) |
| eval meters `--green` fills, `#e5484d` in ported code | `--ok` / `--err` |
| `chat/chat.css .md-table` legacy vars | cockpit vars |
| `RunSurfacePage` stray `var(--red)` | `var(--err)` |
| `AgentsRosterPage` undefined `var(--bg-subtle, transparent)` | `--fill` |

Hover/focus discipline (S1, the structural fix): atoms move their interactive styling from inline
objects to a small `styles/atoms.css` (classes) so `:hover`/`:focus-visible` exist. Adopt
swe-brain's global policy in `styles/globals.css`: `:where(button,a,select,[role="button"],
[tabindex]):focus-visible { outline: 2px solid hsl(var(--focus-ring)); outline-offset: 2px }`;
text inputs no ring; `tr[tabindex]:hover { background: hsl(var(--hover-bg)) }` +
`tr[tabindex]:focus-visible` bg tint — then DELETE DataTable/EventStream's JS onMouseEnter hover
mutation and add `tabIndex` rows. Also: `font-feature-settings: "cv11","ss01","tnum"` on body.

Deletions (S1): `pages/AgentsPage.tsx` (orphan), `react-markdown` + `remark-gfm` deps (unused),
`T.statusVar` (dead accessor; or define the vars — decision: delete, the playground has no
job-status domain).

### 7.2 Shared page kit (S1) — new `components/kit/` (molecules)

Extract once, delete ~600 duplicated lines:

| Kit piece | Replaces |
|---|---|
| `relTime(when)` in `lib/format.ts` | `relative()` ×5 + `chat/atoms` variant ×1 |
| `shortId`, `formatDuration` in `lib/format.ts` | scattered locals |
| `JsonBlock {value, maxHeight?}` | `preStyle` ×4 |
| `ActualAnswer` → `components/kit/AnswerPanel.tsx` | ×3 copies |
| `PageHeader {title, badges?, actions?}` | per-page `<h1>` blocks ×~12 |
| `SectionHeading {eyebrow, blurb?, rollup?}` (swe-brain SectionHeader idiom: uppercase tiny eyebrow, 0.08em tracking, border-bottom, right mono rollup) | `sectionHeadingStyle` ×3 |
| `AsyncState` wrapper rendering loading / unconfigured ("Eval persistence is not configured… `AP_PERSISTENCE != 0`") / not-found / error / empty | 5-state JSX in every eval page (unconfigured card ×6, error card ×7, spinner block ×10) |
| `Segmented {options, value, onChange, size?, variant?: track\|subtle}` (port swe-brain atom) | 4 hand-rolled segmented controls (TokensPage toggle, RunSurfacePage ModeToggle, AgentLensPage ModeChip, NodeInspector tabs) |
| `Field {label, children}` (one) | 6 labeled-uppercase-field variants |
| `Stat {label, value, sublabel?, tone?}` (merge with StatCard) | EvalRunDetail/Compare `Stat` + `StatCard` |
| `useSortedRows(rows, defaultKey)` hook | sort-state triple ×5 |
| `DropdownMenu {trigger, children}` (backdrop z25 + panel z30 pattern) | SessionsMenu (S8) + RunPickerMenu (S6) |
| `statusTone(status): Tone` (one, returning cockpit tones) | 5 incompatible copies |

Typography sweep rule (applied per file as touched, completed in S8): raw px → `--fz-*`; raw
radii 5/6/8/10 → `--radius-*`; raw gaps → `--space-*`.

### 7.3 Six-theme system (S2)

Split `styles/theme.css` (213 lines) into:
- `styles/tokens-base.css` — primitives (fonts/radius/spacing/type ramp/motion/density) +
  color-mix derivation layer + alias bridge (bridge deleted in S8 once
  `grep -rn "\-\-bg-\|\-\-fg-\|var(--green)\|var(--red)\|var(--yellow)\|var(--purple)\|accent-emerald" src/` is clean).
- Six `styles/theme-<id>.css` files, each ONE `:root[data-theme="<id>"]` block.

Per-theme contract (~22 declarations — the whole per-theme surface; everything else derives):
`--background --foreground --card --secondary --accent --muted --muted-foreground --border
--destructive --status-completed --warn --hover-bg --row-selected-bg --focus-ring (hsl TRIPLES —
`T.state` wraps in hsl(); keep triples in every theme or migrate T.state first — decision: keep
triples) --shadow-1 --shadow-2 --shadow-3 --chalk-inset` + `color-scheme: light|dark` + new
category slots `--category-1..4` (used by: blast tokens, waterfall tool_result bar, EventStream
badge accents).

Theme sources (swe-brain `apps/frontend/src/styles/theme-*.css` — port palette values, translate
hsl-triple vocabulary → the dashboard's full-color base where they differ):

| Target id | swe-brain source file | Family |
|---|---|---|
| `blue` | `theme-swe-brain-blue.css` | cool light — current dashboard light block is already ~this; reconcile |
| `blue-dark` | `theme-swe-brain-blue-dark.css` | cool dark (DEFAULT) — current dark block |
| `earth` | `theme-swe-brain.css` | warm light |
| `earth-dark` | `theme-swe-brain-dark.css` | warm dark |
| `chalky` | `theme-chalky-primary.css` | blueberry light |
| `chalkboard` | `theme-chalkboard.css` | slate-teal dark |

Mix-space gotchas to carry: `--err-soft` mixes in **srgb** (oklch arc drifts purple); blue-dark
keeps amber warn (`--warn` stays amber even in cool themes — canonical-amber decision).

Mode resolution (kill the duplicated dark `@media` block): drop `system` from CSS entirely —
`ui/theme-mode.ts` generalizes to `{family: "blue"|"earth"|"chalk", mode: "system"|"light"|"dark"}`
with `lightFor/darkFor` maps (`chalk` light=`chalky`, dark=`chalkboard`); the before-paint script
in `index.html` + a `matchMedia("(prefers-color-scheme: dark)")` listener always stamp a CONCRETE
`data-theme`. Persist under `apdash-theme` (versioned JSON value; migrate legacy strings
`"dark"→{family:"blue",mode:"dark"}`, `"light"→…"light"`, `"system"→…"system"`). Update
`main.tsx applyMode` accordingly. Artifact-style `?theme=` query override (applied, never
persisted) — port from swe-brain `lib/theme.ts`, useful for capture tooling.

`ThemeToggle` → theme picker: family select (3) × mode segmented (system/light/dark); keep
`aria-pressed` + keyboard semantics.

Validation (S2): flip through all six themes on `/`, `/run` (constellation re-tones — nodes,
edges, blast dots), `/chat`, `/eval` (meters/badges re-tone), light+dark each; before-paint =
no flash on reload with a non-default theme; system mode follows OS toggle live.

### 7.4 Per-page styling-debt checklist (worked through S1 kit adoption → finished in S8 sweep)

| Page | Debt to clear |
|---|---|
| `AppShell.tsx` | legacy vars → cockpit; hover state on inactive NavLinks; px 15/11/14 → ramp; ThemeToggle `#fff` |
| `DashboardPage` | rgba error tint → `--err-soft`; PageHeader; AsyncState; StatCard→kit Stat |
| `ToolsPage` | useSortedRows; meter fills → `--accent`/token; healthTone → statusTone(kit) |
| `TokensPage` | segmented toggle → kit Segmented; Badge filled `#0d1117` case gone via atom rewrite |
| `LivePage` | connection-badge idiom → kit (shared with ClaudeCodePage); PageHeader |
| `ClaudeCodePage` | same as LivePage |
| `ConversationsPage` | relTime/shortId → kit; useSortedRows; (S7 makes it live) |
| `ConversationDetailPage` | preStyle → JsonBlock; rgba tint → `--err-soft`; part rendering stays |
| `ChatPage` | header chrome → cockpit atoms; input styles → kit `inputStyle`; height math `calc(100vh - 48px)` documented against AppShell padding; collapse-tab button → kit |
| `RunSurfacePage` | `var(--red)` → `--err`; ModeToggle → kit Segmented; reuse kit inputStyle |
| `pages/build/AgentsRosterPage` | `--bg-subtle` → `--fill`; card hover via CSS; disclosure button → kit |
| `pages/build/AgentLensPage` | ModeChip → kit Segmented; DataBlock → JsonBlock |
| `pages/build/RolesPage` | InstantiationMatrix hand-rolled table → DataTable; link styles |
| `pages/build/CapabilitiesPage` | (S4 rework) tokens sweep rides along |
| `pages/eval/*` (8 files) | AsyncState everywhere; relTime/preStyle/ActualAnswer/Stat/statusTone → kit; FilterSelect → kit Field+select; RunLauncher header-push layout fix; ConfirmModal destructive colors via atom rewrite |
| `components/organisms/DataTable` | JS hover → CSS `tr[tabindex]`; header cursor only when sortable; keyboard focus visual |
| `components/organisms/EventStream` | JS hover → CSS; TYPE_TONES → cockpit tones/category tokens |
| `components/organisms/SessionCard` | tone maps → cockpit |
| `styles/theme.css` | split per §7.3; alias bridge deleted in S8 |

---

## 8. Persisted-row vs live-event shapes (single reference table)

| Aspect | Live SSE (`WireFrame` via `toEventLike`) | Persisted (`PersistedEvent` via `persistedToEventLike`) |
|---|---|---|
| Type name | bare (`tool.start`) | `agent.`-prefixed (`agent.tool.start`) — fold's `bare()` strips |
| Payload casing | snake_case (`tool_name`, `duration_ms`) | camelCase (full `AgentEvent` in `data`: `toolName`, `durationMs`) |
| Ordering | arrival order; assign monotonic `seq` client-side | `id`/insert order; assign `seq = i + 1` in adapter |
| `iteration` | 0-based | 0-based (same runtime event) — fold +1s both |
| `message.chunk`/`delta` | drives chat bubble only, never a step | persisted (UX profile) but skipped by fold |
| `llm.start` | present → provisional thinking step | present (SQLiteExporter UX profile persists it) → same path |
| finish | only on `done` + `terminal:true` refold | last `message.complete`, `terminal:true` |
| Answer source | accumulate deltas, `message.complete` replaces whole | `RunRow.finalAnswer` (RunStoreExporter writes it); conversations: assistant `StoredMessage.content` |
| Eval SSE | separate 4-event vocabulary (`run.snapshot`/`case.result`/`run.finished`/`done`) — unchanged | eval runs also write `runs` rows with `metadata.{evalRunId,caseId}` |

The three SSE consumers stay distinct (house rule): permissive POST-stream parser (chat — never
name-filter), named-listener EventSource (event log — enumerated `NAMED_EVENTS`), eval run stream.

---

## 9. What is deliberately NOT ported

- Agent Composer / authoring UI (excluded by decree).
- swe-brain's `CompiledSpec` lens + `buildPromptLines` (playground's real renderer wins).
- swe-brain's generated store / TanStack-style collections (`store.*.useData()`), `authedFetch`
  (playground has no auth), `API_BASE_URL` derivation (dev proxy owns the origin),
  hand-rolled router / nav-model (React Router 7), `capByName` hardcoded catalog overlay
  (payload-wins only; unknown → honest neutral), `RunTraceCollector` backend fold (the playground
  folds client-side from events — one fold, §1.3), swe-brain's blocking `POST /agents/:name/run`
  (playground streams; blocking run not needed by any ported surface).
- swe-brain "Ask agent" stub (replaced by navigation to real chat).
- Six-theme Google-Fonts `<link>` set — keep the dashboard's current font loading; add fonts only
  if a theme genuinely needs one (chalk themes use Kalam for `--font-hand`; ship it as a
  self-hosted woff2 or drop hand-font styling to the sans stack — decision at S2 time, note in PR).

## 10. Open questions (carried into slices as flagged decisions)

1. Optional `blastRadius` metadata on core `Capability` (would make blast presentation real
   framework data) — core change, separate track; UI ships blast-optional (§1.2).
2. Batch endpoint `GET /conversations/:id/full` to kill the parts N+1 — nice-to-have after S7.
3. `--category-1..4` slot semantics (brand/flow/emit/generate vs blast trio) — settle in S2 PR.
4. Whether workbench invokes should emit bus events by default (visibility vs noise on /live) —
   default ON with `?silent=1` escape hatch, revisit after S4.
