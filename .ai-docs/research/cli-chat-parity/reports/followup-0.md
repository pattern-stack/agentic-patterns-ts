# chat-patterns ↔ agentic-patterns-server contract — empirical smoke test

Date: 2026-07-19. Server: `ap playground --no-open --no-dashboard` from worktree
`/Users/dug/Projects/sandbox/agentic-patterns-ts/.claude/worktrees/atomic-soaring-taco`
(commit 10d5c0b) on `http://localhost:3456`. Client: `/Users/dug/Projects/sandbox/chat-patterns`
(contracttest + shipped `internal/httpclient` via public `tui.NewHTTPClient`).

## 0. Setup notes

- `bun install` then **`bun run build` is required** before booting — `bun run
  packages/agent-cli/src/cli.ts playground` from source fails with
  `Cannot find module '@agentic-patterns/runtime'` until workspace `dist/` exists.
- No fixture copy needed: the worktree root already ships `agents/`
  (calculator, todo, writing-coach); all three were discovered.
- **No LLM key in the environment.** The playground banner promises a
  `ClaudeCodeAPIRunner` subscription fallback, but empirically no run can complete:
  - model-less agents (all three fixtures, `readiness: {ready:false, missing:["model"]}`)
    throw `ModelResolver: the agent declares no model and this runner resolves per-agent models.`
  - an agent that *does* declare `claude-sonnet-4-5` (tested via a scratchpad agents dir on
    port 3499) instead routes to `@ai-sdk/anthropic` and throws
    `AI_LoadAPIKeyError: Anthropic API key is missing.`
  - Consequently only agent-list, conversation-create, error shapes, and the *pre-token*
    stream behavior were empirically checkable. Not runnable live: gap-analysis §2.2 items
    #4 (`tool.rejected` parse), #5 (`message.complete` tokens / `done.run_id`), #6
    (`input.request` live round trip), #7 (vocabulary drops), #10 (`display_type`).

## 1. `contracttest.ValidateBackend` against http://localhost:3456

Run via a scratchpad Go module (`replace github.com/pattern-stack/chat-patterns => local`),
`contracttest.ValidateBackend(t, "http://localhost:3456")`:

| Check | Result | Detail |
|---|---|---|
| Health | **PASS** | `GET /health` → 200 `{"status":"ok"}` |
| ListAgents | **FAIL** | `validate.go:56: decode agents: json: cannot unmarshal object into Go struct field .role of type string` |
| CreateConversation | **NOT REACHED** | suite aborts: `cannot continue without an agent ID` |
| SendMessage | **NOT REACHED** | same |

Sanity check: `go test ./contracttest/...` against its own bundled mock passes (`ok ... 0.340s`),
so the failure is server-shape, not toolchain.

**Correction to gap-analysis §2.2's "executable floor" claim.** The doc says the TS server
"would pass its four checks today except for the body-key issue." Empirically wrong on both
halves: the body-key issue never touches contracttest (it posts `{"content"}` to `/messages`
directly), and the suite instead **fails at ListAgents** because `validate.go:50-54` types
`role` as `string` inline — mismatch #3 (`role` object) lives in contracttest too, not only in
`httpclient`. With that one decode fixed, the remaining checks would pass — verified manually:

- `POST /conversations {"agent_id":"calculator"}` → **201** `{"id":"…","agent_id":"calculator"}` ✔
- `POST /conversations/:id/messages {"content":"Hello"}` → **200**, `Content-Type: text/event-stream` ✔
  (contracttest asserts only status + content-type, so it passes even though the stream is torn — see §3/N5).

## 2. Shipped default client (`tui.NewHTTPClient` with `EndpointConfig{SendMessage: "/conversations/{id}/messages"}`)

All five interface methods fail against the live server:

| Method | Result | Exact error / cause |
|---|---|---|
| `ListAgents` | FAIL | `list agents: unexpected response format` — `role` object breaks `[]AgentSummary` unmarshal; the legacy `[]string` fallback also fails (§2.2 #3 confirmed) |
| `CreateConversation("calculator")` | FAIL | `create conversation: HTTP 404` — client posts `{"agent_name":"calculator"}`; server reads absent `agent_id` and returns **404** `{"error":"Agent not found"}` (§2.2 #2 confirmed, but see N2: it manifests as 404, not a validation 400) |
| `SendMessage` (path overridden to `/messages`) | FAIL | `send message: HTTP 400` — body key is hardcoded `{"message":…}` (`types.go:85-87`), server replies `{"error":"content is required"}` (§2.2 #1 confirmed: path override alone is insufficient) |
| `ListConversations` | FAIL | `list conversations: HTTP 404` — client GETs `/conversations`; the server has **no GET /conversations** (list lives at `/admin/conversations`) — NEW, see N3 |
| `GetConversation` | FAIL | `get conversation: HTTP 404` for a live-but-unpersisted conversation; for persisted ids the route exists but the shape is incompatible — NEW, see N4 |

## 3. NEW mismatches beyond gap-analysis §2.2

- **N1 — contracttest itself fails today.** `ValidateBackend` halts at ListAgents on the
  `role`-object decode (`contracttest/validate.go:50-54`); §2.2 attributes the executable-floor
  failure to the body key and implies contracttest passes. It doesn't; #3 must be fixed in two
  places (httpclient *and* contracttest).
- **N2 — wrong-create-body surfaces as 404, not 400.** `{"agent_name":"calculator"}` →
  404 `{"error":"Agent not found"}` (server looks up `undefined`). Also `{}` → same 404. A Go-side
  fix that only remaps a 400 error path would miss this; the client just reports `HTTP 404`,
  indistinguishable from a genuinely unknown agent.
- **N3 — conversation *list* route/shape gap.** Client default `GET /conversations` → 404
  (Hono default). The server's list is `GET /admin/conversations`, and even with an
  `EndpointConfig` override its shape is camelCase summaries
  (`{"conversationId","agentName","messageCount","tokenCount","startedAt","lastMessageAt","status"}`)
  while `types.Conversation` expects snake_case `{id, agent_name, state, exchange_count,
  total_input_tokens, …}` — decode yields zero-value structs. The picker path needs a shape
  adapter, not just a path override.
- **N4 — conversation *detail* route exists but is incompatible.** `GET /conversations/:id`
  is real (store-backed): 404 `{"error":"conversation \"<id>\" not found"}` for conversations
  that exist only in the in-memory registry (i.e., every conversation before its first
  *persisted* turn), and for persisted ids returns a camelCase summary **without** a
  `messages[]` array (`{"id","agentConfigId","status","agentName","model","tokenCount",
  "messageCount","startedAt","completedAt","error","createdAt","updatedAt"}`).
  `types.ConversationDetailResponse` expects snake_case + embedded `messages[]` → decodes to a
  near-empty struct (only `id` survives). Messages actually live at
  `GET /conversations/:id/messages` (200, camelCase rows) + `GET /messages/:id/parts` (N+1).
- **N5 — torn SSE stream on pre-token runner failure (server-side robustness gap).** When the
  runner fails before streaming (ModelResolver reject, missing API key), the server responds
  **HTTP 200 `text/event-stream` with exactly 14 bytes: `data: {"conver`** — a truncated
  `conversation.start` payload with **no `event:` line, no `error` event, no `done`
  terminator**. Reproduced twice (both failure modes, both ports). Consequences: the
  chat-patterns SSE parser yields nothing and the shipped client synthesizes
  `StreamChunk{Done:true}` — the user sees an empty, apparently *successful* reply with no
  error; and contracttest's SendMessage check (status+content-type only) passes on a torn
  stream. The server's drain loop (`agent-server/src/routes/conversations.ts:391-406`) has no
  catch that emits an SSE `error` frame before the stream aborts.
- **N6 — EndpointConfig doc/code drift inside chat-patterns.** The public
  `types.EndpointConfig` comment documents the default SendMessage path as
  `"/conversations/{id}/messages"` (`internal/types/types.go:151`) but the actual default is
  `"/conversations/{id}/send"` (`internal/httpclient/client.go:32`). Whoever reads the doc
  comment believes the client already matches the server.
- **N7 (minor) — legacy `/send` 404 is text/plain.** `POST /conversations/:id/send` → 404
  body `404 Not Found`, `Content-Type: text/plain` (Hono fallthrough), unlike the JSON
  `{"error":…}` shapes elsewhere. Cosmetic, but any client that decodes error JSON gets a
  decode error layered on the 404.

Positive confirmations (no mismatch):

- `POST /conversations/:id/input` is live on playground: unknown correlation →
  404 `{"error":"no pending input for correlation_id","correlationId":"x"}` (the
  input registry *is* configured — not the 501-unconfigured path).
- `POST /conversations/:id/messages` to an unknown conversation → 404
  `{"error":"Conversation not found"}` (JSON, as documented).
- `GET /admin/events/stream` is a working EventSource firehose (also carries
  `claude_code.hook` telemetry frames — noteworthy for any TUI that would drive from it:
  the vocabulary is wider than agent events).
- `maxIterations` accepted shape not contradicted (not exercised past validation).

## 4. Scorecard vs gap-analysis §2.2 items

| § | Item | Empirical status |
|---|---|---|
| 1 | `/send`+`{message}` vs `/messages`+`{content}` | **Confirmed**; path override works, hardcoded body key → 400 `content is required` |
| 2 | create body `{agent_name}` vs `{agent_id}` | **Confirmed**, with sharper shape: 404 "Agent not found", not 400 |
| 3 | `role` string vs object | **Confirmed**, and also breaks contracttest itself (N1) |
| 4 | canonical `tool.rejected` unparsed | Not runnable (no LLM) — code-read only |
| 5 | tokens/run_id discarded | Not runnable (no LLM) |
| 6 | `input.request` dropped | Return leg verified live (input route + 404 shape); event delivery not runnable |
| — | "contracttest would pass except body-key" | **Refuted** (N1) |

Artifacts: Go harness `<scratchpad>/contract-live/` (live_test.go + shippedclient/main.go),
SSE captures `<scratchpad>/sse-capture.txt`, `<scratchpad>/sse-happy.txt`, server logs
`<scratchpad>/playground.log`, `<scratchpad>/playground2.log`. No files in either repo were
modified; both playground processes were shut down after the run.
