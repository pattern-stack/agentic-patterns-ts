# Scout dossier — chat-patterns Go R1: wire fixes, abort, no-allowlist flip, cockpit cmd, CI

Evidence scout for the harness-cockpit stack, R1 (Go side). Every anchor below was read at the
stated commit by this scout; server-side anchors were read in this repo's worktree.

- **Go repo**: `/Users/dug/Projects/sandbox/chat-patterns` @ `187411b` ("feat: agenti-kit
  providers, team conversations, surface theme, and stable tool args") — the same commit the
  gap-analysis reports were derived from. **Note:** the local clone was 5 commits behind
  (`0c93dd1`) at scout start; it was fast-forwarded to `origin/main` = `187411b` (clean tree,
  ff-only). Before the ff, `cmd/agenti-kit/` and `_examples/agentic-patterns/` did not exist
  locally — anyone re-verifying must be on `187411b`.
- **TS repo**: `/Users/dug/Projects/sandbox/agentic-patterns-ts` (worktree
  `.claude/worktrees/atomic-soaring-taco`, branch `main` @ `10d5c0b`).
- **Baseline**: `go build ./... && go vet ./... && go test ./...` all pass at `187411b`
  (run by this scout; test packages: contracttest, internal/chat, internal/sse,
  internal/stdioclient, internal/ui, atoms, molecules). `internal/httpclient` has **zero tests**.

Server contract facts used throughout (all re-verified in this worktree):

| Fact | Evidence |
|---|---|
| `GET /agents` → `role` is object `{id,name}` or `null`; also `description`, `readiness`, `instantiation` | `packages/agent-server/src/routes/agents.ts:76-93` |
| `POST /conversations` body `{agent_id, scope?\|context?}`; unknown agent → 404 `{"error":"Agent not found"}`; 201 `{id, agent_id}` (+ `context`/`scope`/`context_redacted` for scope-declaring registrations) | `routes/conversations.ts:64-69`, `:208-226` |
| `POST /conversations/:id/messages` body `{content, maxIterations?}`; missing content → 400 `{"error":"content is required"}`; response is SSE over the POST body | `routes/conversations.ts:331-344` |
| `message.complete` payload `{content, input_tokens, output_tokens, model}` | `packages/agent-runtime/src/transport/sse-formatter.ts:93-102` |
| `tool.rejected` payload `{tool_name, reason, gate_name}` | `sse-formatter.ts:161-169` |
| terminator `event: done` `data: {run_id}` (or `{}` if no `agent.message.start` seen) | `routes/conversations.ts:404-407` |
| Drain loop is `try … finally` with **no catch** → N5 torn stream on pre-token failure (fix is pre-work, out of scope here; a lenient Go client must still not render it as success) | `routes/conversations.ts:393-409` |
| Server base: `ap playground` default port **3456**, routes mounted at root (no `/api` prefix) | `packages/agent-cli/src/constants.ts:18`, `commands/playground.ts:71`, `agent-server/src/app.ts:35-58` |

---

## 1. The five wire fixes (gap-analysis §2.2 #1, #2, #3, #4, #5)

### 1.1 Fix #1 — send path + body key (`{"message"}`→`{"content"}`, `/send`→`/messages`)

Evidence:
- Default path is `/conversations/{id}/send`: `internal/httpclient/client.go:32`.
- Body marshals `types.SendMessageRequest{Message: content}`: `client.go:204`; the DTO is
  `Message string \`json:"message"\`` at `internal/types/types.go:111-114`.
- `SendMessageRequest` has exactly one consumer (`client.go:204` — verified by grep), so the
  rename is contained.
- N6 doc/code drift confirmed: the `EndpointConfig` comment already documents the default as
  `/conversations/{id}/messages` (`types.go:178`) — this fix makes code match its own docs.

Proposed diff:

```diff
--- a/internal/httpclient/client.go
@@ -32 (newEndpointConfig defaults)
-		sendMessage:        "/conversations/{id}/send",
+		sendMessage:        "/conversations/{id}/messages",
@@ -204 (SendMessage)
-	body, err := json.Marshal(types.SendMessageRequest{Message: content})
+	body, err := json.Marshal(types.SendMessageRequest{Content: content})
```

```diff
--- a/internal/types/types.go
-// SendMessageRequest is the POST body for /conversations/{id}/send.
+// SendMessageRequest is the POST body for /conversations/{id}/messages.
 type SendMessageRequest struct {
-	Message string `json:"message"`
+	Content string `json:"content"`
 }
```

Anyone still pointing at the legacy Python orchestrator can restore old behavior via
`Config.Endpoints` (`tui.go:95` passes it through) — but the body key is intentionally NOT
configurable; the legacy `/send`+`message` pairing dies with this change (see Open decisions §7.4).

### 1.2 Fix #2 — create body `{agent_name}`→`{agent_id}`

Evidence:
- `types.CreateConversationRequest{AgentName: agentID}` marshaled at `client.go:171`; DTO
  `AgentName string \`json:"agent_name"\`` at `types.go:105-109`. Single consumer (grep).
- Server destructures `body.agent_id` and looks it up; a missing key manifests as 404
  "Agent not found" (server looks up `undefined`), not a 400 — `conversations.ts:64-69`,
  matching live finding N2.
- The response decode is already safe: `client.go:192-196` decodes into
  `types.ConversationResponse` but only reads `.ID`; the server's 201 `{id, agent_id}` decodes
  `id` case-insensitively. `Greeting` stays empty (server sends none) — harmless
  (`app/model.go:191-193` only renders non-empty greetings).

Proposed diff:

```diff
--- a/internal/types/types.go
 // CreateConversationRequest is the POST body for /conversations/.
 type CreateConversationRequest struct {
-	AgentName string  `json:"agent_name"`
+	AgentID string  `json:"agent_id"`
 	Model     *string `json:"model,omitempty"`
 }
```

```diff
--- a/internal/httpclient/client.go
@@ -171 (CreateConversation)
-	body, err := json.Marshal(types.CreateConversationRequest{AgentName: agentID})
+	body, err := json.Marshal(types.CreateConversationRequest{AgentID: agentID})
```

**R1 scope-on-create seam (same change site).** R1 also adds scope/preset on create. The shape
the server wants is `{"agent_id": "...", "scope": {…}}` (`conversations.ts:64`, `scope` wins
over the deprecated `context` alias, `:73-77`). Concretely:

- Add `Scope map[string]any \`json:"scope,omitempty"\`` to `CreateConversationRequest`.
- The `types.Client` interface (`internal/types/client.go:15`) has
  `CreateConversation(ctx, agentID string)` — plumb an options param:
  `CreateConversation(ctx context.Context, agentID string, opts *types.CreateOptions)` with
  `type CreateOptions struct { Scope map[string]any }`. Mechanical update in 6 implementations:
  `httpclient` (+ its `StubClient`, `client.go:170,329`), `stdioclient`, `cliclient`,
  `execclient`, `internal/demo` — non-HTTP clients ignore `opts`.
- Error surfacing: `client.go:188-190` collapses non-201 into `"create conversation: HTTP %d"`,
  discarding the body. Scope failures return 400 `{error:"scope validation failed", issues[]}`
  (`conversations.ts:130-137`) — read the body on non-201 and include `error` (+ issues count)
  in the returned error, or scope validation will be undebuggable from the TUI.
- Presets: the server does NOT materialize presets server-side; `GET /agents` exposes
  `instantiation.presets` (`agents.ts:88-93`) and the client materializes the chosen preset into
  `scope` (this is how the React chat does it, gap-analysis §1.4). R1 minimal: a
  `--preset`/`--scope` flag or env on the cockpit cmd resolved against `instantiation.presets`
  before create.

### 1.3 Fix #3 — `role` object decode, in BOTH httpclient and contracttest

**Site A — `internal/httpclient/client.go:110-144`.** The canonical decode unmarshals into
`[]types.AgentSummary` whose fields are untagged `ID/Name/Role string` (`types.go:6-10`); Go's
case-insensitive matching binds the wire `role` object to the string field and errors
(live-confirmed N1). The legacy `[]string` fallback then also fails. Additionally
`AgentSummary.Role` is a *display* string, rendered as tertiary text in the agent picker
(`internal/app/model.go:367-371`) — the server's richest display string is `description`, not
`role.name`.

Proposed change — decode via a wire DTO, keep the legacy `[]string` fallback intact:

```go
// wireAgent matches GET /agents from the agentic-patterns TS server
// (agent-server/src/routes/agents.ts:76-93). role is {id,name} | null.
type wireAgent struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Role        *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"role"`
}
```

```diff
--- a/internal/httpclient/client.go (ListAgents, lines 116-120)
-	// Try decoding as []AgentSummary first (canonical format)
-	var agents []types.AgentSummary
-	if err := json.Unmarshal(body, &agents); err == nil && len(agents) > 0 && agents[0].ID != "" {
-		return agents, nil
-	}
+	// Try decoding the canonical TS-server shape first (role is an object|null).
+	var wire []wireAgent
+	if err := json.Unmarshal(body, &wire); err == nil && len(wire) > 0 && wire[0].ID != "" {
+		agents := make([]types.AgentSummary, 0, len(wire))
+		for _, w := range wire {
+			display := w.Description
+			if display == "" && w.Role != nil {
+				display = w.Role.Name
+			}
+			agents = append(agents, types.AgentSummary{ID: w.ID, Name: w.Name, Role: display})
+		}
+		return agents, nil
+	}
 	// Fallback: try as []string (legacy format)   [unchanged, lines 122-144]
```

(`description` is always present on the TS wire — `agents.ts:78` emits `a.description ?? ""`.)

**Site B — `contracttest/validate.go:50-54`.** The anonymous struct types `Role string`; the
suite dies at ListAgents before create/send ever run (live-confirmed). Only `ID` is asserted, so
the most robust fix is shape-agnostic:

```diff
--- a/contracttest/validate.go
 		var agents []struct {
-			ID   string `json:"id"`
-			Name string `json:"name"`
-			Role string `json:"role"`
+			ID   string          `json:"id"`
+			Name string          `json:"name"`
+			Role json.RawMessage `json:"role"` // object | string | null — contract only asserts ID
 		}
```

Two contracttest facts the implementer should know (both verified in this scout):
1. **Create/send in contracttest are already correct** — `validate.go:74` sends
   `{"agent_id": …}` and `validate.go:107-108` posts `{"content"}` to
   `/conversations/{id}/messages`. Only the role decode blocks the suite; with it fixed the
   remaining steps pass against a live `ap playground` (per the smoke-test report, re-verified
   as still-current code).
2. The **mock server in `contracttest/validate_test.go:13-17` serves `role` as a string**
   (`mockAgent.Role string`). Update the mock to the real server shape
   (`"role": {"id":"…","name":"…"}`) in the same PR so the mock stops encoding the stale
   contract. With `json.RawMessage` both shapes pass, but the mock should model the truth.

### 1.4 Fix #4 — parse canonical `tool.rejected`

Evidence: `internal/sse/parse.go:119` cases only `"agent.tool.rejected"`. The server emits
`tool.rejected` with `{tool_name, reason, gate_name}` (`sse-formatter.ts:161-169`). The render
path already exists: `ChunkToolReject` → "Tool rejected: name: reason" (`chat/model.go:690-697`).

Proposed diff:

```diff
--- a/internal/sse/parse.go
-	case "agent.tool.rejected":
+	case "agent.tool.rejected", "tool.rejected":
 		var d struct {
 			ToolName string `json:"tool_name"`
 			Reason   string `json:"reason"`
+			GateName string `json:"gate_name"`
 		}
 		if err := json.Unmarshal([]byte(evt.Data), &d); err != nil {
 			return nil
 		}
+		reason := d.Reason
+		if d.GateName != "" {
+			reason += " (gate: " + d.GateName + ")"
+		}
 		return &types.StreamChunk{
-			Content:  d.Reason,
+			Content:  reason,
 			Type:     types.ChunkToolReject,
 			ToolName: d.ToolName,
 		}
```

(The gate suffix is optional polish; the two-token case addition is the required part. Still not
live-verifiable without an LLM key + an approval-gated agent — code-read + unit test only.)

**Freebie in the same file:** canonical `iteration.start`/`iteration.end` are also unparsed —
`parse.go:133` cases only `"agent.iteration.start", "agent.iteration.end"`. Add the canonical
names to the same case while touching the file:
`case "agent.iteration.start", "agent.iteration.end", "iteration.start", "iteration.end":`.

### 1.5 Fix #5 — `message.complete` tokens + `done.run_id`

Evidence and the one real subtlety:
- `parse.go:69-72`: `message.complete` returns `{Done: true}` and discards the payload;
  `SSEMessageCompleteData` (`sse/types.go:12-16`) is dead code and lacks the `model` field the
  server also sends (`sse-formatter.ts:100`).
- `parse.go:136-137`: `done` returns `{Done: true}`, discarding `run_id`.
- **The subtlety:** because `message.complete` currently sets `Done`, the httpclient reader
  goroutine returns at that chunk (`httpclient/client.go:238-241`) — the `done` frame is
  *unreachable*. Capturing `run_id` therefore REQUIRES demoting `message.complete` from
  Done-signal to data-carrier and letting `done` (or channel close) terminate the turn.
- Safety net for streams that never send `done` (legacy Python backends, N5 torn streams):
  channel close synthesizes `{Done: true}` twice over — `httpclient/client.go:244-245` and
  `chat/model.go:1031-1033` (`readStream` on closed channel). So demoting `message.complete`
  cannot hang any existing backend that closes the response body. (A hypothetical legacy server
  that holds the connection open after `agent.message.complete` would hang — accepted risk,
  see Open decisions §7.2.)

Proposed diffs:

```diff
--- a/internal/types/types.go (ChunkType consts)
 	ChunkLLMStart        ChunkType = "llm_start"
 	ChunkLLMEnd          ChunkType = "llm_end"
+	ChunkMsgComplete     ChunkType = "msg_complete" // terminal message stats (tokens/model)
```

```diff
--- a/internal/types/types.go (StreamChunk)
 	// LLM call metadata (populated for ChunkLLMEnd)
 	ModelName    string
 	InputTokens  int
 	OutputTokens int
+	// RunID is the server-side run id from the SSE `done` frame (populated
+	// on the terminal Done chunk; empty for backends that don't send it).
+	RunID string
```

```diff
--- a/internal/sse/types.go
 // SSEMessageCompleteData is the JSON payload for agent.message.complete events.
 type SSEMessageCompleteData struct {
 	Content      string `json:"content"`
 	InputTokens  int    `json:"input_tokens"`
 	OutputTokens int    `json:"output_tokens"`
+	Model        string `json:"model"`
 }
```

```diff
--- a/internal/sse/parse.go
 	case "agent.message.complete", "message.complete":
-		// Content was already streamed incrementally via chunks.
-		// Only signal completion — do not repeat the full content.
-		return &types.StreamChunk{Done: true, Type: types.ChunkText}
+		// Content was already streamed incrementally via chunks — never
+		// repeat it. Carry the turn stats; the turn ends on `done` (or
+		// channel close for backends that don't send one).
+		var d SSEMessageCompleteData
+		if err := json.Unmarshal([]byte(evt.Data), &d); err != nil {
+			return &types.StreamChunk{Type: types.ChunkMsgComplete}
+		}
+		return &types.StreamChunk{
+			Type:         types.ChunkMsgComplete,
+			ModelName:    d.Model,
+			InputTokens:  d.InputTokens,
+			OutputTokens: d.OutputTokens,
+		}
@@
 	case "done":
-		return &types.StreamChunk{Done: true, Type: types.ChunkText}
+		var d struct {
+			RunID string `json:"run_id"`
+		}
+		_ = json.Unmarshal([]byte(evt.Data), &d) // "{}" when no run started
+		return &types.StreamChunk{Done: true, Type: types.ChunkText, RunID: d.RunID}
```

Consumer side (`chat/model.go handleResponse`, switch at :607): add a case that stashes the
stats on the model — rendering is R3's token-footer job, R1 only captures:

```go
case types.ChunkMsgComplete:
	m.lastModel = chunk.ModelName
	m.lastInputTokens = chunk.InputTokens
	m.lastOutputTokens = chunk.OutputTokens
```

plus `m.lastRunID = chunk.RunID` inside the existing `if chunk.Done` block (`model.go:724`)
when `chunk.RunID != ""` (new Model fields: `lastModel string`, `lastInputTokens`,
`lastOutputTokens int`, `lastRunID string`). Without a case, `ChunkMsgComplete` would fall
through the switch harmlessly (no default case; the Done check at :724 still runs) — so this is
additive, not load-bearing for stream termination.

`skipStreaming` (`model.go:867-939`): its `default:` arm appends `chunk.Content` as text but is
guarded by `chunk.Content != ""` (`:928`) — `ChunkMsgComplete`/`done` chunks have empty Content,
so no change is strictly required there; optionally mirror the stash.

Existing tests that MUST change with this fix:
- `internal/sse/parse_test.go:84` `TestChunkFromSSE_MessageComplete_NoDuplication` asserts
  `Done == true` — becomes: not Done, Type `ChunkMsgComplete`, tokens/model populated.
- `parse_test.go:182` `TestChunkFromSSE_Done` — extend with a `{"run_id":"run-123"}` payload
  assertion.

---

## 2. Abort — cancelable context + Esc wiring

### 2.1 The traced update loop (who sees a key first)

1. `tea.Program` runs `app.Model` (`tui.go:162-165`).
2. `app.Model.Update` (`internal/app/model.go:122`): the `tea.KeyPressMsg` case at `:165-172`
   handles **ctrl+c → tea.Quit** and ctrl+m (mouse toggle), then *falls through* (no return for
   other keys) to the phase switch at `:231-236`.
3. In chat phase → `updateChat` (`app/model.go:276-291`): **Esc is intercepted here, before the
   chat model ever sees it** — non-empty input → clear input; empty input → back to agent-select
   (`:278-286`). This is the bug surface: pressing Esc mid-stream today drops you to the picker
   while the stream keeps folding (stream `ResponseMsg`s are routed at app level `:200-207`
   regardless of phase — verified).
4. Only then `m.chat.Update(msg)` → `chat.Model.handleKey` (`chat/model.go:409`); its streaming
   branch (`:423-430`) accepts only Enter (= `skipStreaming`, drain-don't-cancel).
5. The request itself: `submit()` calls
   `client.SendMessage(context.Background(), convID, text)` at `chat/model.go:568` — the
   documented no-abort hole. The transport is ready for cancellation: `httpclient.SendMessage`
   builds the request with `http.NewRequestWithContext` and a timeout-free stream client
   (`httpclient/client.go:210-223`, comment at `:217-218` says "cancellation is handled via
   ctx"), and `sse.ParseSSE` closes the body and surfaces read errors as a synthetic `error`
   event (`sse/parse.go:19`, `:51-53`).

**Interception points (both needed):** `app/model.go:278` (Esc reaches the app first) and, for
completeness/standalone use, the chat streaming branch `chat/model.go:423-430`.

### 2.2 Proposed changes

`internal/chat/model.go` — Model fields (struct at `:149-169`):

```diff
 	streaming         bool
 	streamCh          <-chan types.StreamChunk
+	cancelStream      context.CancelFunc // cancels the in-flight SendMessage
+	aborted           bool               // user-initiated cancel → render "stopped", not error
```

`submit()` (`:566-575`):

```diff
 	client := m.client
 	convID := m.conversationID
-	ch, err := client.SendMessage(context.Background(), convID, text)
+	ctx, cancel := context.WithCancel(context.Background())
+	ch, err := client.SendMessage(ctx, convID, text)
 	if err != nil {
+		cancel()
 		m.streaming = false
 		m.messages = append(m.messages, TextMessage(RoleAssistant, "Error: "+err.Error()))
 		m.rebuildViewportContent()
 		return *m, nil
 	}
+	m.cancelStream = cancel
 	m.streamCh = ch
```

New accessors (near `IsInputEmpty`, `:256`):

```go
// IsStreaming reports whether a turn is currently in flight.
func (m *Model) IsStreaming() bool { return m.streaming }

// AbortStream cancels the in-flight request. There is no server cancel
// route (gap-analysis §2.6.2) — canceling the context tears down the POST
// body, which IS the server's cancellation contract (same as the React
// client's connection-drop; note it also fail-closed-denies any pending
// HITL approvals server-side).
func (m *Model) AbortStream() {
	if m.cancelStream == nil {
		return
	}
	m.aborted = true
	m.cancelStream()
	m.cancelStream = nil
}
```

Streaming key branch (`:423-430`):

```diff
 	if m.streaming {
 		// Enter skips streaming — drain remaining chunks immediately
 		if k == "enter" {
 			m.skipStreaming()
 			return *m, nil
 		}
+		// Esc aborts the in-flight turn (aborted ≠ error).
+		if k == "esc" {
+			m.AbortStream()
+			return *m, nil
+		}
 		return *m, nil
 	}
```

`handleResponse` error arm (`:596-602`) — distinguish abort, and fix the pre-existing
spinner leak (this arm never resets `spinnerActive`, unlike the Done arm at `:727` — after a
stream error the tick loop at `:369-381` keeps rebuilding the viewport forever):

```diff
 	if chunk.Error != nil {
 		m.streaming = false
 		m.streamCh = nil
+		m.spinnerActive = false
+		if m.cancelStream != nil {
+			m.cancelStream()
+			m.cancelStream = nil
+		}
+		if m.aborted {
+			m.aborted = false
+			m.messages = append(m.messages, TextMessage(RoleSystem, "⊘ stopped"))
+			m.rebuildViewportContent()
+			return *m, nil
+		}
 		m.messages = append(m.messages, TextMessage(RoleAssistant, "Error: "+chunk.Error.Error()))
 		m.rebuildViewportContent()
 		return *m, nil
 	}
```

Done arm (`:724-737`) — release the context and clear the abort flag (covers the race where the
user aborts exactly as the stream finishes cleanly):

```diff
 	if chunk.Done {
 		m.streaming = false
 		m.streamCh = nil
 		m.spinnerActive = false
+		m.aborted = false
+		if m.cancelStream != nil {
+			m.cancelStream()
+			m.cancelStream = nil
+		}
```

`internal/app/model.go` `updateChat` (`:276-291`) — abort must win over "back to picker":

```diff
 	if keyMsg, ok := msg.(tea.KeyPressMsg); ok {
 		if keyMsg.String() == "esc" {
+			if m.chat.IsStreaming() {
+				m.chat.AbortStream()
+				return m, nil
+			}
 			if !m.chat.IsInputEmpty() {
 				m.chat.ClearInput()
 				return m, nil
 			}
 			m.phase = PhaseSelectAgent
 			return m, nil
 		}
 	}
```

Also update the legend hint (`app/model.go:397`): `esc: back` → `esc: stop/back` (or similar).

### 2.3 How cancellation actually terminates the stream (traced)

Cancel ctx → the in-flight `resp.Body.Read` fails with `context.Canceled` → `ParseSSE`'s scanner
stops, `scanner.Err() != nil` → synthetic
`SSEEvent{Event:"error", Data:{"error_type":"scan_error","message":"context canceled"}}`
(`sse/parse.go:51-53`) → `ChunkFromSSE` error case (`:139-148`) → `StreamChunk{Done:true,
Error:&APIError{…}}` → reader goroutine returns (`httpclient/client.go:239-241`) → channel closes
→ `handleResponse` error arm sees `m.aborted` and renders "⊘ stopped". If cancellation lands
after a clean EOF, the Done arm clears the flag instead. Do NOT string-match "context canceled"
(it arrives laundered through the scan_error APIError) — the `aborted` flag is the discriminator.

Ctrl+C stays as-is (`app/model.go:166` → `tea.Quit`): process exit closes the connection, which
is the same server-side teardown. (Alternative — first press aborts, second quits — in Open
decisions §7.1.)

`go vet` note: the `lostcancel` check is satisfied — `cancel` is called on the submit error
path and stored otherwise; the Done/error arms release it.

---

## 3. No-allowlist flip — unknown SSE events pass through

### 3.1 How unknown events flow today

- `ParseSSE` **already forwards every event** regardless of name (`sse/parse.go:14` — "Unknown
  event types are silently forwarded — the consumer decides").
- The drop happens one layer up: `ChunkFromSSE`'s `default:` returns `nil`
  (`parse.go:150-152`), and the httpclient reader skips nil chunks
  (`httpclient/client.go:236-238`). Today this silently eats: `conversation.start/end`,
  `message.start`, `message.cancel`, `thinking.start`, `thinking.complete` (as a distinct name),
  `tool.intent`, `tool.progress`, `input.request`, `iteration.*` (canonical names), `llm.*`,
  `step.*`, `state.delta`, `backpack.*`, `scratchpad.*` — the full §2.2 #7 list, plus the R2
  HITL trigger.
- Note the asymmetry the flip must preserve: known-event frames with **malformed JSON** also
  return nil (e.g. `parse.go:64-66`) — that matches React's "drop only malformed, never by name"
  rule (§2.6.3). The flip changes only the by-name drop.

### 3.2 Minimal change

`internal/types/types.go`:

```diff
 	ChunkLLMEnd          ChunkType = "llm_end"
+	ChunkUnknown         ChunkType = "unknown" // passed-through event with no typed mapping
```

```diff
--- StreamChunk
 	ToolError   string
 	DurationMs  int
+	// Raw passthrough (populated for ChunkUnknown): the SSE wire name and
+	// unparsed JSON payload, for generic rendering / debug sinks / future
+	// typed handling (input.request, step.*, state.delta, …).
+	RawEvent string
+	RawData  string
```

`internal/sse/parse.go`:

```diff
-	default:
-		// Unknown events are silently ignored per spec
-		return nil
+	default:
+		// No-allowlist discipline (gap-analysis §2.6.3): pass unknown events
+		// through to the reducer layer; only malformed frames are dropped.
+		// This is what keeps future vocabulary (input.request, step.*,
+		// state.delta) reachable without a parser release.
+		return &types.StreamChunk{
+			Type:     types.ChunkUnknown,
+			RawEvent: evt.Event,
+			RawData:  evt.Data,
+		}
```

### 3.3 Why this cannot break existing typed handling (verified paths)

- `httpclient` reader (`client.go:233-246`): forwards any non-nil chunk; `Done` is false on
  unknown chunks → stream continues. No change needed.
- `chat/model.go handleResponse` switch (`:607-722`) has **no default case** — a `ChunkUnknown`
  falls through all arms, hits the `chunk.Done` check (false), triggers a viewport rebuild and
  re-arms `readStream`. Behavior-identical to today's drop, minus the loss of the data.
- `skipStreaming` (`:867-935`) DOES have a `default:` arm that appends `chunk.Content` as text —
  guarded by `chunk.Content != ""` (`:928`), and `ChunkUnknown` carries empty `Content` (payload
  lives in `RawData`). Safe. Add `case types.ChunkUnknown:` (no-op) there anyway to make the
  intent explicit rather than coincidental.
- Other `types.Client` implementations (stdioclient, cliclient, execclient, demo) construct
  chunks directly and never call `ChunkFromSSE` (verified: its only non-test consumer is
  `httpclient/client.go:236`) — unaffected.

### 3.4 Debug sink (recommended, tiny)

In `handleResponse`, an opt-in status line so unknown traffic is *visible* during R2/R3 bring-up:

```go
case types.ChunkUnknown:
	if m.debugEvents { // new Model field, set from env in chat.New
		appendToParts(target, PartStatus, "⋯ "+chunk.RawEvent)
	}
```

with `debugEvents: os.Getenv("CHAT_DEBUG_EVENTS") != ""` in `New` (`chat/model.go:207`).
`PartStatus` already renders as a dim status line (same idiom as the `llm.end` token line,
`:718-721`). A `/debug` slash command can replace the env var later (Open decisions §7.5).

Existing test that MUST flip: `internal/sse/parse_test.go:193`
`TestChunkFromSSE_UnknownEvent_ReturnsNil` → becomes `…_PassesThrough` asserting
`Type == ChunkUnknown`, `RawEvent == "unknown.event.type"`, `RawData` preserved, `Done == false`.
`TestChunkFromSSE_InvalidJSON_ReturnsNil` (`:201`) stays as-is — malformed still drops.

---

## 4. Cockpit consumer cmd — survey and recommendation

### 4.1 Templates surveyed

**`_examples/agentic-patterns/main.go` (40 lines, read in full)** — the minimal HTTP consumer:
`tui.New(tui.Config{AppName, AssistantLabel, BackendURL})` + `app.Run()`. Points at the *dead
Python orchestrator* (`http://localhost:8080/api` default, `AP_BACKEND_URL` env, header comment
references `python -m uvicorn agentic_patterns.app.orchestrator.app`). Right shape, wrong
target; its endpoint assumptions predate every fix in §1.

**`cmd/agenti-kit/` (read: main.go, agencies.go, commands/commands.go)** — the full consumer:

```
cmd/agenti-kit/
  main.go          # tui.New(Config{AppName, AssistantLabel, BackendStdio, Commands})
  agencies.go      # hard-coded types.AgencyConfig teams (shape/spec/build)
  commands/        # commands.go = All() aggregator; one file per slash command
    commands.go  shape.go  spec.go  build.go  issues.go  settings.go
  providers/       # provider probing + config persistence (anthropic/openai/google/ollama)
```

Patterns worth copying: the `commands.All(deps) []tui.CommandDef` aggregator
(`commands/commands.go:16-26`), one-file-per-command, config via `tui.Config` only.
Patterns NOT to copy: `BackendStdio` spawning a Python bridge (`main.go:27-31`), the
`agenticPatternsDir()` sibling-repo walk (`main.go:52-73`), and note `Config.OnReady` is
declared but never invoked anywhere (`config.go:43-44`; `main.go:18-19`'s comment pretends
otherwise) — don't build on it.

### 4.2 Recommendation

**Name: `cmd/cockpit`** (binary `cockpit`) — matches the stack's "harness cockpit" vocabulary
and avoids colliding with the TS `ap` CLI namespace. Runner-up: `cmd/ap-cockpit` if the binary
will be installed on PATHs where `cockpit` (the Linux admin tool) is a real conflict.

Structure (start minimal, grow into agenti-kit's shape when slash commands arrive in R2/R3):

```
cmd/cockpit/
  main.go          # R1: this is the whole thing
  commands/        # R2+: /sessions, /scope, /debug, /approve-style commands
```

Proposed `main.go` (R1):

```go
// cockpit is the harness cockpit for the agentic-patterns TS server.
// It speaks the live server contract: GET /agents, POST /conversations
// {agent_id, scope?}, POST /conversations/{id}/messages {content} → SSE.
//
// Run the server first:  ap playground        (default port 3456)
// Then:                  go run ./cmd/cockpit  [AP_SERVER_URL=... to override]
package main

import (
	"fmt"
	"os"

	tui "github.com/pattern-stack/chat-patterns"
)

func main() {
	app, err := tui.New(tui.Config{
		AppName:        "agentic-patterns",
		AssistantLabel: "agent:",
		BackendURL:     "http://localhost:3456",
		EnvOverride:    "AP_SERVER_URL",
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if err := app.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
```

Verified semantics backing this: `EnvOverride` is checked first and wins when the env var is
set (`tui.go:62-67`); with the env unset, `BackendURL` applies (`tui.go:94-95`). No
`Endpoints:` override is needed once §1.1's default-path fix lands. Port 3456 / root-mounted
routes verified (`constants.ts:18`, `app.ts:35-58`).

Also add a Justfile recipe (pattern: existing `kit:` recipe at `Justfile:31-33`):

```just
# Chat against a running `ap playground` (agentic-patterns TS server)
cockpit:
    cd cmd/cockpit && go run .
```

Disposition of `_examples/agentic-patterns/`: repoint its README/comments at `cmd/cockpit` or
delete it — leaving a Python-orchestrator example named "agentic-patterns" next to a TS-server
cockpit is a foot-gun (Open decisions §7.6).

---

## 5. CI — minimal quality gate

Verified: the repo has **no `.github/` directory at all** and no other CI config; but the
Justfile already defines exactly the right gate — `quality: go build ./... && go vet ./... &&
go test ./...` (`Justfile:43-45`), and it passes today at `187411b`. Proposal —
`.github/workflows/check.yml` (job named `check`, mirroring the TS repo's required-status name,
so branch protection can be enabled with the same convention later):

```yaml
name: check
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod   # go 1.25.0 (go.mod:3)
          cache: true
      - uses: extractions/setup-just@v3
      - run: just quality
```

If a third-party `setup-just` action is unwanted, inline the three commands instead
(`run: go build ./... && go vet ./... && go test ./...`) — but routing through `just quality`
keeps local and CI gates definitionally identical.

---

## 6. Test plan per change

Conventions observed: table-free direct assertions, `httptest.Server` for HTTP
(`contracttest/validate_test.go:21-96` is the house mock-server idiom), chat-model tests drive
`handleResponse` directly with hand-built chunks (`internal/chat/model_test.go:9-36`,
`newTestModel()`/`resp()` helpers).

| Change | Tests |
|---|---|
| #1 send path/body | NEW `internal/httpclient/client_test.go` (package currently untested): httptest server capturing `r.URL.Path` and body → assert `POST /conversations/c1/messages` and body `{"content":"hi"}`; serve two `message.delta` + `message.complete` + `done` frames and assert the chunk sequence. Also: `EndpointConfig` override still rewrites the path. |
| #2 create body | Same file: assert body `{"agent_id":"a1"}` and that a 201 `{id, agent_id}` yields `CreateConversationResult{ID:"…"}`. When the scope seam lands: `{"agent_id":…,"scope":{…}}` with opts set, key absent with opts nil; non-201 error includes the server's `error` string. |
| #3 role decode ×2 | httpclient test: serve the real TS shape (`role` object, `role: null`, and `description`-only) → assert `AgentSummary{ID,Name,Role}` mapping incl. description fallback; keep a legacy `[]string` fixture green. contracttest: update `mockAgent` (`validate_test.go:13-17`) to `Role` as `{id,name}` object; `ValidateBackend` must pass against the updated mock. |
| #4 tool.rejected | `parse_test.go`: NEW `TestChunkFromSSE_ToolRejected_CanonicalName` with payload `{"tool_name":"deploy","reason":"denied","gate_name":"approval"}` → `ChunkToolReject`, ToolName set, Content contains reason + gate; keep the legacy-name test. Render path already covered by `TestPartAccumulation_ToolReject` (`chat/model_test.go:152`). |
| #5 tokens/run_id | UPDATE `TestChunkFromSSE_MessageComplete_NoDuplication` (`parse_test.go:84`): now `Done==false`, `Type==ChunkMsgComplete`, tokens+model populated, Content still empty. UPDATE `TestChunkFromSSE_Done` (`:182`): `{"run_id":"r-1"}` → `Done && RunID=="r-1"`; bare `{}` → `RunID==""`. NEW chat-model test: delta → msg_complete(tokens) → done(run_id) sequence finalizes exactly once and stashes stats/run_id. Guard test: stream ending WITHOUT `done` (channel close) still finalizes (synthetic Done path, `client.go:244-245`). |
| Abort | Chat-model test: submit-like state (streaming=true, cancel stub), `AbortStream()`, then error chunk → last message is the system "stopped" line, `streaming==false`, `spinnerActive==false`, `aborted` reset; error chunk WITHOUT abort → "Error:" message (existing behavior). httpclient test: httptest handler that flushes one delta then blocks on a channel; cancel the ctx; assert the chunk channel closes with a terminal Error/Done chunk within a timeout. App-level: `updateChat` with streaming chat + Esc keeps `phase == PhaseChat` (no picker exit) — needs a small fake around `chat.Model` state or drive via exported setters. |
| No-allowlist flip | FLIP `TestChunkFromSSE_UnknownEvent_ReturnsNil` (`parse_test.go:193`) → passthrough assertions (`ChunkUnknown`, RawEvent/RawData, !Done). KEEP `TestChunkFromSSE_InvalidJSON_ReturnsNil` (`:201`) — malformed still drops. Chat-model test: `ChunkUnknown` chunk produces zero parts with debug off, one `PartStatus` ("⋯ event.name") with debug on, and never terminates the stream. |
| Cockpit cmd | `go build ./cmd/cockpit` (covered by `just quality`); no unit tests needed for a 30-line main. Live: `ap playground` + `AP_SERVER_URL` unset → agent list appears, one full turn streams. |
| Contract (live) | Optional but recommended: env-gated live runner in contracttest — `func TestLiveBackend(t *testing.T) { url := os.Getenv("CHAT_BACKEND_URL"); if url == "" { t.Skip(...) }; ValidateBackend(t, url) }` — run manually against `http://localhost:3456`. After §1 lands, all four steps should pass (create/send were verified already-correct in this scout; only the role decode blocks today). Keep out of CI (needs a live server). |

Live-verification ceiling (unchanged from the gap-analysis): #4 and the tool/HITL event paths
need an LLM key + tool-calling agent; token fields on `message.complete` need a real model run.
Everything else above is fully testable offline.

---

## 7. Open decisions (each with a recommendation)

1. **Ctrl+C during streaming: quit vs abort-first.** Recommend keep `ctrl+c → tea.Quit`
   (`app/model.go:166`) and make Esc the abort key. Process exit closes the socket, which is
   already the server's cancel semantics; abort-first-quit-second Ctrl+C adds modal state for
   little gain, and Esc matches the React chat's key.
2. **Demoting `message.complete` from Done-carrier.** Required to ever see `done.run_id`
   (§1.5). Risk: a legacy backend that emits `agent.message.complete` but holds the connection
   open would hang until teardown. Recommendation: accept — the only known legacy target (Python
   orchestrator `/send`) closes the response body per turn, and channel close synthesizes Done
   at two layers.
3. **Agent picker display string.** Server offers `description` (always present, may be "")
   and `role.name`. Recommend `description`, fallback `role.name`, fallback empty — description
   is what the dashboard leans on. Also note `GET /agents` carries `readiness.missing`
   (`agents.ts:81-84`); rendering unready agents dimmed is cheap polish, not R1-required.
4. **Legacy compatibility surface.** The `[]string` ListAgents fallback + `getAgentDetail`
   path (`client.go:122-168`) and the `EndpointConfig` path overrides stay; the legacy
   `{"message"}` body key and `agent_name` create key are removed without a compat flag.
   Recommend exactly that split: paths configurable, body shapes canonical-only.
5. **Debug-sink toggle.** Env var `CHAT_DEBUG_EVENTS` for R1 (zero UI plumbing); promote to a
   `/debug` slash command (registry already supports it, `command/`) when R2 touches commands
   anyway.
6. **`_examples/agentic-patterns/` disposition.** Recommend delete (or rewrite as a
   three-line pointer at `cmd/cockpit`) in the same PR that adds the cockpit — two things named
   "agentic-patterns" speaking two different contracts is exactly how the N6-style drift
   happened.
7. **Scope-on-create plumbing shape.** `CreateOptions` struct param on the `types.Client`
   interface (§1.2) vs a separate `CreateConversationWithScope` method. Recommend the options
   param: 6 mechanical call-site updates, no interface bloat, and R2/R3 will want more options
   (preset name, maxIterations) in the same bag.
8. **PR slicing for R1.** Recommended order (each lands green through `just quality`):
   (1) CI workflow + cockpit cmd skeleton (gets the gate live first);
   (2) wire fixes #1–#3 + contracttest mock update (unblocks the live contract suite);
   (3) #4 + #5 + no-allowlist flip (same two files, shared tests);
   (4) abort. Item (1) before (2) so every wire fix merges through CI.

## 8. Corrections / drift found while scouting

- Gap-analysis §2.2 line for the send-body DTO cites `types.go:85-87`; at `187411b` it is
  `types.go:111-114` (file grew). All other §2.2 anchors verified exact: `client.go:32`,
  `client.go:110-168`, `contracttest/validate.go:50-54`, `sse/parse.go:119`,
  `sse/types.go:12-16`, `chat/model.go:568`, `types.go:151`-comment → actually at
  `types.go:178` for the EndpointConfig comment (N6) — both cited lines drifted by the same
  file growth; the facts hold.
- `SSEMessageCompleteData` is missing the server's `model` field — not called out in the
  gap-analysis (#5 says "tokens"); the token footer (R3) wants model too, so add it now (§1.5).
- Pre-existing bug worth the drive-by fix in the abort PR: `handleResponse`'s error arm never
  resets `spinnerActive` (`chat/model.go:596-602` vs the Done arm `:727`), leaving spinner ticks
  rebuilding the viewport indefinitely after any stream error.
- `Config.OnReady` (`config.go:43-44`) is dead — declared, never invoked; don't design the
  cockpit around it.
