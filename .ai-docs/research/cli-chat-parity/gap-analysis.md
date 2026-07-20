# Terminal-Chat vs Web-Chat Parity — Gap Analysis Synthesis (rev 2)

Goal: get a CLI/terminal chat to feature parity (MVP of same coverage) with the React web chat
(`packages/agent-dashboard`, the Agent Console at `/chat/:agentId`). Four candidate surfaces were
read in depth, then a critic pass ran live validation and deep-dives; this synthesizes all of it:

| Slice | Report |
|---|---|
| React web chat | `reports/react-chat.md` |
| Server HTTP/SSE contract | `reports/server-contract.md` |
| `ap` TypeScript CLI | `reports/ts-cli.md` |
| chat-patterns (Go TUI) | `reports/chat-patterns-go.md` |
| tui-patterns (Go framework) | `reports/tui-patterns-go.md` |
| Repo lineage | `reports/lineage.md` |
| **Live contract smoke test** (chat-patterns client vs running `ap playground`) | `reports/contract-smoke-test.md` |
| **History/replay contract mismatch** (Go picker vs TS read routes) | `reports/history-contract-mismatch.md` |
| **HITL in-process feasibility** (`ap run` approval loop) | `reports/hitl-in-process-feasibility.md` |
| **`display_type` emission cost** (server-side + client heuristic) | `reports/display-type-cost.md` |

**What changed in rev 2** (critic findings folded in):

1. The earlier claim that "chat-patterns' contracttest would pass against the TS server except
   for the body-key issue" is **refuted by live test** — it fails at ListAgents on the
   `role`-object decode and never reaches the later checks (§2.2, N1).
2. Live validation surfaced **five new mismatches** beyond the code-read ones — most seriously a
   **torn 14-byte HTTP-200 SSE stream with no error/done frame on any pre-token runner failure**
   (§2.2, N5) — a server-side robustness bug that hurts *every* client, whichever strategy wins.
3. The conversation-history/replay contract between the Go picker and the TS read routes shares
   **almost no wire surface** (list path, every field name, messages-inline vs N+1, branch
   fields) — but a TS compat shim is ~0.5–1 day (§2.3).
4. Two previously-open cost questions are now priced: **in-process HITL for `ap run` is Small
   (~half a day, CLI-only, ~80–120 LOC, zero runtime/server changes)** and **server-side
   `display_type` is S/M (~half a day, additive, core+runtime, `bump-both`)** with a viable
   ~30-line Go client heuristic as a zero-server-cost stopgap (§2.5). These materially move the
   strategy effort signals in §4.

Column key for the matrix: **full** / **partial** / **none**. tui-patterns' column is almost
uniformly "none (transport-ready)" — its transports, atoms, and theme are real and tested, but
**every view including chat is a one-line `doc.go` stub** (`views/chat/doc.go`); treat that column
as "what exists below the UI line."

---

## 1. Feature-coverage matrix

### 1.1 Conversation core

| Capability (React ref) | React chat | ap TS CLI | chat-patterns Go | tui-patterns Go |
|---|---|---|---|---|
| Multi-turn conversation, server/engine-side threading (`chat/useChat.ts`) | full | full — in-process `Conversation` (`run.ts:118-190`) | partial — full over HTTP/stdio; **stateless per message over CLI transport** (Claude/Gemini spawn per send, `cliclient/claude.go:91`) | none (no UI; stdio/http transports demux streams, `transport/stdio/client.go:92-167`) |
| Lazy create + scope-validated `POST /conversations` (`chat-client.ts:186`, 400→typed issues) | full | partial — same validation ladder but in-process, pre-run exit on failure (`run.ts:85-116,235-285`) | partial — bare `{agent_name}` create only, no scope concept; **live-tested: fails against the TS server with 404 "Agent not found"** (§2.2 N2) | none |
| Per-turn abort / stop, aborted≠error (`useChat.ts:174-177`, Esc/Stop) | full | full — Ctrl+C AbortController + `stream.return()` (`run.ts:418-431`) | **none** — `SendMessage` uses `context.Background()` (`chat/model.go:568`); Enter only skips the animation | none |
| `maxIterations` per-message knob (`ChatPage.tsx:1143-1223`) | full | none | none | none (invocation `input` is freeform; nothing renders it) |
| HITL `input.request` cards: approval/select/text + `POST /conversations/:id/input` (`parts.tsx:303-407`) | full | **none today, but proven Small to add** — event dropped (`run.ts:511-513`); gate only wired in playground; feasibility study confirms an in-process approval loop needs ~80–120 LOC in the CLI only (§2.5, hitl report) | **none** — ConfirmPrompt/RadioSelect molecules exist but are wired nowhere; `input.request` is an unknown event and silently dropped (the return leg `POST /conversations/:id/input` was live-verified working on playground) | none |
| Resume a live conversation after restart | **none** (server gap: in-memory registry, `app.ts:28`) | none | none (picker dead code, §1.5) | none (sessions explicitly a protocol non-feature, PROTOCOL.md:868-875) |

### 1.2 Streaming & rendering

| Capability | React | ap CLI | chat-patterns | tui-patterns |
|---|---|---|---|---|
| Token-by-token streaming (`message.delta` fold) | full | full (`run.ts:443-515`) | full (`chat/model.go:593-741`) | none (transports yield `StreamChunk` channels; no renderer) |
| Markdown rendering (`lib/markdown.ts`) | full | none (raw ANSI, no-markdown by convention) | **full — best in class**: goldmark terminal renderer + mid-stream fence/bold fixup, GFM tables, chroma (`ui/goldmark.go`, 39 tests) | **none** — `textblock`/markdown deliberately not ported |
| Thinking: collapsible with preview (`parts.tsx:181-206`) | full | partial — dim `💭` lines, no fold (`run.ts:463-515`) | full — collapsed summary ↔ full expand (`view.go:297-353`) | none |
| Waiting indicator / long-run spinners | partial (bouncing dots, `MessageRow.tsx:20-27`) | partial (static line) | full — graduated spinners subtle→pulse→heartbeat (`view.go:386-396`), 14 presets | atoms only (18 spinner presets, `ui/atoms/spinner.go`) |
| Model + token footer (`model.ts:530-539`) | full | full (`message.complete` footer) | partial — **SSE `message.complete` tokens discarded** (`sse/types.go:12-16` dead); stdio `llm.end` only | none |
| Scroll ergonomics / tail-follow / jump-to-latest (`ChatPanel.tsx:43-97`) | full | n/a (line stream) | full (stick-to-bottom, mouse wheel, `model.go:175-204`) | none |
| state_delta viz — 7 ops, tool-anchored nesting, coalescing, density toggle (`parts.tsx:409-885`, `model.ts:197-338`) | full | none (state events dropped) | none (events unknown → dropped) | none |
| Scratchpad rail / Carry Gauge / receipt reconciliation / bidirectional seeks (`chat/ScratchpadRail.tsx`, 893 ln) | full | none | none | none |
| Delegation / agent_step nesting by span (`model.ts:143-162`) | full | none (dropped) | full — but **stdio transport only**; nested SubParts + iteration/llm status lines (`model.go:647-722`) | none — and **defaultvocab transformer silently drops `delegation.*`/`llm.*`** (`transformer/defaultvocab/transformer.go:163`) |
| `[#N]` citation chips with provenance hover/seek (`parts.tsx:23-132`) | full | none | none | none |

### 1.3 Tool-call UX

| Capability | React | ap CLI | chat-patterns | tui-patterns |
|---|---|---|---|---|
| Tool cards: status glyph, duration, expandable I/O (`parts.tsx:209-245`) | full | partial — one-line arg/result previews, 120/240-char caps (`run.ts:463-515`) | full — click + Tab-cycle expand/collapse, auto-collapse on complete (`view.go:398-542`) | none |
| Rich result rendering by `display_type` (diff/code/bash + chroma) | **none** (JSON code blocks only) | none | **full — exceeds React** (`view.go:564-605`) — but the TS server never emits `display_type`; fixing that is a half-day additive change, or a ~30-line client heuristic works today (§2.5) | atoms only (codeblock/highlight/diffless) |
| `tool.rejected` rendering (`parts.tsx` ⊘ state) | full | none (ignored) | partial — parses only legacy `agent.tool.rejected`; the canonical `tool.rejected` name the server emits is **not parsed** (`sse/parse.go:119`; not live-verifiable without an LLM key — code-read only) | partial — `chat` transformer parses the legacy alias; v0.5.0 protocol **dropped the event entirely** |
| `tool.intent` dedupe (upsert by id, `model.ts:428-481`) | full | n/a (intent ignored) | n/a (event unknown) | n/a |
| `tool.progress` | **none — typed but unrendered** (`sse-events.ts`, no reducer case) | none | none | none — **shared gap on all four surfaces**; runtime emits it but nobody renders it |

### 1.4 Session scope (#268/#308 — the largest chat-adjacent subsystem)

| Capability | React | ap CLI | chat-patterns | tui-patterns |
|---|---|---|---|---|
| Scope on create with defaults precedence (`ChatPage.tsx:97-452`) | full | full — `--context`/`AP_CONTEXT` > `scope.defaults` > `instantiateDefaults`, explicitly mirrors `POST /conversations` (`run.ts:235-285`) | none | none |
| Typed form from `instantiation.schema` (widgets, tri-state untouched draft, blank-optional/required semantics) | full | none — raw JSON string only | none | **none, but fully spec'd** — PROTOCOL.md §Forms (draft-07 + `x-ui-*`) is a designed superset of exactly this; zero implementation (Phase 3) |
| Named presets (client-side materialization) | full | none (no `--preset`, noted parity gap, `README.md:95`) | none | none |
| Per-field zod 400 mapping (`ScopeValidationError`) | full | partial — formatted issue list, pre-run exit (`run.ts:296`) | none | none |
| Redacted echo, immutable lock, ScopeChip (`ChatPage.tsx:1629-1685`) | full | partial — one-line redacted scope banner (`run.ts:374`) | none | none |

### 1.5 Transcript / replay / export / eval

| Capability | React | ap CLI | chat-patterns | tui-patterns |
|---|---|---|---|---|
| Session list (`GET /admin/conversations`, 5s poll) | full | none | partial — `ListConversations` implemented in http+stdio clients but **never called by any UI path**; live-tested against the TS server: **zero fields decode** (snake_case vs camelCase, wrong path — §2.3) | none |
| Read-only session replay (stored messages + N+1 parts, unknown-part degradation) | full | none | partial — `GetConversation`/picker (`chat/picker.go`, 237 ln, New/Continue/**Branch**) is complete **dead code**, never instantiated; and the TS detail route carries no inline `messages[]`, which the one-request Go client structurally cannot handle (§2.3) | none (replay view stub; JSONL replay transport spec'd, unbuilt) |
| Persistence of the terminal chat itself | n/a (server persists) | **none** — `ap run` passes no `ConversationStore` (`run.ts:187`); playground chats DO persist to SQLite | none client-side | none |
| Transcript export (markdown / markdown-io / JSON, `chat/export-chat.ts`) | full | none | none | none |
| Capture exchange as eval case (`POST /eval/cases/from-session`, `CaptureCasePanel.tsx`) | full | none in-chat (`ap eval` runs banks, writes the same store, `eval.ts:327-397`) | none | none |
| Per-turn trace (live fold + replay via `/admin/runs/:id/events`, waterfall/log) | full | none | none | none (chattrace view stub; Phase 4) |
| Run deep-link from `done.run_id` | full | n/a (in-process, but runId exists on events) | none (`run_id` in the done frame ignored) | none |

### 1.6 Agent management

| Capability | React | ap CLI | chat-patterns | tui-patterns |
|---|---|---|---|---|
| Agent list + in-chat picker/switch (`AgentPickerMenu`, thread reset pre-paint) | full | partial — `ap agents` table + one agent per invocation; no in-chat switch | full UI — agent-select phase + `/agents` command (`app/model.go:241-274`); **but ListAgents fails live against the TS server** on the `role`-object decode (§2.2 N1/#3) | partial — `cmd/tui` prints pattern kinds and exits (`cmd/tui/main.go:79`) |
| Capabilities/tool catalog with param schemas (ToolsRail) | full | partial — `ap tools list/call` outside chat (`tools.ts:91,128`) | none | none (inspector view stub; composition endpoints spec'd) |
| Deep link / addressable session | full (`/chat/:agentId`, `/run?run=`) | n/a | n/a | n/a |
| Slash commands + autocomplete | n/a (GUI menus) | partial — `/exit` `/quit` only | full — registry, aliases, fuzzy autocomplete (`command/`, `ui/autocomplete/`) | partial — registry+parser ported (`shell/command/`), no UI |
| Multi-line composer, paste, input history | full | none (clack single-line `text()`) | partial — multiline+paste yes; no up-arrow history, append-only editing (`chat/input.go:9-10`) | none |

### 1.7 Error handling & honesty

| Capability | React | ap CLI | chat-patterns | tui-patterns |
|---|---|---|---|---|
| Honest-degradation states (typed 503 "unconfigured"/404, "(no scope)" vs "not recorded", labeled unknown parts) | full — a house discipline | partial (loud credential preflight, exit-code taxonomy) | partial — errors render, but no typed degradation states; **live: a torn pre-token stream renders as an empty *successful* reply** (§2.2 N5) | partial — `ErrorShape` DTO defined, **never decoded** (`transport/http/client.go:198`) |
| Stream-error vs user-abort distinction | full | full | partial (no abort at all) | n/a |
| Recoverable `error` frames inline | full | full | full | transformer-level only |

### 1.8 Theming

| Capability | React | ap CLI | chat-patterns | tui-patterns |
|---|---|---|---|---|
| Theme system | full — 6 themes, OS-flip watch (`src/ui/theme-mode.ts`) | none — hand-rolled ANSI helpers, deliberate no-chalk | full — 4-dim token system, YAML themes, bg auto-detect | full — same system ported + `TUI_THEME`/`COLORFGBG` autodetect (`theme/registry.go:29-45`) |

### 1.9 Parity ceiling — gaps the React chat itself has (a terminal MVP need not exceed these)

- No live-conversation resume (server registry is in-memory) and no cancel endpoint —
  connection-drop is the only stop, which also fail-closed-denies pending approvals.
- No branch/rollback/clear routes despite runtime support (`Conversation.fork/rollback`).
- `tool.progress` unrendered everywhere; travel frames are client-derived (no runtime emitter).
- Replay never shows tool_call/agent_step parts (runtime persists only
  `user_prompt`/`text`/`state_delta`) and never shows bound scope ("not recorded" states).
- No auth anywhere; no attachments, editing, or regeneration.
- **New (live-found)**: pre-token runner failures produce a torn SSE stream with no `error`
  frame (§2.2 N5) — even the React client would fold nothing and show an empty assistant turn;
  this is a shared ceiling bug, not a client gap.

An honest MVP bar is therefore: matrix rows where React is "full" **minus** the interactive
Scratchpad/Trace rails (a textual state-delta summary is a defensible MVP stand-in — open
question for discussion), and sharing the same honest-degradation stances for the ceiling items.

---

## 2. The transport-contract gap

### 2.1 What the agentic-patterns server actually speaks (fixed side)

- `GET /agents` → rich roster incl. `instantiation:{available,defaults,schema,presets}`;
  `role` is an **object** `{id,name}|null` (`routes/agents.ts:65-98`).
- `POST /conversations {agent_id, scope?|context?}` → 201 `{id, agent_id, context?, …}`;
  400 `{error:"scope validation failed", issues[]}`; 502 on instantiate failure.
- `POST /conversations/:id/messages {content, maxIterations?}` → **SSE over the POST response
  body** (NOT EventSource-compatible); ~30 snake_case wire names from one exhaustive
  `toSSEMapping` (`sse-formatter.ts:74-395`); terminator `event: done` `{run_id}`; full
  vocabulary forwarded, curation is the client's job.
- `POST /conversations/:id/input {correlation_id, decision|value}` — HITL return leg; 501 when
  unconfigured; stream teardown auto-denies pending requests. **Live-verified on playground**:
  registry is wired, unknown correlation → 404 with the documented JSON shape.
- `GET /admin/events/stream` — EventSource-compatible global firehose (all conversations,
  traceId-enriched) — live-verified working; note it also carries `claude_code.hook` telemetry
  frames, so its vocabulary is wider than agent events.
- History/trace read routes: `/admin/conversations`, `/conversations/:id` (detail without
  messages), `/conversations/:id/messages`, `/messages/:id/parts`, `/admin/runs/:id[/events]` —
  all 503-degrading. **There is no bare `GET /conversations` list route** (404).
- **Not offered to any client**: cancel endpoint, rehydrate/fork routes, auth,
  `display_type` on tool events, `systemPrompt` on `message.start`.
- **Known server bug (live-found, N5)**: any runner failure *before the first token* (model
  resolution reject, missing API key) yields HTTP 200 `text/event-stream` with exactly 14 bytes
  — `data: {"conver` — a truncated `conversation.start`, **no `event:` line, no `error` event,
  no `done`**. The drain loop (`agent-server/src/routes/conversations.ts:391-406`) has no catch
  that writes an SSE error frame. Every strategy below should assume this gets fixed
  server-side; a lenient client otherwise renders an empty "successful" reply.

### 2.2 chat-patterns' expected contract vs the server — live-validated

The vocabularies are siblings (same author, same lineage), and the server's canonical event
names are exactly what chat-patterns' SSE parser accepts. But the **live smoke test**
(contracttest + shipped `tui.NewHTTPClient` against a running `ap playground`, commit 10d5c0b)
shows the request/response shapes are further apart than the code-read suggested. **All five
shipped-client methods fail against the live server.**

**Correction to rev 1**: the claim that `contracttest.ValidateBackend` "would pass its four
checks today except for the body-key issue" is **wrong on both halves**. Empirically: Health
PASSes, then **ListAgents FAILs** (`decode agents: json: cannot unmarshal object into Go struct
field .role of type string` — `contracttest/validate.go:50-54` types `role` as `string`), and
the suite aborts before CreateConversation/SendMessage ever run. The `role`-object mismatch
lives in contracttest too, not just httpclient — it must be fixed in **two places**. With that
one decode fixed, the remaining checks pass (manually verified: create → 201 `{id, agent_id}`;
send `{"content"}` to `/messages` → 200 `text/event-stream`) — though contracttest asserts only
status + content-type, so it also "passes" on a torn N5 stream.

| # | Mismatch | Where | Live status | Fix size |
|---|---|---|---|---|
| 1 | Send body: client posts `{"message"}` to `/conversations/{id}/send`; server wants `{"content"}` at `/conversations/{id}/messages` | `httpclient/client.go:32`, `types.go:85-87` vs `conversations.ts:331` | **Confirmed** — path override works via `EndpointConfig`, but the hardcoded body key gets 400 `{"error":"content is required"}`; a Go code change is required, override alone is insufficient | ~5 lines Go (or a server-side `message` alias) |
| 2 | Create body: client sends `{agent_name, model?}`; server requires `agent_id` | `httpclient` vs `conversations.ts:63` | **Confirmed with sharper shape (N2)** — manifests as **404 "Agent not found"** (server looks up `undefined`), NOT a validation 400; indistinguishable from a genuinely unknown agent | trivial |
| 3 | `GET /agents` decode: client expects `role` as string; server returns object/null | `httpclient/client.go:110-168` **and** `contracttest/validate.go:50-54` (N1) | **Confirmed live**; legacy `[]string` fallback also fails | trivial ×2 |
| 4 | Canonical `tool.rejected` unparsed (only legacy `agent.tool.rejected`) | `sse/parse.go:119` | Not runnable live (no LLM key) — code-read only | trivial |
| 5 | `message.complete` tokens discarded; `done.run_id` ignored | `sse/types.go:12-16` | Not runnable live | small |
| 6 | `input.request` unknown → dropped: an approval-gated tool **hangs until teardown auto-deny** | no parser case, no POST-input leg, no UI flow (molecules exist unused) | Return leg live-verified working server-side; event delivery not runnable | the one real feature build (~parser + client call + ConfirmPrompt wiring) |
| 7 | `step.*`, `backpack.*`, `scratchpad.*`, `iteration.*`, `llm.*` (SSE) dropped silently | parser default | Not runnable live | fine for MVP; needed for state-viz/trace parity |
| 8 | No scope on create at all | — | — | new feature (see strategies) |
| 9 | No stop: `context.Background()` on send | `model.go:568` | — | plumb a context; server still has no cancel route (connection drop only) |
| 10 | `display_type`-rich rendering has no data source — server never emits the field | `sse-formatter.ts:151-160` | Not runnable live | **now priced: S/M server-side or ~30-line client heuristic** (§2.5) |
| N3 | List route/shape: client default `GET /conversations` → 404; server list is `GET /admin/conversations` with camelCase summaries incompatible with `types.Conversation` snake_case tags | `client.go:33,272-276` vs `conversations.ts:229-241` | **New, live-found** — path override insufficient; needs a shape adapter | see §2.3 |
| N4 | Detail route exists but 404s for live-but-unpersisted conversations and returns a camelCase summary **without** `messages[]`; the one-request Go client decodes a near-empty struct | `client.go:296-300` vs `conversations.ts:246-274` | **New, live-found** | see §2.3 |
| N5 | Torn 14-byte SSE stream on pre-token runner failure; client synthesizes `Done:true` → empty "successful" reply | `conversations.ts:391-406` (no catch → no SSE error frame) | **New, live-found, reproduced twice** | server-side fix, small; benefits all clients |
| N6 | chat-patterns-internal doc/code drift: `EndpointConfig` comment documents default send path `/conversations/{id}/messages` but code defaults to `/send` | `types.go:151` vs `client.go:32` | **New** | doc fix |
| N7 | Legacy `/send` 404 is `text/plain` (Hono fallthrough), unlike JSON error shapes elsewhere | — | **New, minor** | cosmetic |

Live-test caveat: no LLM path was runnable keylessly (fixture agents declare no model; a
model-declaring agent threw `AI_LoadAPIKeyError` despite the ClaudeCodeAPIRunner banner), so
items #4, #5, #6 (event delivery), #7, #10 remain code-read-verified only.

### 2.3 History/replay contract — the Go picker vs the TS read routes

The deep-dive confirms the picker path is dead **twice over**: (1) nothing in chat-patterns ever
instantiates `PickerModel` or dispatches/handles its messages, and no replay renderer consumes
`ConversationDetailResponse`; (2) even if wired, the wire shapes share almost nothing:

- **List**: zero fields decode — Go wants `id/agent_name/state/exchange_count/
  total_input_tokens/total_output_tokens/created_at/updated_at`; TS emits `conversationId/
  agentName/messageCount/tokenCount/startedAt/lastMessageAt/status`. Go's case-insensitive JSON
  matching never bridges underscores. The `?agent_name=` filter is silently ignored server-side.
- **Detail**: path matches (`GET /conversations/:id`) but TS returns no inline `messages[]` —
  messages are N+1 at `/conversations/:id/messages` + `/messages/:id/parts`, which the
  one-request Go client has no code to perform. Notably the TS store already holds parts inline
  (`StoredMessage.parts`, `store.ts:42`) — the N+1 split was a dashboard-parity choice, so
  inlining is cheap.
- **Vocab**: `kind` is `request|response` (TS) vs `user|assistant` (TUI render vocab);
  part types produced are `user_prompt/text/tool_call/state_delta` vs TUI-known
  `text/thinking/tool_call/error/waiting`; Go's `MessagePart{type,content}` drops the
  `metadata` that carries tool_call detail. `exchange_count` ≈ `messageCount / 2`.
- **Branch**: `branched_from_id`/`branched_at_sequence` have no TS counterpart anywhere;
  `ActionBranch` is unimplementable — but the fields are `*T`+`omitempty`, so absence decodes
  harmlessly. Ship the picker with branch disabled.

**Fix sizing (from the deep-dive)**: a TS compat shim — snake_case list route (bare
`GET /conversations`, no route conflict exists) + `agent_name` filter + inline `messages` (with
`sequence` = index) on detail — is **~0.5–1 day** of server work. Go-side picker wiring + a
replay renderer is **~1–2 days**. Branch support is a multi-day TS feature; defer.

### 2.4 tui-patterns v0.5.0 vs the server — a different generation

No overlap at the endpoint layer: `/capabilities` negotiation, `/patterns/{kind}/{name}`,
two-step `POST /invocations` + `GET /invocations/{id}/events`, `{type, ts, data}` event
envelope, required `iteration.*`, `tool.rejected` dropped, sessions explicitly out of scope.
The server speaks none of it. Bridging options:

- **Server grows a v0.5.0 facade** (`/capabilities` derivable from `/agents` + `/openapi.json`;
  `POST /invocations` wrapping conversation-create+send; envelope added at `agentEventToSSE`).
  Clean but real server work, and chat would still need conversation semantics v0.5.0 lacks.
- **tui-patterns speaks the chat protocol**: the designed seam already exists — the pluggable
  `EventTransformer` with the dual-vocabulary `chat` transformer
  (`transport/sse/transformer/chat/transformer.go`) accepts the server's event names verbatim.
  What's missing is a chat-shaped HTTP client (agents/conversations/SSE-off-POST), which is
  ~a re-port of chat-patterns' `httpclient` (~350 lines) — and it would inherit every §2.2
  shape mismatch unless written against the live server from the start. Note the semantic
  divergence to resolve: `chat` transformer treats `message.complete` as Done; `defaultvocab`
  waits for `done`.

### 2.5 Newly-priced seams (critic deep-dives)

**HITL in `ap run` — Small, proven.** The whole approval mechanism is transport-agnostic by
design: the runner parks inside `bus.publish` while the gate awaits a `PendingInputRegistry`
promise; the HTTP input route is nothing but `registry.resolve()`. The CLI can subscribe to
`agent.input.request` on the shared singleton bus, run a clack `select()` while the parked
stream idles the event loop (no stdout races — the blocked runner emits nothing), and resolve
the registry directly. ~55 LOC in `run.ts` + `parseApprovalTools` hoist + tests; **zero
runtime/server changes**; one half-day PR. Caveats: pair the gate with `timeoutMs` or a
teardown deny-sweep (bus swallows handler exceptions); Ctrl+C during the prompt is clack's, not
the REPL SIGINT path; add an `agent.tool.rejected` render case so denies aren't silent.

**`display_type` on tool events — S/M server-side, or free client-side.** The clean fix is an
optional `displayType?` declared on core's `ToolDefinition`/`ToolSchema` (same philosophy as
the `terminal` flag), stamped by the runner from schemas it already holds at all three
`tool.end` sites, and conditionally copied by `sse-formatter` (the `backpack.*` `display` field
is the established idiom). ~40–60 production lines across 4 files + tests, fully backward
compatible, touches core+runtime → `just bump-both`. Alternatively a ~30-line Go heuristic
(name sniff bash/read/edit + `@@` hunk-marker sniff on string results) works against today's
server with zero protocol change — the two compose: heuristic now, server field overrides it
when non-empty. One consumer-side caveat: chat-patterns only promotes **string** results
(`parse.go:104-107`); object results always render generic regardless of `display_type`.

### 2.6 Cross-cutting seam decisions (whichever client wins)

1. **Drive from the per-turn POST stream** (raw payloads, per-conversation, run_id on done) —
   matches the React reducer model — vs the **global `GET /admin/events/stream` firehose**
   (EventSource-compatible, traceId-enriched, multiplexes everything, and carries
   `claude_code.hook` frames). React uses the former; recommend the same for parity semantics.
2. **Cancellation ownership**: server has no cancel route; MVP options are connection-drop
   (what React does) or adding `POST /conversations/:id/cancel` emitting `agent.message.cancel`.
3. **No-allowlist discipline**: React's parser drops frames only when malformed, never by name
   (a load-bearing decision after an allowlist ate `agent.step.*`). chat-patterns/tui-patterns
   transformers do the opposite (unknown → nil). Any Go adaptation should pass unknown events
   through to the reducer layer to inherit the same future-proofing.
4. **Fix N5 server-side regardless of strategy**: wrap the chat-stream drain loop so pre-token
   failures emit a proper `error` frame + `done`; without it every lenient client shows an
   empty successful reply, and contracttest cannot catch it (it checks only status/content-type).
5. **In-process option (TS only)**: the `ap` CLI can skip HTTP entirely — `Conversation.stream()`
   yields the same `AgentEvent` union the SSE mapping serializes. Zero transport gap, but it
   forfeits shared persistence with playground, the run_id/done contract, and server-side scope
   400 mapping unless deliberately mirrored (much already is, `run.ts:235-285`).

---

## 3. Lineage verdict — which repo is the living base

**chat-patterns is the parent and the only working terminal chat; tui-patterns is the same
author's (Doug's) intended successor, and both are ~3 months dormant.**

- Direction of flow is unambiguous: tui-patterns commit `19c31ae` ("port atoms and theme system
  from chat-patterns"); theme tokens and YAML files byte-identical; zero reverse references.
- chat-patterns: 12 commits (2026-04-10→12), 14.3k LOC, tests green, polished rendering core,
  5 transports, real consumer app (`cmd/agenti-kit`). BSL 1.1, no CI.
- tui-patterns: 7 commits all on 2026-04-15, 4.2k LOC, Phase 1 of 7 complete — PROTOCOL.md
  v0.5.0 (contract of record, written before code), three tested transports, atoms/theme/command
  registry. **All five views incl. chat are doc.go stubs**; `cmd/tui` prints a banner and exits.
  MIT, CI. Its roadmap absorbs chat-patterns as `cmd/chat-patterns` in Phase 5.
- Verdict: *intent says tui-patterns; working software says chat-patterns.* chat-patterns is the
  designated donor — every roadmap arrow points out of it — but it is the only artifact that can
  render a conversation today. Meanwhile the **TS `ap` CLI is the only surface that is actively
  maintained, in-repo, and already speaks the runtime natively** — it isn't part of the Go
  lineage at all, which is precisely what makes it a live third option.
- The live smoke test tempers the "near-miss" framing of rev 1: chat-patterns' shipped HTTP
  client fails **all five** interface methods against the real server, and its own conformance
  suite fails at step two. The vocabularies are siblings; the *shapes* were never actually
  exercised against this server before now.
- Licensing note: reusing BSL chat-patterns code inside MIT tui-patterns is trivially resolvable
  (same author) but should be made explicit if strategy B or C proceeds.

---

## 4. Three candidate MVP strategies (for discussion — no pick made)

All three now share two prerequisites regardless of choice: **fix N5** (torn pre-token SSE
stream) server-side, and decide the **cancellation** stance (§2.6).

### Strategy A — Build the chat into the `ap` TS CLI (grow `ap run`)

Extend the existing terminal chat in `packages/agent-cli` (`src/commands/run.ts`), either
in-process (today's mode + ConversationStore + HITL gate + richer rendering) or as a new
remote-attach mode speaking the server's POST-SSE contract against a running `ap playground`.

- **Effort signal: Medium — and now de-risked at its sharpest cliff.** The HITL feasibility
  study proves the approval loop is a **half-day, CLI-only PR** (~80–120 LOC, all primitives
  already exported, zero runtime/server changes). Beyond that, the head start is large:
  streaming REPL exists, scope resolution already mirrors the server, `Conversation` accepts
  stores and a `history` ctor option, the event union is native (no wire adaptation
  in-process), and persistence lands in the same `events.db` the dashboard reads. Single
  language, single repo, no protocol drift ever.
- **What must be built**: HITL prompt flow (now Small), persistence/resume, markdown +
  fold/expand rendering, session list/replay commands, scope presets flag/typed prompts,
  state-delta textual summary, export, eval capture (recorder already shared with the server).
- **Biggest risks**: (1) the rendering ceiling — the repo has a deliberate no-TUI-framework,
  no-chalk convention; React-grade collapse/expand/scrollback in raw ANSI is the hard 60%, and
  adopting ink/blessed is a philosophy change; (2) risk of slowly re-implementing chat-patterns,
  worse; (3) the REPL/renderer are the only untested parts of an otherwise well-tested package;
  (4) in-process mode quietly diverges from web semantics (no `done.run_id`, no server-side 400
  mapping) unless remote mode is chosen — and remote mode inherits the missing cancel endpoint.

### Strategy B — Revive chat-patterns as the client of the agentic-patterns server

Fork/embed the working Go TUI and point it at the TS server: fix the §2.2 shape mismatches (in
both httpclient AND contracttest), add a TS compat shim for history routes, wire the dead
conversation picker + a replay renderer, add the HITL leg.

- **Effort signal: Medium (revised up from "Small-to-Medium core").** The live smoke test shows
  every client method fails today, and the history contract needs work on both sides. Concrete
  bill: Go wire fixes (#1–#5, N1 ×2 places) — small; **TS compat shim** for list/detail
  (snake_case + `agent_name` filter + inline messages) — ~0.5–1 day; **Go picker wiring +
  replay renderer** (kind/part-type mapping incl. `user_prompt`/`state_delta` handling) —
  ~1–2 days; HITL leg — the one real feature build; `display_type` — free via client heuristic
  now, server field later. The streaming/tool/markdown/theming core still **exceeds** React in
  places (goldmark streaming fixup, display_type diff/code rendering, graduated spinners).
- **What has no answer here**: the entire session-scope subsystem (typed forms, presets,
  tri-state drafts, per-field 400s) — the single largest React chat subsystem — would start from
  zero, likely as a JSON-prompt MVP stopgap; state-delta/trace/scratchpad rendering likewise.
- **Biggest risks**: (1) investing in the designated donor repo — the author's own roadmap
  retires it into tui-patterns; (2) a Go client for a TS server splits the toolchain and
  guarantees ongoing contract-drift policing — the `/send` vs `/messages` drift happened
  *within* one repo (N6), and the smoke test proves the shapes were never exercised against
  this server; (3) BSL 1.1 license needs an explicit relicensing decision; (4) repo dormant 3
  months, `httpclient`/`cliclient` untested, no stop-generation, no CI; (5) branch UI must ship
  disabled (no TS counterpart).

### Strategy C — Execute tui-patterns Phase 2+3+5 and target the server (roadmap-aligned)

Build the shell (P2), the JSON-schema form engine (P3), and port the chat view from
chat-patterns (P5) into tui-patterns; bridge to the server either via a chat-shaped client using
the existing dual-vocabulary `chat` transformer, or by growing a v0.5.0 facade on the server.

- **Effort signal: Large** — three roadmap phases from doc-stubs plus a protocol bridge.
- **Why it's tempting anyway**: it is the **only strategy with a designed answer to scope-form
  parity** — PROTOCOL.md's draft-07 + `x-ui-*` form engine maps almost 1:1 onto
  `instantiation.schema` (the server already emits `scope.toJsonSchema()`); capability
  negotiation formalizes the honest-degradation discipline both frontends practice; MIT + CI +
  semver'd contract; and finishing P5 retires the chat-patterns fork permanently — MVP and
  consolidation in one move.
- **Biggest risks**: (1) largest scope, MVP furthest away — high odds of building framework
  instead of product; (2) two protocols to reconcile (v0.5.0 has no conversation semantics,
  dropped `tool.rejected`, requires `iteration.*`; the server has no `/capabilities` or
  `/invocations`); (3) the `defaultvocab` transformer already silently drops `delegation.*`/
  `llm.*`/`validation.error` — multi-agent data loss baked in at the canonical vocabulary;
  (4) unknown whether the ~60 bootstrap issues were ever filed; the ecosystem peers
  (backend-patterns, codegen-patterns) are unverified; (5) a new chat-shaped Go client would
  re-encounter every §2.2 shape mismatch unless developed against the live server (the smoke
  test harness at `(scratchpad)/contract-live/` is reusable for exactly this).

### Open questions worth settling in the discussion (they change the strategy ranking)

1. **MVP bar for state-viz/trace**: is a textual state-delta summary + `ap`-style run-id pointer
   acceptable, or are the interactive Scratchpad/Trace rails in scope? (If in scope, everything
   is Large.)
2. **Is HITL approval required for MVP?** For Strategy A this is now a proven half-day; for B/C
   it remains a real build (parser case + input POST + ConfirmPrompt wiring). Fail-closed
   teardown-deny makes silent drops actively harmful either way.
3. **In-process vs remote-attach** for the TS CLI path — shared persistence and web-identical
   semantics vs zero-transport simplicity.
4. **Who owns cancellation** — add `POST /conversations/:id/cancel` server-side, or bless
   connection-drop as the contract (what React does)?
5. **Should the server emit `display_type`** on tool events? Now priced at ~half a day
   (core+runtime, `bump-both`); the client heuristic alternative is free and forward-compatible
   — the sequencing question is ship-heuristic-first vs field-first.
6. **Scope-form parity depth**: raw JSON prompt (B), flag/prompt hybrid (A), or full schema-driven
   forms (C / React parity)?
7. **N5 + compat shim as strategy-neutral pre-work**: the torn-stream fix and (if any Go path is
   live) the snake_case history shim are useful under every strategy — worth landing first
   regardless of the pick?
