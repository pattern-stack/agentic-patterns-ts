# History / Replay Contract Mismatch — chat-patterns (Go TUI) vs agent-server (TS)

Sources read:
- Go client: `/Users/dug/Projects/sandbox/chat-patterns/internal/httpclient/client.go` (`ListConversations` L247-277, `GetConversation` L279-301, endpoint defaults L28-59)
- Go types: `/Users/dug/Projects/sandbox/chat-patterns/internal/types/types.go` L99-155 (`Conversation`, `ConversationDetailResponse`, `ConversationMessage`, `MessagePart`, `EndpointConfig`)
- Go picker: `/Users/dug/Projects/sandbox/chat-patterns/internal/chat/picker.go` (dead — nothing in the app dispatches `ConversationsLoadedMsg` or handles `ConversationSelectedMsg`)
- TS routes: `.../packages/agent-server/src/routes/conversations.ts` L229-328 (four read routes)
- TS store: `.../packages/agent-runtime/src/conversation/store.ts` (`StoredMessage` L34-43, `StoredMessagePart` L46-61, `StoredConversationSummary` L64-73)

## What the Go client hardcodes vs what's configurable

`EndpointConfig` (types.go L148-155) lets a host override **URL paths only** (list default `/conversations`, get default `/conversations/{id}`). The **decode shapes are hardcoded Go structs**: `ListConversations` insists on a **bare top-level JSON array** of `Conversation` (client.go L272-276) and `GetConversation` insists on a single `ConversationDetailResponse` object with **inline `messages` including inline `parts`** (client.go L296-300). Field names are snake_case JSON tags; Go's `encoding/json` matches case-insensitively but does **not** bridge `agentName` ↔ `agent_name` — underscore differences are hard misses.

Side note: the Go client's *internal* default for send is `/conversations/{id}/send` (client.go L32) while the public `EndpointConfig` doc comment claims `/conversations/{id}/messages` (types.go L151). The TS server serves `POST /conversations/:id/messages` — so even the send path only works if overridden.

## Mismatch table

| Dimension | Go client expects | TS server provides | Verdict |
|---|---|---|---|
| **List path** | GET `/conversations` (default; path overridable) | GET `/admin/conversations` (conversations.ts L229). Plain GET `/conversations` is **not routed** → 404 | Bridgeable via `EndpointConfig.ListConversations = "/admin/conversations"` |
| **List query params** | `?agent_name=<name>` server-side filter (client.go L256-260) | None — `store.listConversations()` takes only `limit` (store.ts L114); query string ignored | Silent: Go gets ALL agents' conversations unfiltered |
| **List envelope** | Bare JSON array (hardcoded decode) | Bare JSON array | Match (the only one) |
| **List field names** | `id`, `agent_name`, `state`, `exchange_count`, `total_input_tokens`, `total_output_tokens`, `branched_from_id`, `branched_at_sequence`, `created_at`, `updated_at` | `conversationId`, `agentName`, `messageCount`, `tokenCount`, `startedAt`, `lastMessageAt`, `status` (L233-241) | **Zero fields decode.** `agentName`≠`agent_name`, `conversationId`≠`id`, `startedAt`≠`created_at`. Picker would render blank rows with zero timestamps |
| **List: state vs status** | `state` (free string, display-only in picker L198) | `status` ∈ `active\|completed\|error` (store.ts L68) | Field name differs; vocab would be acceptable if bridged |
| **List: token fields** | `total_input_tokens` + `total_output_tokens` split | single combined `tokenCount`; the summary projection has no split (store.ts L70) — though `StoredMessage` does carry `inputTokens`/`outputTokens` (L39-40), so a split is computable | Needs summary-projection change or per-conversation recompute |
| **List: exchange_count** | count of user↔assistant exchanges | `messageCount` = raw stored messages; one exchange = one `request` + one `response` message (conversation.ts `_persistExchange`), so exchange_count ≈ messageCount/2 | Semantics differ 2×; server would need to count `kind === "request"` messages |
| **Detail path** | GET `/conversations/{id}` (default) | GET `/conversations/:id` (L246) | **Path matches out of the box** |
| **Detail field names** | snake_case: `id`, `agent_name`, `model`, `state`, `exchange_count`, `messages`, `branched_*`, `created_at`, `updated_at` | camelCase: `id`, `agentConfigId`, `status`, `agentName`, `model`, `tokenCount`, `messageCount`, `startedAt`, `completedAt`, `error`, `createdAt`, `updatedAt` (L256-274) | Only `id` and `model` decode; everything else silently zero |
| **Detail: messages inline vs N+1** | `messages: [{id, kind, sequence, parts:[{type, content}]}]` **inline in the detail response** — the client makes exactly one request and never calls a messages/parts endpoint | Detail has **no messages at all**. Messages live at GET `/conversations/:id/messages` (L279, preview `content` only, `metadata: null`) and parts at GET `/messages/:id/parts` (L305) — an N+1 the Go client has no code to perform | **Structural mismatch** — replay would always render an empty conversation. Note the store already returns parts inline (`StoredMessage.parts`, store.ts L42), so the server *chose* the N+1 split for dashboard parity; inlining is cheap |
| **Message identity fields** | `kind` (string), `sequence` (int) | `kind` present; **no `sequence`** — order is array order; extra `conversationId`, `runId`, token fields | `sequence` must be synthesized (array index) |
| **kind/role vocab** | `Kind` is an untyped string; the TUI's rendering vocab is `user`/`assistant` (messageblock.go L18-19, types.go L14 "Role: user or assistant") — replay code that maps kind→role doesn't exist yet | `kind` ∈ `request` \| `response` (store.ts L37) | Vocab mismatch (`request/response` vs `user/assistant`), but the consumer is unwritten so it's a mapping decision, not a break |
| **Part type vocab** | TUI part types: `text`, `thinking`, `tool_call`, `error`, `waiting` (chat/model.go L34-38); wire `MessagePart` is `{type, content}` only | Store part types actually produced: `user_prompt`, `text`, `tool_call`, `state_delta` (conversation.ts L376-405); parts also carry `metadata`, `position` | `user_prompt` and `state_delta` are unknown to the TUI; `tool_call` content lives partly in `metadata`, which the Go `MessagePart` struct drops |
| **Branch fields** | `branched_from_id`, `branched_at_sequence` on both list and detail; picker renders a "branch" badge (picker.go L208-215) and offers an ActionBranch key (L105-115) | **Nothing.** No branch concept anywhere in `StoredConversation`/summary/routes; no branch-create API | Fields are `*string`/`*int` + `omitempty`, so absence decodes as nil — badge just never shows. ActionBranch is unimplementable against this server |
| **Timestamps** | `time.Time` → RFC3339 required | `.toISOString()` everywhere | Compatible (once field names are bridged) |
| **Error/empty behavior** | Any non-200 → Go error | Detail 404s with `{error}` for unknown id (L251); `/conversations/:id/messages` returns `[]` (no 404, L277-278); everything 503s when persistence is off (`notConfigured`, AP_PERSISTENCE) | Acceptable; the 503-when-unconfigured will read as "list conversations: HTTP 503" |

## Fix-size estimate (honest)

The picker is dead **twice over**: (1) no wire compatibility, and (2) no Go app code actually invokes it — nothing dispatches `ConversationsLoadedMsg`, nothing handles `ConversationSelectedMsg`, and no replay renderer consumes `ConversationDetailResponse`. Fixing the server contract alone does not make it work.

**Option A — TS compat routes (recommended, ~0.5–1 day):** add to `conversations.ts`:
- `GET /conversations` (list): snake_case projection; `agent_name` filter (in-memory filter over `listConversations()` is fine); `exchange_count` = count of `kind === "request"`; token split needs either a `StoredConversationSummary` extension (inputTokens/outputTokens — touches the protocol + InMemory store + any other store impl) or a lazy per-conversation `getMessages` sum. ~60-100 lines + tests.
- Inline `messages` (with `sequence` = index and inline `parts` from `StoredMessage.parts`) into the existing `GET /conversations/:id` response, snake_case aliases alongside the current camelCase keys (additive, dashboard unaffected). ~40 lines + tests.
- Emit `state` alias for `status`; omit branch fields.
This makes list + continue-replay decode correctly with a one-line Go-side `EndpointConfig` override for the list path (or serve at bare `/conversations` and no override at all — no route conflict exists).

**Option B — Go adapter client (~150-300 lines Go):** custom decode structs for the camelCase shapes + the N+1 messages/parts fetch + kind/part-type mapping. Worse: duplicates the server's dashboard contract in Go and bakes in the N+1.

**Either way, still required in Go (~1-2 days):** wire the picker into the app model (fetch cmd → `ConversationsLoadedMsg`, handle `ConversationSelectedMsg`), and write the replay renderer (detail → `chat.Message` list with `request→user` / `response→assistant`, part mapping `user_prompt→text`, drop/annotate `state_delta`, hydrate `tool_call` without metadata or extend `MessagePart` to carry it).

**Out of scope for "make it work": branching.** `ActionBranch` needs server-side branch-create semantics (`branched_from_id`/`branched_at_sequence` on create + store schema + replay-from-sequence). That is a multi-day feature on the TS side, not a contract patch. Recommend the picker ship with branch disabled.

**Bottom line:** wire-contract fix is small (Option A, half a day of TS). A *working* picker is small-plus-medium: the Go consumer half was never written. Branch support is the only genuinely large piece and can be deferred.
