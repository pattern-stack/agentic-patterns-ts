# chat-patterns (Go / Bubble Tea v2 terminal chat UI) — deep-read report

**Repo location read:** `/private/tmp/claude-501/-Users-dug-Projects-sandbox-agentic-patterns-ts/78887b5e-96db-4d36-9c70-9c8ada14bb2b/scratchpad/chat-patterns` (same content also at `/Users/dug/Projects/sandbox/chat-patterns`).
**Module:** `github.com/pattern-stack/chat-patterns`, Go 1.25, ~14.3K lines of Go. Deps: bubbletea v2 (`charm.land/bubbletea/v2`), bubbles v2, lipgloss v2, chroma v2 (syntax highlight), goldmark (markdown), yaml.v3. License BSL 1.1 → Apache 2.0 on 2030-04-10.
**History:** 12 commits, 2026-04-10 → 2026-04-12 (`git log`: "Initial commit — chat-patterns standalone package" through "feat: agenti-kit providers, team conversations, surface theme, and stable tool args"). This is a ~3-day-old extraction, but with real polish in the rendering layer.
**Health:** `go build ./...` passes; `go test ./...` passes (all packages green).

## 1. What it is

A standalone, backend-agnostic terminal chat UI for AI agents. One Go library (`tui.New(Config)` → `app.Run()`, `tui.go:32,130`) that renders a chat conversation driven by any of **five interchangeable transports** behind a single `types.Client` interface (`internal/types/client.go:6-25`):

| Transport | Package | Selected by | Notes |
|---|---|---|---|
| HTTP/SSE | `internal/httpclient/` | `Config.BackendURL` or `Config.BackendService` | full-featured incl. history endpoints |
| Managed local service | `internal/service/` + httpclient | `Config.BackendService` | TUI spawns/health-checks/stops the backend process |
| JSON-RPC 2.0 over stdio | `internal/stdioclient/` | `Config.BackendStdio` | richest event vocabulary (delegation, llm, iteration events) |
| CLI JSONL (Claude Code / Gemini CLI) | `internal/cliclient/` | `Config.BackendCLI` + `Format: FormatClaude\|FormatGemini` | spawns CLI **per message**, parses stream-json |
| Raw exec | `internal/execclient/` | `Config.BackendExec` | pipes prompt to any CLI, streams stdout as text |

Exactly one backend must be set (`tui.go:86-91`). `Config.EnvOverride` names an env var that overrides with an HTTP URL; if the env var is set-but-empty a `StubClient` with canned agents is used (`tui.go:62-67,121-124`; `internal/httpclient/client.go:310-343`).

Public API surface: `tui.go` (App/New/Run/RunGallery), `config.go` (Config, CommandDef, CLIAgentConfig, ExecConfig), `client.go` (factory functions NewHTTPClient/NewStubClient/NewStdioClient/NewCLIClient/NewExecClient), `types.go` (type aliases into `internal/types`), `stdio.go` (StdioConfig), `service.go` (ServiceNode/ServiceStatus re-exports), `theme.go` (Theme token re-exports + DarkTheme/LightTheme).

## 2. Feature inventory (what the TUI actually implements)

### 2.1 App shell & lifecycle
- **Two-phase state machine**: `PhaseSelectAgent` → `PhaseChat` (`internal/app/model.go:25-28`). On start it calls `ListAgents`, shows a j/k/enter agent picker (`internal/app/model.go:241-274`, `viewAgentSelect` 317-383), on enter calls `CreateConversation` and switches to chat. `esc` in chat: clears input if non-empty, else returns to agent select (`internal/app/model.go:277-286`).
- **Greeting support**: `CreateConversationResult.Greeting` renders as first assistant message (`internal/app/model.go:190-193`; only the stdio client actually populates it, `internal/stdioclient/client.go:396-403`).
- **Status bar / legend** with key hints, managed-service health dot (healthy/unhealthy/starting) and a heartbeat spinner (`internal/app/model.go:385-427`, `molecules/statusbar.go`).
- **Managed backend lifecycle**: `ServiceManager.StartAll/StopAll` with process-group SIGTERM→SIGKILL, health polling every 200ms until healthy (30s timeout) then a 3s health tick loop (`internal/service/local.go:84-204`, `manager.go:58-68`). Signal handling for SIGINT/SIGTERM stops services (`tui.go:143-152`).
- **Mouse toggle**: `ctrl+m` flips mouse capture (scroll+click vs terminal-native text selection) (`internal/app/model.go:169-172,311-313`).
- **AltScreen + focus reporting**, hide-cursor re-assert on terminal focus regain (`internal/app/model.go:157-163,309-310`).

### 2.2 Streaming chat (the core)
- **Part-aware message model**: a `Message{Role, Parts[]}` where each `MessagePart` is one of `text | thinking | tool_call | delegation | error | status | waiting` (`internal/chat/model.go:31-102`). Streaming chunks append to the last open part of the same type or open a new part (`appendToParts`, `model.go:773-791`).
- **Token-by-token streaming** via `<-chan StreamChunk` → `readStream` tea.Cmd loop (`model.go:1029-1037`, `handleResponse` 593-741). Waiting placeholder part (spinner) shows until first real chunk (`model.go:557-563`).
- **Skip/fast-forward streaming**: pressing `enter` mid-stream drains the whole channel synchronously and renders the final state (`skipStreaming`, `model.go:867-939`).
- **Two live spinners**: tool spinner (SparseCenter) and thinking spinner (Star), ticking only while streaming (`model.go:576-590`). **Graduated escalation** for long-running tools: subtle <5s → Pulse 5–15s → Heartbeat >15s (`view.go:386-396`). 14+ named spinner presets in `atoms/spinner.go:18-94` and a spinner gallery (`internal/app/spinners.go`).
- **Markdown rendering** of text parts through a custom goldmark→terminal renderer (`internal/ui/goldmark.go`, 901 lines) covering headings, paragraphs, fenced/indented code blocks (chroma-highlighted), blockquotes, lists, list items, thematic breaks, HTML blocks, emphasis, code spans, links, autolinks, images, raw HTML, strikethrough, task checkboxes, and full GFM tables (`goldmark.go:157-184`). **Streaming fixup** closes unterminated fences/bold/italic/strike/links so partial markdown parses cleanly mid-stream (`goldmark.go:30-125`, entry `internal/ui/markdown.go:46-55`). 39 tests in `internal/ui/markdown_test.go`.
- **Thinking parts**: live spinner while streaming; collapsed one-line summary ("thinking: <first line, 60 chars>") when complete; expandable to full markdown with a left border + italics (`view.go:297-353`).
- **Tool-call rendering**: state machine pending/running/complete/error (`model.go:44-52`). Running tools show header + streaming result; completed tools **auto-collapse** to a one-line header with `▸`/`▾` toggle and a summary derived from well-known argument keys (command/path/file_path/pattern/query/url/description) (`view.go:398-542`, `fillToolCallResult` `model.go:851-864`). Expanded view shows quoted `input` (sorted key: value lines) and `output`/`error` blocks (`view.go:469-515`).
- **display_type dispatch** for tool results: `diff` → unified-diff parser + chroma-highlighted DiffBlock; `code` → CodeBlock with language inferred from file path via chroma's lexer matcher (~250 languages, `view.go:702-711`); `bash` → bash-highlighted code block; default plain text (`view.go:564-605`; parser `molecules/diffparser.go:43`).
- **Tool rejection events** render as error parts ("Tool rejected: <name>: <reason>") (`model.go:690-697`).
- **Expand/collapse interactions**: a `Region` table maps rendered visual lines → (message, part) for **mouse click-to-toggle** (`model.go:132-138,965-989`) and **tab/shift+tab keyboard focus cycling** with enter-to-toggle and scroll-into-view (`model.go:497-514,488-495,991-1008`). Region offsets account for soft-wrap (`visualHeight`, `view.go:717-732`).
- **Viewport scrolling**: pgup/pgdn, shift+↑/↓, ctrl+u/d (dual-purpose with input editing), mouse wheel; auto-stick-to-bottom unless the user scrolled up; "↑ N%" scroll indicator in the status line (`model.go:175-204,399-421`; `view.go:79-89`).
- **Input editing**: hand-rolled single buffer (not bubbles/textinput — comment says extraction is prep for swapping later, `internal/chat/input.go:9-10`): multiline via shift+enter/alt+enter/ctrl+j, backspace, word delete (ctrl+w/alt+backspace), line clear (ctrl+u/super+backspace), paste via `tea.PasteMsg` (blocked during streaming), soft-wrapped display with `you:` prefix (`model.go:409-527`, `view.go:37-102`).
- **Error handling**: stream errors and fatal chunks append error/assistant messages and stop streaming (`model.go:596-601,699-706`).

### 2.3 Slash commands + autocomplete
- Registry with names, aliases, categories, hidden flag, insertion-order listing, prefix + Levenshtein fuzzy `Suggest` (`internal/command/registry.go`). Parser supports quoted tokens, `-f` flags, `--key=val` / `--key val` options (`internal/command/parse.go`).
- Built-ins: `/help` (`/h`, `/?`), `/clear` (`/c`), `/agents` (`/a` → back to agent select), `/quit` (`/q`) (`internal/command/commands.go:32-77`).
- Consumers register custom commands via `Config.Commands` (`tui.go:187-213`); handlers return `tea.Cmd` and can emit `command.SystemMsg` to print into the chat.
- **Autocomplete dropdown**: typing `/` opens a filtered list (max 6 visible), arrows to navigate, enter/tab to accept, live refinement while typing (`internal/ui/autocomplete/autocomplete.go`; keyboard plumbing `internal/chat/model.go:432-475,516-524`).

### 2.4 Multi-agent / team conversations (stdio only)
- `Client.CreateTeamConversation(AgencyConfig{Name, Agents[]{Role, IsCoordinator, Model, MaxTurns}})` (`internal/types/types.go:38-50`, `client.go:17-18`). **Only the stdio client implements it** — HTTP, CLI, exec, demo, stub all return "team conversations not supported" errors (`httpclient/client.go:199-201`, `cliclient/client.go:78-80`, `execclient/client.go:57-59`).
- Stdio client sends `createTeamConversation` and remembers the conversation ID so subsequent sends use `sendTeamMessage` instead of `sendMessage` (`stdioclient/client.go:406-449`).
- App-side: a custom command can return `command.TeamConversationMsg{Agency}`; the app creates a fresh chat model and team conversation (`internal/app/model.go:213-221`).
- **Delegation rendering**: `delegation.start/.end` stream events create `PartDelegation` blocks (agent badge + message summary); events tagged with `agent_id` route into the delegation's nested `SubParts` (text/thinking/tools of the sub-agent) rendered inside a left-bordered container; completed delegations auto-collapse (`model.go:141-146,647-689,753-769`; `view.go:607-690`). Also `iteration.start/end` and `llm.start/llm.end` events render as dim status lines ("iteration 2", "calling <model>...", "↳ 1,234 in / 56 out tokens") (`model.go:708-722`).
- Reference consumer: `cmd/agenti-kit` — an SDLC tool that spawns `python -m agentic_patterns.app.tui.bridge` over stdio and registers `/shape`, `/spec`, `/build` (each launching a hard-coded team of Sonnet agents, `cmd/agenti-kit/agencies.go`), `/issues` (shells out to `gh issue`), `/settings`, `/providers` (parallel probing of Claude CLI, Anthropic/OpenAI keys, Codex CLI, Gemini CLI, Ollama with config persisted; `cmd/agenti-kit/providers/`).

### 2.5 Themes
- Token-based theme system: 9 category colors (default/agent/system/tool/user/cat5–8), 7 statuses (success/error/warning/info/muted/running), foreground/background/dim/surface (`internal/ui/theme/theme.go:10-18`, resolve logic 27-60). Styles are `{Category, Hierarchy(Primary..Quaternary), Emphasis, Status}` tokens resolved to lipgloss.
- Two embedded YAML themes (`themes/dark.yml` Dracula-ish, `themes/light.yml`; `themes/embed.go`), loadable YAML files (`theme/loader.go:91-97`), a registry with `Register`/`SetActive` (`theme/registry.go`), **auto light/dark detection** via `lipgloss.HasDarkBackground` with custom theme override through `Config.Theme` (`tui.go:41-47`).

### 2.6 Component library (atomic design)
- Atoms (10, each with tests): badge, codeblock (chroma), highlight, icon, inlinecode, separator, spinner, table, textblock (`internal/ui/components/atoms/`).
- Molecules (11, each with tests): confirmprompt, diffblock, diffparser, errorblock (message+suggestions), header, messageblock, radioselect, statusbar, statusblock, toolcallblock (`internal/ui/components/molecules/`).
- ConfirmPrompt and RadioSelect exist as render functions but **no chat flow uses them** (no approval/HITL gate wired into the chat loop).

### 2.7 Demo & gallery modes (no backend)
- `DemoClient` replays scripted conversations from JSON fixtures with realistic word-by-word timing, thinking pauses, tool durations, tool_reject and error parts (`internal/demo/client.go`; fixtures `demo/fixtures/demo-parts.json`, `demo.json`). `DemoRunner` pre-fills the next user message after each turn (`internal/app/demo.go`).
- Component gallery (`internal/app/gallery.go`, 471 lines) and spinner gallery (`internal/app/spinners.go`). Justfile recipes: `just demo | gallery | spinners | claude | gemini | echo | kit | build | test | quality`.
- `render_demo_test.go` snapshot-renders the demo script through the real pipeline.

## 3. Wire/transport contracts

### 3.1 HTTP/SSE (PROTOCOL.md §HTTP + `internal/httpclient`)
Endpoints (paths overridable via `EndpointConfig`, `internal/types/types.go:174-182`):
- `GET /health` → `{"status":"ok"}` (optional)
- `GET /agents` → `[{id,name,role}]`; **legacy fallback**: if the response is `["name",...]`, the client fetches `GET /agents/{name}` per agent for `{name, role_name, mission}` details (`httpclient/client.go:110-168`)
- `POST /conversations` `{agent_name, model?}` → 201 `{id, agent_name, model, state, exchange_count, total_input_tokens, ...}` (client only uses `id`)
- `POST /conversations/{id}/send` (code default, `httpclient/client.go:32`) with body `{"message": "..."}` (`types.go:111-114`), `Accept: text/event-stream` → SSE stream. **PROTOCOL.md instead documents `POST /conversations/{id}/messages` with body `{"content": "..."}` (PROTOCOL.md:32,63-67) — the shipped client defaults disagree with the spec doc on both path and body field.** The contracttest suite (`contracttest/validate.go:106-127`) tests the `/messages` + `{"content"}` shape, i.e. it validates the documented contract, not what `HTTPClient` actually sends by default.
- `GET /conversations?agent_name=` → `[Conversation]` (id, agent_name, state, exchange_count, token totals, branched_from_id?, branched_at_sequence?, timestamps)
- `GET /conversations/{id}` → full detail with `messages[]{id, kind(human|ai), sequence, parts[]{type, content}}`

SSE events accepted (`internal/sse/parse.go:60-153`; parser at `parse.go:15-56`, 16-buffered channel, treats connection close as implicit done):
- `message.delta` / `agent.message.chunk` → `{"delta"}` → ChunkText
- `message.complete` / `agent.message.complete` → treated purely as Done (assembled content and token counts are **ignored** — `SSEMessageCompleteData` in `sse/types.go:12-16` is dead)
- `thinking` / `agent.reasoning` → `{"content"}` → ChunkThinking
- `tool.start` / `agent.tool.start` / `tool_start` → `{tool_call_id, tool_name, display_type, arguments, input}` → ChunkToolStart
- `tool.end` / `agent.tool.end` / `tool_end` → `{tool_call_id, result|output, error, duration_ms, display_type}` → ChunkToolEnd
- `agent.tool.rejected` → `{tool_name, reason}` → ChunkToolReject. **The canonical `tool.rejected` name from PROTOCOL.md:176-189 is NOT handled — only the legacy alias parses.**
- `agent.iteration.start/.end` → ChunkIteration (which the chat model's switch never handles — no-op)
- `error` / `agent.error` → `{error_type, message}` → terminal error chunk
- `done` → Done. Unknown events silently dropped.

Display types: `generic | diff | code | bash` (PROTOCOL.md:220-231).

### 3.2 JSON-RPC 2.0 stdio (`internal/stdioclient`, PROTOCOL.md §stdio)
Newline-delimited JSON-RPC over subprocess stdin/stdout. Requests: `listAgents`, `createConversation {agent_id}` (result may include `greeting`), `sendMessage {conversation_id, content}`, `createTeamConversation {agency}` (undocumented in PROTOCOL.md), `sendTeamMessage` (undocumented), optional `listConversations`/`getConversation` (graceful nil on `-32601`). Streaming arrives as `stream.event` notifications `{type, data}` reusing the SSE vocabulary **plus stdio-only events** (`stdioclient/client.go:165-342`): `delegation.start {from,to,content}`, `delegation.end {from,result}`, `iteration.start {iteration}`, `iteration.end`, `llm.start {model}`, `llm.end {model,input_tokens,output_tokens}` — none of which appear in PROTOCOL.md. Tool events accept both `tool_call_id|id` and `tool_name|name` field spellings (commit ec89cf6 fixed this). Optional `agent_id`/`agent_name` on any event routes it to a delegation (`client.go:143-152`). Lifecycle: pending-request map keyed by id, single active stream channel (a second concurrent SendMessage would clobber `c.streamCh`), SIGTERM+5s→SIGKILL shutdown (`client.go:539-563`). 8 tests with a fake subprocess (`client_test.go`).

### 3.3 CLI JSONL (`internal/cliclient`) — Claude Code & Gemini
- Spawns `<command> <args...> <prompt>` **per message**; stdout scanned line-by-line (1MB max line), stderr passthrough; Done emitted on process exit (`client.go:83-133`).
- **ClaudeParser** (`claude.go`) handles `claude -p --output-format stream-json --verbose --include-partial-messages`: `stream_event` inner events (`content_block_start` for `tool_use`/`thinking`, `content_block_delta` for `text_delta`/`thinking_delta`/`input_json_delta` with per-index partial-JSON accumulation, `content_block_stop` finalizing tool args), `assistant` messages (full tool_use args update + tool_result), `user` messages (tool_result blocks, string or content-block-array, is_error flag). Tool display types are hardcoded per Claude tool name: Bash→bash, Edit/Write→diff, Read/Glob/Grep→code, else generic (`claude.go:329-340`).
- **Session continuity is NOT implemented**: `system.init`'s `session_id` is explicitly ignored ("session management not needed", `claude.go:91`) and no `--resume`/`--continue` is added, so **every message spawns a fresh Claude process with no memory of the conversation** unless the consumer bakes continuation flags into `Args` themselves. Same for Gemini. This is the biggest functional gap of the CLI transport for a chat product.
- **GeminiParser** (`gemini.go`) is a simplified Claude-shaped parser (text deltas + tool_use start + tool_result; no thinking, no arg accumulation) with an explicit `TODO: Verify exact Gemini CLI stream-json format against real output` (`gemini.go:13`) — i.e. Gemini support is speculative/untested against the real CLI.
- **Zero tests** for either parser.

### 3.4 Raw exec (`internal/execclient`)
Spawns command per message; prompt as last arg or piped to stdin (`PromptViaStdin`); stdout read in 256-byte chunks emitted as ChunkText, rendered through markdown. No tools/thinking/history. No tests.

### 3.5 Contract test kit (`contracttest/`)
`ValidateBackend(t, baseURL)` (HTTP: health, list agents, create conversation, send message returns `text/event-stream`) and `ValidateStdioBackend(t, cmd, args...)` (listAgents/createConversation/sendMessage stream with message.delta + done). Self-tested against an in-process HTTP server and the Python example agent.

## 4. State management

- All UI state lives in Bubble Tea models: `app.Model` (phase, agents list, health map, demo/gallery flags) and `chat.Model` (messages, parts, input buffer, viewport, regions, focusedRegion, activeDelegations stack, streaming flag, streamCh). No persistence of any kind — **no local history storage; chat history is in-memory only and lost on exit.**
- Conversation identity is a single `conversationID` string on the chat model; server-side context is the only continuity mechanism (works for HTTP and stdio; absent for CLI/exec transports as noted).
- Delegation routing: a stack of `delegationContext{msgIdx, partIdx, agentID}` matches `chunk.AgentID` to nest sub-agent events (`internal/chat/model.go:141-146,753-769`).
- Region table rebuilt on every render for click/keyboard hit-testing in visual-line space (`model.go:304-342`, `view.go:188-245`).

## 5. Maturity assessment — works vs. stubbed/dead

### Solid and working
- Streaming chat with part-aware rendering, markdown, syntax highlighting, thinking/tool collapse-expand, spinner graduation, scrollback, autocomplete, slash commands, themes, demo/gallery — this is the polished core (evidenced by the commit history being mostly rendering fixes, and 100+ tests across atoms/molecules/markdown/chat/sse/stdio).
- Stdio transport incl. team conversations and delegation rendering (feature-complete relative to the UI).
- HTTP/SSE happy path (streaming, tool events) with legacy event-name compatibility.
- Managed service lifecycle + health bar.

### Half-finished / aspirational / dead code
1. **Conversation history/resume/branch UI is dead code.** `chat.PickerModel` (`internal/chat/picker.go`, 237 lines) implements a full "CONVERSATIONS" picker with New/Continue/**Branch** actions, branch badges, exchange counts — but **nothing ever instantiates it**: `app.Model` has no picker phase and never sends `ConversationsLoadedMsg`/handles `ConversationSelectedMsg` (grep: only defined in picker.go). Likewise `Client.ListConversations`/`GetConversation` are implemented in http+stdio transports but never called by any UI path, and `chat.Model.ExchangeCount`/`IsBranch` header badges (`view.go:128-142`) are never set by anyone. Branch metadata types (`BranchedFromID`, `BranchedAtSequence`, `ConversationDetailResponse.Messages`) exist in `internal/types/types.go:127-166` with no consumer. **So: no way to list, resume, replay, or branch a past conversation from the TUI today**, despite the plumbing existing at every layer below the UI.
2. **CLI transport has no session continuity** (see §3.3) — multi-turn chat with Claude Code via `just claude` is stateless per message.
3. **Gemini parser is unverified** (explicit TODO, `internal/cliclient/gemini.go:13`); no thinking/args accumulation; zero tests.
4. **`Config.OnReady` is declared but never invoked** (`config.go:43-44`; only other mention is a comment in `cmd/agenti-kit/main.go:18` that pretends it's used).
5. **PROTOCOL.md drift**: documented send path `/conversations/{id}/messages` + body `{"content"}` vs. implemented default `/conversations/{id}/send` + body `{"message"}` (`httpclient/client.go:32`, `types.go:111-114`); canonical `tool.rejected` event not parsed (only `agent.tool.rejected`); `message.complete` token counts documented but discarded; stdio-only events (delegation/iteration/llm, createTeamConversation/sendTeamMessage) undocumented. README architecture section also claims "10 atoms" (there are 9 atom source files + context) — minor.
6. **Team conversations only work over stdio**; every other transport errors. The HTTP protocol has no team endpoint at all.
7. **ConfirmPrompt / RadioSelect molecules unused** — no human-in-the-loop approval flow in the chat loop (tool.rejected is display-only; the TUI cannot approve/deny anything).
8. **Token/usage display**: only via stdio `llm.end` events; SSE `message.complete` token counts dropped; no cumulative usage UI.
9. **Untested packages**: httpclient, cliclient, execclient, command, app, service, demo, autocomplete, theme have no test files (`go test ./...` output). Tested: chat (9), sse (12), stdioclient (8), ui/markdown (39), all atoms/molecules, contracttest.
10. **Concurrency roughness**: stdioclient supports one in-flight stream (`c.streamCh` overwritten per SendMessage); `formatNumber` etc. fine; `ChunkIteration` (SSE `agent.iteration.*`) maps to a chunk type the chat model ignores.
11. **Hand-rolled input** flagged for replacement with bubbles/textinput (`internal/chat/input.go:9-10`); no input history (up-arrow recall), no cursor movement within the line (append/delete-only editing).

### Feature parity checklist vs. a typical React web chat (for the gap analysis)
- Streaming text: **yes**. Thinking: **yes** (collapsible). Tool calls with args/results, diff/code/bash rendering: **yes**. Markdown+tables+syntax highlight: **yes**. Multi-turn within a session: **yes** (HTTP/stdio), **no** (CLI/exec). Conversation list/resume/branch: **transport-ready, UI missing (dead picker)**. Multi-conversation/tabs: **no** (single active conversation). Teams/multi-agent with delegation UI: **yes, stdio only**. Slash commands + autocomplete: **yes**. Themes: **yes**. Attachments/images: **no**. Message editing/regenerate/stop-generation (as opposed to skip-to-end): **no** (enter skips animation but the backend request isn't cancelled — `context.Background()` is used for SendMessage, `model.go:568`). Approval prompts: **no**. Token usage display: partial (stdio only). Persistence: **none client-side**.

## 6. Key file map (for navigation)
- Public: `tui.go`, `config.go`, `client.go`, `types.go`, `stdio.go`, `service.go`, `theme.go`, `PROTOCOL.md`, `README.md`
- Chat core: `internal/chat/model.go` (1053 ln, state+stream handling), `internal/chat/view.go` (732 ln, rendering), `internal/chat/picker.go` (dead), `internal/chat/input.go`
- App shell: `internal/app/model.go`, `demo.go`, `gallery.go`, `spinners.go`
- Transports: `internal/httpclient/client.go`, `internal/sse/{parse,types}.go`, `internal/stdioclient/{client,jsonrpc}.go`, `internal/cliclient/{client,claude,gemini}.go`, `internal/execclient/client.go`, `internal/service/{local,manager,node}.go`, `internal/demo/client.go`
- UI kit: `internal/ui/{markdown,goldmark}.go`, `internal/ui/autocomplete/`, `internal/ui/components/{atoms,molecules}/`, `internal/ui/theme/`, `themes/*.yml`
- Consumers: `cmd/agenti-kit/` (stdio bridge to agentic-patterns Python + provider probing), `_examples/{claude-code,gemini,minimal,stdio-python,stdio-typescript,custom-commands,custom-theme,agentic-patterns,claude,demo}/`
- Validation: `contracttest/`
