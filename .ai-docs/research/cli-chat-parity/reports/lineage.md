# Lineage report: chat-patterns vs tui-patterns (pattern-stack Go terminal repos)

Reader slice: relationship between the two Go repos, full git histories, PROTOCOL.md
comparison, shared-code forensics, and a recommendation for which repo is the base going
forward. Local clones (unshallowed to full history):

- `chat-patterns` → https://github.com/pattern-stack/chat-patterns.git — clone at
  `/private/tmp/claude-501/-Users-dug-Projects-sandbox-agentic-patterns-ts/78887b5e-96db-4d36-9c70-9c8ada14bb2b/scratchpad/chat-patterns`
- `tui-patterns` → https://github.com/pattern-stack/tui-patterns.git — clone at
  `/private/tmp/claude-501/-Users-dug-Projects-sandbox-agentic-patterns-ts/78887b5e-96db-4d36-9c70-9c8ada14bb2b/scratchpad/tui-patterns`

All file:line anchors below are relative to those clone roots.

---

## 1. Verdict up front

**chat-patterns is the parent; tui-patterns is a deliberate, planned re-extraction of it
into a generalized framework — and tui-patterns is the intended living lineage, but it is
only ~10% built.** The repos are 100% same-author (Doug/"Dug", two machines' git
identities), three days apart. tui-patterns' own roadmap
(`tui-patterns/scripts/bootstrap-issues.sh`, a 7-phase GitHub epic bootstrapper) states
that chat-patterns will eventually *move into* tui-patterns as `cmd/chat-patterns` in
"Phase 5 — Chat Port" (`tui-patterns/cmd/chat-patterns/README.md:3`). Today, however,
**chat-patterns is the only repo with a working end-to-end chat TUI** (14.3k LOC, 5
transports, full part-aware chat rendering, a real consumer app); tui-patterns is 4.2k
LOC of foundation (transports, atoms, theme, protocol DTOs) whose entire UI layer —
molecules, widgets, all five views, the shell, the conformance suite — is doc.go
placeholder packages, and whose `cmd/tui` binary only prints a "Connected" banner
(`tui-patterns/cmd/tui/main.go:79`: `fmt.Println("(sidebar + detail pane — Phase 2)")`).

**Recommendation for a terminal-chat MVP:** treat **chat-patterns as the functional base**
(it is the only thing that can render a chat today) while treating **tui-patterns'
PROTOCOL.md v0.5.0 as the contract of record** for anything new on the wire. Detail and
caveats in §8.

---

## 2. Git history comparison

### chat-patterns — 12 commits, 2026-04-10 → 2026-04-12 (3 days)

```
e922286 2026-04-10 10:57 Doug <dug@Dougs-MacBook-Pro.local>  Initial commit — chat-patterns standalone package
edbe084 2026-04-10 11:01 Doug  fix: tool call args, code block padding and truncation
e0c7a63 2026-04-10 11:26 Doug  fix: accumulate tool call args from input_json_delta events
46e6d3c 2026-04-10 11:30 Doug  fix: parse tool results from user messages, show check/x on complete
ec89cf6 2026-04-10 12:15 Doug  fix: stdio client tool event parsing — accept both protocol field names
c4c2c6c 2026-04-10 12:23 Doug  fix: enable mouse scroll in terminal
0c93dd1 2026-04-10 13:08 Doug  feat: support greeting message from CreateConversation
1bd238a 2026-04-12 01:12 Dug   feat: agenti-kit app + expandable parts for tool calls and thinking
9beb90d 2026-04-12 21:05 Dug   fix: expand/collapse click handling and thinking block rendering
995f4ce 2026-04-12 21:14 Dug   fix: tool call expand/collapse for all states + input/output sections
3bac4e1 2026-04-12 21:57 Dug   fix: italicize thinking text and separate tool call input/output sections
187411b 2026-04-12 22:07 Dug   feat: agenti-kit providers, team conversations, surface theme, and stable tool args  ← HEAD
```

- Single author (Doug; "Doug <dug@Dougs-MacBook-Pro.local>" and "Dug <dug@Mac.localdomain>"
  are the same person on two machines). One branch (`main`), no tags.
- The "Initial commit — chat-patterns **standalone package**" message implies the code was
  extracted from somewhere earlier (likely a TUI living inside the Python
  `agentic-patterns` repo — the stdio bridge default is
  `python -m agentic_patterns.app.tui.bridge`, `chat-patterns/cmd/agenti-kit/main.go:28-29`),
  but within the visible universe chat-patterns is the origin repo.
- Last commit (2026-04-12) shipped **agenti-kit** — a full consumer app inside
  `cmd/agenti-kit/` (see §5.4) — plus multi-agent team conversations and theme surface color.
- **Dormant since 2026-04-12** (as of 2026-07-19: ~3 months).

### tui-patterns — 7 commits, all on 2026-04-15 (one day)

```
b2a90f6 2026-04-15 09:11 Dug  chore: initial scaffold
a630d3d 2026-04-15 09:16 Dug  docs: add PROTOCOL.md v0.5.0
e4df403 2026-04-15 09:25 Dug  chore: add bootstrap-issues.sh for phase tracking
19c31ae 2026-04-15 14:00 Dug  feat(ui,theme): port atoms and theme system from chat-patterns   ← smoking gun
8e3f680 2026-04-15 14:01 Dug  feat(types,protocol,shell): add stream types, protocol DTOs, slash-command registry
6c354f7 2026-04-15 14:01 Dug  feat(transport): SSE parser with EventTransformer, HTTP/stdio/jsoncli clients
d85c9cd 2026-04-15 14:01 Dug  feat(cmd/tui): wire connect flow for --backend / --stdio / --jsoncli  ← HEAD
```

- Same single author, one branch, no tags. Created **3 days after** chat-patterns' last
  commit; PROTOCOL.md was written *before* any code (commit 2 of 7).
- Commit `19c31ae` literally says "**port atoms and theme system from chat-patterns**".
- Also **dormant since 2026-04-15** (~3 months). Neither repo is actively alive; the
  question is which *design* is the living lineage, and that is unambiguously tui-patterns
  (it was created to supersede, and its roadmap absorbs chat-patterns).

### Direction of flow

Everything flows chat-patterns → tui-patterns. There are zero references to tui-patterns
inside chat-patterns (grep over all .go/.md files: no hits). tui-patterns references
chat-patterns constantly: README repo-layout (`tui-patterns/README.md:37`), the Phase-5
placeholder (`tui-patterns/cmd/chat-patterns/README.md:1-5`), fifteen "Port … from
chat-patterns" issue bodies in `scripts/bootstrap-issues.sh` (e.g. lines 253-348), and the
legacy-vocabulary SSE transformer named `chat`
(`tui-patterns/transport/sse/transformer/chat/transformer.go:1-4`: "legacy chat-patterns
event vocabulary transformer … accepts both `agent.*` and PROTOCOL.md v0.5.0 names").

---

## 3. Shared / copied code forensics

Confirmed via file-level diffs — tui-patterns is a *copy-with-cleanup*, not a git fork
(histories share no commits; code was re-committed fresh):

| Surface | chat-patterns | tui-patterns | Diff verdict |
|---|---|---|---|
| Theme tokens | `internal/ui/theme/tokens.go` | `theme/tokens.go` | **byte-identical** |
| Theme core | `internal/ui/theme/theme.go` | `theme/theme.go` | identical minus comments/gofmt |
| Theme YAML files | `themes/dark.yml`, `themes/light.yml` | same paths | **byte-identical** |
| Theme registry | `internal/ui/theme/registry.go` | `theme/registry.go` | tui adds env-based light/dark auto-detect (`TUI_THEME`, `COLORFGBG`), `theme/registry.go:26-46` |
| 8 atoms (badge, codeblock, highlight, icon, inlinecode, separator, spinner, table) + tests | `internal/ui/components/atoms/` | `ui/atoms/` | identical minus import path + trimmed comments |
| Slash-command registry/parser (incl. Levenshtein fuzzy autocomplete) | `internal/command/` | `shell/command/` | identical logic, comments trimmed |
| SSE parser | `internal/sse/parse.go` (hardcoded chat vocabulary via `ChunkFromSSE`) | `transport/sse/parse.go` | **generalized**: vocabulary-free `ParseFrames` + pluggable `EventTransformer` interface (`transport/sse/parse.go:11-28`), 1 MiB scanner buffer, SSE `id:` support |
| StreamChunk type | `internal/types/types.go:53-73` | `types/stream.go:30-62` | superset: adds `MessageID`, `ChunkProgress`, `ChunkValidation`, progress fields |
| Stdio JSON-RPC client | `internal/stdioclient/` | `transport/stdio/` | rewritten with new method names (`capabilities`, `patterns.kinds`, `patterns.list`, `patterns.get`, `invocations.create`, `stream.event` — `transport/stdio/client.go:201-263`) |
| HTTP client | `internal/httpclient/client.go` (agents/conversations endpoints) | `transport/http/client.go` (capabilities/patterns/invocations endpoints) | rewritten against new protocol |

New in tui-patterns with no chat-patterns ancestor: `protocol/` DTO package
(`protocol/capabilities.go`, `protocol/patterns.go`), `transport/jsoncli/` (spawn
`<cli> … --json [--stream]`, NDJSON streaming — 245 LOC + 199 LOC tests), and the two SSE
transformers (`defaultvocab` for PROTOCOL v0.5.0 names, `chat` for legacy names).

---

## 4. PROTOCOL.md section-by-section comparison

The two protocols are **different generations, not siblings**. chat-patterns' is a chat
backend contract; tui-patterns' v0.5.0 is a superset "HTTP for terminals" that demotes
chat to "one capability shape among many" (`tui-patterns/PROTOCOL.md:44`).

### 4.1 chat-patterns PROTOCOL.md (13.6 KB, unversioned)

**HTTP endpoints** (`chat-patterns/PROTOCOL.md:27-34`; paths overridable via
`EndpointConfig`, `chat-patterns/internal/types/types.go:174-182`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{"status":"ok"}` (optional) |
| GET | `/agents` | `AgentSummary[]` `{id,name,role}` |
| POST | `/conversations` | body `{agent_id}` → `{id, agent_id}` |
| POST | `/conversations/{id}/messages` | body `{content}` → **SSE stream** |
| GET | `/conversations?agent_name=` | `Conversation[]` (optional) |
| GET | `/conversations/{id}` | detail w/ part-aware messages (optional) |

⚠ Spec/code drift: the doc says the send path is `/conversations/{id}/messages` with body
key `content` (`PROTOCOL.md:32,66`), but the implementation defaults to
`/conversations/{id}/send` with body key `message`
(`internal/httpclient/client.go:32`, `internal/types/types.go:111-114`) — tuned for the
Python agentic-patterns orchestrator (`_examples/agentic-patterns/main.go:9-10`).

**SSE event vocabulary** (`PROTOCOL.md:76-217`): `message.delta {delta}`,
`message.complete {content, input_tokens?, output_tokens?}`, `thinking {content}`,
`tool.start {tool_call_id, tool_name, display_type?, arguments?}`, `tool.end
{tool_call_id, result?, error?, duration_ms?, display_type?}`, `tool.rejected {tool_name,
reason}`, `error {error_type, message}`, `done {}`. Legacy aliases accepted:
`agent.message.chunk`, `agent.message.complete`, `agent.reasoning`, `agent.tool.*`,
`tool_start`/`tool_end`, `agent.error` (`PROTOCOL.md:377-390`).

**Display types**: `generic | diff | code | bash` (`PROTOCOL.md:222-231`).

**Stdio transport** (`PROTOCOL.md:235-346`): JSON-RPC 2.0, newline-delimited. Methods:
`listAgents`, `createConversation`, `sendMessage` (events stream as `stream.event`
notifications reusing the SSE vocabulary, then a final response), optional
`listConversations` / `getConversation`. The implementation additionally supports
`createTeamConversation` (`internal/stdioclient/client.go:406-409`) — **undocumented in
the protocol** (multi-agent teams shipped in the last commit and never got spec'd).

**Streaming lifecycle** (`PROTOCOL.md:349-374`): deltas in order; tool start/end paired by
`tool_call_id` (may overlap); `message.complete` after all deltas; `done` terminal;
`error` terminates without `done`.

Ends with a "backend in 30 minutes" Python walkthrough + contract-test hooks
(`contracttest.ValidateBackend` / `ValidateStdioBackend`) — both **actually implemented
and passing** (`chat-patterns/contracttest/validate.go:17`, `validate_stdio.go:17`).
(Nit: the walkthrough's import paths say `github.com/dugshub/chat-patterns`,
`PROTOCOL.md:444,482` — pre-rename leftover.)

### 4.2 tui-patterns PROTOCOL.md v0.5.0 (35.7 KB, semver'd, pre-stable)

New vocabulary layer: **Pattern** (named object grouped by *kind*: agent/workflow/
subsystem/noun), **Capability** (invocable op on a pattern), **Invocation** (execution →
event stream), **Composition** (atom tree: `slot`/`kind`/`preview`/`raw` +`assembled`),
**Item** (instance in a collection pattern), **Schema** (JSON Schema draft-07 with
`x-ui-*` form extensions) (`tui-patterns/PROTOCOL.md:30-44`).

**HTTP endpoints** (`PROTOCOL.md:52-66`):

| Method | Path | Required |
|---|---|---|
| GET | `/capabilities` | yes — entry point, capability negotiation |
| GET | `/patterns` → `{"kinds":[...]}` | yes |
| GET | `/patterns/{kind}` → `PatternSummary[]` | yes |
| GET | `/patterns/{kind}/{name}` → `PatternDetail` | yes |
| GET | `/patterns/{kind}/{name}/composition` | if advertised |
| GET | `/patterns/{kind}/{name}/schema` | if advertised |
| GET/POST/PATCH | `/patterns/{kind}/{name}/items[/{id}]` | if collection-valued |
| POST | `/invocations` (`{kind,pattern,capability,input,stream}`) → `{invocation_id}` | yes |
| GET | `/invocations/{id}/events` | yes — SSE stream |
| GET | `/invocations?pattern=&kind=` | no |

Uniform error shape `{"error":{code,message,details}}` (`PROTOCOL.md:70-82`).
Capabilities response advertises protocol_version, server name/version, pattern kinds,
composition/schema/items flags, streaming mode (`sse|ndjson|line-buffered|none`), the full
event list the backend may emit, JSON-Schema draft + `x-ui-*` extensions, and feature
flags (`multi_agent`, `cost_accounting`, `sessions`) (`PROTOCOL.md:92-157`).

**Event vocabulary** (`PROTOCOL.md:526-724`) — every event now enveloped as
`{type, ts, data}`; SSE `event:` line must equal `type`; optional `id:` for resumption
(`PROTOCOL.md:779-788`). Required: `message.delta` (now with `message_id`),
`message.complete`, `tool.start`, `tool.end`, `iteration.start`, `iteration.end`,
`error` (now `{code,message,retryable}`), `done`. Optional: `thinking`,
`delegation.start/end`, `llm.start/end` (model, tokens, cost), `validation.error`,
`progress.update`. `display_type` grows to `generic|code|diff|bash|json|table`
(`PROTOCOL.md:616`). Notably **`tool.rejected` was dropped** from v0.5.0 (the legacy
`chat` transformer still parses `agent.tool.rejected`, `transformer/chat/transformer.go:95`).

**Forms** (`PROTOCOL.md:340-488`): JSON Schema draft-07 → widget mapping table (text,
textarea, toggle, radio, picker, date, number, multi-select, kv-editor, repeater) plus
`x-ui-widget|label|help|group|visible|picker|preview` extensions, incl. JSONLogic
conditional visibility and async picker option sources.

**Four transport bindings** (`PROTOCOL.md:773-864`): HTTP+SSE (canonical); JSON-RPC stdio
with renamed methods (`capabilities`, `patterns.kinds`, `patterns.list`, `patterns.get`,
`patterns.composition`, `patterns.schema`, `items.list`, `invocations.create`,
`stream.event` notifications now carrying `{invocation_id, event}`); **jsoncli**
(spawn `<cli> <kind> <capability> <pattern> --json [--stream]`, NDJSON, exit-code rules);
**jsonl replay** (recorded streams with `replay.header` + `replay.gap_ms` pacing —
transport package is doc-stub only, `transport/jsonl/doc.go`).

**Sessions**: explicitly a non-feature in 0.5.0; TUI-local git wrapping instead
(`PROTOCOL.md:868-875`). **Composition is read-only** in 0.5.0; `PATCH …/composition`
promised for 0.6+ (`PROTOCOL.md:336`).

The doc names the intended backend emitters: Python `backend-patterns` (pydantic
`Field()` metadata → `x-ui-*`) and TypeScript `codegen-patterns`
(`generate-json-schema.ts` from Zod `.describe()`) (`PROTOCOL.md:448-452`).

### 4.3 Migration mapping (old → new)

| chat-patterns | tui-patterns v0.5.0 |
|---|---|
| implicit contract, no version | `GET /capabilities` + semver + soft-degrade rules |
| `/agents` | `/patterns/agent` (agents are just a pattern kind) |
| `POST /conversations` + `POST …/messages` | `POST /invocations` + `GET /invocations/{id}/events` (2-step) |
| bare event payloads | `{type, ts, data}` envelope, `message_id` on deltas |
| `tool.rejected` | dropped (no v0.5.0 equivalent) |
| — | `iteration.*` now *required*; `delegation.*`, `llm.*`, `progress.update`, `validation.error` added |
| 4 display types | 6 (adds `json`, `table`) |
| stdio `listAgents`/`createConversation`/`sendMessage` | stdio `capabilities`/`patterns.*`/`invocations.create` |
| — | forms/JSON-Schema layer, composition/inspector layer, jsoncli + jsonl bindings |

---

## 5. Feature inventory — chat-patterns (the working product, 14,314 LOC Go)

### 5.1 Public embedding API
- `tui.New(Config)` → `App.Run()` (`tui.go:32-173`); gallery mode `App.RunGallery()`
  (`tui.go:176-185`).
- `Config` (`config.go:14-45`): `AppName` (required), `AssistantLabel`, exactly one of
  five backends, `EnvOverride` (env var URL override; empty-set env yields a canned
  `StubClient` with 3 fake agents, `tui.go:121-123`,
  `internal/httpclient/client.go:310-343`), custom `Theme`, custom slash `Commands`
  (name/aliases/description/category/hidden/handler, `config.go:48-67`), endpoint path
  overrides, `OnReady` hook.

### 5.2 Five transports behind one `types.Client` interface
1. **HTTP/SSE** `internal/httpclient/client.go` — list agents (canonical `AgentSummary[]`
   *or* legacy `[]string` + per-agent detail fetch, lines 110-145), create conversation,
   SSE-streamed send (30s timeout on REST, unbounded for streams, lines 203-249),
   list/get conversations. Team conversations unsupported (`client.go:199-201`).
2. **JSON-RPC stdio** `internal/stdioclient/` (840 LOC + tests) — subprocess spawn,
   `listAgents`/`createConversation`/`createTeamConversation`/`sendMessage`;
   accepts both protocol field-name variants for tool events (commit ec89cf6).
3. **CLI JSONL** `internal/cliclient/` (651 LOC) — **built-in Claude Code parser**
   (`claude.go`: full `stream-json` handling — text/thinking deltas,
   `input_json_delta` tool-arg accumulation via per-index pending tools, tool results
   parsed out of user messages, session events) and a **Gemini CLI parser**
   (`gemini.go` — flagged `TODO: Verify exact Gemini CLI stream-json format`, line 13).
4. **Raw exec** `internal/execclient/` (133 LOC) — pipe prompt to any CLI (arg or stdin),
   render stdout as markdown.
5. **Demo** `internal/demo/client.go` — scripted conversations incl. structured parts
   (tool calls with display types, thinking, errors) for the `just demo` replay.

Plus **ServiceManager** (`internal/service/`, 310 LOC): auto-start/stop a local backend
process (`BackendService`), health polling surfaced in the status bar
(`internal/app/model.go:223-228, 385-427`).

### 5.3 Chat UX (the parity checklist for any terminal MVP)
- **Part-aware messages** — parts: text, thinking, tool_call, delegation, error, status,
  waiting (`internal/chat/model.go:34-42`); streaming appends to the open part and
  auto-closes on type change (`model.go:773-791`).
- **Streaming** with skeleton "waiting" placeholder, Enter-to-skip (drain) during
  streaming (`model.go:423-429, 867-939`).
- **Tool calls**: running→complete/error lifecycle, args accumulated across events,
  duration, check/✗ markers, input/output sections, syntax-highlighted rendering routed by
  `display_type` (`generic|diff|code|bash`), auto-collapapse on completion
  (`model.go:618-645, 851-864`; renderers `internal/chat/view.go:398-605`).
- **Expand/collapse everywhere** with three input paths: mouse click (region hit-testing
  built during render, `model.go:132-138, 965-989`), Tab/Shift-Tab region focus + Enter
  toggle (`model.go:497-514`), and per-part `Expanded` state.
- **Thinking blocks** — italicized, collapsible, truncated summary vs full.
- **Multi-agent delegations** — nested sub-agent parts: `delegation.start/end` routes
  agent-tagged events into `DelegationPart.SubParts` via an active-delegation stack
  (`model.go:141-146, 647-686, 753-769`); `llm.start/end` renders "calling model…" and
  "↳ N in / M out tokens" status lines (`model.go:714-722`).
- **Slash commands** — built-ins `/help /clear /agents /quit` + aliases
  (`internal/command/commands.go:32-77`), full parser with flags/options
  (`command/parse.go`), **fuzzy autocomplete dropdown** (prefix + Levenshtein ≤ len/3,
  `command/registry.go:91-141`; UI `internal/ui/autocomplete/`), custom command injection
  from config (`tui.go:187-213`).
- **Agent picker phase** → chat phase state machine, Esc to go back / clear input
  (`internal/app/model.go:22-28, 241-291`).
- **Team conversations** — `command.TeamConversationMsg` swaps in a team chat via
  `CreateTeamConversation` (`app/model.go:213-221`), driven by an `AgencyConfig`
  (`internal/types/types.go:38-50`).
- **Streaming markdown renderer** — goldmark-based custom terminal renderer with
  mid-stream fixup for unclosed constructs (`internal/ui/markdown.go`,
  `internal/ui/goldmark.go`); chroma syntax highlighting.
- **Component library** — 10 atoms + 11 molecules (messageblock, toolcallblock, diffblock
  + unified-diff parser, errorblock w/ suggestions, statusbar, statusblock, header,
  confirmprompt, radioselect …) all unit-tested; **14 spinner presets** with graduated
  escalation (subtle <5s → pulse 5-15s → heartbeat >15s, `view.go:386`).
- **Theme system** — token-based (9 categories, 7 statuses, hierarchy, emphasis, surface),
  YAML-loaded, embedded dark/light, terminal background auto-detect
  (`tui.go:42-47`), custom theme registration.
- **Viewport ergonomics** — soft wrap, mouse wheel, pgup/pgdn, ctrl+u/d dual-purpose
  (scroll vs line-edit), shift+arrows, pinned scroll on expand, auto-follow when at
  bottom; `ctrl+m` toggles mouse capture for text selection (`app/model.go:169-172`);
  focus-regain re-hides cursor (`app/model.go:157-163`).
- **Greeting message** support from CreateConversation (`app/model.go:191-193`).
- **Demos**: `just demo|gallery|spinners|claude|gemini|echo|kit` (`Justfile`).

### 5.4 agenti-kit — bundled consumer app (`cmd/agenti-kit/`, 908 LOC)
SDLC chat tool over a Python `agentic_patterns.app.tui.bridge` stdio backend
(`main.go:24-37`, dir resolved via `AGENTIC_PATTERNS_DIR` or sibling-repo walk).
Slash commands `/shape /spec /build` launch preset multi-agent **agencies** (pm
coordinator + architect / spec-writer / coder+reviewer, all
`anthropic/claude-sonnet-4-20250514`, `agencies.go:5-29`), plus `/issues /settings
/providers`. Ships a hexagonal **provider-discovery subsystem** (`providers/`):
parallel probes for Anthropic (Claude CLI + API key), OpenAI (key + Codex CLI), Google
(Gemini CLI), Ollama local, with first-launch probe-and-save onboarding
(`providers/provider.go`, `main.go:19-22`).

### 5.5 Maturity signals — chat-patterns
- 27 test files; `go test ./...` **passes** (contracttest, chat model incl. render-demo
  golden tests, sse, stdioclient, ui, atoms, molecules).
- Contract tests real for HTTP + stdio (`contracttest/validate.go`, `validate_stdio.go`).
- Untested areas: httpclient, cliclient, execclient, command, app, agenti-kit.
- **Dead/aspirational**: conversation picker with New/Continue/**Branch** actions
  (`internal/chat/picker.go:17-29`) is fully written but referenced nowhere — branching
  fields also exist on the DTOs (`types.Conversation.BranchedFromID`,
  `internal/types/types.go:134-135`) with no UI wiring. Gemini parser unverified
  (`cliclient/gemini.go:13`). Doc/code endpoint drift (§4.1). Old `dugshub` import paths
  in PROTOCOL examples. License: **BSL 1.1** converting to Apache-2.0 on 2030-04-10
  (`README.md:156`).
- No CI workflow in-repo (Justfile `quality` only). Rich `.claude/` SDLC scaffolding
  (understander/planner/specifier/implementer/validator agents).

---

## 6. Feature inventory — tui-patterns (the framework skeleton, 4,177 LOC Go)

### 6.1 Actually implemented (Phase 1 complete)
- **Protocol DTOs** — `protocol/capabilities.go:7-41`, `protocol/patterns.go:6-97`
  (Capabilities, PatternSummary/Detail/Item, Composition/Atom, InvocationRequest/
  Created/Summary, ErrorShape).
- **HTTP transport** `transport/http/client.go` — full v0.5.0 client: `Connect()`
  (capabilities negotiation + caching), ListPatternKinds/ListPatterns/GetPattern/
  GetComposition/GetSchema/ListItems, CreateInvocation, StreamInvocationEvents (SSE →
  transformer → `StreamChunk` channel). Tested against httptest (128-LOC test).
- **Stdio transport** `transport/stdio/` (304 LOC + jsonrpc + 156 LOC tests) — new method
  names, `stream.event` notification demux by `invocation_id`.
- **jsoncli transport** `transport/jsoncli/` (245 LOC + 199 LOC tests) — spawn-per-call
  `--json` / NDJSON `--stream`, exit-code validation. **New capability chat-patterns
  never had.**
- **SSE parser + pluggable transformers** — `transport/sse/parse.go` (`ParseFrames`,
  `Stream`, `EventTransformer`); `transformer/defaultvocab/` (v0.5.0 names incl.
  iteration/delegation/llm/progress/validation) and `transformer/chat/` (legacy
  chat-patterns names — the explicit compatibility bridge).
- **Types** `types/stream.go` — superset StreamChunk (MessageID, progress fields, 16
  chunk types).
- **Ported foundation**: 8 atoms + tests (`ui/atoms/`), theme system + env auto-detect
  (`theme/`), slash-command registry/parser (`shell/command/`), embedded YAML themes.
- **cmd/tui** — flag-based connect flow (`--backend | --stdio | --jsoncli`), prints
  capabilities banner, exits (`cmd/tui/main.go:26-80`).
- **CI**: GitHub Actions `just quality` on push/PR (`.github/workflows/ci.yml`) — the only
  repo of the two with CI. License: **MIT**. 18 test files, `go test ./...` passes.

### 6.2 Doc-stub only (READ ME claims vs reality)
README promises "sidebar navigation, JSON Schema-driven forms, composition inspection,
invocation streaming, and a chat view" (`README.md:9`) — **none exist**. Placeholder
packages containing only a doc.go: `ui/molecules`, `ui/widgets`, `views/chat`,
`views/chattrace`, `views/inspector`, `views/replay`, `views/runner`, `shell` (shell
proper — command palette, sidebar, panes, toasts), `contracttest` (conformance suite:
zero code despite PROTOCOL.md §12 advertising `contracttest.ValidateJSONCLI`),
`transport/jsonl` (replay). The README quickstart itself says "(stub) more detail once
cmd/tui lands a connect flow" (`README.md:16`) — slightly stale, the connect flow landed.
PROTOCOL.md §12's `tui.New(tui.Config{...})` example (`PROTOCOL.md:965-980`) references a
root package that **does not exist yet**.

### 6.3 The roadmap (authoritative intent)
`scripts/bootstrap-issues.sh` files 7 epics + ~60 child issues to GitHub:
P1 Foundation Port (done in-code), P2 Shell Primitives (sidebar/pane/statusbar/toast/
palette + 10 form widgets), P3 Form Engine + Inspector (schema→widgets, x-ui resolver,
live validation, JSONLogic visibility, composition tree + $EDITOR atom edit),
P4 Runner/Trace/Replay (runner view, 30/70 span-tree trace from iteration/tool/
delegation/llm events, JSONL recorder/replayer), **P5 Chat Port** ("Role → Actor"
generalization — human/agent/tool/system/subagent — port messageblock/toolcallblock/
diffblock/etc., chat view embeddable under a shell "Playground", standalone
`cmd/chat-patterns` binary; lines 524-568), P6 Consumers (codegen-patterns TUI +
universal `--json` CLI, aloevera workflows, backend-patterns FastAPI endpoints),
P7 Conformance + distribution (contracttest suite, reference backend, brew/go-install/
releases). Wider ecosystem named: `frontend-patterns` (the web peer — "It is a peer to
frontend-patterns (web)", `README.md:11`), `backend-patterns`, `codegen-patterns`,
`aloevera`.

---

## 7. Other pattern-stack terminal work referenced

- **agenti-kit** — not a separate repo; it lives at `chat-patterns/cmd/agenti-kit/`
  (added in chat-patterns' final two commits). Depends on the Python `agentic-patterns`
  repo's `agentic_patterns.app.tui.bridge` stdio backend.
- **Python agentic-patterns orchestrator** — HTTP/SSE consumer example
  (`chat-patterns/_examples/agentic-patterns/main.go`) targets
  `http://localhost:8080/api` with content-negotiated SSE on `/conversations/{id}/send`.
  (Note: this is the *Python* sibling, distinct from the TypeScript agentic-patterns-ts
  workspace this analysis runs in.)
- **frontend-patterns / backend-patterns / codegen-patterns / aloevera** — referenced from
  tui-patterns README/PROTOCOL/roadmap as protocol peers and Phase-6 consumers; not
  present locally, existence/state unverified.
- go.mod imports: both repos depend only on charm.land bubbletea/lipgloss v2 (+ bubbles
  in chat-patterns), chroma, yaml; chat-patterns additionally goldmark (markdown). No
  cross-repo Go imports — the "sharing" is copy-based.

## 8. Which repo should be the base going forward?

**Intent says tui-patterns; working software says chat-patterns.** Concretely:

1. **The author already decided**: tui-patterns exists *because* chat-patterns was judged
   too chat-specific; its roadmap absorbs chat-patterns as a Phase-5 consumer binary, and
   its `chat` SSE transformer + legacy aliases exist precisely to keep chat-patterns
   backends working during migration. tui-patterns also has the better hygiene: MIT (vs
   BSL 1.1), CI, semver'd protocol, capability negotiation, cleaner package layout
   (public packages, not `internal/`).
2. **But for a chat-parity MVP on a realistic clock**, chat-patterns is the only asset
   that renders a conversation: part-aware streaming, tool calls, thinking, delegations,
   markdown, themes, slash commands, five transports, passing tests. Reaching the same
   point in tui-patterns means executing Phases 2+5 (shell + chat port) from doc-stubs.
3. **Pragmatic recommendation**: build the terminal MVP **on chat-patterns' code** (embed
   it or fork its chat/ui/transport guts), while adopting **tui-patterns' PROTOCOL.md
   v0.5.0 as the wire contract** for any new backend work — its event envelope,
   `/capabilities` negotiation, and invocation model are the forward-compatible shape, and
   tui-patterns' `transport/` + `transformer/chat` packages show exactly how to keep both
   vocabularies working at once. If the MVP timeline allows framework work, the highest-
   leverage single move is executing tui-patterns Phase 5 (port chat-patterns' molecules/
   chat view into tui-patterns) — that lands the MVP *and* retires the fork. Do not invest
   new feature work in the chat-patterns repo itself: it is the designated donor, three
   months dormant, and every roadmap arrow points out of it.

## 9. Half-finished / aspirational items (both repos, consolidated)

| Item | Where | State |
|---|---|---|
| Conversation picker (new/continue/**branch**) | `chat-patterns/internal/chat/picker.go` | written, never wired — dead code |
| Conversation branching fields | `chat-patterns/internal/types/types.go:134-135,148-149` | DTOs only |
| Gemini JSONL parser | `chat-patterns/internal/cliclient/gemini.go:13` | TODO: unverified against real output |
| Team conversations over HTTP | `chat-patterns/internal/httpclient/client.go:199-201` | errors "not supported" (stdio only) |
| `createTeamConversation` stdio method | `chat-patterns/internal/stdioclient/client.go:406` | implemented but absent from PROTOCOL.md |
| Send-path doc/code drift (`/messages` vs `/send`) | chat-patterns PROTOCOL.md:32 vs httpclient:32 | inconsistent |
| All views, molecules, widgets, shell, palette | `tui-patterns/views/*`, `ui/molecules`, `ui/widgets`, `shell/doc.go` | doc.go stubs |
| Conformance suite (`ValidateJSONCLI` etc.) | `tui-patterns/contracttest/doc.go` | advertised in PROTOCOL §12, zero code |
| JSONL replay transport | `tui-patterns/transport/jsonl/doc.go` | spec'd (PROTOCOL §8.4), zero code |
| Root `tui.New(Config)` package | `tui-patterns/PROTOCOL.md:969-979` | referenced in docs, does not exist |
| `cmd/chat-patterns` consumer binary | `tui-patterns/cmd/chat-patterns/README.md` | explicit Phase-5 placeholder |
| Composition write-back (`PATCH …/composition`), session endpoints | tui-patterns PROTOCOL.md:336, 868-875 | deferred to 0.6+ |
