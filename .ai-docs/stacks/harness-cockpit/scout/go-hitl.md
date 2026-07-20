# Go R2 scout — HITL approval leg end-to-end (chat-patterns ⇄ agentic-patterns server)

Evidence scout dossier for the harness-cockpit R2 round: wire the human-in-the-loop
`input.request` → prompt → `POST /conversations/:id/input` → resolution loop into the Go TUI.

- Go repo: `/Users/dug/Projects/sandbox/chat-patterns` (canonical: github.com/pattern-stack/chat-patterns), HEAD `0c93dd1`, `go build ./...` clean (verified 2026-07-19).
- TS repo: `/Users/dug/Projects/sandbox/agentic-patterns-ts/.claude/worktrees/atomic-soaring-taco` (all TS paths below relative to it), commit lineage of `main` @ 10d5c0b.
- Strategy context: `.ai-docs/research/cli-chat-parity/gap-analysis.md` §2.2 item #6 ("the one real feature build"), §2.6; mechanism background: `.ai-docs/research/cli-chat-parity/reports/hitl-in-process-feasibility.md`.

Every claim below is anchored to a file:line I read in this pass, or a command output. Line
numbers for `chat-patterns` were re-verified with `grep -n` after one stale-read incident.

---

## 0. Verdict summary

The server side is **done and tested** — nothing to build there (§1). The Go side needs five
surgical changes (§3 A–E) plus one guard in the app shell (§3 F): a parser case, two type
additions, one HTTP client method behind an optional interface, prompt state + key routing in
the chat model, and render cases reusing the already-shipped (but chat-unwired) `ConfirmPrompt`
/ `RadioSelect` molecules. Two behavioral traps are called out that a naive port would hit:
the **enter-to-skip drain deadlock** (§3.D5) and the fact that **`tool.rejected` never appears
on the per-turn POST stream — a deny arrives as `error {error_type:"ToolCallBlocked"}`** (§1.4,
§3.D6). Estimated size: ~300 production LOC Go + ~300 test LOC, one PR (or two: parser/client
+ model/view).

---

## 1. Server side — already done (verify-only, no R2 server work)

### 1.1 Outbound leg: `input.request` on the per-turn POST stream

- Event type: `agent.input.request`, `packages/agent-runtime/src/events/types.ts:221-242`.
  Fields: `correlationId`, `kind: "approval"|"select"|"text"` (`HumanInputKind`, :219),
  `prompt`, `options?`, `toolName?`, `toolCallId?`, `arguments?`.
- Wire mapping: `packages/agent-runtime/src/transport/sse-formatter.ts:105-116` — SSE event
  name **`input.request`**, payload (snake_case):

  ```json
  {
    "correlation_id": "call-1",       // always present
    "kind": "approval",               // always present; "approval" | "select" | "text"
    "prompt": "The agent wants to run \"danger\". Approve?",  // always present
    "options": ["a","b"],             // only if set (kind "select")
    "tool_name": "danger",            // only if set
    "tool_call_id": "call-1",         // only if set (== correlation_id for gate approvals)
    "arguments": {"payload":"x"}      // only if set
  }
  ```

  NOTE: on the per-turn POST stream there is **no `traceId`/`timestamp` enrichment** — the
  server route uses `agentEventToSSE` → raw `toSSEMapping` payload
  (`packages/agent-server/src/sse.ts:36-40`); only the admin firehose's `SSEFormatter.format`
  enriches (`sse-formatter.ts:408-419`). The Go client needs nothing beyond the payload above.
- Delivery: the chat route subscribes `agent.input.request` on the shared bus and writes it
  onto **this turn's** SSE stream, filtered by traceId, before/while the runner generator is
  parked (`packages/agent-server/src/routes/conversations.ts:363-389`; the no-write-race
  invariant is documented at :386 — "The runner is blocked here, so no concurrent writeSSE
  races this").
- **Only producer today is the approval gate**, and it always emits `kind:"approval"`:
  `packages/agent-runtime/src/interaction/approval-gate.ts:70-80` (`kind: "approval"` at :75;
  `correlationId = intent.toolCallId` at :59). Verified by grep across runtime/server/cli —
  no `select`/`text` producer exists yet. This scopes R2 (see Open Decision D3).

### 1.2 Return leg: `POST /conversations/:id/input`

`packages/agent-server/src/routes/conversations.ts:454-491`:

- Body: `{correlation_id: string, decision?: "approve"|"deny", value?: string}`.
- Semantics (:476-479): explicit `decision` wins; else `value` present ⇒ approve; else bare
  call ⇒ **deny**. → the Go client should always send an explicit `decision` (matches the
  React client, `packages/agent-dashboard/src/api/chat-client.ts:124-143`).
- Responses: `200 {ok:true, correlationId, decision}` (:490); `400` missing correlation_id
  (:472-474); `404 {error:"no pending input for correlation_id", correlationId}` when already
  settled/unknown (:486-488); `501 {error:"human-input not configured", hint:...}` when no
  registry (:455-463).
- The route is nothing but `inputRegistry.resolve(...)` — the `:id` is addressing sugar
  (doc comment :447-453).

### 1.3 Fail-closed behavior (timeout + teardown)

- Registry timeout: `PendingInputRegistry.create` auto-resolves **DENY** with
  `timedOut: true` after `timeoutMs` (`packages/agent-runtime/src/interaction/
  pending-input-registry.ts:80-86`; deny constant :47). Timeout is opt-in via
  `AP_APPROVAL_TIMEOUT_MS` in playground wiring
  (`packages/agent-cli/src/commands/playground.ts:100-110`; registry passed to server config
  at :177). The timeout value is **not on the wire** — the client cannot render a countdown.
- Stream teardown: the route's `finally` resolves every still-pending correlationId of the
  turn with `{decision:"deny"}` when the SSE stream ends for any reason — including client
  disconnect (`conversations.ts:434-442`).

### 1.4 What a DENY actually looks like on the chat stream ⚠️

This is the one place the R2 mission statement ("render `tool.rejected` after a deny") needs a
correction, verified in code:

- On block, the gate chain publishes `agent.tool.rejected` **on the bus only** — it is emitted
  inside `AgentEventBus.publish` → `_emitRejection` → `super.publish(rejection)`
  (`packages/agent-runtime/src/events/agent-event-bus.ts:54-96`). It is **never yielded by the
  runner generator**, and the chat route forwards only yielded events plus its one
  `agent.input.request` subscription (`conversations.ts:380-401`). So **`tool.rejected` never
  appears on the per-turn POST stream** (it does reach the admin firehose and the collector).
- What the runner *yields* after a deny (streaming path,
  `packages/agent-runtime/src/runner/agent-runner.ts:1462-1484`):
  `agent.error {errorType:"ToolCallBlocked", message:"Tool call '<name>' blocked by gate",
  recoverable:false}` → `agent.conversation.end {reason:"error"}` → **the run ends** (`return`,
  :1484). On the wire: `event: error` + `event: conversation.end` + `event: done`.
- Confirmed by the server's own e2e test: deny ⇒ stream contains `ToolCallBlocked` and **no**
  `tool.end` (`packages/agent-server/src/__tests__/approval-round-trip.test.ts:214-223`).

Consequence for the Go client: the deny/timeout resolution frame to react to is
`error` with `error_type == "ToolCallBlocked"`, not `tool.rejected`. The canonical
`tool.rejected` parser alias (gap-analysis §2.2 #4, an R1 item) is still worth adding for the
admin stream and future servers, but it is not the R2 deny-rendering path.

### 1.5 "Live-verified" citation

Per gap-analysis rev 2 (`.ai-docs/research/cli-chat-parity/gap-analysis.md`):

- §2.1: "`POST /conversations/:id/input` … **Live-verified on playground**: registry is wired,
  unknown correlation → 404 with the documented JSON shape."
- §2.2 row #6: "the return leg `POST /conversations/:id/input` was live-verified working on
  playground"; the *outbound* event delivery was not runnable live (no LLM key) but is covered
  by server tests I read this pass:
  - `__tests__/approval-round-trip.test.ts:200-224` — real `createServer` + real gate: exactly
    one `input.request` frame despite the double gate-check, approve ⇒ `tool.end`, deny ⇒
    `ToolCallBlocked`, both via a mid-stream `POST .../input` (:187-195).
  - `__tests__/conversations-input.test.ts:99-186` — 501/400/404 ladder, approve resolution,
    bare-`value`-implies-approve, inline delivery + foreign-traceId filtering.

Pre-req reminder: R2 rides on R1's send-path fixes — the Go client still posts
`{"message"}` to `/conversations/{id}/send` by default (`internal/httpclient/client.go:32`,
`:204`; `internal/types/types.go:111-114`), which the TS server 400s. No `input.request`
frame can be observed until R1 lands.

---

## 2. Go side — current state (all verified at HEAD `0c93dd1`)

| Piece | Where | State |
|---|---|---|
| SSE line parser | `internal/sse/parse.go:15-56` (`ParseSSE`) | fine as-is — event/data framing is generic |
| Event→chunk mapper | `internal/sse/parse.go:60-154` (`ChunkFromSSE`) | **no `input.request` case** → falls to `default:` and is silently dropped (:150-153). `tool.rejected` only parsed under legacy name `agent.tool.rejected` (:119-131) |
| Chunk vocabulary | `internal/types/types.go:21-36` (`ChunkType`), `:53-73` (`StreamChunk`) | no input-request chunk type; no correlation/options fields |
| Client interface | `internal/types/client.go:6-25` | 6 methods; **no input-respond method** |
| HTTP client | `internal/httpclient/client.go` | `SendMessage` :203-249 (stream goroutine :231-246 stops at first `Done`); no input POST; `endpointConfig` defaults :28-59 |
| Chat model | `internal/chat/model.go` | streaming chunks via `ResponseMsg` (:382-383, :593-741); keys gated by `m.streaming` (:423-430, only Enter → `skipStreaming`); `skipStreaming` does a **blocking** channel drain (:867-871); send uses `context.Background()` (:568 — R1 fixes) |
| Render | `internal/chat/view.go:289-380` (`renderPart`) | part cases text/thinking/delegation/toolcall/waiting/status/error; no input-request case |
| Molecules | `internal/ui/components/molecules/confirmprompt.go:16-50`, `radioselect.go:25-71` | pure render functions, state caller-owned; **used only by the component gallery** (`internal/app/gallery.go:431-457`), wired to nothing in chat — exactly as gap-analysis §1.1 row HITL says |
| App shell | `internal/app/model.go` | `esc` in chat phase bails to agent-select before the chat model sees it (:277-285); `ctrl+c` quits (:166-168) |

Consumer-facing invariant that makes the design simple: **at most one `input.request` can be
pending per stream**. The runner gate-checks intents sequentially and parks inside
`bus.publish` on the first block (`agent-runner.ts:1450-1462` loop; hitl report §How-the-
blocking-mechanism-works items 1–4), and the Go client has exactly one stream per
conversation. A single `pendingInput *pendingInputState` field is therefore sufficient —
but still store + echo `correlation_id`, never assume.

---

## 3. Change plan (exact sites + proposed shapes)

### A. `internal/types/types.go` — chunk vocabulary (+ ~20 LOC)

Add to the `ChunkType` const block (after `:35`):

```go
ChunkInputRequest ChunkType = "input_request"
```

Add to `StreamChunk` (after the tool fields, `:65-72`):

```go
// Human-input fields (populated for ChunkInputRequest)
CorrelationID string   // echo back to resolve; == ToolCallID for gate approvals
InputKind     string   // "approval" | "select" | "text" (unknown → treat as approval)
Options       []string // for InputKind "select"
```

`Prompt` travels in the existing `Content`; `ToolName`/`ToolCallID`/`Arguments` reuse the
existing tool fields (`:66-69`).

Add the answer DTO (near `SendMessageRequest`, `:111-114`):

```go
// InputResponse answers a ChunkInputRequest (HITL return leg).
type InputResponse struct {
    CorrelationID string
    Decision      string // "approve" | "deny" — always sent explicitly
    Value         string // select/text answer; empty = omitted on the wire
}
```

### B. `internal/types/client.go` — optional responder interface (+ ~8 LOC)

Do **not** widen `types.Client` (that forces stubs into stdioclient, cliclient, execclient,
demo, Stub — 5 extra files for transports that mostly can't support it). Add an optional
interface the chat model type-asserts (Open Decision D1):

```go
// InputResponder is implemented by clients that can answer a human-input
// request (ChunkInputRequest). Clients that cannot (CLI-spawn transports)
// simply don't implement it; the chat renders a read-only waiting state and
// the server's teardown/timeout auto-deny keeps the run from hanging.
type InputResponder interface {
    RespondInput(ctx context.Context, conversationID string, resp InputResponse) error
}
```

Mirrors the React read-only branch (`agent-dashboard/src/chat/parts.tsx:343-344`
`!respond ⇒ "Awaiting a decision (read-only view)."`).

### C. `internal/sse` — parser case (+ ~35 LOC)

`internal/sse/types.go` — payload struct (field names from §1.1, authoritative source
`sse-formatter.ts:105-116`):

```go
// SSEInputRequestData is the JSON payload for input.request events.
type SSEInputRequestData struct {
    CorrelationID string         `json:"correlation_id"`
    Kind          string         `json:"kind"`
    Prompt        string         `json:"prompt"`
    Options       []string       `json:"options"`
    ToolName      string         `json:"tool_name"`
    ToolCallID    string         `json:"tool_call_id"`
    Arguments     map[string]any `json:"arguments"`
}
```

`internal/sse/parse.go` — new case in `ChunkFromSSE` (insert before `default:`, `:150`):

```go
case "input.request":
    var d SSEInputRequestData
    if err := json.Unmarshal([]byte(evt.Data), &d); err != nil {
        return nil
    }
    if d.CorrelationID == "" {
        return nil // unanswerable prompt — drop; server teardown/timeout denies
    }
    return &types.StreamChunk{
        Type:          types.ChunkInputRequest,
        Content:       d.Prompt,
        CorrelationID: d.CorrelationID,
        InputKind:     d.Kind,
        Options:       d.Options,
        ToolName:      d.ToolName,
        ToolCallID:    d.ToolCallID,
        Arguments:     d.Arguments,
    }
```

Also (R1 overlap — include here iff R1 hasn't landed it): widen `:119` to
`case "agent.tool.rejected", "tool.rejected":` and note the canonical payload is
`{tool_name, reason, gate_name}` (`sse-formatter.ts:161-169`) — **no `tool_call_id`** on the
wire, so rejection cannot be correlated to a specific call id; render by `tool_name` only.
This alias serves the admin firehose / future servers; the live deny path is §1.4's `error`.

If R1's "no-allowlist flip" (gap-analysis §2.6 #3) restructures `ChunkFromSSE` to forward
unknown events raw, this case still belongs in the typed layer — `input.request` is
interactive, not pass-through display data.

### D. `internal/chat/model.go` — prompt state machine (+ ~120 LOC)

**D1. State + part type.** New part type next to `:34-42`:

```go
PartInputRequest PartType = "input_request"
```

New struct (next to `ToolCallPart`, `:55-66`) + `MessagePart` pointer field (`:87-94`):

```go
// InputRequestPart is a HITL prompt awaiting (or having received) a decision.
type InputRequestPart struct {
    CorrelationID string
    Kind          string // "approval" | "select" | "text" (unknown → approval)
    ToolName      string
    Arguments     map[string]any
    Options       []string
    // interaction state (caller-owned; molecules are pure renderers)
    Selected   int    // approval: 0=deny,1=approve (default 0 — fail-closed); select: option index
    TextBuf    string // kind "text"
    Resolution string // "" while pending; e.g. "✓ approved", "⊘ denied", "⊘ auto-denied (run ended)"
    Busy       bool   // POST in flight
}
```

Model field (`Model`, `:149-169`): `pendingInput *pendingRef` where
`pendingRef{msgIdx, partIdx int; correlationID string}` — the part itself stays in the
transcript (survives resolution as a historical card, like React's resolved state,
`parts.tsx:321-341`).

**D2. Chunk arrival** — new case in `handleResponse` switch (`:607-722`):

```go
case types.ChunkInputRequest:
    // Dedupe by correlation id (belt-and-braces; server sends exactly one —
    // approval-round-trip.test.ts:206-207 proves the double-gate-check dedupe).
    if m.pendingInput != nil && m.pendingInput.correlationID == chunk.CorrelationID {
        break
    }
    m.ensureAssistantMessage()
    last := &m.messages[len(m.messages)-1]
    if len(last.Parts) == 1 && last.Parts[0].Type == PartWaiting {
        last.Parts = last.Parts[:0] // same waiting-placeholder swap as ChunkToolStart :620-622
    }
    last.Parts = append(last.Parts, MessagePart{
        Type:    PartInputRequest,
        Content: chunk.Content, // the prompt
        InputReq: &InputRequestPart{
            CorrelationID: chunk.CorrelationID,
            Kind:          chunk.InputKind,
            ToolName:      chunk.ToolName,
            Arguments:     chunk.Arguments,
            Options:       chunk.Options,
        },
    })
    m.pendingInput = &pendingRef{len(m.messages) - 1, len(last.Parts) - 1, chunk.CorrelationID}
    m.viewport.GotoBottom() // the prompt must be visible to be answerable
```

Fall through to the existing tail: `chunk.Done` is false for this chunk, so
`return *m, readStream(m.streamCh)` (`:740`) re-arms the reader — **required**, because the
timeout auto-deny frames (§1.4) arrive on this same channel with no client action.

**D3. What happens to incoming frames while the prompt is up.** Normally *nothing arrives*:
the runner is parked inside `bus.publish` (server invariant, `conversations.ts:386`,
hitl report §(b)). The channel idles; the armed `readStream` cmd simply waits. Three
exceptions, all of which must dismiss the prompt:

1. **Timeout auto-deny** (server `AP_APPROVAL_TIMEOUT_MS`): wire `error
   {error_type:"ToolCallBlocked"}` → `ChunkFromSSE` maps to a chunk with
   `Error: &types.APIError{Type:"ToolCallBlocked",...}, Done:true` (`parse.go:139-148`).
2. **Our own deny** produces the same frames after the POST resolves.
3. **Stream teardown** (server restart / R1 abort): channel closes → `readStream` synthesizes
   `Done:true` (`model.go:1029-1036`) or a scan-error frame (`parse.go:51-53`).

Implement dismissal at the top of `handleResponse` (before the `chunk.Error` early-return at
`:596-601` — that early-return path is exception 1/2's entry point):

```go
if m.pendingInput != nil && (chunk.Error != nil || chunk.Done) {
    m.resolvePendingInput("⊘ auto-denied (run ended)") // sets Resolution, clears pendingInput
}
```

And soften the double-render: when `chunk.Error` is a `*types.APIError` with
`Type == "ToolCallBlocked"` **and** the prompt was just resolved locally as denied, render the
error as the expected outcome — reuse the existing `ChunkToolReject` presentation
(`PartError "Tool rejected: ..."`, `:690-697`) rather than the generic
`"Error: ..."` assistant message (`:599`). The run *did* end (conversation.end
reason:"error", §1.4) — don't hide that; phrase it, e.g. `⊘ blocked: Tool call 'x' blocked by
gate`. (Open Decision D2.)

**D4. Key routing.** Insert at the top of `handleKey` (`:409`), **before** the scroll-key and
`m.streaming` branches:

```go
if m.pendingInput != nil {
    return m.handlePendingInputKey(msg)
}
```

`handlePendingInputKey` (new, ~50 LOC):

- `approval` (and unknown kinds — React precedent `model.ts:492-493` defaults unknown →
  approval): `left/right/h/l/tab` toggle `Selected`; `y` ⇒ approve now; `n` ⇒ deny now;
  `enter` ⇒ submit current selection (default **deny** — fail-closed, `Selected` zero-value
  0); `esc` ⇒ deny.
- `select`: `up/down/j/k` move cursor over `Options`; `enter` ⇒ approve with
  `Value: Options[Selected]` (matches React: option click posts
  `{decision:"approve", value: opt}`, `parts.tsx:353`); `esc` ⇒ deny.
- `text`: printable keys / backspace edit `TextBuf` (reuse `deleteChar`/`deleteWord`
  helpers, `:478-483`); `enter` (non-empty) ⇒ approve with `Value: TextBuf`; `esc` ⇒ deny.
- Scroll keys (`pgup`/`pgdown`/`shift+arrows`) still forward to the viewport so a long
  transcript can be reviewed before deciding.

On submit: set `Busy`, set `Resolution` provisionally? No — keep the card in "answering…"
until `InputResolvedMsg` (below) confirms; disable double-submit via `Busy` (React's `busy`
guard, `parts.tsx:307-317`).

**D5. ⚠️ Enter-to-skip drain deadlock guard.** `skipStreaming` (`:867-939`) does a blocking
`for chunk := range m.streamCh` on the UI goroutine. Two hazards once HITL exists:

- With `m.pendingInput != nil`, Enter now routes to the prompt (D4), so the `:424-427` skip
  branch is unreachable while pending — good, keep it that way.
- If the user hits Enter-skip *before* the gate fires, the drain loop will receive the
  `ChunkInputRequest` and then **block forever on a parked channel** (the runner won't emit
  again until someone answers; the only outside rescue is the server timeout). Fix inside the
  drain loop: on `chunk.Type == types.ChunkInputRequest`, perform D2's state append, `break`
  out of the drain, restore `m.streaming = true`, and return `readStream(m.streamCh)` so the
  prompt is answered interactively. (`skipStreaming` must change signature to return a
  `tea.Cmd`, call site `:425`.)

**D6. Decision command + resolution message.** New msg + cmd:

```go
type InputResolvedMsg struct {
    CorrelationID string
    Decision      string
    Value         string
    Err           error
}

func (m *Model) resolveInputCmd(decision, value string) tea.Cmd {
    responder, ok := m.client.(types.InputResponder)
    if !ok { // read-only transport: leave card pending; server timeout/teardown denies
        m.setPendingResolution("awaiting decision elsewhere (client cannot respond)")
        return nil
    }
    ref, convID := m.pendingInput, m.conversationID
    return func() tea.Msg {
        err := responder.RespondInput(context.Background(), convID, types.InputResponse{
            CorrelationID: ref.correlationID, Decision: decision, Value: value,
        })
        return InputResolvedMsg{ref.correlationID, decision, value, err}
    }
}
```

Handle `InputResolvedMsg` in `Update` (`:350-397` switch):

- `Err == nil`: stamp `Resolution` (`"✓ approved"`, `"✓ <value>"`, `"⊘ denied"` — same
  copy as React `parts.tsx:321-327`), clear `Busy` + `m.pendingInput`, rebuild viewport.
  The stream then delivers the consequence (approve ⇒ `tool.start`/`tool.end`…; deny ⇒
  §1.4 error+done) through the already-armed `readStream`.
- `Err` is the 404-orphan (see E): the request was already settled server-side (timed out /
  torn down) — stamp `"⊘ auto-denied (expired)"`, clear pending; the wire frames explaining
  it are already in flight.
- other `Err` (network, 501): stamp nothing, clear `Busy`, append a `PartError` with the
  error, **keep the prompt pending** so the user can retry (server timeout still backstops).

**D7. Exported guard for the app shell:** `func (m *Model) HasPendingInput() bool`.

### E. `internal/httpclient/client.go` — `RespondInput` (+ ~45 LOC)

- `endpointConfig` (`:19-59`): add `respondInput` with default
  `"/conversations/{id}/input"` + path helper (mirror `sendMessagePath`, `:61-63`); add the
  corresponding optional override field to `types.EndpointConfig` (`types.go:175-182`).
- Method (satisfies `types.InputResponder`; add
  `var _ types.InputResponder = (*HTTPClient)(nil)` next to `:76`):

```go
// ErrInputOrphaned — the server had no pending request for this correlation id
// (already answered, timed out, or torn down). Callers treat it as auto-deny.
var ErrInputOrphaned = errors.New("input request already settled")

func (c *HTTPClient) RespondInput(ctx context.Context, conversationID string, in types.InputResponse) error {
    decision := in.Decision
    if decision == "" {
        decision = "deny" // fail closed; also matches the server's bare-call default (conversations.ts:478-479)
    }
    payload := map[string]any{"correlation_id": in.CorrelationID, "decision": decision}
    if in.Value != "" {
        payload["value"] = in.Value
    }
    body, err := json.Marshal(payload)
    if err != nil { return err }
    url := c.BaseURL + c.endpoints.respondInputPath(conversationID)
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
    if err != nil { return err }
    req.Header.Set("Content-Type", "application/json")
    resp, err := c.HTTPClient.Do(req) // 30s default timeout is fine — resolve() is synchronous server-side
    if err != nil { return err }
    defer resp.Body.Close()
    switch resp.StatusCode {
    case http.StatusOK:
        return nil
    case http.StatusNotFound:
        return ErrInputOrphaned
    case http.StatusNotImplemented:
        return fmt.Errorf("respond input: server has no input registry (HTTP 501)")
    default:
        return fmt.Errorf("respond input: HTTP %d", resp.StatusCode)
    }
}
```

(`StubClient` intentionally does **not** implement `InputResponder` — it exercises the
read-only branch.)

### F. Render + shell (+ ~60 LOC)

**`internal/chat/view.go`** — new case in `renderPart` (`:289-380`), e.g. after `PartStatus`:

```go
case PartInputRequest:
    return renderInputRequestPart(ctx, part)
```

`renderInputRequestPart`:

- Resolved (`Resolution != ""`): one status-styled line — `⏸ <prompt>` header +
  `Resolution` (tertiary), i.e. the card collapses to its outcome like React's
  `.approval-resolved` (`parts.tsx:341-342`).
- Pending, kind approval/unknown: header line
  `⏸ <prompt>  [tool badge: ToolName]`, then bounded args via the existing
  `formatArgsExpanded` (`view.go:546-562`), then
  `molecules.ConfirmPrompt(ctx, molecules.ConfirmPromptData{Question: "", Selected: p.Selected == 1})`
  plus a key hint line `y approve · n deny · enter = <current>` (tertiary). NOTE
  `ConfirmPromptData.Selected=false` renders the **no** badge filled/error-red
  (`confirmprompt.go:36-47`) — correct default-deny affordance.
- Pending, kind select: `molecules.RadioSelect(ctx, molecules.RadioSelectData{Label: prompt,
  Options: mapOptions(p.Options), Selected: p.Selected})` (`radioselect.go:25-71`) + hint.
- Pending, kind text: prompt + `> <TextBuf>_` line.
- Busy: swap the hint for `answering…`.

Do **not** register a click Region for the part (regions drive expand/collapse only,
`model.go:131-138`; the prompt is keyboard-driven and always the last part while pending).

Status line (`view.go:71-89`): when `m.pendingInput != nil`, replace the streaming `"..."`
with `⏸ awaiting your decision` so the state is visible even when scrolled up.

**`internal/app/model.go`** — two guards:

- `updateChat` (`:277-285`): the `esc` → back-to-agent-select branch must not fire while a
  prompt is pending — `if keyMsg.String() == "esc" && !m.chat.HasPendingInput() { ... }`;
  a pending-input `esc` then reaches `handlePendingInputKey` = deny (D4). Without this,
  `esc` abandons the chat view with the run still parked (the stream stays open — today's
  send uses `context.Background()`, `chat/model.go:568` — so the server would not even
  teardown-deny until process exit).
- Legend (`:385-398`): when `m.chat.HasPendingInput()`, hint
  `y approve · n deny · enter confirm`. (`ctrl+c` quit at `:166-168` is fine as-is: process
  exit drops the connection ⇒ server teardown deny, `conversations.ts:438-442`.)

---

## 4. End-to-end frame walkthroughs (what the implementer should observe)

Setup: `AP_APPROVAL_TOOLS=<tool> ap playground` (wiring `playground.ts:93-110,177`), R1 send
fix in place. All frames on the one `POST /conversations/:id/messages` response body.

**Approve:** `conversation.start` → `message.start` → … → `tool.intent` →
`input.request {correlation_id, kind:"approval", prompt, tool_name, tool_call_id, arguments}`
→ *(stream idles; TUI prompt up; user hits `y`)* → `POST .../input
{correlation_id, decision:"approve"}` → `200 {ok:true}` → `InputResolvedMsg` stamps
`✓ approved` → stream resumes: `tool.start` → `tool.end` → … → `message.complete` → `done`.
(Server-side proof of sequence: `approval-round-trip.test.ts:201-212`.)

**Deny:** same until the prompt; user hits `n` → POST `{decision:"deny"}` → card `⊘ denied` →
stream resumes with `error {error_type:"ToolCallBlocked", recoverable:false}` →
`conversation.end` → `done`; TUI renders the calm blocked line (D3), turn ends
(`streaming=false` via the `Done` chunk). Proof: `approval-round-trip.test.ts:214-223`,
`agent-runner.ts:1462-1484`.

**Timeout (no user action, `AP_APPROVAL_TIMEOUT_MS` set):** prompt up → registry auto-denies
(`pending-input-registry.ts:80-86`) → same deny frames arrive unsolicited → D3 dismissal
stamps `⊘ auto-denied (run ended)`.

**Late answer race:** user answers a hair after the timeout → `404` → `ErrInputOrphaned` →
`⊘ auto-denied (expired)`; deny frames already rendered/in flight. (404 shape live-verified,
gap-analysis §2.1.)

**Disconnect / abort (R1 ctx-cancel) mid-prompt:** body closes → server `finally` denies
pending ids (`conversations.ts:434-442`) → run unblocks to the deny path with nobody
listening; client-side channel close → synthesized `Done` (`model.go:1029-1036`) → D3
dismissal.

---

## 5. Test plan (per change site)

**C — `internal/sse/parse_test.go`** (extend existing table-driven suite):
1. `input.request` full payload → chunk with all fields (type, prompt-in-Content,
   correlation, kind, options, tool fields).
2. Minimal payload `{correlation_id,kind,prompt}` → optional fields zero; `Done == false`.
3. Missing `correlation_id` → `nil` (dropped).
4. Malformed JSON → `nil`.
5. (alias) `tool.rejected` with canonical payload `{tool_name,reason,gate_name}` →
   `ChunkToolReject` (skip if R1 landed it).

**E — new `internal/httpclient/client_test.go`** (`httptest.Server`; note this package
currently has zero tests — gap-analysis §4.B risk (4)):
1. `RespondInput` approve → asserts method POST, path `/conversations/abc/input`, body
   `{"correlation_id":"c1","decision":"approve"}` (and `value` present only when set).
2. Empty `Decision` → body carries `"deny"`.
3. 404 → `ErrInputOrphaned`; 501 → error mentioning registry; 200 → nil.
4. Endpoint override via `types.EndpointConfig.RespondInput` is honored.

**D — `internal/chat/model_test.go`** (extend; drive with `ResponseMsg`/`tea.KeyPressMsg`
like the existing tests; fake client implementing `InputResponder` recording calls):
1. `ChunkInputRequest` → part appended, `pendingInput` set, waiting placeholder replaced,
   returned cmd re-arms the stream (non-nil).
2. Dedupe: same correlation id twice → one part.
3. Keys: `y` → cmd whose msg is `InputResolvedMsg{decision:"approve"}` and fake client
   received `{c1, approve, ""}`; `n`/`esc` → deny; approval default: bare `enter` → deny.
4. Select kind: `down`+`enter` → `{decision:"approve", value:"optB"}`.
5. Text kind: type + `enter` → value round-trips; empty `enter` is a no-op.
6. `InputResolvedMsg{Err:nil}` → `Resolution` stamped, `pendingInput` nil; typing then
   reaches the normal composer again (streaming still true blocks it — assert prompt keys no
   longer intercept).
7. `InputResolvedMsg{Err:ErrInputOrphaned}` → `⊘ auto-denied (expired)`, pending cleared.
8. Auto-dismiss: pending + `ResponseMsg{Chunk:{Error: APIError{Type:"ToolCallBlocked"},
   Done:true}}` → resolution stamped, blocked line rendered, `streaming=false`.
9. Channel close while pending (`readStream` synthesized Done) → auto-denied stamp.
10. Deadlock guard: enter-skip drain hits `ChunkInputRequest` → drain stops, prompt pending,
    `streaming` still true, cmd re-arms reader (drive `skipStreaming` with a channel that
    would block after the input chunk — the test failing mode is a test timeout).
11. Read-only client (no `InputResponder`) → card shows the awaiting-elsewhere state, no
    panic, no cmd.

**F — `internal/chat/render_demo_test.go` style golden checks:**
1. Pending approval part renders prompt + yes/no badges (no-selected default) + hint.
2. Pending select renders cursor on `Selected`.
3. Resolved renders single outcome line.
4. App: `esc` with `HasPendingInput()` true keeps `PhaseChat`.

**E2E (manual, the R2 exit criterion):** against `AP_APPROVAL_TOOLS=bash
AP_APPROVAL_TIMEOUT_MS=30000 ap playground` with a real key: approve run, deny run, timeout
run, and a dashboard cross-check (answer from the TUI while the dashboard admin stream
watches — correlation ids match). Optionally extend `contracttest` with a
`POST /conversations/{id}/input {correlation_id:"nonexistent"}` ⇒ expect 404 JSON — a cheap
conformance probe of the live-verified behavior (gap-analysis §2.1) that needs no LLM key.

---

## 6. Open decisions (recommendation first)

**D1 — Interface widening vs optional assertion.** *Recommend optional `InputResponder`
assertion (§3.B).* Widening `types.Client` touches 6 implementations
(`httpclient`, `stdioclient`, `cliclient`, `execclient`, `demo`, `StubClient` — grep §2) and
forces fake support onto CLI-spawn transports that are stateless-per-send
(`cliclient/claude.go` spawn model). The assertion keeps R2 a 5-file Go diff and gives the
read-only degradation branch for free. Cost: one type assertion in the chat model.

**D2 — How loudly to render the post-deny `error` frame.** *Recommend: special-case
`APIError.Type == "ToolCallBlocked"` into the `ChunkToolReject` presentation
(`⊘ blocked: …`) instead of the generic red `"Error: …"` message, keeping the
`conversation ended` fact visible.* The user just pressed deny; a scary error for the outcome
they chose reads as a client bug. Honesty is preserved — the run genuinely ended and the card
+ blocked line say so. (React's live chat has the same shape arriving and renders it as an
error part, `model.ts:522-528` — we deviate deliberately for terminal UX; note it in the PR.)

**D3 — Kind coverage.** *Recommend implementing all three kinds (approval fully; select via
`RadioSelect`; text via a ~20-LOC `TextBuf`), with unknown kinds falling back to the approval
affordance.* Grounds: the only wire producer today is the approval gate (`approval-gate.ts:75`
— verified no `select`/`text` producer exists), so approval is the tested path; but the
select/text molecules and the server contract both already exist, the reducer precedent for
unknown→approval is established (`model.ts:492-493`), and the marginal cost is ~40 LOC. If
scope pressure hits, cut **text** first (no producer, most interaction code), never approval.

**D4 — Where the prompt lives visually.** *Recommend inline transcript part + `GotoBottom()`
(§3.D2), not a modal overlay.* It matches the React card, keeps the viewport/region machinery
untouched, survives resolution as history, and avoids inventing an overlay layer in a
viewport-based renderer. The status-line `⏸` covers the scrolled-away case.

**D5 — Client-side timeout display.** *Recommend: none in R2.* The wire payload carries no
`timeout_ms` (§1.1); guessing invites lying. If wanted later, the additive server change is a
one-liner in the `input.request` mapping (`sse-formatter.ts:105-116`) + gate option
plumb-through — file it as a follow-up, don't block R2.

**D6 — Sequencing with R1.** R2's e2e legs are unobservable until R1's send-body fix lands
(§1.5 pre-req). The parser/client/model changes are all testable without a live server
(§5 unit plan), so R2 can be *built* in parallel but only *demoed* after R1. The
`tool.rejected` alias (§3.C) is nominally R1 #4 — whichever round lands first carries it;
duplicate-case in Go is a compile error, so coordinate.
