# React Chat Frontend — Feature Inventory (packages/agent-dashboard)

Slice report for the web-chat vs terminal-chat parity gap analysis. All paths are relative to
`packages/agent-dashboard/`. Line anchors refer to the current worktree state
(branch `main`, worktree `atomic-soaring-taco`).

The chat surface is the **Agent Console** at route `/chat/:agentId` (`src/App.tsx:40-41`,
`ChatRoute` at `src/App.tsx:69-78`). It is composed of: a header toolbar (agent picker, sessions
menu, scope editor/chip, copy/export, capture-as-eval-case, run settings), a streaming message
column (`ChatPanel`), and a right-hand collapsible `ConsoleRail` with three tabs — **Tools**,
**Trace**, **Scratchpad**. The page is 1,765 lines (`src/pages/ChatPage.tsx`); the `src/chat/`
organism directory is ~4,300 lines of source + ~3,400 lines of tests.

---

## 1. Top-level architecture

```
ChatRoute (App.tsx)  — URL owns agent selection (/chat/:agentId, deep-linkable)
  └─ ChatPage (pages/ChatPage.tsx)
       ├─ Header: AgentPickerMenu · SessionsMenu · New Chat · ScopeChip ·
       │          exchange/streaming badges · RunSettingsMenu(⚙) ·
       │          CopyChatMenu · CaptureCasePanel · ScopeContextPanel
       ├─ ChatPanel (chat/ChatPanel.tsx) — message column + composer
       │    └─ MessageRow → coalesceStateParts → PartView (chat/parts.tsx)
       └─ ConsoleRail (components/ConsoleRail.tsx) — tab shell
            ├─ ToolsRail       (components/ToolsRail.tsx)
            ├─ TraceRail       (components/TraceRail.tsx)
            └─ ScratchpadRail  (chat/ScratchpadRail.tsx)

State driver: useChat (chat/useChat.ts) — conversation lifecycle + SSE fold
Transport:    chat-client.ts (fetch-based SSE over POST) → event-adapter.ts → applyParts (chat/model.ts)
```

Two render sources feed the SAME `ChatPanel`/`PartView` stack:
- **Live**: SSE frames folded incrementally by `applyParts` (`chat/model.ts:345`).
- **Replay**: stored conversation messages + parts mapped by `storedMessagesToChat`
  (`chat/stored-parts.ts:167`), rendered read-only (`onSend` omitted).

---

## 2. Wire / transport contracts

### 2.1 HTTP endpoints the chat surface calls

| Endpoint | Method | Used by | Notes |
|---|---|---|---|
| `/agents` | GET | `listAgents` (`api/chat-client.ts:60`) | Roster: `{id, name, description, instantiation?}`. `instantiation = {available, defaults, schema?, presets?}` powers the scope editor (`chat-client.ts:29-41`). |
| `/agents/:id/capabilities` | GET | `fetchAgentCapabilities` (`chat-client.ts:91`) | Tools rail: `{capabilities: [{name, description?, toolbox?, tools:[{name, description, parameters?}], plays[]}]}`. |
| `/conversations` | POST | `createConversation` (`chat-client.ts:186`) | Body `{agent_id, context?}` — scope is posted under the legacy `context` key deliberately (pre-#308 servers ignore an unknown `scope` key; comment at `chat-client.ts:169-185`). Response `{id, agent_id, context?, context_redacted?}`. 400 with `issues[]` → typed `ScopeValidationError` (`chat-client.ts:160`) for per-field form mapping. |
| `/conversations/:id/messages` | POST (SSE response) | `streamMessage` (`chat-client.ts:223`) | Body `{content, maxIterations?}`. Response is a hand-parsed SSE stream (see 2.2). |
| `/conversations/:id/input` | POST | `sendInputResponse` (`chat-client.ts:124`) | Human-in-the-loop return leg: `{correlation_id, decision: "approve"|"deny", value?}`. |
| `/admin/conversations` | GET (polled 5s) | `useAdminData` (`hooks/useAdminData.ts:10`) from `ChatPage.tsx:309` | Sessions menu. No per-agent query param — filtered/sorted client-side (`lib/sessions.ts:14`, by `agentName`, newest-first). |
| `/conversations/:id/messages` | GET | `pickSession` (`ChatPage.tsx:461`) | Session replay message list. |
| `/messages/:id/parts` | GET | `pickSession` (`ChatPage.tsx:471-477`) | **N+1**: one fetch per message; acknowledged as accepted debt ("batching is a later server nicety, port-map §10.2", `ChatPage.tsx:459-460`). |
| `/admin/runs/:id/events` | GET | `fetchRunEvents` (`lib/runsApi.ts:79`) | Trace + Scratchpad rails in replay mode. 503 → typed `unconfigured`, 404 → `not-found` (honest degradation states). |
| `/eval/sets` | GET | `fetchEvalSets` (capture panel, `chat/CaptureCasePanel.tsx:131`) | 503 → "Eval persistence isn't configured". |
| `/eval/cases/from-session` | POST | `captureFromSession` (`lib/evalApi.ts:341`) | Body `{conversationId, setId, exchange?, expected?, split?, tags?, caseId?, createSet?}`; response `{setId, caseId, created, input, expected, tags, split}`. |

All fetches are plain relative-path `fetch` (Vite dev proxy / same-origin `ap playground` server).
There is no auth layer anywhere in the chat client.

### 2.2 SSE streaming protocol

- **Transport**: EventSource cannot be used (message endpoint is POST) — `streamMessage` reads
  `res.body` through `TextDecoderStream` and hand-parses `event: X\ndata: {json}\n\n` frames,
  handling both `\n\n` and `\r\n\r\n` boundaries (`chat-client.ts:244-316`).
- **No name allowlist** (load-bearing design decision): the parser drops only malformed frames,
  never by event name; the reducer decides what renders. An earlier allowlist silently ate
  `agent.step.*` events (`chat-client.ts:302-304`, `api/sse-events.ts:185-197` `WireFrame`).
- **Generator terminates on the `done` frame** (`chat-client.ts:261`); `done.run_id` is captured
  as `lastRunId` for the trace rail's "Full ↗" deep link (`chat/useChat.ts:163-165`).
- **Adapter**: `toEventLike` (`api/event-adapter.ts:36`) flattens `{name, data}` →
  `{type, ...snake_case_payload}` — the ONE seam between wire and folds.

### 2.3 SSE event vocabulary (typed doc, `api/sse-events.ts:11-181`)

`conversation.start/end`, `message.start`, `message.delta {delta, chunk_index}`,
`message.complete {content, input_tokens, output_tokens, model}`, `message.cancel`,
`input.request {correlation_id, kind: approval|select|text, prompt, options?, tool_name?, arguments?}`,
`thinking.start`, `thinking {content}`, `thinking.complete {content}`,
`tool.intent`, `tool.start {tool_call_id, tool_name, arguments}`,
`tool.progress {progress, status_text?}` (typed but **not rendered** — no reducer case),
`tool.end {result, duration_ms, error?}`, `tool.rejected {tool_name, reason, gate_name}`,
`step.start`/`step.end {span_id, parent_span_id?, step_name, agent_name?, arguments, result, duration_ms, error?}`,
7 state-delta events (`backpack.drop|read|absorb`, `scratchpad.write|read|fork|join` — full
snake_case payloads at `sse-events.ts:93-176`), `error {error_type, message, recoverable}`, `done`.

The reducer (`applyParts`, `chat/model.ts:345-544`) additionally aliases `message.chunk`
(cockpit lineage), `reasoning`/`reasoning.complete`, `llm.end`, and strips `agent.`/`pattern.`
prefixes (`bare()`, `model.ts:107`). Unknown types are silently ignored (default case).

---

## 3. Feature inventory (user-facing)

### 3.1 Agent picker & routing
- **Agent picker dropdown** (`AgentPickerMenu`, `ChatPage.tsx:925-1014`): kit `DropdownMenu` with
  `menuitemradio` semantics, checkmark on active, disabled/empty states. Never a native `<select>`
  (project rule "playground-menus LD4").
- **Deep-linkable per-agent URLs**: `/chat/:agentId`; bare `/chat` redirects (replace) to the first
  agent (`ChatPage.tsx:519-526`). Legacy prop-less mode (tests) auto-picks first agent
  (`ChatPage.tsx:332`).
- **Agent switch resets the thread** via `useLayoutEffect` before paint so the new agent's header
  never renders over the old thread for a frame (`ChatPage.tsx:536-543`).
- Data: `GET /agents`.

### 3.2 Conversation lifecycle & streaming (useChat, `chat/useChat.ts`)
- Conversation created lazily on **first send**; id reused for follow-ups (server-side threading).
- **Double-create race guard**: same-frame duplicate `send()` calls join one in-flight
  `createConversation` promise via `creatingRef` (`useChat.ts:97-105, 144-159`).
- Each send appends a user message + a placeholder streaming assistant message, then folds each SSE
  frame into that message's parts via `applyParts` (`useChat.ts:119-190`).
- **Per-turn abort**: `AbortController` per send; Stop button and Escape key
  (`ChatComposer.tsx:44-47`); AbortError marks the message `aborted` (not errored)
  (`useChat.ts:174-177`).
- **Error split**: transport failures → flat `error` string rendered as "Stream error: …" in the
  header (`ChatPage.tsx:911-913`); scope 400s → `scopeIssues[]` mapped onto typed form rows.
- **Per-message settings**: `maxIterations` (tool-loop cap, 1–50, default 10) set in the ⚙
  RunSettingsMenu (`ChatPage.tsx:1143-1223`), sent on every message.
- Exposes `traceEvents` (raw EventLike stream for the current turn, reset per send) and
  `lastRunId` (from `done.run_id`) for the rails (`useChat.ts:77-84`).
- **No conversation resume**: a live thread cannot be continued after reload; replayed sessions are
  strictly read-only. `reset()` clears everything (`useChat.ts:202-215`).

### 3.3 Message rendering (Part union, `chat/model.ts:28-75` + `chat/parts.tsx`)
One discriminated `Part` union; one dispatcher (`PartView`, `parts.tsx:901-928`):
- **text** — user: plain pre-wrap; assistant: markdown via the dependency-free `md()` renderer
  (`components/kit/Markdown.tsx`, `lib/markdown.ts` — headings, bold/italic, code fences, lists,
  blockquotes, links, tables), plus `[#N]` **citation-chip linkification** (`parts.tsx:49-62`).
- **thinking** — collapsible `<details>` "Thinking…/Thought" with one-line preview; empty completed
  thinking renders an honest non-interactive "reasoned privately" chip (`parts.tsx:181-206`).
  Streamed deltas accumulate; `thinking.complete` closes it.
- **tool_call** — collapsible card: status glyph (✓/✗/⋯/⊘), name, duration; expandable input/output
  JSON `CodeBlock`s with copy chips; error opens by default; `tool.rejected` renders a ⊘ rejected
  state (`parts.tsx:209-245`; reducer cases `model.ts:428-481` incl. tool.intent/start dedupe).
- **agent_step** (delegation) — a pipeline stage run by a sub-agent, ◆ card with "agent · name"
  label; **child tool calls nest under their step** via `parent_span_id` (`childTarget`,
  `model.ts:143-162`; renderer `parts.tsx:248-300`). Open while running.
- **input_request** (human-in-the-loop) — inline blocking card with three kinds: approval
  (Approve/Deny), select (option buttons + Cancel), text (input + Send). Answer POSTs via the
  `InputResponderContext` seam (`chat/input-responder.ts`, `parts.tsx:303-407`); deduped by
  `correlation_id` (`model.ts:485-507`); renders inert "Awaiting a decision (read-only view)" on
  replay.
- **state_delta** (#226 state-viz) — one Δ/◇/⇄ frame per Backpack/Scratchpad mutation with 7 ops
  (drop, absorb, read, write, travel, fork, join), each with its own renderer
  (`parts.tsx:409-818`): diff-style row previews with `[#N]` handles, before/after panes for
  writes, "innate/auto" chips for framework-initiated writes, redaction notice for
  never-persisted injected prompt text (`parts.tsx:651-656`). Frames **nest under the causing
  tool call** by `tool_call_id` (`insertStateDelta`, `model.ts:197-224`).
- **travel frames are UI-derived** (no runtime emitter): at each top-level `step.start`, packs with
  prior drops emit a synthetic ⇄ "travels → stage" frame with a manifest strip, honestly labeled
  with a "derived" chip (`model.ts:226-304`, `parts.tsx:714-765`).
- **state_group** — render-time coalescing: 3+ consecutive explicit write frames fold into one
  expandable "N state ops" summary card (`coalesceStateParts`, `model.ts:320-338`;
  `StateGroupPart`, `parts.tsx:834-885`). Applied in `MessageRow`, never mutates the model.
- **error** — ⚠ banner with `errorType` + message (`parts.tsx:888-898`).
- **Message footer**: model name + input/output token counts from `message.complete`/`llm.end`
  (`MessageRow.tsx:11-18`, `model.ts:530-539`).
- **Waiting indicator**: streaming assistant message with no text yet shows bouncing dots labeled
  "thinking…" or "running tools…" (`MessageRow.tsx:20-27, 51, 67-71`).
- **Relative timestamps** auto-refresh every 30s (`chat/atoms.tsx:44-61`).

### 3.4 Chat panel behaviors (`chat/ChatPanel.tsx`)
- **Tail-follow scroll lock**: auto-scrolls while user is within 48px of bottom; releases when they
  scroll up; a "↓ latest" jump button appears when unstuck (`ChatPanel.tsx:43-97`).
- Two sizes (`full`/`compact`) and a `fill` mode for height-bounded parents.
- Empty-state labels vary: "Select an agent…", "No messages yet — say hello.",
  "Loading session…", "No messages in this session." (`ChatPage.tsx:661-669`).
- **Composer** (`chat/ChatComposer.tsx`): auto-growing textarea (max 160px), Enter=send,
  Shift+Enter=newline, Escape=abort, Send↔Stop button swap while streaming, disabled gating.

### 3.5 Sessions menu + replay (read-only transcript)
- **SessionsMenu** "Sessions (N) ▾" (`ChatPage.tsx:1695-1763`): rows are id · message-count badge ·
  status badge · relative time. No titles — `ConversationSummary` carries none (honest degradation
  documented at `ChatPage.tsx:1688-1693`).
- **Replay**: picking a session fetches messages + per-message parts (N+1), sorts by `createdAt`,
  maps to `Part`s (`stored-parts.ts`), renders through the same ChatPanel read-only with a
  "Viewing session <id> — read-only" banner (`ChatPage.tsx:626-631`). Monotonic `viewTokenRef`
  guards stale fetches (`ChatPage.tsx:461-499`).
- Stored-part vocabulary: `user_prompt`, `text`, `tool_call`+`tool_result` (fill-merged by id),
  `agent_step` (flat, `children` honestly empty), `state_delta` (wire event name + snake payload
  in metadata). Unknown types degrade to labeled text `[type] …` — never silently dropped
  (`stored-parts.ts:38-144`).
- **Honest data note** (`stored-parts.ts:15-28`): the runtime today persists only `user_prompt`,
  `text`, and `state_delta` parts — `Exchange.toolCalls` is always `[]`, so tool_call/agent_step
  replay paths are speculative-but-ready code that no real row has ever exercised.
- The last message's `runId` feeds the replay Trace/Scratchpad rails (`ChatPage.tsx:490-493`).
- **New Chat** exits replay AND resets the live thread + unlocks/reseeds the scope editor
  (`ChatPage.tsx:503-514`).

### 3.6 Session scope (SessionScope #268/#308) — the biggest chat-adjacent subsystem
- **Gate**: `instantiation.available` on the agent summary decides whether scope UI exists at all.
- **Two editor modes** in the `ScopeContextPanel` popover (`ChatPage.tsx:1242-1381`):
  - **Typed rows** when `instantiation.schema` (JSON schema) exists: folded via `foldToolParams`
    (`lib/toolParams.ts:42`) into per-field widgets — checkbox for boolean, kit-DropdownMenu enum
    picker (never native select, `ChatPage.tsx:1514-1590`), number input, JSON sub-textarea for
    object/array/unknown, text otherwise (`scopeWidgetFor`, `ChatPage.tsx:114-120`).
  - **JSON textarea fallback** for schema-less/older servers (#268 behavior) with live parse
    validation; invalid JSON **blocks Send** (`ChatPage.tsx:658-660`) with an "· invalid" tell on
    the trigger.
- **Presets** (#308 D7): named preset objects from the registration materialize client-side into
  the rows via a "Preset ▾" menu; the preset name is never sent (`ChatPage.tsx:1389-1444`).
- **Untouched-draft semantics** (tri-state, deliberate): displaying seeded defaults ≠ choosing
  them; nothing is POSTed until the operator edits or picks a preset, so the server resolves its
  own defaults at bind time (`ChatPage.tsx:411-425`). Blank optional row → key omitted; blank
  required row → sent as `""` so the server's zod produces an honest field-scoped 400
  (`assembleScopeRows`, `ChatPage.tsx:192-211`).
- **Locking**: scope is immutable per conversation (Decision 2); the editor locks the moment a
  create is in flight (`contextLocked`, `ChatPage.tsx:434`), then shows the server-echoed bound
  context (never the draft) + redacted-key list; "New Chat to change scope."
- **Server validation mapping**: `ScopeValidationError.issues[]` → per-row errors by
  `issue.path[0]`, unmatched issues to a panel footer (`ChatPage.tsx:439-452`).
- **ScopeChip** in the header once bound (`ChatPage.tsx:1629-1685`): first 1–2 scalar entries
  (values capped at 24 chars), "+N" tail, full JSON popover, redacted-keys line, honest
  non-interactive "(no scope)" pill; hidden entirely during replay (scope wasn't captured).
- The Tools rail repeats the scope readout with its own honesty states: "unscoped" (no hook),
  "default · binds on send", "this conversation" (bound echo incl. redacted flags), and
  "not recorded for replays" (`ToolsRail.tsx:254-333`).

### 3.7 Console rail — Tools tab (`components/ToolsRail.tsx`)
- Live-fetched catalog from `GET /agents/:id/capabilities`: capability groups (name, backing
  toolbox, description, play chips) → tool rows expandable in place with param list (name, type,
  optional flag, description via `foldToolParams`) and a "Full detail ↗" deep link to
  `/capabilities/:id`. Tool/capability count summary bar. Scope section (3.6).

### 3.8 Console rail — Trace tab (`components/TraceRail.tsx`)
- **Live feed**: current turn's `traceEvents` folded by `eventsToSteps`
  (`graph/trace-from-events.ts`) with `terminal: !streaming` so an in-flight run reads
  "in progress" rather than fabricating a finish.
- **Replay feed**: viewed session's linked `runId` → `GET /admin/runs/:id/events` →
  `persistedToEventLike` → same fold. `runId: null` → honest "No run linked to this exchange"
  hint; 503/404 → typed messages (`TraceRail.tsx:65-104, 172-181`).
- **Two lenses**: Waterfall / Log toggle, sharing the full-page organisms `TraceWaterfall`/
  `TraceLog` in narrow layout; keyed by run id so expand state can't leak between runs
  (`TraceRail.tsx:186-193`).
- **"Full ↗" deep link** to `/run?run=<id>` (the full trace explorer page) once a run id exists.

### 3.9 Console rail — Scratchpad tab (`chat/ScratchpadRail.tsx`, 893 lines)
"What this run carries between stages" — a Carry Gauge over `foldInventory(events[0..cursor])`
(`chat/fold-inventory.ts`, pure fold sharing `state-accessors.ts` with the timeline so the two
surfaces cannot drift):
- **Evidence packs**: hero row per backpack (focal size numeral, drop/merged/skipped sub-line,
  manifest tooltip), collapsible ledger of `[#N]` entries (fold at 12 rows, own-scroll past 24),
  per-entry **provenance card** (minted drop + via-tool + tags + merge history) on 500ms hover or
  click-pin, with "jump to write" and "light lineage" (flash every frame that touched the
  identity) actions (`ScratchpadRail.tsx:495-718`).
- **Stage outputs**: one hero row with the stage chain (done/current/failed coloring), saved
  ticks, N/M fraction; expandable `agents.<stage>` rows with ✓ set / pending and "→ prompt"
  suffix when injected (`ScratchpadRail.tsx:720-821`).
- **Kept values**: quiet rows for explicit scratchpad writes (`ScratchpadRail.tsx:823-846`).
- **Health footer**: receipt reconciliation — "✓ matches all write receipts" /
  "reconciling — run in progress" / a loud "⚠ receipts disagree" mismatch button that seeks the
  diverging frame (`ScratchpadRail.tsx:848-893`; reconciliation math in `fold-inventory.ts`).
- **Bidirectional seeks** (all scoped to the chat column's own scroll, never the page):
  - rail row → producing Δ frame in the timeline (via `data-skey`/`data-minted`/`data-drop-seq`
    stamps, skipping read/travel frames — `PRODUCING` selector, `ScratchpadRail.tsx:84, 201-240`);
  - Δ frame's mono `.d-key` → rail row (bubbled `chat:seek-rail` CustomEvent bridged by ChatPage,
    which opens the rail on the Scratchpad tab inside `flushSync` — `ChatPage.tsx:285-305`,
    `parts.tsx:439-457`); consumable/retry-able nonce protocol so replay-fetch races and remounts
    never replay a stale seek (`ScratchpadRail.tsx:242-294`).
  - `[#N]` cite chips in assistant prose: hover shows the minting frame's line + provenance
    (lazily-set native title), click seeks the minting frame; cross-highlights the rail row or
    overlays a peek line on a collapsed pack (`parts.tsx:23-132`, `ScratchpadRail.tsx:296-321`).
- **Density interplay**: seeks into hidden frames first bubble `chat:reveal-state-frames`, which
  ChatPage handles inside `flushSync` (flipping density Off→Writes) so the rect math never
  measures a display:none frame (`ChatPage.tsx:262-279`, `parts.tsx:99-115`).
- Supports a scrub `cursor` prop ("as of step N/M") with one-shot recency-tick animation on
  cursor+1 and instant settle on jumps — but **ChatPage never passes a cursor** (scrubbing is
  exercised only by the full-page run surface / tests).
- Replay mode fetches the run's events itself (same `fetchRunEvents` + honest degradation states).

### 3.10 Scratchpad density toggle (#226)
- 3-way `Segmented` in the ⚙ menu: **All / Writes / Off** (default Writes), applied as
  `data-density` on the chat column; CSS does the work (`chat.css:675-687`) — Off hides all `.sd`
  frames, Writes compacts closed read/innate frames (`ChatPage.tsx:213-225, 260`).

### 3.11 Copy / export (`CopyChatMenu`, `ChatPage.tsx:1024-1097`; `chat/export-chat.ts`)
- Copies the on-screen thread (live OR replayed) to clipboard in three formats:
  - `markdown` — readable transcript, tool calls as one-line summaries;
  - `markdown-io` — plus fenced JSON input/output per tool call, thinking as blockquotes;
  - `json` — full structured thread (roles, parts, tokens, model, conversation id).
- state_delta/state_group parts are deliberately omitted from markdown (kept in JSON)
  (`export-chat.ts:142-146`). "Copied ✓" feedback with timer cleanup.

### 3.12 Capture as eval case (`chat/CaptureCasePanel.tsx`)
- Header popover turning a live exchange into a `StoredEvalCase` via
  `POST /eval/cases/from-session`. Pre-send hint state → form (exchange picker with user-turn
  snippets, defaulting to the latest exchange; set picker incl. "➕ Create new set…" with
  slug/name/description; split train/dev/test; expected-answer textarea prefilled from the last
  assistant text) → submitting → outcome (created vs updated case ids) → "Capture another".
- Disabled while streaming or viewing a replay; always stays wired to the LIVE conversation
  (do-not-regress note, `ChatPage.tsx:19-23`). 503 → "Eval persistence isn't configured."
- Note: this panel still uses native `<select>`s (`CaptureCasePanel.tsx:282-362`) — the one chat
  surface not yet migrated to kit DropdownMenu pickers (agent picker/scope enum were; parked
  polish lives in issue #281 per memory).

### 3.13 Header chrome & misc
- Exchange-count badge, "streaming" spinner badge (`ChatPage.tsx:856-865`).
- ⚙ RunSettingsMenu: max tool calls (1–50 clamped), scratchpad density, conversation-id readout.
- Agent one-line description with hover-for-full-title truncation (`ChatPage.tsx:874-891`).
- Errors: agents-load failure and stream errors as red inline lines (`ChatPage.tsx:906-913`).
- Layout fills `calc(100vh - 48px)` so the chat scrolls internally, never the page
  (`ChatPage.tsx:577-588`).

### 3.14 Theming
- Six-theme system: {family: blue|earth|chalk} × {mode: system|light|dark} resolved in JS to a
  concrete `data-theme` on `<html>`, persisted at localStorage `apdash-theme` (with legacy-string
  migration), live OS-flip watching, and a non-persisted `?theme=<id>` query override for capture
  tooling (`src/ui/theme-mode.ts`; picker in `components/ThemeToggle.tsx`; CSS in
  `styles/theme-*.css` + `styles/tokens-base.css`).
- The chat subtree is wrapped in `.chat-route` so cockpit chat tokens resolve locally
  (`pages/chat-route.css`, `ChatPage.tsx:25-28`); chat visuals in `chat/chat.css` (~690 lines)
  and `chat/scratchpad-rail.css`.

---

## 4. State management

- **No global store**. Everything is React local state + refs:
  - `useChat` owns the thread (messages, streaming, conversationId, bound context echo,
    scopeIssues, traceEvents, lastRunId) with refs for conv-id/create-race/abort.
  - `ChatPage` owns view state: selection, replay (`viewingId/Messages/RunId/Error` + token ref),
    scope drafts (tri-state `contextText` / `rowDraft`), rail open/tab, density, rail seek nonce.
  - Rails own their own replay fetch state; disclosure state is rail-local.
- **Cross-component coordination via DOM CustomEvents** (`chat:seek-rail`,
  `chat:reveal-state-frames`) bubbled through the chat column, with `flushSync` where synchronous
  layout is load-bearing (`ChatPage.tsx:262-305`).
- **Polling**: sessions list refreshes every 5s via `useAdminData` (`hooks/useAdminData.ts`).
  Message streaming is the fetch-generator; no EventSource in the chat path (the generic
  `connectSSE`/`useEventStream` EventSource helper serves the separate `/live` +
  `/claude-code` pages).

---

## 5. Maturity signals

**Strong:**
- Zero TODO/FIXME markers across `src/chat`, `src/api`, and `ChatPage.tsx`.
- Heavy test coverage on the core folds and behaviors (~3,900 lines of chat-relevant tests):
  `chat/model.test.ts` (688), `chat/fold-inventory.test.ts` (751),
  `chat/__tests__/ScratchpadRail.test.tsx` (671), `state-delta-parts.test.tsx` (504),
  `ChatPage.scopeForm/scopeChip/scratchpadTab/density.test.tsx` (~840 combined),
  `chat-client.test.ts` (216, SSE frame parsing), `stored-parts.test.ts` (297),
  `useChat.test.ts` (78), `export-chat.test.ts` (78), `CaptureCasePanel.test.tsx` (293),
  `sessions.test.ts`, `toolParams.test.ts`.
- Extensive "honest degradation" discipline: typed 503/404 states, "(no scope)" vs hidden vs
  "not recorded for replays", "request not persisted", degrade-to-labeled-text for unknown parts,
  "derived" chips on UI-synthesized travel frames, redacted-preview notices.
- Race-condition hardening throughout (create-dedupe, monotonic view tokens, seek nonces,
  cancelled-fetch guards, flushSync commentary).

**Half-finished / aspirational / debt:**
- **README is stale**: `packages/agent-dashboard/README.md` lists only 6 routes and never
  mentions `/chat`, `/run`, `/eval/*`, or the Console at all; it still describes a "NestJS backend
  on port 3100" proxy. The code is far ahead of the README.
- **Session replay of tool calls is untested-by-reality**: the runtime persists only
  `user_prompt`/`text`/`state_delta` parts; the `tool_call`/`tool_result`/`agent_step` stored-part
  mappers have "never [been] exercised" by a real row (`stored-parts.ts:15-28`).
- **`tool.progress` is typed but unrendered** (no `applyParts` case) — progress ticks are dropped.
- **Replay scope not captured**: a replayed session's bound scope is unknown; three surfaces show
  explicit "not recorded" states instead. (Memory notes `resolveScope` work is "pending evidence".)
- **N+1 parts fetch** on session replay, acknowledged as deferred server work.
- **Travel frames are client-derived** (v1 explicitly: "no runtime emitter", `model.ts:226-231`);
  `[#N]` cite resolution can still collide when two packs mint the same index inside one message
  (`parts.tsx:36-39`).
- **Scratchpad cursor scrubbing** is plumbed but not reachable from ChatPage (only the run
  surface / tests use it).
- **CaptureCasePanel native `<select>`s** are the remaining pre-kit-menu holdout (parked polish,
  #281).
- No auth, no multi-tab/live-shared conversation state, no message editing/regeneration, no
  attachment/file support, no conversation delete/rename — none of these exist anywhere in the
  chat surface.

---

## 6. Parity checklist seed (what a terminal chat must cover to match)

1. Agent list + selection (`GET /agents`), incl. `instantiation` metadata.
2. Conversation create with optional scope under `context` key; render server echo + redacted
   keys; per-field 400 issue mapping; scope immutability + "new chat to rescope".
3. Typed scope form from JSON schema (widgets, defaults precedence: `instantiation.defaults` >
   property `default`), presets materialized client-side, blank-optional-omitted /
   blank-required-empty-string semantics.
4. POST-SSE streaming with hand-rolled frame parse, no event-name allowlist, `done`/`run_id`.
5. Incremental part fold: text deltas, thinking (+complete/redacted), tool intent/start/end/
   rejected upsert-by-id, agent_step nesting by span ids, error frames, model/token metadata.
6. Human-in-the-loop input.request cards (approval/select/text) + `POST /conversations/:id/input`.
7. State-delta rendering (7 ops), tool-anchored nesting, coalescing, density control, derived
   travel frames — plus the Scratchpad inventory fold + receipt-reconciliation health.
8. Per-turn abort (Stop/Escape) with aborted-vs-error distinction; maxIterations knob.
9. Session list (client-filtered `GET /admin/conversations`) + read-only replay from stored
   messages/parts with graceful unknown-part degradation.
10. Trace view per turn (live events fold / replay via `/admin/runs/:id/events`), waterfall+log
    lenses, deep link to the run explorer.
11. Tools/capability catalog per agent with param schemas and scope readout.
12. Export transcript (markdown / markdown+IO / JSON).
13. Capture-exchange-as-eval-case (`POST /eval/cases/from-session`) with set create/pick,
    split, expected prefill.
14. Honest-degradation states for unconfigured persistence (503), missing runs (404), unlinked
    exchanges, and unrecorded replay scope.
