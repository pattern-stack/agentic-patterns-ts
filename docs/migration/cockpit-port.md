---
title: "Cockpit → Dashboard port playbook"
description: "Playbook for porting the retrieval-agent cockpit UI into the dashboard: source→target file map, SSE event adapter spec, step checklist, verified contracts."
sidebar:
  label: "Cockpit → Dashboard port"
---

**Status:** Ready to start · **Created:** 2026-06-25 · **Owner:** Doug
**Companion ADR:** [`docs/adr/0001-constellation-dashboard.md`](../adr/0001-constellation-dashboard.md)

This is the cold-start guide for porting the **retrieval-agent cockpit** UI into
`@agentic-patterns/dashboard`. It assumes you have BOTH repos open:

- **Source (the cockpit):** `/Users/dug/Projects/retrieval-agent/src/cli/cockpit-ui/`
- **Target (this repo):** `packages/agent-dashboard/`

Read the ADR first for the *why*. This doc is the *how* — exact contracts, the
source→target map, the adapter spec, and a step checklist. The contracts below
were verified against the live code on 2026-06-25.

---

## 0. The decision (locked)

**Develop locally in this repo; do NOT publish to npm until a milestone.** The
dashboard is `private` (v0.1.1) and ships *bundled inside* `@agentic-patterns/cli`
(`ap playground` mounts it from `packages/agent-cli/assets/dashboard/`). So
"upstreaming the UI" is just editing `packages/agent-dashboard` and running
`bun run dev` — npm is never in the loop for UI work.

**Which packages get touched, and when npm enters:**

| Package | Role here | npm |
|---|---|---|
| `@agentic-patterns/dashboard` (PRIVATE) | the whole UI lift + the SSE adapter | never — bundled into the CLI |
| `@agentic-patterns/server` (published) | add `/admin/conversations`; enrich `/agents` with capabilities; (later) per-run scope | milestone publish |
| `@agentic-patterns/runtime` (published) | formalize provider routing in `HybridModelResolver` + `maxIterations` run option | milestone publish |
| `@agentic-patterns/cli` (published) | release vehicle — its build carries the dashboard | the publish that ships everything |
| `@agentic-patterns/core` | nothing expected | — |

Publish trigger: once the **chain graph + chat render correctly against the real
server** (steps 1–3 below). Then bump+publish runtime/server (if changed) then
cli. No changesets in this repo → manual per-package version bumps. retrieval-agent
already consumes `@agentic-patterns/runtime` (`claudeCode` in its `config.ts`), so
the provider-routing work flows back to it on the next runtime bump.

**Tune against real agents as you go.** This repo has `agents/` (calculator, todo,
writing-coach) and `examples/` — drive the dashboard against `agents/calculator`
via `ap playground` from step 1, so discovery/composition/streaming prove out on
real registrations, not mocks.

---

## 1. The three promotable pieces (source inventory)

All under `retrieval-agent/src/cli/cockpit-ui/`:

| # | Piece | Source files | Transport-coupled? |
|---|---|---|---|
| 1 | **Constellation engine + renderer** | `model/{constellation-model,trace-from-events,composition,layout,use-run-replay,catalog,types}.ts` + `constellation/{ConstellationGraph,ConstellationNode,ConstellationEdge,RunBarHud}.tsx` + `constellation.css` + `components/GraphPanel.tsx` | only the event-name fold (see §3) |
| 2 | **ChatPanel organism** | `components/chat/*` (ChatPanel, useChat, model, parts, MessageRow, ChatComposer, atoms, chat.css, index, model.test) | `useChat` → `/api/ask` (rewire to framework chat-client) |
| 3 | **ChatWorkspace console** | `components/workspace/{ChatWorkspace,SessionRail,ContextRail,universe}.{tsx,ts}` + `workspace.css` | SessionRail → `/api/runs`; universe → static catalog |
| — | **Theming + atoms + markdown** | `ui/{theme,tokens,atoms,theme-mode,cockpit}.*` + `ui/vendor/*` + `lib/markdown.ts` | none (theming decision below) |

`lib/api.ts` (the cockpit's `/api/*` client + `askStream` SSE parser) is **NOT
ported** — it's the seam that gets rewritten as the adapter (§3).

> Note: this repo's `@agentic-patterns/dashboard` already has `src/hooks/useChat.ts`
> — that is the *ancestor* of the cockpit's `components/chat/useChat.ts`. The port
> replaces it with the refined version (streaming tool-calls/thinking inline, the
> `Part` union, `model.test.ts`). This is literally upstreaming the dashboard's own
> chat, improved.

---

## 2. Target tree (`packages/agent-dashboard/src/`)

The dashboard is **Vite + React 19 + React Router 7**, atomic components, pure CSS
custom-property tokens (no Tailwind). The cockpit pieces are plain React+TS+CSS →
Vite-compatible. New deps to add to the dashboard `package.json`: `@xyflow/react`,
`lucide-react`.

```
packages/agent-dashboard/src/
├── api/
│   ├── chat-client.ts          KEEP — createConversation + streamMessage (the transport)
│   ├── client.ts · sse-events.ts · types.ts   KEEP
│   └── event-adapter.ts        NEW  — ClientEvent (named SSE) → cockpit EventLike (§3)
├── constellation/              NEW  ← cockpit constellation/* (renderer)
├── graph/                      NEW  ← cockpit model/* (engine: IR, folds, replay, layout)
│   └── (constellation-model, trace-from-events, composition, layout, use-run-replay, catalog, types)
├── chat/                       NEW  ← cockpit components/chat/* (ChatPanel organism)
│   └── (rewire useChat onto api/chat-client via event-adapter)
├── workspace/                  NEW  ← cockpit components/workspace/* (the 3-pane console)
├── components/                 KEEP existing atoms/molecules/organisms/templates
│   └── GraphPanel.tsx          NEW  ← cockpit components/GraphPanel.tsx
├── hooks/
│   ├── useChat.ts              REPLACE with cockpit chat/useChat.ts (rewired)
│   ├── useAdminData.ts · useEventStream.ts   KEEP
├── pages/                      KEEP 8 pages; new ChatWorkspace becomes the Chat page
│   └── ChatPage.tsx            REPLACE body with <ChatWorkspace/>
├── styles/
│   ├── globals.css             MERGE with cockpit ui/theme.css token layer (theming decision)
│   └── (bring cockpit tokens.ts + ui/atoms.tsx + lib/markdown.ts + cockpit.css md styles)
├── lib/markdown.ts             NEW  ← cockpit lib/markdown.ts (renders images)
└── App.tsx                     KEEP React Router shell; route Chat → ChatWorkspace
```

Decision to make on landing: **fold `model/` into `graph/`** (clearer name in a
general dashboard) — rename imports accordingly. The cockpit calls it `model/`;
nothing forces that name.

---

## 3. The adapter — the one real seam (`api/event-adapter.ts`)

The cockpit folds (`applyParts` for chat, `trace-from-events`/`composition` for the
graph) consume a flat **`EventLike`** shape: `{ type: string, ...payloadFields }`
where fields may be camelCase OR snake_case (the folds tolerate both via
`fields()`/`bare()`). The framework streams **named SSE**:

```
event: tool.start\n
data: {"tool_call_id":"...","tool_name":"search","arguments":{...}}\n
\n
```

**Adapter = flatten named SSE into EventLike:** `{ type: <event-name>, ...<data payload> }`.
The framework's `api/chat-client.ts#streamMessage` already yields typed `ClientEvent
{ name, data }` — so the adapter is:

```ts
// event-adapter.ts
export function toEventLike(ev: ClientEvent): EventLike {
  return { type: ev.name, ...ev.data };   // name → type, spread snake_case payload
}
```

Then in the rewired `useChat.send()`:
```ts
for await (const ev of streamMessage(convId, content, signal)) {
  const e = toEventLike(ev);
  setLiveEvents(prev => [...prev, e]);          // for the constellation
  patch(assistantId, m => applyParts(m.parts, e)); // for the chat thread
}
```

### Contract deltas to fix in the folds (small, enumerated)

The framework event vocabulary differs from the cockpit's in three concrete ways.
Fix these in the ported folds (do NOT hack around them in the adapter):

1. **`message.delta` not `message.chunk`.** `applyParts` (chat/model.ts) has a
   `message.chunk` case reading `delta`. Add a `message.delta` alias (same body).
   Frame: `{ delta, chunk_index }`.
2. **Graph fold uses prefixed names.** `composition.ts#deriveChain` matches the
   literal `'agent.message.start'` (reads `agentName`) and `'agent.tool.start'`
   (reads `toolName`). The framework emits **`message.start`** `{ agent_name }` and
   **`tool.start`** `{ tool_name }` (bare, snake_case). Make `deriveChain` accept
   bare names + `agent_name`/`tool_name`. (`trace-from-events` already strips the
   `agent.`/`pattern.` prefix via `bare()` and reads snake_case, so it mostly works.)
3. **`iteration.*` / `llm.*` are filtered from the conversation stream.** The server
   hides `iteration.start/end` + `llm.start/end` from `POST /conversations/:id/messages`
   (they remain on `/admin/events/stream`). The cockpit's RunBarHud/replay uses
   iteration counts. Either (a) live without iteration/llm in the live graph (degrade
   the HUD), or (b) also subscribe to `/admin/events/stream` filtered to this
   conversation's trace and merge. Start with (a); revisit if the HUD looks bare.

### Conversation lifecycle

Framework = **two steps**: `POST /conversations {agent_id}` → `{id}`, then
`POST /conversations/:id/messages {content}` → SSE. The cockpit's single
`/api/ask {question, arm, ...}` collapses both. In the rewired `useChat`: create
the conversation once per thread (on first send or on mount), reuse its id for
follow-ups (the framework threads context server-side per conversation — better
than the cockpit's stateless `/api/ask`). `arm`/`dealId`/scope have no home in the
generic `{content}` body → see "scoped agents" seam (§5).

---

## 4. Step checklist (maps to ADR migration steps)

Drive every step against `agents/calculator` (or a richer agent) via `bun run dev`
or `ap playground`.

- [ ] **Step 0 — land the code.** Copy pieces 1–3 + theming into the target tree
      (§2). Add `@xyflow/react`, `lucide-react` to dashboard deps. Get it to BUILD
      (fix imports, rename `model/`→`graph/`). Nothing wired yet.
- [ ] **Step 1 — chain graph from a live conversation.** Write `event-adapter.ts`;
      rewire `useChat` onto `chat-client` (§3); apply the three fold fixes. Feed
      `liveEvents` into `GraphPanel` (chain mode). Send a message to calculator →
      watch the constellation animate. (ADR step 1.)
- [ ] **Step 2 — composition view + Universe rail.** Enrich the server `/agents`
      (or add `/agents/:id`) to return the discovered agent's declared
      capabilities/tools (read the `AgentLike`'s `Capability`/`Toolbox` structure;
      `core` defines them). Replace `composition.ts`'s hardcoded `TOOL_CAPABILITY`
      and `workspace/universe.ts`'s static catalog with this. (ADR step 2 + closes
      the "catalog coupling" open Q.)
- [ ] **Step 3 — the ChatWorkspace shell + sessions.** Route the Chat page to
      `<ChatWorkspace/>`. Implement `GET /admin/conversations` (history) in the
      server — from the collector or EventStore — to back `SessionRail` (it's
      referenced by the existing ConversationsPage but **not implemented**). Absorb
      the existing pages (Agents/Tools/Tokens/Live) under the new shell or keep them
      as routes. (ADR step 3.)
- [ ] **Step 4 — provider routing + run options (runtime).** Formalize the hard
      provider list in `HybridModelResolver` (§5). Surface `maxIterations` as a run
      option through `/conversations/:id/messages` + a dashboard control (the cockpit
      already proved the UX — `ContextRail` "Limits"). (ADR #5.)
- [ ] **Step 5 — consumer proof.** Turn retrieval-agent's 3 arms
      (`packages/benchmarks/agent-eval/run-lib.ts#executeAsk`) into
      `agents/*.agent.ts` registrations; drive via `ap playground`; keep Lens/Eval
      as a consumer plugin. (ADR step 4.)
- [ ] **Milestone — publish.** Bump+publish runtime/server (if changed), then cli.

---

## 5. Open seams (concrete resolutions)

| Seam | Reality (verified) | Resolution |
|---|---|---|
| **Conversation history** | `GET /admin/conversations` is referenced by the dashboard but **NOT implemented** in the server | Add it to `@agentic-patterns/server` — project from the in-memory collector (and/or EventStore) into `{id, agent_id, started_at, title, status}[]`. Backs `SessionRail`. |
| **Capability introspection** | `/agents` returns only `{id,name,description}`; the `agent` is opaque `any` at discovery | Enrich `/agents` (or `/agents/:id`) to introspect the `AgentLike`'s declared `Capability`+`Toolbox` (from `core`). Drives Universe rail + composition graph. Replaces the cockpit's static catalog. |
| **Provider routing** | `@agentic-patterns/runtime` ALREADY has `HybridModelResolver` (profiles → gateway → pattern: `claude-*`→anthropic, `gpt-*`→openai, `gemini-*`→google) | Formalize the hard list `{anthropic, openai, gemini, bifrost, ollama}`; enable a provider **iff its env is present**; fail at call-time, never block config. Port the bifrost (Basic-auth OpenAI-compat), ollama-native, and claude-code (Max-sub CLI) builders from retrieval-agent `src/runtime/config.ts#buildModel` as provider entries. claude-code is an `anthropic` variant. |
| **Scoped agents** | conversation body is generic `{content}`; no place for arm/deal/as-of/scope | The per-run-scope channel through `/conversations` (ADR open Q). Generic agents unaffected. Defer to after step 3; retrieval's arms need it for step 5. |
| **Theming** | dashboard = single dark theme via CSS vars (`--bg-canvas`…), no component lib; cockpit = swe-brain blue light/dark/system (`--paper`, `--ink`, `--accent-ink`…) + vendored atoms | Adopt the cockpit's `ui/theme.css` token + derivation layer (it DEFINES the vars the cockpit components reference) + `tokens.ts` + `ui/atoms.tsx` + `ui/vendor/*`. Keep the dashboard's React Router shell. The report notes the dashboard tokens were "designed to unify" with the cockpit's. |
| **`GraphPanel` height** | React Flow collapses to height 0 without a definite-height parent | Carry the cockpit gotcha: wrap `GraphPanel` in a fixed-height box (the rail uses `height:400`). |

---

## 6. Quick reference — verified contracts (2026-06-25)

**SSE frame:** `event: <name>\ndata: <json-payload>\n\n` (payload snake_case).
**Client event names:** `conversation.start|end`, `message.start|delta|complete|cancel`,
`thinking.start|thinking|thinking.complete`, `tool.intent|start|progress|end|rejected`,
`iteration.start|end`*, `llm.start|end`*, `error`, `done`. (* = `/admin/events/stream` only.)
**Endpoints:** `GET /agents`, `POST /conversations {agent_id}`, `POST /conversations/:id/messages {content}` (SSE),
`GET /admin/{dashboard,agents,tools,tokens,events/stream,events/recent}`, `GET /admin/conversations` *(missing)*.
**Discovery:** `agents/**/*.agent.{ts,js,mjs}` → `DiscoveredAgent {id, name, description?, agent, file}`; CLI injects `runner`.
**Playground:** `AgentEventBus → InMemoryEventCollector → InMemoryAdminService + SSEExporter (+ optional SQLiteExporter)`; attaches runner; `createServer(...)`; `mountDashboard()` (SPA fallback, after routes).
**Dev:** `bun run dev` → server `:3456` + dashboard `:5173`. Build for release: CLI `build:dashboard` (Vite) → `packages/agent-cli/assets/dashboard/`.
