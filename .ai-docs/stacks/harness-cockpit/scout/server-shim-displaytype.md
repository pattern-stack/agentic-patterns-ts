# Scout dossier — TS server R3: history compat shim + `display_type`

Scope: the two R3 server-side work items for the harness-cockpit rollout
(gap analysis `.ai-docs/research/cli-chat-parity/gap-analysis.md` §2.3 / §2.5).
Every anchor below was re-read at worktree HEAD (`main` @ 10d5c0b lineage) this
session, 2026-07-19; the Go anchors were read from the clone at
`/Users/dug/Projects/sandbox/chat-patterns`. Where a prior report anchor moved
or was imprecise, the correction is called out inline.

Paths below are repo-relative to
`/Users/dug/Projects/sandbox/agentic-patterns-ts/.claude/worktrees/atomic-soaring-taco/`
unless prefixed with the chat-patterns clone path.

---

## Part A — History compat shim (bare `GET /conversations` + inline `messages[]`)

### A.0 Verified current state

**TS routes** — all in `packages/agent-server/src/routes/conversations.ts`:

| Route | Lines | Notes |
|---|---|---|
| `POST /conversations` | 63–226 | create; scope ladder |
| `GET /admin/conversations` | 229–243 | camelCase `ConversationSummary[]` off `store.listConversations()` |
| `GET /conversations/:id` | 246–275 | camelCase detail, **no `messages[]`**; already calls `store.getMessages(id)` at L253 for aggregates — the messages are literally in hand and discarded |
| `GET /conversations/:id/messages` | 279–301 | preview `content`, `metadata: null` |
| `GET /messages/:id/parts` | 305–328 | the N+1 leg |
| `POST /conversations/:id/messages` | 331–445 | SSE turn stream (N5 drain loop at 391–406) |
| `POST /conversations/:id/input` | 454–491 | HITL return leg |

**No route conflict** for a bare `GET /conversations`: `grep -rn '"/conversations'
packages/agent-server/src/routes/*.ts` shows only `routes/conversations.ts`
registers conversation paths, and the only GETs are `/conversations/:id` (L246)
and `/conversations/:id/messages` (L279) — a bare exact path `/conversations`
overlaps neither (and the existing `POST /conversations` differs by method).
All route groups mount at `"/"` (`packages/agent-server/src/app.ts:35-58`);
docs routes mount last and introspect `app.routes` (`app.ts:69-77` comment), so
the new route auto-appears in `/openapi.json` — no docs change needed.
`packages/agent-server/src/__tests__/docs.test.ts` builds stub apps with
explicit route lists (L44-122), not full-app snapshots, so it cannot break.

**503 degradation**: the file-local `notConfigured(c)` helper
(`routes/conversations.ts:501-509`) returns
`503 {error:"persistence not configured", hint:"…AP_PERSISTENCE != 0…"}` when
`store` is `undefined`. All four existing read routes call it first; the shim
routes must too. Go-side effect (verified in
`/Users/dug/Projects/sandbox/chat-patterns/internal/httpclient/client.go:272`):
any non-200 becomes the error string `list conversations: HTTP 503` — an
acceptable honest-degradation rendering, no special-casing needed.

**Store shapes** — `packages/agent-runtime/src/conversation/store.ts`:

- `StoredMessage` L34-43: `id, conversationId, kind: "request"|"response",
  runId?, inputTokens, outputTokens, createdAt, parts: StoredMessagePart[]` —
  **parts are inline at L42, confirmed** (the gap-analysis §2.3 claim holds).
- `StoredMessagePart` L46-61: `id, messageId, type, content?, metadata,
  position?, createdAt?`.
- `StoredConversationSummary` L64-73: `conversationId, agentName, model,
  status ("active"|"completed"|"error"), messageCount, tokenCount, startedAt,
  lastMessageAt?` — **no input/output token split, no per-kind counts**.
- `ConversationStore.listConversations(limit?)` L114 (protocol);
  `InMemoryConversationStore.listConversations` L222-242; SQLite impl at
  `packages/agent-runtime/src/storage/conversation-store.ts:266-285` — same
  projection, also no split. **No query filter exists in the protocol** — an
  `agent_name` filter must be applied in the route.

**What parts actually get persisted** —
`packages/agent-runtime/src/conversation/conversation.ts` `_persistExchange`
L359-390: request message = one `user_prompt` part (L376); response message =
zero-or-more `state_delta` parts then one terminal `text` part (L383).
`tool_call` parts appear **only** in `_toMessageHistory` (L395-417), the
runner-facing canonical history — never persisted. So the shim's inline
`parts[]` will only ever contain types `user_prompt | text | state_delta`
today (matches gap-analysis §1.9).

**Go decode targets** — `/Users/dug/Projects/sandbox/chat-patterns/internal/`:

- `types/types.go` `Conversation` L127-138 (list row):
  `id, agent_name, state, exchange_count, total_input_tokens,
  total_output_tokens, branched_from_id (*string, omitempty),
  branched_at_sequence (*int, omitempty), created_at, updated_at`
  (`time.Time` → RFC3339 required; `.toISOString()` satisfies it).
- `ConversationDetailResponse` L141-152: same + `model`, `messages[]`.
- `ConversationMessage` L155-160: `id, kind, sequence, parts`.
- `MessagePart` L163-166: **`{type, content *string}` only** — extra JSON keys
  (e.g. `metadata`) are silently ignored by `encoding/json`, so emitting them
  is harmless and future-proofs an extended Go struct.
- `httpclient/client.go` defaults (`newEndpointConfig`, L29-59):
  `listConversations: "/conversations"`, `getConversation:
  "/conversations/{id}"` — a bare TS list route means **zero Go-side
  `EndpointConfig` override**. `ListConversations` (L251-281) sets
  `?agent_name=<name>` when non-empty and decodes a **bare top-level JSON
  array**. `GetConversation` (L283-305) decodes a single object.

### A.1 Change 1 — new `GET /conversations` list route

Add to `routes/conversations.ts` (place directly above the
`GET /admin/conversations` block at L229; register **before**
`GET /conversations/:id` for readability — Hono matches exact-vs-param
correctly either way).

Proposed shape (snake_case, bare array):

```ts
// GET /conversations — chat-patterns (Go TUI) history compat shim: snake_case
// summaries with exchange/token aggregates, bare array, optional ?agent_name=
// exact-match filter. The camelCase dashboard list stays at
// GET /admin/conversations — this route is additive.
app.get("/conversations", async (c) => {
  if (!store) return notConfigured(c);
  const agentName = c.req.query("agent_name");
  let summaries = await store.listConversations();
  if (agentName) summaries = summaries.filter((s) => s.agentName === agentName);
  const rows = await Promise.all(
    summaries.map(async (s) => {
      // Summary projection has no kind/token split (store.ts:64-73) —
      // compute from messages. Parts ride along (StoredMessage.parts) but
      // stay unserialized; local-scale N+1 is deliberate (see decision A-1).
      const messages = await store.getMessages(s.conversationId);
      return {
        id: s.conversationId,
        agent_name: s.agentName,
        model: s.model,
        state: s.status,
        exchange_count: messages.filter((m) => m.kind === "request").length,
        total_input_tokens: messages.reduce((n, m) => n + m.inputTokens, 0),
        total_output_tokens: messages.reduce((n, m) => n + m.outputTokens, 0),
        created_at: s.startedAt.toISOString(),
        updated_at: (s.lastMessageAt ?? s.startedAt).toISOString(),
        // branched_from_id / branched_at_sequence deliberately omitted —
        // no TS branch concept; Go fields are *T+omitempty → decode nil.
      };
    }),
  );
  return c.json(rows);
});
```

Field-by-field justification against `types.go:127-138`: every Go tag is
satisfied; `model` is extra (Go ignores unknown keys — harmless, and the
detail struct wants it anyway); `state` gets the store's `status` value
verbatim (`active|completed|error` — free display string in the picker,
`picker.go` renders it uninterpreted per the history report).

### A.2 Change 2 — inline `messages[]` + snake_case aliases on `GET /conversations/:id`

Extend the existing handler (L246-275) **additively** — keep every current
camelCase key (dashboard contract), append:

```ts
return c.json({
  /* …existing camelCase keys L257-273 unchanged… */
  // --- chat-patterns compat aliases (additive; Go ignores the camelCase) ---
  agent_name: conv.agentName,
  state: "active",                      // same constant as `status` (L264)
  exchange_count: messages.filter((m) => m.kind === "request").length,
  created_at: conv.createdAt.toISOString(),
  updated_at: (lastMessage?.createdAt ?? conv.updatedAt).toISOString(),
  messages: messages.map((m, i) => ({
    id: m.id,
    kind: m.kind,                       // "request" | "response" — verbatim, see A.4
    sequence: i,                        // store has no sequence column; array order IS the order
    parts: m.parts.map((p) => ({
      type: p.type,                     // user_prompt | text | state_delta (today)
      content: p.content ?? null,
      metadata: p.metadata,             // Go MessagePart drops it today; future-proof (A-3)
    })),
  })),
});
```

Notes:
- `messages` is already fetched at L253 (`store.getMessages(id)`) — this change
  adds **zero** store calls.
- `id` and `model` already exist in the camelCase payload and match the Go tags
  as-is (only fields whose names differ need aliases).
- The existing 404 (L250-251) and 503 behavior are untouched. Reminder from the
  live smoke test (gap-analysis N4): live-but-unpersisted conversations 404
  here — that is correct behavior once persistence is on (`AP_PERSISTENCE`),
  and the Go picker only lists persisted conversations anyway.

### A.3 Vocabulary mapping the Go renderer should apply (documented here so the
shim and the R3 Go work agree; **no TS translation** — see decision A-2)

| TS wire (verbatim from store) | Go/TUI render vocab | Mapping owner |
|---|---|---|
| `kind: "request"` | role `user` | Go replay renderer |
| `kind: "response"` | role `assistant` | Go replay renderer |
| part `user_prompt` | `PartText` (`text`) | Go |
| part `text` | `PartText` | Go |
| part `state_delta` | `PartStatus` one-liner or drop-with-count (`metadata.event` names the frame, e.g. `backpack.drop`) | Go |
| part `tool_call` (never persisted today; defensive) | `PartToolCall`; detail lives in `metadata` — requires the extended `MessagePart` or degrade to generic | Go |
| unknown future types | labeled degradation, never crash (matches dashboard `stored-parts.ts` posture noted at `conversation.ts:355-357`) | Go |

TUI part vocab verified at
`/Users/dug/Projects/sandbox/chat-patterns/internal/chat/model.go:31-43`:
`text, thinking, tool_call, delegation, error, status, waiting` (the history
report's "5 types" undercounted; `status` exists and is the right target for
`state_delta`). `Conversation.Kind`/`ConversationMessage.Kind` are untyped
strings in Go — nothing breaks on `request|response`; only the (unwritten)
replay renderer maps them.

### A.4 Test plan (Part A)

Extend `packages/agent-server/src/__tests__/conversations.test.ts` (existing
harness at L87-284 already builds an app with an `InMemoryConversationStore`
and seeds messages — reuse it):

1. `GET /conversations` 503s with the `notConfigured` shape when no store —
   mirror the L89-96 pattern.
2. Seed 2 conversations (different agents), 2 exchanges each →
   - bare-array envelope; newest-first (store contract);
   - `exchange_count === 2`, `total_input_tokens`/`total_output_tokens` equal
     the seeded sums (not the combined `tokenCount`);
   - snake_case keys exactly (`agent_name`, `created_at`, `updated_at`,
     `state`); assert `branched_from_id` is absent (`not.toHaveProperty`).
3. `?agent_name=` filter: matching name → only that agent's rows; unknown
   name → `[]` (200, not 404).
4. Detail: response still carries every pre-existing camelCase key
   (regression guard for the dashboard) **and** `messages[]` inline with
   `sequence` = 0..n-1, parts `{type, content, metadata}`, `kind` verbatim;
   `content: null` for a content-less `state_delta` part.
5. Empty conversation (created, no messages): `exchange_count 0`,
   `total_*_tokens 0`, `updated_at === created_at`, `messages: []`.

Optional cross-check (R1/R3 Go side, not this repo): chat-patterns
`contracttest` + `tui.NewHTTPClient` against `ap playground` with
`AP_PERSISTENCE=1` — the smoke-test harness referenced in gap-analysis §4
Strategy C note is reusable.

### A.5 Open decisions (Part A) — with recommendations

- **A-1 aggregates source**: per-conversation `store.getMessages()` in the
  route (N+1 inside the server) **[recommended]** vs extending
  `StoredConversationSummary` with `inputTokens/outputTokens/requestCount`.
  The extension touches the runtime protocol + both store impls
  (`store.ts:64-73`, `storage/conversation-store.ts:266-285`) and forces
  `bump-both` for a server-only feature; the N+1 is against local
  SQLite/in-memory at picker scale (tens of rows). If list latency ever
  matters, the summary extension is the clean follow-up. Note the parts blobs
  ride along on `getMessages` — acceptable at this scale, flag in the PR.
- **A-2 kind vocab**: emit stored `request|response` verbatim
  **[recommended]**; the Go renderer maps to `user|assistant`. The server
  stays honest to its store; Go's field is an untyped string; translation in
  TS would make the TS wire diverge from `GET /conversations/:id/messages`
  (which already says `kind: m.kind`).
- **A-3 `metadata` on inline parts**: include **[recommended]** — Go drops
  unknown keys today, and the R3 Go work will likely extend `MessagePart` to
  carry it for `tool_call`/`state_delta` detail; emitting it now avoids a
  second server PR.
- **A-4 bare route vs `/admin` alias only**: bare `GET /conversations`
  **[recommended]** — zero Go-side `EndpointConfig` override needed (Go
  default path is exactly `/conversations`), and no conflict exists
  (verified above; also the history report's "no route conflict exists"
  claim re-verified at HEAD).
- **A-5 `limit` passthrough**: not needed for the picker; skip (Go client
  sends no limit param — `client.go:251-262` sets only `agent_name`).

---

## Part B — `display_type` on tool events

### B.0 Verified current state

- `ToolCallStartEvent` (`packages/agent-runtime/src/events/types.ts:97-103`)
  and `ToolCallEndEvent` (L105-114) carry no display field.
- `sse-formatter.ts` (`packages/agent-runtime/src/transport/sse-formatter.ts`)
  `agent.tool.start` case L133-141 (fixed object literal), `agent.tool.end`
  case L151-160 (already payload-variable form + conditional `error` at
  L158). The established conditional-field idiom is the backpack `display`
  copy: `if (event.display !== undefined) payload.display = event.display;`
  at **L270 (`backpack.drop`), L283 (`backpack.read`), L299
  (`backpack.absorb`)** — all three re-verified.
- Runner emission sites (`packages/agent-runtime/src/runner/agent-runner.ts`),
  all three with a `ToolSchema[]` already in scope:

  | Context | `agentTools` fetched | `tool.start` | `tool.end` |
  |---|---|---|---|
  | `run()` loop | L311 | L540-554 | L588-602 |
  | `convertExecutableTools()` (SDK-driven; used by `runStructured`) | L799 (per-tool `t` in the loop — no map needed) | L824-835 | L865-879 |
  | `stream()` loop | L1108ff, `agentTools` L1128 | L1487-1498 | L1550-1562 |

  The display-type-cost report's "~589, ~866, ~1550" anchors all still hold.
  Precedent for a name-keyed lookup built from `agentTools` already exists in
  the same scopes: `terminalTools` Sets at L316 and ~L1132.
- Core: `ToolDefinition` (`packages/agent-core/src/molecules/toolbox.ts:54-84`)
  has `description, parameters, returns?, terminal?, execute`; the `terminal`
  doc (L67-77) states the design precedent verbatim: "core carries the flag,
  the host enforces the semantics". `defineTool` L123-162 (note its
  conditional `terminal` passthrough at L158-160 — copy that pattern).
  `Toolbox.getToolSchemas()` L176-180 → `ToolSchema.fromZod`.
- `ToolSchema` (`packages/agent-core/src/molecules/tool-schema.ts`): frozen
  class, `terminal?` at L51, positional ctor L56-71 (6 params), `fromZod`
  L78-94 (5 params), `toDict` L108-123 with conditional `returns`/`terminal`
  spreads at L120-121. Second `fromZod` caller:
  `packages/agent-core/src/molecules/playbook.ts:55` (already omits
  `terminal` — pre-existing).
- Tool flow to the runner: `Agent.getTools()` → `Role.getTools()` →
  `Capability.getTools()` → `Toolbox.getToolSchemas()`
  (`organisms/agent.ts:96-98`, `organisms/role.ts:119-124`,
  `molecules/capability.ts:43`).
- Server relay: `packages/agent-server/src/sse.ts:37-40` — `agentEventToSSE`
  delegates verbatim to runtime's `toSSEMapping`; **zero server changes**.
- Go consumer (verified in the clone): `internal/sse/types.go:27` and `:36`
  declare `DisplayType string \`json:"display_type"\`` on both
  `SSEToolStartData` and `SSEToolEndData`; `internal/sse/parse.go:95,113`
  thread it onto the chunk. Absent field → `""` → generic render (graceful).
  Render vocabulary: `"diff" | "code" | "bash"`; string results only get the
  rich path (`parse.go:104-107`).

### B.1 Change sites, in dependency order

1. **`packages/agent-core/src/molecules/toolbox.ts`**
   - `ToolDefinition` (after `terminal?`, L77):
     ```ts
     /**
      * Optional render hint for transports/clients ("code" | "diff" | "bash"
      * today, by convention — the string is opaque to core). Same philosophy
      * as `terminal`: core carries the flag, the host/renderer interprets it.
      */
     displayType?: string;
     ```
   - `defineTool` spec (L123-134): add `displayType?: string;` and after the
     `terminal` passthrough (L158-160):
     `if (spec.displayType !== undefined) definition.displayType = spec.displayType;`
   - `getToolSchemas()` (L178): pass `def.displayType` as the new trailing
     `fromZod` argument.
2. **`packages/agent-core/src/molecules/tool-schema.ts`**
   - `readonly displayType?: string;` after `terminal` (L51); 7th positional
     ctor param (L56-71); 6th `fromZod` param threaded to the ctor (L93);
     `toDict` conditional spread mirroring L121:
     `...(this.displayType !== undefined ? { displayType: this.displayType } : {})`.
   - Leave `fromOpenAI` (L97-105) as-is (it already drops `returns`/`terminal`).
3. **`packages/agent-core/src/molecules/playbook.ts:55`** — thread
   `def.displayType` in its `fromZod` call too (see decision B-3).
4. **`packages/agent-runtime/src/events/types.ts`** — add
   `readonly displayType?: string;` to `ToolCallStartEvent` (L97-103) and
   `ToolCallEndEvent` (L105-114). `createEvent` is typed against these
   interfaces, so the runner stamps type-check.
5. **`packages/agent-runtime/src/runner/agent-runner.ts`** — at each of the
   three contexts:
   - `run()` / `stream()`: next to the existing `terminalTools` Set (L316 /
     ~L1132) build
     `const displayTypes = new Map(agentTools.flatMap((t) => t.displayType ? [[t.name, t.displayType] as const] : []));`
     then in the six event literals add
     `...(displayTypes.has(tc.toolName) ? { displayType: displayTypes.get(tc.toolName) } : {})`
     (or stamp `displayType: displayTypes.get(tc.toolName)` — the field is
     optional and `undefined` is legal; the formatter guards on
     `!== undefined`. Prefer the conditional spread so frozen event objects
     don't carry an explicit-undefined key).
     Exact literals: tool.start L540-554 & tool.end L588-602 (run);
     tool.start L1487-1498 & tool.end L1550-1562 (stream).
   - `convertExecutableTools()`: `t` is in hand inside the `for` loop —
     stamp `...(t.displayType !== undefined ? { displayType: t.displayType } : {})`
     into the literals at L824-835 and L865-879.
   - Do **not** stamp `tool.intent` (Go parses `display_type` only on
     start/end; see decision B-2).
6. **`packages/agent-runtime/src/transport/sse-formatter.ts`**
   - `agent.tool.start` (L133-141): convert to the payload-variable form and
     add `if (event.displayType !== undefined) payload.display_type = event.displayType;`
   - `agent.tool.end` (L151-160): add the same line beside the `error` guard
     (L158). Idiom identical to backpack `display` (L270/283/299).
7. **Server**: nothing (`sse.ts:37-40` relays `toSSEMapping` verbatim —
   verified).

~40–60 production lines across 5 files (the report's 4-file count missed
`playbook.ts`), fully additive; absent field serializes to nothing (formatter
guard) and to `""` on the Go side.

### B.2 Test plan (Part B)

- **core** `packages/agent-core/src/molecules/__tests__/tool-schema.test.ts`:
  `fromZod` with/without `displayType` → property present/absent; `toDict`
  includes it only when set (byte-identical dict for undeclared tools —
  the L119 comment's guarantee).
- **core** `.../toolbox.test.ts`: a `toolbox()` with
  `displayType: "diff"` on one tool → `getToolSchemas()` carries it through;
  undeclared sibling tool → `undefined`.
- **core** `.../tool-authoring.test.ts`: `defineTool({ displayType })`
  passthrough (mirror the existing `terminal` passthrough test).
- **runtime** `packages/agent-runtime/src/runner/__tests__/agent-runner.test.ts`
  and `agent-runner-stream.test.ts`: existing tool-calling fixtures — assert
  the emitted `agent.tool.start`/`agent.tool.end` carry `displayType` when the
  schema declares it and lack the key when not (both `run()` and `stream()`
  paths; `runStructured`/`convertExecutableTools` covered wherever the
  existing structured-run tool test lives).
- **runtime** sse-formatter tests — **two files exist**:
  `packages/agent-runtime/src/transport/__tests__/sse-formatter.test.ts` and
  `packages/agent-runtime/src/__tests__/transport/sse-formatter.test.ts`
  (apparent legacy duplicate; check both, update whichever asserts the
  tool.start/tool.end payloads — payload gains `display_type` only when the
  event has it).
- **server**: optional one assertion in
  `packages/agent-server/src/__tests__/sse.test.ts` that a `displayType`-bearing
  `agent.tool.end` round-trips to `display_type` in `data` (belt-and-braces on
  the relay; not strictly required).

### B.3 Versioning / landing

- Touches **core + runtime** → `just bump-both` (Justfile L97:
  `bump-both lockstep="minor" core="minor"` — additive feature, the minor
  defaults are right; server/cli ride the lockstep automatically).
- Part A alone is server-only, but A and B land in the same R3 round and B
  forces `bump-both` anyway — one lockstep release covers both.
- Protected `main`: every commit via PR with required status `check`
  (`bun run check` = build + typecheck + lint + test).
- Project-memory caveat (from the eval-surface release, not re-verified this
  session): the publish gate needs `rm bun.lock && bun install` in the SAME
  commit as the version bump.

### B.4 Open decisions (Part B) — with recommendations

- **B-1 shape**: bare `displayType?: string` **[recommended]** vs
  `display?: { type?: string }`. The bare string maps 1:1 onto the Go
  `display_type` field, matches the `terminal` precedent, and the richer
  object can be introduced later only via a breaking rename — but no concrete
  second hint (collapse/title) exists yet, and the backpack `display` object
  remains the home for rich display metadata where it's actually needed.
  Minimalism wins.
- **B-2 stamp `tool.intent` too?** No — Go declares `display_type` only on
  start/end (`sse/types.go:27,36`), the React chat renders intent as a
  placeholder upserted by id, and nothing consumes it there. Skip; additive
  later if a consumer appears.
- **B-3 `playbook.ts:55`**: thread `displayType` **[recommended]** — one
  line, keeps the two `fromZod` call sites consistent. Note it currently also
  omits `terminal`; fixing that is a drive-by candidate but out of scope
  (behavioral: playbook-sourced schemas would suddenly declare terminal
  tools — leave it, flag in the PR description).
- **B-4 sequencing vs the Go heuristic**: unchanged from the report — the R1
  Go client can ship the ~30-line name/hunk-marker sniff now; this server
  field overrides it whenever non-empty (`display_type == ""` falls through).
  They compose; no coordination needed beyond the vocabulary convention
  `code | diff | bash`.
- **B-5 rendering contract producers must honor** (doc note for tool
  authors, worth one line in the PR/docs): `"diff"` → result must be unified
  diff text and `arguments.path` names the file; `"code"` → result is the
  code string, language inferred from `arguments.path`; `"bash"` → result
  rendered as a bash block; and chat-patterns only rich-renders **string**
  results (`parse.go:104-107`) — object-returning tools get the generic
  render regardless of the field.

---

## Cross-cutting notes for the implementer

- **N5 interplay**: none — the pre-work torn-stream fix lives in the same
  file's POST handler (`routes/conversations.ts:391-406`) but touches no code
  Part A adds; if pre-work hasn't merged first, expect adjacent-line merge
  friction only.
- **Suggested PR slicing**: A and B are independent — two PRs
  (`server: chat-patterns history compat shim` server-only; `core+runtime:
  displayType on tool events` with the bump-both) keeps review clean and lets
  A land without a core release.
- **Gap-analysis anchor corrections found while verifying** (all minor):
  history report cites TUI part types at `chat/model.go L34-38` with 5 values —
  actual is L31-43 with 7 (adds `delegation`, `status`); display-type report
  counts 4 production files — `playbook.ts:55` makes a 5th `fromZod` site;
  everything else re-verified exactly as reported.
