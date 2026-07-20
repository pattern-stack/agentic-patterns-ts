# Go R1+R3 UX Dossier — scope-on-create + preset picker, conversation picker/replay, token footer

Scout report for the harness-cockpit stack. Everything below was verified against:

- **Go client**: `/Users/dug/Projects/sandbox/chat-patterns` @ `187411b` ("feat: agenti-kit
  providers, team conversations, surface theme, and stable tool args"), clean working tree,
  `go build ./...` passes. **Caveat**: the clone's working tree was rewritten (restored to
  HEAD) *while this scan ran* — every `file:line` in this dossier was re-verified against the
  post-rewrite tree, and several line anchors differ from the gap-analysis reports (which read
  an older/dirty tree; e.g. `chat/model.go` is 1053 lines here, not 751). Where the two
  disagree, **this dossier's anchors are the ones checked against `187411b`**.
- **TS server**: worktree `/Users/dug/Projects/sandbox/agentic-patterns-ts/.claude/worktrees/atomic-soaring-taco`
  @ `10d5c0b` (same commit the live smoke test ran against).
- Sibling dossier this coordinates with: `scout/server-shim-displaytype.md` (the TS history
  compat shim + `display_type`) — referenced below as **[shim]**. Its Part A wire shapes are
  treated as the contract for §2.

Assumed base (owned by the R1 wire-fix scout, *not* re-specified here): create body
`{agent_id}` not `{agent_name}` (`internal/types/types.go:106-109` /
`internal/httpclient/client.go:170-197`), send body `{content}` at
`/conversations/{id}/messages` (`types.go:112-114`, default path fix at
`internal/httpclient/client.go:32`), `role`-object decode in **both** `httpclient`
(`client.go:92-145`) and `contracttest/validate.go:50-57`, canonical `tool.rejected` parse
(`internal/sse/parse.go:119`), context-plumbed abort (`chat/model.go:568` uses
`context.Background()` today). Sections below note where this work *touches* those same lines
so the implementer can sequence/stack cleanly.

---

## 1. (a) Scope on create + preset picker (R1)

### 1.1 Server contract (all verified by direct read)

**`GET /agents`** (`packages/agent-server/src/routes/agents.ts:65-98`) — each row:

```jsonc
{
  "id": "…", "name": "…", "description": "…",
  "role": { "id": "…", "name": "…" } | null,        // L81 — object, NOT string
  "readiness": { "ready": bool, "missing": ["model"?] },  // L82
  "instantiation": {                                   // L89-94
    "available": bool,       // instantiate hook OR declared scope (L90)
    "defaults":  object|null,// scope.defaults ?? instantiateDefaults ?? null (L91)
    "schema":    object|null,// scope.toJsonSchema(), null on throw (L92, L53-60)
    "presets":   object|null // Record<presetName, Record<field, value>> (L93)
  }
}
```

Preset value type confirmed at `agent-server/src/config.ts:51`
(`presets?: Readonly<Record<string, Readonly<Record<string, unknown>>>>`).

**`POST /conversations`** (`agent-server/src/routes/conversations.ts:63-226`):

- Body `{agent_id, scope?, context?}`; `scope` wins over the deprecated `context` (L75-77).
- `scope` must be a JSON **object** — explicit `null`/array/scalar → 400
  `` {"error":"`scope` must be a JSON object"} `` (L82-87).
- Sending `scope` to a hook-less+scope-less agent → 400 `"Agent has no instantiate hook — scope is not accepted"` (L89-96).
- **No server-side merge**: `effectiveContext = rawScope ?? {...declaredDefaults}` (L115-118).
  If the client sends a scope object, declared defaults are **not** composed underneath it
  (only zod `.default()`s inside `scope.parse` fill gaps, L128-130). ⇒ the client must
  materialize `defaults ⊕ preset` itself — matching the React chat's D7 posture
  (`agent-dashboard/src/pages/ChatPage.tsx:151-160, 399-406`): *presets materialize
  client-side; the preset **name** is never sent*.
- Validation failure → 400 `{"error":"scope validation failed","issues":[…zod issues…]}`
  (L136-140); instantiate throw → 502 `{"error":"instantiate failed: …"}` (L152-158).
- 201 echo for scope/hook agents: `{id, agent_id, context, scope?, context_redacted?}` —
  `scope` present only for scope-declaring registrations, values **redacted** (L211-225).
  Scope is **immutable for the conversation lifetime** (L38-50, Decision 2) — there is no
  "change scope mid-chat"; a `/scope` command can only *display*.
- Omitting `scope` entirely is the "use defaults" path (L115-118) — and for agents that
  declare **required fields with no defaults**, a bare create is a *deliberate* 400 (D11,
  L120-127). The TUI must render that 400's `issues`, not treat it as fatal.

### 1.2 Go wire changes

**`internal/types/types.go`**

- `AgentSummary` (L6-10) gains instantiation (+ JSON tags — the R1 role fix will already be
  adding tags to this struct for the direct `[]AgentSummary` decode):

```go
type AgentSummary struct {
    ID            string         `json:"id"`
    Name          string         `json:"name"`
    Role          string         `json:"-"`      // flattened from role.name by httpclient (R1 fix)
    Description   string         `json:"description"`
    Instantiation *Instantiation `json:"instantiation,omitempty"`
}

// Instantiation mirrors GET /agents `instantiation` (agents.ts:89-94).
type Instantiation struct {
    Available bool                              `json:"available"`
    Defaults  map[string]any                    `json:"defaults"`
    Schema    map[string]any                    `json:"schema"`   // display-only for now
    Presets   map[string]map[string]any         `json:"presets"`
}
```

- `CreateConversationRequest` (L106-109, after the R1 `agent_id` fix) gains
  `Scope map[string]any \`json:"scope,omitempty"\`` — `omitempty` keeps the no-scope create
  byte-identical to today (important: server 400s scope-for-scopeless agents, §1.1).
- `CreateConversationResult` (L100-103) gains the redacted echo for `/scope` display:

```go
type CreateConversationResult struct {
    ID       string
    Greeting string
    Scope    map[string]any // redacted echo (`scope` ?? `context` from the 201 body); nil when absent
    Redacted []string       // `context_redacted` keys, when any
}
```

- New typed error for the validation 400:

```go
// ScopeValidationError is the decoded 400 {"error":"scope validation failed","issues":[…]}.
type ScopeValidationError struct{ Issues []ScopeIssue }
type ScopeIssue struct {
    Path    []any  `json:"path"`
    Message string `json:"message"`
}
func (e *ScopeValidationError) Error() string { /* "scope validation failed: N issue(s)" */ }
```

**`internal/types/client.go`** — `Client.CreateConversation` (L15) changes signature:

```go
CreateConversation(ctx context.Context, agentID string, scope map[string]any) (CreateConversationResult, error)
```

Five implementations to touch (all verified to exist):
`internal/httpclient/client.go:170` (real change), `internal/httpclient/client.go:329`
(StubClient — accept+ignore), `internal/stdioclient/client.go`, `internal/cliclient/client.go`,
`internal/execclient/client.go`, `internal/demo/client.go`. For non-HTTP transports scope is
meaningless: follow the repo's existing honest-degradation precedent
(`cliclient/client.go:135-143` returns nil for unsupported history) but be *loud* for scope —
`if len(scope) > 0 { return …, fmt.Errorf("scope not supported by this transport") }` —
silently dropping a user-entered scope is worse than an error.

**`internal/httpclient/client.go`**

- `CreateConversation` (L170-197): marshal `{agent_id, scope}`; on non-201 read the body and
  decode `{"error":…}` — if `error == "scope validation failed"`, decode `issues` into
  `ScopeValidationError`; else surface the server's `error` string (today the method throws
  away the body, L188-190, which is exactly why smoke-test N2 was undiagnosable). Decode the
  201 body's `scope`/`context`/`context_redacted` into the result (§1.1 echo).
- `ListAgents` (L92-145): while fixing the role decode (R1), also decode `instantiation`
  (comes free with the struct tags above). The legacy `[]string` fallback path (L122-144)
  leaves `Instantiation` nil — correct, that backend has no scope concept.

### 1.3 App flow — a preset step between agent-select and create

Today `updateAgentSelect` enter (`internal/app/model.go:258-270`) constructs `chat.New` and
fires `client.CreateConversation(ctx, agent.ID)` immediately (L267). Insert a new phase:

**`internal/app/model.go`**

- `Phase` (L25-28): add `PhaseScopeSetup` between `PhaseSelectAgent` and `PhaseChat`.
- Model (L50-80): add

```go
scope        scopeState // nil-able sub-model, internal/app/scope.go (new file)
```

with `scopeState` holding: `agent types.AgentSummary`, `cursor int`, `mode` (list | jsonEdit),
`jsonBuf string`, `valErr *types.ScopeValidationError`, `submitErr error`.

- **Entry decision** in the enter handler (L258-270): if
  `agent.Instantiation == nil || !agent.Instantiation.Available` → create immediately with
  `scope=nil` (today's behavior, zero regression for scope-less backends). Else if the app was
  configured with a non-nil `Config.DefaultScope` (§1.4) → create immediately with that map.
  Else → `m.phase = PhaseScopeSetup`, seed `scopeState`.
- **The picker list** (render mirrors `viewAgentSelect`, L317-383 — same atoms, same cursor
  idiom):

```
Configure scope for <agent.Name>:
  ▸ Defaults            <one-line summary of Instantiation.Defaults, or "(server defaults)">
    preset: staging     <one-line summary of preset values>
    preset: prod        …
    Custom JSON…
```

  Rows = `["defaults"] + sortedPresetNames + ["custom"]`. Selecting:
  - **Defaults** → `CreateConversation(ctx, id, nil)` — *omit* scope so the server composes
    its own defaults and D11-400s honestly (§1.1). Do **not** send
    `Instantiation.Defaults` back — the echo already proves what was resolved.
  - **Preset `p`** → `merged := shallowMerge(Instantiation.Defaults, Instantiation.Presets[p])`
    (defaults first, preset keys win) → `CreateConversation(ctx, id, merged)`. The merge is
    required because the server does not compose defaults under a supplied scope (§1.1
    L115-118); shallow is correct — scope fields are flat top-level keys
    (`SessionScopeLike.defaults`, `config.ts:50`).
  - **Custom JSON** → `mode = jsonEdit`: a single-buffer editor reusing the chat input
    idioms — accumulate `tea.KeyPressMsg.Text`, handle `tea.PasteMsg` (multi-line JSON paste
    is the main entry vector; note the app-level `Update` must forward `PasteMsg` to the
    scope phase — today `PasteMsg` is only consumed inside `chat.Model.Update`,
    `chat/model.go:354-358`), backspace via `deleteChar` (`chat/input.go:13-19`), enter =
    parse. `json.Unmarshal` into `map[string]any`; local parse error renders inline; valid →
    `CreateConversation(ctx, id, parsed)` **unmerged** (raw JSON is the power path — mirror
    `ap run --context` which also replaces rather than merges; precedence per
    `agent-cli` run.ts: explicit context > defaults). Pre-seed `jsonBuf` with
    `Instantiation.Defaults` marshaled — an editable starting point beats an empty buffer.
- **400 handling**: `ConversationCreatedMsg` (L37-41) gains `ValErr *types.ScopeValidationError`.
  In the `ConversationCreatedMsg` case (L185-198): if `ValErr != nil` → stay in
  `PhaseScopeSetup`, render each issue as `path.join(".") + ": " + message` under the picker
  (use `molecules.ErrorBlock`, same as `loadErr` at L334-339). This is the D11 path: an agent
  with required fields makes even "Defaults" 400 — the issues list *is* the form prompt for
  MVP. Other errors → existing `loadErr` path (L186-189) but must no longer strand the user in
  `PhaseSelectAgent` with a stale error — reset `loadErr` on every new selection (existing
  latent nit; today `m.loadErr` is never cleared once set, L174-183).
- **Scope echo → chat**: on success store `result.Scope`/`result.Redacted` on the app model
  (new fields) and pass a one-line summary into the chat header or an initial system message:
  recommend a system message `scope: {org_id: "acme", api_key: <redacted>}` via
  `chat.TextMessage(chat.RoleSystem, …)` appended right before `m.phase = PhaseChat`
  (pattern identical to the Greeting append at L191-193).
- **Esc/back**: `PhaseScopeSetup` + esc → back to `PhaseSelectAgent` (jsonEdit mode: first esc
  → back to list mode). Extend `renderLegend` (L385-398) with a `PhaseScopeSetup` hint line:
  `"j/k: navigate  enter: select  esc: back"`.

### 1.4 `/scope` command + non-interactive entry

- **`/scope` (display-only — scope is immutable, §1.1)**: register in
  `command.DefaultRegistry` (`internal/command/commands.go:32-77`) a `Def{Name:"scope"}`
  whose handler emits a new `command.ShowScopeMsg{}`. The app (which owns the stored echo)
  catches it in `Update` and forwards a formatted `command.SystemMsg{Content: …}` into
  `m.chat.Update` — the chat model already renders `SystemMsg` (`chat/model.go:391-394`).
  Redacted keys render as `<redacted>` (they arrive already redacted; just annotate which,
  from `Redacted`). No scope bound → `"(no scope bound)"` — honest, matches the React
  "(no scope)" discipline.
- **`--context`-style flag**: belongs to the new consumer cmd (R1, other scout), but the
  library must accept it: add `Config.DefaultScope map[string]any` to the public `Config`
  (`config.go:14-45`), threaded `tui.App` → `app.Config` (`internal/app/model.go:44-47`) →
  the entry decision in §1.3. Semantics: **bypass** the interactive step entirely (it is the
  scriptable path); a create-400 with DefaultScope set renders the issues in
  `PhaseSelectAgent`'s error block and stays there. Recommend the consumer cmd parse
  `--context '<json>'` + `AP_CONTEXT` env with flag>env precedence, mirroring
  `ap run` (`agent-cli` run.ts context ladder, per gap-analysis §1.4).

### 1.5 Deliberately out of scope (recommendation: defer)

Schema-driven typed forms (`instantiation.schema` → widgets) — the React parity feature — is
a Phase-3-sized build (tui-patterns PROTOCOL.md designed it; nothing implements it). The
preset list + JSON editor + server-issue echo covers every agent the fixtures ship. Keep
`Instantiation.Schema` decoded (cheap) so a later form engine needs no wire change.

### 1.6 Test plan (a)

Go (`just quality` = build + vet + test; conventions per `internal/chat/model_test.go`
plain-stdlib tests):

1. `internal/httpclient`: **new** `client_test.go` with `httptest.Server` (none exists today —
   the smoke test proved exactly why it must):
   - `ListAgents` decodes `instantiation` (presets/defaults present, null schema, absent
     instantiation → nil).
   - `CreateConversation(id, nil)` body has **no** `scope` key; `(id, map)` body carries it.
   - 400 `scope validation failed` → typed `ScopeValidationError` with issues; 400 other →
     error containing server `error` string; 404 → "Agent not found" surfaced (N2 regression).
   - 201 echo: `scope`+`context_redacted` land in the result.
2. `internal/app`: **new** `scope_test.go` — drive `Model.Update` with a fake
   `types.Client` (record-args stub): available=false → immediate create with nil scope;
   presets → phase transition, cursor nav, enter on preset sends *merged* map (assert
   defaults⊕preset with preset winning); custom JSON happy + parse-error + `PasteMsg` append;
   ValErr keeps phase and renders issues (assert `View()` contains `path: message`);
   DefaultScope bypasses the phase.
3. `contracttest` (optional but cheap): add a scope-create sub-check gated on an
   `instantiation.available` agent being present — POST with an empty object and assert
   201-or-400-with-issues (both are contract-conформant), never 500.
4. Live: `ap playground` from this worktree with a scope-declaring fixture agent
   (`agents/` ships calculator/todo/writing-coach — check which declares a scope; if none,
   add one to the scratchpad agents dir per the smoke-test recipe) — walk picker→preset→400
   →fix→201→`/scope`.

---

## 2. (b) Conversation picker + replay (R3)

### 2.1 Verified current state

- `PickerModel` (`internal/chat/picker.go:37-45`, 237 lines) is complete UI: New/Continue on
  enter (L92-104), Branch on `b` (L105-116), badge/meta rendering (L179-220), loading/error
  states. **Dead twice over, re-confirmed on `187411b`**: repo-wide grep finds zero references
  to `NewPicker`/`ConversationsLoadedMsg`/`ConversationSelectedMsg` outside `picker.go`
  itself; nothing calls `types.Client.ListConversations` from any UI path (only the client
  impls define it), and nothing consumes `ConversationDetailResponse` (only
  `internal/demo/client.go:182` stubs it).
- `chat.Model.ExchangeCount`/`IsBranch` (`chat/model.go:167-168`) render as header badges
  (`chat/view.go:128-142`) but are **never assigned anywhere** — ready-made for replay.
- Wire structs the picker decodes: `types.Conversation` (`types.go:127-138`),
  `ConversationDetailResponse` (L141-152, inline `messages[]`), `ConversationMessage`
  (L155-160, `kind`+`sequence`+`parts`), `MessagePart{Type, Content}` (L163-166 — **drops
  `metadata`**).
- Endpoint defaults already right for the shim: list `/conversations`, get
  `/conversations/{id}` (`httpclient/client.go:33-34`); `?agent_name=` filter sent when
  non-empty (L259-264).

### 2.2 Wire dependency — the [shim] contract (agreed, do not re-negotiate)

[shim] Part A adds to the TS server: bare `GET /conversations` (snake_case summaries,
`agent_name` filter, `exchange_count`/token split) and inline `messages[]` + snake_case
aliases on `GET /conversations/:id` (`sequence` = array index, parts
`{type, content, metadata}`). With that landed, **`types.Conversation` and
`ConversationDetailResponse` decode as-is — zero Go decode changes** except one:

- **Extend `types.MessagePart` (L163-166) with
  `Metadata map[string]any \`json:"metadata,omitempty"\``** — [shim] A-3 emits it, and it is
  the only way to label `state_delta` parts (their `content` is deliberately empty;
  `agent-runtime/src/conversation/conversation.ts:424-429` — the event name lives at
  `metadata.event`) and to hydrate future `tool_call` parts. Additive, nothing breaks.

Persisted part vocabulary today (verified `conversation.ts:359-390`): request =
`[user_prompt]`; response = `[state_delta…, text]`. `tool_call` parts are **never persisted**
by `_persistExchange` — the history report's "part types produced: …tool_call…" overstated;
gap-analysis §1.9 has it right. Replay therefore renders text-only conversations today, by
design; handle `tool_call` defensively anyway (one `case`, cheap).

### 2.3 App wiring

**`internal/app/model.go`**

- `Phase`: add `PhasePickConversation` (order: SelectAgent → PickConversation →
  ScopeSetup(new-only) → Chat).
- Model: add `picker chat.PickerModel`, `replayAgent types.AgentSummary`.
- **Agent-select enter** (L258-270) becomes: fire
  `client.ListConversations(ctx, agent.Name)` as a `tea.Cmd` returning
  `chat.ConversationsLoadedMsg`, set `m.phase = PhasePickConversation`,
  `m.picker = chat.NewPicker(agent.Name)`, `m.picker.SetSize(m.width, m.height-5)`.
  - **Filter caveat (decision R3-1)**: the [shim] filter is exact-match on the *store's*
    `agentName`, which is `agent.role.name` (`conversation.ts:366-368`) — **not** the
    registration `name`/`id` from `GET /agents`. For the fixture agents these can differ.
    Recommendation: pass `""` (no filter, show all) for MVP and display each row's own
    `AgentName` (the picker already does, L188); revisit if the list gets noisy. This
    sidesteps the mismatch entirely.
  - **Degradation**: `ConversationsLoadedMsg.Err` non-nil (503 persistence-off, transports
    returning nil/nil, old servers 404ing) → skip the picker: log nothing, go straight to
    the ScopeSetup/create path (identical UX to today). Err==nil with 0 rows → still show
    the picker (it renders "+ New conversation" + "No past conversations", L221-226) — or
    skip; recommend **skip on empty** to save a keystroke (decision R3-2, weak preference).
- **Message routing** (in `Update`, alongside the existing typed cases L123-229):

```go
case chat.ConversationsLoadedMsg:
    if msg.Err != nil { /* skip-to-create path */ }
    var cmd tea.Cmd
    m.picker, cmd = m.picker.Update(msg)
    return m, cmd

case chat.ConversationSelectedMsg:
    switch msg.Action {
    case chat.ActionNew:      // → §1.3 entry decision (scope setup or create)
    case chat.ActionContinue: // → fetch detail
        client, id := m.client, msg.ConversationID
        return m, func() tea.Msg {
            d, err := client.GetConversation(context.Background(), id)
            return conversationLoadedMsg{Detail: d, Err: err}
        }
    case chat.ActionBranch:   // disabled this round — swallow (see below)
    }

case conversationLoadedMsg: // new app-local msg
    // build chat, replay, enter PhaseChat (read-only)
```

  Also forward `tea.KeyPressMsg`/window sizing to `m.picker.Update` while in
  `PhasePickConversation` (the phase dispatch at L231-238 gets a third arm).
- **Branch stays disabled**: cheapest correct form — in the `ConversationSelectedMsg`
  handler treat `ActionBranch` as a no-op (swallow). The picker's `b` key (picker.go:105-116)
  then does nothing, and the branch badge never renders anyway (`branched_from_id` absent →
  nil, L209-215). Do **not** delete the picker code — the shim deliberately leaves the fields
  `omitempty`. Optionally add a `key: disabled` note in the picker footer text.

### 2.4 Replay renderer — new file `internal/chat/replay.go`

Pure function + one model hook; mapping table is [shim] A.3 verbatim:

```go
// ReplayMessages converts a stored conversation detail into renderable messages.
func ReplayMessages(d *types.ConversationDetailResponse) []Message {
    var out []Message
    for _, cm := range d.Messages {           // shim guarantees ascending sequence
        role := RoleAssistant                  // kind "response"
        if cm.Kind == "request" { role = RoleUser }
        var parts []MessagePart
        for _, p := range cm.Parts {
            switch p.Type {
            case "user_prompt", "text":
                if c := deref(p.Content); c != "" {
                    parts = append(parts, MessagePart{Type: PartText, Content: c, Complete: true})
                }
            case "state_delta":
                ev, _ := p.Metadata["event"].(string) // e.g. "backpack.drop"
                if ev == "" { ev = "state change" }
                parts = append(parts, MessagePart{Type: PartStatus, Content: "Δ " + ev, Complete: true})
            case "tool_call": // never persisted today (conversation.ts:359-390); defensive
                parts = append(parts, MessagePart{Type: PartStatus, Content: "tool call (details not recorded)", Complete: true})
            default:          // unknown future types: labeled degradation, never crash
                parts = append(parts, MessagePart{Type: PartStatus, Content: "[" + p.Type + " part]", Complete: true})
            }
        }
        if len(parts) > 0 { out = append(out, Message{Role: role, Parts: parts}) }
    }
    return out
}
```

Hook-up in the `conversationLoadedMsg` handler:

```go
m.chat = chat.New(m.client, msg.Detail.AgentName, m.registry)
m.chat.SetSize(m.width, m.height-5)
for _, cm := range chat.ReplayMessages(msg.Detail) { m.chat.AppendMessage(cm) }
m.chat.SetConversationID(msg.Detail.ID)
m.chat.ExchangeCount = msg.Detail.ExchangeCount   // header badge, view.go:128-134
m.chat.GotoBottom()
m.phase = PhaseChat
```

**Read-only stance (decision R3-3, recommendation firm)**: continuing is **replay-only**.
The TS conversation registry is in-memory (`agent-server/src/app.ts` per gap-analysis §1.9);
a stored id is not in the `conversations` Map after restart, so
`POST /conversations/:id/messages` → 404 `"Conversation not found"`
(`conversations.ts:334-337`). Until a rehydrate route exists server-side, the TUI must say
so honestly rather than let the send fail confusingly:

- Add `chat.Model.ReadOnly bool`; when set, `submit()` (model.go:530) short-circuits regular
  messages (slash commands still work) with a system message:
  `"read-only replay — the server cannot resume stored conversations yet"`. Render a
  `replay` badge in `RenderHeader` next to the agent badge (pattern: IsBranch badge,
  view.go:136-142). ~15 lines total.
- Alternative (rejected): attempt the send and surface the 404 — honest but reads as
  breakage, and burns the user's typed message.

### 2.5 Test plan (b)

1. `internal/chat/replay_test.go` (pure, no I/O): request/response role mapping;
   `user_prompt`+`text` → PartText; empty-content `state_delta` with `metadata.event` →
   `Δ backpack.drop` PartStatus; metadata-less state_delta → `Δ state change`; unknown type
   → labeled; empty-parts message dropped; ordering preserved.
2. `internal/chat/model_test.go`: ReadOnly submit → no client call (stub client that fails
   the test if `SendMessage` fires), system message appended; `/help` still works ReadOnly.
3. `internal/app`: picker flow with fake client — agent enter → ListConversations called
   with `""`; err → skipped to create; rows → `PhasePickConversation`; enter on row →
   `GetConversation` called → `PhaseChat` with ExchangeCount set; `b` → no client call,
   phase unchanged; ActionNew → scope-setup entry decision (§1.3).
4. Decode fixtures: golden JSON copied **from the [shim] test expectations** (A.4 #2/#4) →
   `json.Unmarshal` into `types.Conversation`/`ConversationDetailResponse` and assert every
   field non-zero (this is the cross-repo contract lock; zero fields decoding was N3's
   failure mode). Keep the fixtures byte-synced with the shim's test seeds.
5. Live (needs `AP_PERSISTENCE` on + shim landed): create → chat one turn (needs LLM key) →
   restart TUI → picker shows row with exchange_count 1 → replay renders both turns +
   read-only banner.

---

## 3. (c) Token footer (R3)

### 3.1 Wire evidence

- Server `message.complete` payload (verified
  `agent-runtime/src/transport/sse-formatter.ts:93-102`):
  `{content, input_tokens, output_tokens, model}`.
- Server `llm.end` payload (L193-200): `{model, input_tokens, output_tokens, duration_ms}` —
  per-LLM-call granularity, also available.
- Terminator `event: done` `{run_id}` (`agent-server/src/routes/conversations.ts:404-407`,
  `run_id` = first `agent.message.start`'s runId).
- Go today: `SSEMessageCompleteData` (`internal/sse/types.go:12-16`) is defined but **dead**
  — `parse.go:69-72` maps `message.complete` to a bare `{Done:true}` without decoding the
  payload; and because the reader goroutine stops at the first `Done` chunk
  (`httpclient/client.go:233-246`), the subsequent `done` frame — and its `run_id` — is
  **never read**.
- `StreamChunk` already carries `ModelName/InputTokens/OutputTokens` (`types.go:61-64`,
  populated only by the stdio client's `llm.end` today) and the chat model already renders
  per-call token lines for `ChunkLLMEnd` (`chat/model.go:718-721`) with `formatNumber`
  (L1040-1053).

### 3.2 Design

**Parse changes (`internal/sse/`)**

1. `types.go:12-16`: add `Model string \`json:"model"\`` to `SSEMessageCompleteData`.
2. `parse.go:69-72` — decode and *stop terminating on it*:

```go
case "agent.message.complete", "message.complete":
    var d SSEMessageCompleteData
    _ = json.Unmarshal([]byte(evt.Data), &d)
    return &types.StreamChunk{
        Type: types.ChunkMsgComplete,     // NEW ChunkType in types.go:21-36
        ModelName: d.Model, InputTokens: d.InputTokens, OutputTokens: d.OutputTokens,
        // Done: false — the server's `done` frame (parse.go:136-137) terminates.
    }
```

   **Semantics shift + safety net**: today `message.complete` doubles as the terminator.
   Against this server the explicit `done` event follows (§3.1) and `parse.go:136-137`
   already handles it; for any backend that closes the stream without `done`, the existing
   channel-close fallback synthesizes `{Done:true}` (`httpclient/client.go:244-245`) — so no
   hang is possible. This same change is what makes `done.run_id` reachable at all (the
   reader no longer returns early), so also decode it:

```go
case "done":
    var d struct{ RunID string `json:"run_id"` }
    _ = json.Unmarshal([]byte(evt.Data), &d)
    return &types.StreamChunk{Done: true, Type: types.ChunkText, RunID: d.RunID}
```

   (+ `RunID string` on `StreamChunk` — free now, feeds a future `/run` deep-link command.)
3. Optional, recommended (5 lines, closes gap §2.2#7 for tokens): parse SSE `llm.end` →
   `ChunkLLMEnd` with the same fields, giving the HTTP transport the per-call status lines
   the stdio transport already renders (`chat/model.go:714-721`). Guard: this adds mid-turn
   status lines to every HTTP chat — if too chatty, land the parse case but have
   `handleResponse` fold rather than append (defer; decision R3-4).

**Model changes (`internal/chat/model.go`)**

- Model struct (L149-169): add

```go
lastModel      string
lastInTokens   int
lastOutTokens  int
totalInTokens  int
totalOutTokens int
```

- `handleResponse` (L593-741): new case before the `chunk.Done` check:

```go
case types.ChunkMsgComplete:
    m.lastModel = chunk.ModelName
    m.lastInTokens, m.lastOutTokens = chunk.InputTokens, chunk.OutputTokens
    m.totalInTokens += chunk.InputTokens
    m.totalOutTokens += chunk.OutputTokens
```

  (`skipStreaming`, L867-939, drains through its `default` arm — add the same case there so
  Enter-to-skip doesn't lose the footer; its `default` currently appends `Content` as text,
  and `ChunkMsgComplete.Content` is empty so it is *also* safe unhandled, but be explicit.)

**Render (`internal/chat/view.go`)** — the status line is the footer slot: `View()` L71-89
currently shows `...` while streaming + a right-aligned scroll indicator. When
`!m.streaming && m.totalOutTokens > 0`, render left-side (where `...` lives):

```
gpt-x · 1,234 in / 567 out (turn) · 8,910 / 4,321 (total)
```

via `formatNumber` (model.go:1040), `theme.Style{Hierarchy: theme.Tertiary}` (dim — this is
chrome, not content). Collision handling with the scroll indicator already exists (pad
computation L84-88); the footer takes the `statusContent` slot exactly as the streaming
indicator does, so no new layout. Drop the `(total)` clause when it equals the turn (first
exchange). Model-less payloads (`model` empty) render tokens only — never invent.

**Why status line, not header**: the header badges (view.go:120-142) re-render into the
scrollback-anchored header and are the replay/branch slot; the status line is persistent
chrome the eye already checks for state, and matches the React footer's placement semantics
(under the message, `model.ts:530-539` per gap-analysis §1.2). One-line decision, but it's
R3-5 below in case taste differs.

### 3.3 Test plan (c)

1. `internal/sse/parse_test.go` (exists, 215 lines — extend):
   - `message.complete` with full payload → `ChunkMsgComplete`, tokens+model populated,
     `Done == false`;
   - malformed `message.complete` payload → still a non-nil chunk, zero fields (never nil —
     a torn payload must not stall the reader);
   - `done` with `{run_id}` → `Done:true` + RunID; bare `done` `{}` → Done, empty RunID;
   - (if R3-4 taken) SSE `llm.end` → `ChunkLLMEnd` fields.
2. `internal/chat/model_test.go`: stream text → `ChunkMsgComplete{1234,567,"m"}` →
   `done` → assert model fields + totals; two turns → totals accumulate, `last*` reset to
   turn 2; Enter-skip path (`skipStreaming`) preserves footer data.
3. View: `render_demo_test.go`-style golden — footer renders after completion, absent while
   streaming, absent at zero tokens; `formatNumber` grouping (`1,234`).
4. Live (needs an LLM key — the keyless playground cannot exercise this path, smoke-test §0):
   one real turn, footer shows non-zero in/out and the model id; second turn updates totals.

---

## 4. Sequencing, ownership boundaries, open decisions

**Build order within this slice** (each lands green on `just quality`):

1. §3 footer (pure client, no server dependency — the `message.complete`/`done` frames are
   already emitted today; only untestable live without an LLM key).
2. §1 scope+preset (depends only on R1 wire fixes; `GET /agents` already serves
   `instantiation` at `10d5c0b`).
3. §2 picker/replay (**blocked on [shim] Part A landing** in agent-server; the Go side can
   be built against the shim dossier's golden fixtures in parallel).

**Touch-point collisions with the R1 wire-fix scout** (coordinate the stack): both edit
`types.CreateConversationRequest`, `httpclient.CreateConversation`, `httpclient.ListAgents`,
and `contracttest/validate.go`. Recommend R1 wire fixes merge first; §1 rebases on top.
The abort work (R1) replaces `context.Background()` at `chat/model.go:568` — the footer's
`handleResponse` cases are orthogonal (different switch arms), no conflict.

**Open decisions (recommendation first)**:

| # | Decision | Recommendation |
|---|---|---|
| R3-1 | Picker list filter: `?agent_name=` uses store's `role.name`, not registration name — mismatch risk | Send no filter for MVP; rows self-label. Revisit only if noisy |
| R3-2 | Empty history: show picker with only "+ New" vs skip | Skip on `len==0 && err==nil` (saves a keystroke; picker still reachable via a future `/history`) |
| R3-3 | Continue semantics against in-memory registry | Read-only replay + `ReadOnly` flag + honest banner; never attempt the 404 send. Lift when the server grows rehydrate |
| R3-4 | Parse SSE `llm.end` → per-call status lines on HTTP transport | Land the parse case; watch chattiness in live use before folding |
| R3-5 | Footer placement | Status line (chrome), not header badges (identity/replay slot) |
| S-1 | Preset merge owner | Client merges `defaults ⊕ preset` (server does NOT compose defaults under a supplied scope — verified conversations.ts:115-118); raw-JSON path sends unmerged |
| S-2 | Scope on non-HTTP transports | Error when non-empty scope passed (loud), nil-scope passthrough otherwise |
| S-3 | Typed schema forms | Defer; decode `instantiation.schema` now, render nothing |
| S-4 | `Config.DefaultScope` naming/shape | `map[string]any`, bypasses interactive step; consumer cmd owns `--context`/`AP_CONTEXT` parsing |

**Corrections to prior reports folded in here** (so the implementer doesn't chase stale
anchors): `contracttest/validate.go` already posts `{"agent_id"}` (L74) and
`{"content"}`→`/messages` (L107-108) — only its `role` decode (L50-57) is broken, exactly as
smoke-test N1 says; `tool_call` parts are never persisted (`conversation.ts:359-390`),
narrowing the history report's part-type list; chat-patterns' part vocabulary is seven types
including `status`+`delegation` (`chat/model.go:34-42`), and `PartStatus` is the natural
`state_delta` target — both already noted by [shim] A.3, confirmed here independently.
