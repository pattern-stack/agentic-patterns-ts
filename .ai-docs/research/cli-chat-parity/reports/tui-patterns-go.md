# tui-patterns (Go) — Deep Read Report

Reader slice: the Go repo cloned at
`/private/tmp/claude-501/-Users-dug-Projects-sandbox-agentic-patterns-ts/78887b5e-96db-4d36-9c70-9c8ada14bb2b/scratchpad/tui-patterns`
(remote: `https://github.com/pattern-stack/tui-patterns.git`, branch `main`, shallow clone — single visible commit `d85c9cd feat(cmd/tui): wire connect flow for --backend / --stdio / --jsoncli`).

A sibling repo, **chat-patterns**, is cloned at
`.../scratchpad/chat-patterns` (remote pattern-stack/chat-patterns, HEAD `187411b feat: agenti-kit providers, team conversations, surface theme, and stable tool args`). It is essential context because tui-patterns is an in-progress extraction/generalization OF chat-patterns, and several things the task inventory attributes to tui-patterns actually only exist in chat-patterns today. Both are covered below, clearly separated.

---

## 1. Executive summary — the single most important finding

**tui-patterns is at Phase 1 of a 7-phase plan. It has NO interactive UI at all.** Every `views/*` package (inspector, runner, chat, chattrace, replay), `ui/molecules`, `ui/widgets`, `shell` (except the command parser), `transport/jsonl`, and `contracttest` is an **empty package containing only a one-line `doc.go`**. The repo totals ~4,177 lines of Go; what actually exists is:

- a complete, well-specified wire contract (`PROTOCOL.md` v0.5.0, 1,015 lines),
- protocol DTO structs,
- three working transports (HTTP+SSE, JSON-RPC stdio, JSON-CLI) with a pluggable SSE event-transformer layer,
- 8 leaf render atoms, a token-based theme system, and a slash-command registry/parser,
- a `cmd/tui` binary that only connects, prints a "Connected to …" banner, and exits (literally prints `"(sidebar + detail pane — Phase 2)"`).

The **mature, feature-complete terminal chat app is chat-patterns** (~14,314 lines of Go), a separate repo with a different, chat-specific protocol (`/agents`, `/conversations`, `/conversations/{id}/messages` SSE). For terminal-chat-vs-web-chat feature parity as an MVP, chat-patterns is the artifact that has the features TODAY; tui-patterns is the aspirational universal framework those features are being ported into.

The README's claim — "A single binary gives you sidebar navigation, JSON Schema-driven forms, composition inspection, invocation streaming, and a chat view" (`tui-patterns/README.md:9`) — describes the end state, not the code. The quickstart itself admits it: "(stub) more detail once cmd/tui lands a connect flow" (`README.md:16`).

---

## 2. The 7-phase roadmap (from `scripts/bootstrap-issues.sh`)

`tui-patterns/scripts/bootstrap-issues.sh` (idempotent `gh` script that files GitHub labels/milestones/epics/issues) encodes the full build plan and is the best statement of intent in the repo:

| Phase | Milestone | Contents | Status in code |
|---|---|---|---|
| 1 | Foundation Port | atoms, theme, transports, command registry, SSE parser, `cmd/tui` connect banner | **DONE** — every Phase 1 child issue's deliverable exists and is tested |
| 2 | Shell Primitives | sidebar tree, pane container, status bar, toast, command palette, form widgets (text/textarea/toggle/radio/multi-select/number/date/kv-editor/picker/repeater), collapsible | **NOT STARTED** (`shell/doc.go`, `ui/widgets/doc.go` only) |
| 3 | Form Engine + Inspector | JSON Schema→widget mapper, `x-ui-*` resolver, live draft-07 validation, `x-ui-visible` conditional visibility, `x-ui-picker` wiring, Inspector composition-tree view, per-atom copy, edit-in-$EDITOR | **NOT STARTED** (`views/inspector/doc.go` only) |
| 4 | Invocation Runner + Trace + Replay | Runner view (pattern picker→form→stream), 30/70 trace span tree from `iteration.*`/`tool.*`/`delegation.*`/`llm.*`, Replay view, JSONL recorder | **NOT STARTED** (`views/runner/doc.go`, `views/replay/doc.go`, `transport/jsonl/doc.go` only) |
| 5 | Chat Port | Role→Actor generalization, port messageblock/toolcallblock/diffblock/errorblock/confirmprompt/radioselect/statusblock molecules from chat-patterns, embeddable `views/chat`, **standalone `cmd/chat-patterns` binary** | **NOT STARTED** (`views/chat/doc.go`, `ui/molecules/doc.go` only; `cmd/chat-patterns` directory does not exist despite being listed in README repo layout at `README.md:41`) |
| 6 | Consumers | codegen-patterns TUI + universal `--json`/`--stream` CLI flags, aloevera TUI, backend-patterns FastAPI `/capabilities` + `/patterns/*` + `/schema` endpoints | NOT STARTED (lives in other repos anyway) |
| 7 | Conformance + Polish | `contracttest.ValidateHTTP / ValidateStdio / ValidateJSONCLI / ValidateJSONL`, ~200-line reference backend, docs site, Homebrew/go-install/Releases distribution | **NOT STARTED** (`contracttest/doc.go` only) |

Key implication for the chat-view question: in tui-patterns **the chat view is exactly as complete as every other view — zero lines**. All five views are equal stubs. The difference is that chat has a fully working prior implementation next door in chat-patterns to port from (Phase 5), whereas inspector/runner/replay/chattrace have never existed anywhere.

---

## 3. PROTOCOL.md v0.5.0 — the wire contract (tui-patterns)

`tui-patterns/PROTOCOL.md` (1,015 lines) is a complete, carefully-written spec. Version `0.5.0`, pre-stable; minor bumps may break. Core stance: *"tui-patterns itself has no business logic… The TUI only negotiates capabilities, fetches descriptions, renders forms and composition trees, invokes capabilities, and streams events"* (PROTOCOL.md:7). Explicitly **not chat-specific**: *"Chat is one capability shape among many; it is represented as an invocation that emits `message.delta` events"* (PROTOCOL.md:44).

### 3.1 Vocabulary (PROTOCOL.md:30-45)
Backend, **Pattern** (named object grouped by **kind** e.g. `agent`/`workflow`/`subsystem`/`noun`), **Capability** (invocable op like `run`/`plan`), **Invocation** (execution producing an event stream with unique `invocation_id`), **Composition** (atom tree of the pattern's assembled artifact, e.g. system prompt = role + capability atoms + judgment atoms), **Atom** (`slot`, `kind` ∈ text|json|list, `preview`, `raw`, `items`), **Item** (row inside a collection-valued pattern), **Schema** (JSON Schema draft-07 + `x-ui-*` extensions).

### 3.2 HTTP endpoints (PROTOCOL.md:48-83)
| Method/Path | Response | Required |
|---|---|---|
| GET `/capabilities` | `Capabilities` | Yes |
| GET `/patterns` | `{"kinds": string[]}` | Yes |
| GET `/patterns/{kind}` | `PatternSummary[]` | Yes |
| GET `/patterns/{kind}/{name}` | `PatternDetail` (incl. `capabilities[]` with `input_schema_ref`, `links`) | Yes |
| GET `/patterns/{kind}/{name}/composition` | `Composition` | if `capabilities.patterns.composition` |
| GET `/patterns/{kind}/{name}/schema` | JSON Schema | if `capabilities.patterns.schema` |
| GET/POST/PATCH `/patterns/{kind}/{name}/items[/{id}]` | `PatternItem` | if collection-valued |
| POST `/invocations` | `{"invocation_id"}` | Yes |
| GET `/invocations/{id}/events` | SSE stream | Yes |
| GET `/invocations?pattern=&kind=` | `InvocationSummary[]` | No |

Uniform error shape: `{"error":{"code":"pattern_not_found","message":"…","details":{}}}` (PROTOCOL.md:68-83).

### 3.3 Capabilities negotiation (PROTOCOL.md:86-158)
`GET /capabilities` returns `protocol_version`, `server{name,version}`, `patterns{kinds[],composition,schema,items}`, `invocations{streaming: sse|ndjson|line-buffered|none, events[]}`, `forms{json_schema_version:"draft-07", ui_extensions[]}`, `features{multi_agent,cost_accounting,sessions,…}`. The TUI calls it once at connect, enables/hides views accordingly; unknown events/fields/extensions must be soft-ignored (PROTOCOL.md:885-887). `features.sessions` MUST be `false` in 0.5.0 (PROTOCOL.md:874).

### 3.4 Forms (PROTOCOL.md:340-488)
Default widget mapping by schema type (string→text; enum 2→toggle, 3-6→radio, >6→picker; format:date→date; number→number; bool→toggle; array-of-primitives→multi-select/kv-editor; array-of-objects→repeater; object→nested group). Extensions: `x-ui-widget`, `x-ui-label`, `x-ui-help`, `x-ui-group` (collapsible sections), `x-ui-visible` (short `{if:{field,equals}}` form OR JSONLogic, re-evaluated on every change), `x-ui-picker` (`{source, value_field, label_field, preview}` fetched from backend endpoint), `x-ui-preview` (row template like `"{name} — {role}"`). Emitters: Python/pydantic `Field(ui_label=…)` metadata; TypeScript `generate-json-schema.ts` from Zod `.describe()` + sidecar (PROTOCOL.md:448-452). **None of the form engine is implemented.**

### 3.5 Invocation event vocabulary (PROTOCOL.md:492-769)
Every event = `{type, ts (ISO-8601), data}`. **Required names**: `message.delta` (`{message_id, delta}`), `message.complete` (`{message_id, content, input_tokens?, output_tokens?}`), `tool.start` (`{tool_call_id, tool_name, display_type, arguments}`), `tool.end` (`{tool_call_id, result, error, duration_ms, display_type}`), `iteration.start` (`{iteration_id, index, label?}`), `iteration.end` (`{iteration_id, status: ok|error|cancelled}`), `error` (`{code, message, retryable}` — terminates stream, no `done` after), `done` (`{}` — final event). **Optional**: `thinking` (`{content}`), `delegation.start`/`.end` (`{delegation_id, parent_iteration_id, target{kind,pattern,capability}}` / `{delegation_id, status}`), `llm.start`/`.end` (`{call_id, model, input_tokens}` / `{call_id, output_tokens, duration_ms, cost_usd}`), `validation.error` (`{field, message}`, non-fatal), `progress.update` (`{label, current, total}`). `display_type` values: `generic|code|diff|bash|json|table`, unknown→generic (PROTOCOL.md:616). Ordering rules at PROTOCOL.md:748-753: deltas in order per message_id, tool pairs by tool_call_id (may overlap), iterations bracket subtrees, error terminates immediately, done is final.

### 3.6 Transport bindings (PROTOCOL.md:773-865)
1. **HTTP+SSE (canonical)** — SSE `event:` line MUST equal the JSON body's `type`; optional `id:` line for resumption (PROTOCOL.md:779-788).
2. **JSON-RPC 2.0 over stdio** (§8.2) — line-delimited; method mapping `capabilities`, `patterns.kinds`, `patterns.list{kind}`, `patterns.get{kind,name}`, `patterns.composition`, `patterns.schema`, `items.list`, `invocations.create`; events arrive as notifications `stream.event` with `{invocation_id, event}` params, then a final response with the request id; standard -327xx error codes.
3. **JSON-CLI** (§9) — spawn `<cli> <kind> <capability> <pattern> [--input @file.json] --json [--stream]` per request; discovery via `<cli> capabilities --json`, `<cli> patterns --json`, `<cli> <kind> list|get|schema|composition|items … --json`. Streaming = NDJSON on stdout, final line MUST be `done` or `error` event; exit 0 iff `done`; stdout must be pure JSON (no prompts/spinners), stderr is for logs (PROTOCOL.md:855-865).
4. **JSONL replay** (§8.4) — file with one `{"type":"replay.header","protocol_version","invocation":{kind,pattern,capability,input}}` line, event lines, terminating `done`; optional `{"type":"replay.gap_ms","value":N}` pacing lines; playback at 1x/2x/fast.

### 3.7 Sessions — deliberately a non-feature (PROTOCOL.md:868-875)
No protocol-level sessions/checkpoints in 0.5.0. The TUI's sessions UX (where present) is view-local and "wraps git primitives (branch / stash / diff / restore)". This matters for gap analysis: **conversation persistence/resume is not in the universal protocol at all** — chat-patterns has its own conversation model instead (see §7).

### 3.8 "Backend in 30 minutes" + conformance claims (PROTOCOL.md:891-1012)
Walkthrough shows a ~60-line Python jsoncli backend, then Go usage `tui.New(tui.Config{AppName, Backend: jsoncli.New(…)})` — **note: `tui.New`/`tui.Config` do not exist in tui-patterns** (no root package; chat-patterns has that API). Then `contracttest.ValidateJSONCLI(t, "python3", "tiny-backend.py")` which is specified (PROTOCOL.md:997-1002) to: check protocol_version major; walk first pattern of each kind; run streaming invocation and verify terminal done/error; verify framing, delta/complete agreement, tool.start/tool.end pairing, and that emitted event types are declared in capabilities. **`ValidateJSONCLI` exists nowhere in either repo** (grep confirms) — the contracttest package in tui-patterns is `contracttest/doc.go` only ("backend conformance suite verifying PROTOCOL.md compliance", 2 lines).

---

## 4. What is actually implemented in tui-patterns (feature inventory with anchors)

### 4.1 `protocol/` — DTOs (implemented, no logic)
- `protocol/capabilities.go:4` — `ProtocolVersion = "0.5.0"`; `Capabilities` struct with `Extra map[string]any \`json:"-"\`` (declared for unknown fields but never populated — dead field).
- `protocol/patterns.go` — `PatternSummary` (:6), `Capability` (:18), `PatternDetail` (:25), `PatternItem` (:36), `Composition`/`Atom` (:46/:54), `InvocationRequest` (:63, note `Stream bool` with `omitempty` so default-false, whereas PROTOCOL.md says default true), `InvocationCreated` (:72), `InvocationSummary` (:77), `ErrorShape`/`ErrorBody` (:88/:93 — defined but **no transport ever decodes it**; HTTP client returns bare `HTTP <code>` errors, see below).

### 4.2 `types/` — shared stream DTOs
- `types/stream.go:6-26` — `ChunkType` constants: core (`text, thinking, tool_start, tool_end, error, iteration, progress`) plus chat-specific extensions (`msg_start, tool_rejected, delegation_start/end, iteration_start/end, llm_start/end, validation_error`).
- `types/stream.go:30-62` — `StreamChunk`: Content/Type/Done/Error/DurationMs core + MessageID, AgentID/AgentName (multi-agent), ModelName/InputTokens/OutputTokens, ToolCallID/ToolName/DisplayType/Arguments/Result/ToolError, ProgressLabel/Current/Total. `types/doc.go:5` admits: "Phase 5 may split these into transformer-specific payloads."
- `types/stream.go:65-79` — `SSEEvent{Event,Data,ID}`, `APIError{Type,Msg}`.

### 4.3 `transport/sse/` — vocabulary-free SSE parser + pluggable transformers (implemented, tested)
- `transport/sse/parse.go:13-15` — `EventTransformer interface { Transform(SSEEvent) *StreamChunk }` (+ `TransformerFunc` adapter :18-23). Returning nil = skip event silently (this is how "unknown events MUST be ignored" is honored).
- `ParseFrames` (:28-73) — parses `event:`/`data:` (multi-line joined with \n)/`id:` lines, 1MB scanner buffer, emits on blank line; scan errors surface as a synthetic `error` event.
- `Stream` (:79-96) — maps frames through the transformer; closes after first `Done` chunk or emits a synthetic `{Done:true}` if the stream ends without one.
- **`transformer/defaultvocab/`** (`transformer.go`) — PROTOCOL v0.5.0 vocabulary: handles message.delta, message.complete (:51-63 — carries token counts but **does NOT set Done**; only `done` ends the stream), thinking, tool.start/end, iteration.start/end, progress.update, error (Done+APIError), done. `unwrap` (:23-31) tolerates backends that omit the SSE `event:` header and put `{"type":…,"data":…}` in the body. **Gap: `delegation.start/end`, `llm.start/end`, `validation.error` are NOT handled by defaultvocab** despite being in the protocol and having ChunkTypes defined — they fall through to `default: return nil` (:163-164) and are dropped.
- **`transformer/chat/`** (`transformer.go:1-140`) — legacy chat-patterns vocabulary, dual-accepts `agent.*` names AND v0.5.0 names ("backends migrated mid-stream keep working"): agent.message.chunk|message.delta, agent.message.complete|message.complete (**here complete sets Done:true**, :31-32 — a semantic difference from defaultvocab), agent.reasoning|thinking, agent.tool.start|tool_start|tool.start (falls back to `input` field for name), agent.tool.end|tool_end|tool.end (accepts `result` any / `output` string), agent.tool.rejected, agent.iteration.start/end, done, agent.error|error (error_type or code). No delegation/llm events here either.

### 4.4 `transport/http/` — HTTP+SSE client (implemented, tested)
`transport/http/client.go` — `Config{BaseURL, HTTPClient, Transformer}` (default transformer defaultvocab, default 30s-timeout client :35-48). Methods: `Connect` → GET /capabilities + cache (:51-72), `Capabilities()` (:75), `ListPatternKinds` (:80), `ListPatterns` (:91), `GetPattern` (:100), `GetComposition` (:109), `GetSchema` → raw JSON (:118), `ListItems` (:127), `CreateInvocation` → POST /invocations (:136-162), `StreamInvocationEvents` → GET /invocations/{id}/events with `Accept: text/event-stream`, uses a fresh timeout-less client for the long-lived stream (:166-185) and returns `sse.Stream` channel. **Not implemented despite being in the protocol: POST/PATCH items, GET /invocations list, GET items/{id}, Accept-Protocol-Version header, decoding the uniform ErrorShape body (errors are just `"GET %s: HTTP %d"`, :198).**

### 4.5 `transport/stdio/` — JSON-RPC 2.0 subprocess client (implemented, tested)
`transport/stdio/jsonrpc.go` — Request/Response/Notification/`StreamEventParams{invocation_id,event}` shapes, line-delimited Writer with atomic id, Reader with 1MB buffer, standard error-code constants (:131-137).
`transport/stdio/client.go` — spawns subprocess with stdin/stdout/stderr pipes (:47-90); `readLoop` demuxes responses (by id → pending map) vs `stream.event` notifications (:92-127); `handleStreamEvent` unwraps `{type,ts,data}` and routes transformed chunks to the per-invocation stream channel, closing it on Done (:129-167). Methods: `Connect` (`capabilities`), `ListPatternKinds` (`patterns.kinds`), `ListPatterns` (`patterns.list`), `GetPattern` (`patterns.get`), `CreateInvocation` (`invocations.create`, registers stream channel keyed by returned invocation_id) (:200-282). Graceful `Close`: SIGTERM → 5s → SIGKILL (:285-304). **Missing vs protocol: `patterns.composition`, `patterns.schema`, `items.list` methods.** Note `call()` ignores its context — no cancellation/timeouts on individual RPCs (:169-197); stderr pipe is captured but never read.

### 4.6 `transport/jsoncli/` — spawn-per-request CLI client (implemented, tested)
`transport/jsoncli/client.go` — `Config{Command, BaseArgs, Dir, Env, Transformer}`; `Connect` = `<cli> capabilities --json` (:55-69); `ListPatternKinds` = `patterns --json` (:79); `ListPatterns` = `<kind> list --json` (:94); `GetPattern` = `<kind> get <name> --json` (:107); `Invoke` = `<kind> <capability> <pattern> [--input @tmpfile] --json [--stream]` writing Input to a temp file (:122-154). `runStream` parses NDJSON envelope lines through the same transformer, drains stdout after terminal event (:189-244). **Missing vs protocol §9: schema/composition/items verbs; exit-code validation on the streaming path (doc comment at `jsoncli/doc.go:5` claims "exit code is validated at end-of-call" but `runStream` ignores `cmd.Wait()`'s error — doc overstates code).**

### 4.7 `ui/atoms/` — 8 leaf render primitives (implemented, tested)
All follow `func Atom(ctx RenderContext, data AtomData) string` with `RenderContext{Width, Theme}` (`ui/atoms/atoms.go:8-16`).
- `badge.go` — filled/outline variants, 16-char default truncation with ellipsis.
- `codeblock.go` — left-gutter `│` code block, optional language/filepath header, optional line numbers, truncation not wrapping, chroma highlighting when language known.
- `highlight.go` — chroma tokenizer → theme-mapped lipgloss styles (keywords→CatAgent bold, strings→Success, comments→dim italic, functions→CatTool, numbers→CatUser).
- `icon.go` — 9 semantic glyphs (cursor/arrow/bullet/check/x/dot/circle/warning/info).
- `inlinecode.go`, `separator.go` — trivial.
- `spinner.go` — Bubble Tea model with **18 frame presets** (Dense, Sparse, Orbit, Arc, Star, Pong, …), 80ms default tick, ID-scoped tick messages.
- `table.go` — bordered table renderer.
**Missing vs chat-patterns' atoms: `textblock.go` (markdown text block) was not ported; there is no markdown renderer at all in tui-patterns** (chat-patterns has `internal/ui/markdown.go` + `goldmark.go`).

### 4.8 `theme/` + `themes/` — token theming (implemented, tested)
- `theme/tokens.go` — 4-dimensional style token: `Category` (Default/Agent/System/Tool/User + 4 reserved), `Hierarchy` (Primary→Quaternary), `Emphasis` (Strong/Normal/Subtle), `Status` (Success/Error/Warning/Info/Muted/Running); `Style` composes all four (:51-56).
- `theme/theme.go` — `Theme{Name, Categories[9], Statuses[7], Foreground, Background, DimColor, Surface}`; `Resolve(Style) lipgloss.Style` precedence: Status > Category > Hierarchy dimming > Subtle emphasis (:27-55).
- `theme/registry.go` — global active theme; `TUI_THEME` env override; light/dark auto-detect via `COLORFGBG` (bg 7/15 → light) (:29-45); `Register` for custom themes.
- `theme/loader.go` — YAML theme loader (`name/foreground/background/dim/surface/categories/statuses` maps); `themes/embed.go` embeds `dark.yml`/`light.yml`.

### 4.9 `shell/command/` — slash-command system (implemented, tested)
- `parse.go` — `/cmd arg --opt=v --opt v -f "quoted arg"` parser → `ParseResult{Command, Args, Flags, Options, Raw}` with quote-aware tokenizer.
- `registry.go` — `Def{Name, Aliases, Description, Category, Hidden, Handler func(ParseResult) tea.Cmd}`; `Lookup` by name/alias; `List(category)`; `Suggest(partial, limit)` = prefix match → alias match → Levenshtein fuzzy (max dist len/3) (:79-133).
- `commands.go` — `DefaultRegistry()` ships only `/help` (h,?), `/clear` (c), `/quit` (q) plus `ClearMsg`/`ShowHelpMsg`/`SystemMsg` tea messages. (chat-patterns additionally ships `/agents`.)

### 4.10 `cmd/tui/` — the binary (Phase 1 deliverable only)
`cmd/tui/main.go` — flags `--backend URL | --stdio 'cmd args' | --jsoncli 'cmd args'` (exactly one required, :32-45); 15s connect timeout; prints `Connected to <name> v<ver> (protocol <pv>)`, pattern kinds, advertised events, then the placeholder line `"(sidebar + detail pane — Phase 2)"` (:74-79) and exits. Doc comment: "Interactive UI is Phase 2+" (:3). `splitCommand` is whitespace-only (no quoting) (:82-88).

### 4.11 Maturity signals
- **Tests**: `go test ./...` fully green (verified in this session). Tested: shell/command, theme, transport/http (httptest-based), transport/jsoncli, transport/stdio (+jsonrpc), transport/sse + both transformers, all 8 atoms. Untested/empty: types, protocol, all views, molecules, widgets, shell (non-command), jsonl, contracttest.
- **TODO/FIXME count**: zero. The only "stub" markers are the Phase comments in cmd/tui and README.
- Tooling: `Justfile` (build/test/vet/fmt/quality), Go 1.25, deps: bubbletea v2 (charm.land fork), lipgloss v2, chroma v2, yaml.v3. No CI config, no goreleaser, no releases in the clone.
- README repo-layout block lists `cmd/chat-patterns  chat consumer app (Phase 5)` (`README.md:41`) — **directory absent**.

---

## 5. What the contracttest conformance suite requires of a backend

Two different answers, because there are two contracttests:

### 5.1 tui-patterns contracttest (the one the task asks about): SPEC ONLY
Package = `contracttest/doc.go` (2 lines). The *specified* behavior (PROTOCOL.md:984-1002 + Phase 7 issue in bootstrap-issues.sh) is a family `ValidateHTTP / ValidateStdio / ValidateJSONCLI / ValidateJSONL`, table-driven, importable by backend authors, checking:
1. `capabilities` returns a supported protocol_version major;
2. every kind in `patterns.kinds` lists and the first pattern round-trips;
3. a streaming invocation of the first pattern terminates with `done` or `error`;
4. SSE/NDJSON framing correctness, `message.delta` totals agree with `message.complete.content`, every `tool.start` has a matching `tool.end`, and all emitted event types are declared in `capabilities.invocations.events`.
None of this is implemented.

### 5.2 chat-patterns contracttest (implemented, chat-protocol): what a backend must pass TODAY
`chat-patterns/contracttest/validate.go` — `ValidateBackend(t, baseURL)` requires, over HTTP:
1. `GET /health` → 200 (skipped if absent);
2. `GET /agents` → 200 with non-empty `[{id,name,role}]`, non-empty id;
3. `POST /conversations` `{"agent_id":…}` → 200/201 with `{"id"}`;
4. `POST /conversations/{id}/messages` `{"content":"Hello"}` with `Accept: text/event-stream` → 200 with `Content-Type: text/event-stream` (it does NOT parse the stream contents).

`chat-patterns/contracttest/validate_stdio.go` — `ValidateStdioBackend(t, command, args…)` spawns the process and requires JSON-RPC methods: `listAgents` → non-empty list with string ids; `createConversation{agent_id}` → `{id}`; `sendMessage{conversation_id, content}` → at least one `stream.event` notification with `params.type == "message.delta"`, one with `"done"`, and a final JSON-RPC response with matching id, all within 10s. (Note the notification shape it checks — `params.type` directly — differs from tui-patterns' nested `params.event.type`.) Two helper functions (`readResponseSkipNotifications`, `isNotification`, :219-238) are dead code.

---

## 6. chat-patterns — the mature chat TUI (context for parity)

This is a separate ~14.3k-line repo with its own chat-specific `PROTOCOL.md` (498 lines) and is the current terminal chat implementation. Inventory of user-facing features (all working per code):

### 6.1 Its protocol (chat-patterns/PROTOCOL.md)
HTTP: `GET /health` (opt), `GET /agents` (req), `POST /conversations` (req), `POST /conversations/{id}/messages` → SSE (req), `GET /conversations?agent_name=` (opt), `GET /conversations/{id}` (opt). SSE events: `message.delta`, `message.complete{content,input_tokens,output_tokens}`, `thinking`, `tool.start`, `tool.end`, `tool.rejected{tool_name,reason}`, `error{error_type,message}`, `done`. Display types `generic|diff|code|bash`. JSON-RPC stdio methods: `listAgents`, `createConversation`, `sendMessage` (required); `listConversations`, `getConversation` (optional). Note vs tui-patterns v0.5.0: agent/conversation-centric instead of pattern/invocation-centric; SSE stream comes directly off the POST rather than a separate GET events endpoint.

### 6.2 Transports (5, behind `types.Client` interface — `internal/types/client.go:6-25`)
ListAgents / SendMessage(→chan StreamChunk) / CreateConversation (returns optional Greeting) / **CreateTeamConversation(AgencyConfig{name, agents[{role,is_coordinator,model,max_turns}]})** / ListConversations / GetConversation.
- HTTPClient (`internal/httpclient/`), StdioClient (`internal/stdioclient/`), **CLIClient** (`internal/cliclient/` — built-in streaming-JSONL parsers for **Claude Code** (`claude.go`) and **Gemini CLI** (`gemini.go`)), ExecClient (`internal/execclient/` — pipe prompt to any CLI, render stdout as markdown), DemoClient (`internal/demo/` — scripted fixtures `demo/fixtures/demo.json`, `demo-parts.json`). Plus a **ServiceManager** (`internal/service/` — local/node service supervision with health states Healthy/Unhealthy/Starting surfaced in the status bar, `internal/app/model.go:223,410-414`).
- Configurable endpoint paths via `EndpointConfig` (`internal/types/types.go:175-182`).

### 6.3 Chat view features (`internal/chat/model.go`, 1,053 lines; `view.go` 732 lines)
- **Part-aware messages**: `PartType` = text, thinking, tool_call, delegation, error, status, waiting (:34-42); a single assistant message interleaves typed parts.
- **Tool calls**: lifecycle states pending/running/complete/error, arguments+result capture, duration, `StartedAt` driving spinner graduation, expand/collapse (expanded while running, auto-collapse on completion, `fillToolCallResult` :851-864), display_type-routed rendering (via molecules: toolcallblock, diffblock+diffparser, codeblock).
- **Thinking parts**: truncated summary vs full content toggle (`MessagePart.Expanded`, :93).
- **Multi-agent delegation**: `DelegationPart{Agent, Content, SubParts, State, Expanded}`; events tagged with AgentID are routed into the active delegation's SubParts via a delegation stack (`targetParts` :753-769; `ChunkDelegationStart/End` handling :647-688) — nested sub-agent transcripts inside the parent message.
- **LLM/iteration status lines**: `ChunkLLMStart` → "calling <model>...", `ChunkLLMEnd` → "↳ 1,234 in / 56 out tokens" (:714-721), iteration labels as status parts.
- **Streaming UX**: waiting placeholder part on submit (:557-562), dual spinners (SparseCenter for tools, Star for thinking, :576-590), **Enter-to-skip streaming** which drains the channel synchronously (`skipStreaming` :866-939), auto-scroll with stick-to-bottom only when already at bottom (:304-342).
- **Interaction**: mouse wheel scroll; **mouse click-to-toggle** any expandable part via a Region hit-test table built during render (:132-138, `handleClick` :963-989); **Tab/Shift+Tab keyboard focus cycling over expandable regions + Enter to toggle** (:497-514); viewport scroll keys pgup/pgdn, shift+arrows, ctrl+u/d (dual-purpose with input editing, :409-421); multi-line input via shift+enter/alt+enter/ctrl+j; word/line delete (ctrl+w, ctrl+u); paste support.
- **Slash commands + autocomplete**: `/` activates fuzzy autocomplete dropdown (`internal/ui/autocomplete/`), enter/tab accept, typing refines (:432-475). Built-ins: /help, /clear, /agents, /quit (`internal/command/commands.go`).
- **Conversation lifecycle**: agent-select phase (j/k navigation) → chat phase (`internal/app/model.go:232-258`); **conversation picker with New / Continue / Branch actions** (`internal/chat/picker.go:17-29` — `ActionNew/ActionContinue/ActionBranch`); conversation DTOs carry `BranchedFromID/BranchedAtSequence`, exchange counts, token totals (`internal/types/types.go:127-152`); greeting message support; **team conversations** via `command.TeamConversationMsg` (`internal/app/model.go:213`).
- **Rendering**: full markdown via goldmark (`internal/ui/goldmark.go`, `markdown.go`); molecules: messageblock, toolcallblock, diffblock/diffparser, errorblock, statusbar, statusblock, header, confirmprompt, radioselect (all with tests, `internal/ui/components/molecules/`).
- **Apps shipped**: embeddable library (`tui.go` — `tui.New(Config).Run()`), demo mode + component **gallery** (`internal/app/gallery.go`, `just demo`, `just gallery`), and `cmd/agenti-kit` (a larger consumer app with provider onboarding for anthropic/openai/google/ollama, agencies, spec/shape/build/issues commands).
- Recent commits show active polish: expandable parts, thinking italics, click handling, stable tool args, team conversations, surface theme.
- An `_examples/agentic-patterns/main.go` exists — chat-patterns already has a worked example against the agentic-patterns TS backend.

### 6.4 What chat-patterns does NOT have (relevant to parity + migration)
No pattern/capability discovery, no schema-driven forms, no composition inspector, no invocation runner or trace tree, no JSONL replay, no `/capabilities` negotiation (its protocol has no capabilities endpoint), sessions = whatever the backend's conversation endpoints offer (list/continue/branch, all optional).

---

## 7. Half-finished / aspirational items (explicit list)

1. **All five views** in tui-patterns (chat, chattrace, inspector, runner, replay) — doc.go stubs; chat is no further along than the rest.
2. **`cmd/chat-patterns`** — in README layout (`README.md:41`) and Phase 5 plan; directory does not exist.
3. **`contracttest.ValidateJSONCLI`** (and ValidateHTTP/Stdio/JSONL) — fully specified in PROTOCOL.md §12 and Phase 7 issues; zero implementation. The Go snippet in PROTOCOL.md §12 also references a nonexistent root `tui` package (`tui.New(tui.Config{…})`).
4. **`transport/jsonl`** replay transport — doc.go only; replay/recorder are Phase 4.
5. **`ui/molecules`, `ui/widgets`, `shell`** (sidebar/pane/statusbar/palette/toast) — doc.go only (Phase 2/5).
6. **defaultvocab transformer gaps** — `delegation.*`, `llm.*`, `validation.error` events silently dropped despite ChunkTypes existing for them (`transformer/defaultvocab/transformer.go:163-164`).
7. **HTTP client protocol gaps** — no item create/patch, no invocation listing, no ErrorShape decoding, no Accept-Protocol-Version header; stdio client lacks composition/schema/items methods; jsoncli lacks schema/composition/items verbs and streaming exit-code validation (doc.go claims it).
8. **`Capabilities.Extra`** field and chat-patterns' `readResponseSkipNotifications`/`isNotification` — dead code.
9. **Semantic divergence between transformers**: chat transformer treats `message.complete` as Done; defaultvocab does not (waits for `done`) — a backend emitting complete-without-done behaves differently per transformer.
10. **Sessions**: protocol punts to "TUI wraps git" (PROTOCOL.md:868-875) — nothing of that exists; meanwhile chat-patterns' branch/continue picker relies on optional backend conversation endpoints instead.

---

## 8. Implications for the web-chat vs terminal-chat MVP gap analysis

- If MVP parity is wanted **soon**, chat-patterns is the terminal chat: it already covers streaming text, thinking, tool calls with rich rendering (diff/code/bash), delegation/team display, token accounting, slash commands + autocomplete, conversation list/continue/branch, greeting, agent picker, Claude/Gemini CLI passthrough, and an embeddable Go API. Its backend contract is the chat-specific one (agents/conversations/messages + 9 SSE events), with `ValidateBackend`/`ValidateStdioBackend` as the executable conformance floor.
- tui-patterns contributes today only: a stable published wire contract (PROTOCOL.md v0.5.0) that a backend (e.g. `@agentic-patterns/server`) could target ahead of the UI, plus transports that already speak it end-to-end (verified by unit tests, and by `cmd/tui`'s connect banner). Anything that assumes tui-patterns renders something is 2+ phases away.
- The two protocols do not interoperate as-is: different endpoints (`/agents` vs `/patterns/*`; SSE off POST vs separate `/invocations/{id}/events`), different stdio method names (`listAgents/sendMessage` vs `patterns.*/invocations.create`), different notification param shapes. The chat SSE transformer's dual-vocabulary acceptance is the only bridging layer built so far.
