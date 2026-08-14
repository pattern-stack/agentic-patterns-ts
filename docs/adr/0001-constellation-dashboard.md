---
title: "ADR 0001 — The constellation cockpit becomes the dev-kit dashboard"
description: "Rebuilds the dashboard around the constellation cockpit: transport-agnostic graph engine, ChatWorkspace chat view, and uniform model-provider routing."
sidebar:
  label: "ADR 0001 — Constellation Dashboard"
---

- **Status:** Accepted (2026-06-25) — execution playbook in
  [`docs/migration/cockpit-port.md`](../migration/cockpit-port.md).
- **Date:** 2026-06-24 (accepted 2026-06-25)
- **Context owner:** Doug
- **Scope:** `@pattern-stack/agentic-dashboard` (rebuild) + a transport-agnostic graph
  engine; reuses `@pattern-stack/agentic-cli` (`ap playground` + discovery) and the
  `@pattern-stack/agentic-server`/`runtime` plumbing — with the small additive changes
  noted in the playbook (`/admin/conversations`, `/agents` capability enrichment,
  provider-routing formalization).

> **Build/publish decision (locked 2026-06-25):** develop in `packages/agent-dashboard`
> **locally** (`bun run dev` / `ap playground`); do NOT publish to npm until the chain
> graph + chat render against the real server. The dashboard is `private` and ships
> bundled inside `@pattern-stack/agentic-cli`, so UI work needs no publish. Only
> `runtime` (provider routing) + `server` (conversations/capabilities) are
> publishable libs; ship them, then `cli`, at the milestone. Tune against `agents/*`
> as the first suite is built. Full rationale + package table in the playbook.

> First ADR in this repo — starts a `docs/adr/NNNN-*.md` series alongside the
> existing topic docs in `docs/`.

## Context

The dev-kit already has the hard parts of "launch + live-test my agents":

- **Discovery** (`agent-cli/helpers/discover.ts`): globs `agents/**/agent.{ts,js,mjs}`
  (or `agents/<name>.agent.ts`), dynamic-imports each, and normalizes the default
  export into an `AgentRegistration` `{ id, name, description?, agent }` (object or
  factory). The CLI injects the `runner` (env-driven via `createRunner`).
- **`ap playground`**: wires the observability stack (`AgentEventBus` →
  `InMemoryEventCollector` → `InMemoryAdminService` + `SSEExporter` + optional
  `SQLiteExporter`/`EventStore`), attaches the runner to each discovered agent,
  builds the Hono `createServer`, mounts the dashboard SPA at `/`, opens the browser.
- **`@pattern-stack/agentic-server`** (Hono): `/agents`, `/conversations` (run + stream),
  `/admin/*` (stats + `/admin/events/stream` SSE), `/events`, `/health`, `/hooks`.
- **`@pattern-stack/agentic-dashboard`** (Vite + React 19, atomic structure): pages
  Agents / Chat / Conversations / Live / Tokens / Tools / ClaudeCode. It consumes
  the server's SSE + admin/conversations endpoints. **It has no agent-graph view,
  and its current UX isn't where we want it.**

Separately, a richer cockpit was built in a consumer project (`retrieval-agent`):
an **agent-graph "constellation"** with two projections (execution **chain** +
static **composition** — see that repo's ADR 0005), a `trace-from-events` fold over
the same `AgentEvent` union the runtime emits, a polished design-system shell, a
system-aware light/dark theme, and a streaming chat/run-viewer. It is a strictly
richer dashboard than what ships today — it's just wired to a bespoke Bun server.

## Decision

1. **Rebuild `@pattern-stack/agentic-dashboard` around the constellation cockpit.** The
   cockpit's graph + chat/run-viewer + design-system shell become the dashboard's
   core; **absorb the existing dashboard's coverage** (agents, conversations
   history, tokens/tools analytics, live) as views inside the new shell rather than
   discarding them ("steal from the original playground").
2. **Keep the framework plumbing as-is.** Discovery, `ap playground`, the Hono
   server, and the runtime (bus/collector/exporters/runner/`EventStore`) do not
   change. The dashboard is a pure **consumer** of the server's `AgentEvent` SSE +
   `/agents` / `/conversations` / `/admin` endpoints.
3. **The two graph projections map onto the framework's two native sources:**
   - **chain** ("what happened / will happen") ← the `AgentEvent` SSE (a
     conversation stream, or `/admin/events/stream`). The fold already eats this union.
   - **composition** ("what this agent *can* do") ← the discovered
     `AgentRegistration.agent`'s declared capabilities/tools. This is the
     live-agent-development surface, sourced straight from discovery.
4. **The graph ENGINE is transport-agnostic and moves into the framework.** The IR
   (`Constellation`), the per-frame fold (`computeFrame`), the replay hook, and the
   `AgentEvent → TraceStep` fold know nothing about transport. They land in the
   dashboard (or a shared `@pattern-stack/agentic-react` UI package) behind a thin
   **adapter** that maps the framework's SSE/agent shapes to the engine's inputs.
5. **Uniform model-provider routing (carried-in requirement).** Treat every
   provider identically — no blocking `required()`, no key-presence ladder. Define
   a **hard list of supported providers — `anthropic`, `openai`, `gemini`,
   `bifrost`, `ollama`** (for now) — map a model id to its provider (by prefix),
   and enable a provider **iff its config is present**; otherwise the model call
   fails at runtime with a clear error, never blocking config load. Rationale: the
   retrieval-agent cockpit today routes via a fixed key-presence ladder
   (`src/runtime/config.ts` `buildModel`) that mis-routes once multiple keys
   coexist (e.g. a Gemini key set would capture an `openai/*` or `bifrost/*`
   model). Open detail: where the local `claude-code/*` Max-sub CLI path lives —
   an `anthropic` variant, or its own provider entry.

## Contract & boundaries

- **Engine inputs:** an ordered `AgentEvent[]` (live or replayed) + an optional
  agent composition (from the registration). **Outputs:** the rendered graph +
  replay/HUD. No transport knowledge.
- **Adapter (framework-specific):** SSE (`/admin/events/stream`, conversation
  streams) + `/agents` registrations → engine inputs. This is the only framework-
  coupled glue.
- **Framework-level UI:** the constellation graph, the **`ChatPanel` organism**,
  the **`ChatWorkspace` console shell**, the theming/atoms, the event fold.
  - The `ChatWorkspace` (cockpit `components/workspace/`) is the full-screen
    three-pane agentic console — **sessions** (conversation library) · **thread**
    (the `ChatPanel`) · a right rail of **Context** (the agent's editable frame:
    persona, strategy, model, scope), **Universe** (the toolbox grouped by
    capability with blast radius + the data surface it can read), and **Activity**
    (the live constellation + an exploration trail — "watch it work"). It is the
    "regular agentic chat interface" surface and the natural shape for the
    rebuilt dashboard's chat view. In the cockpit its Universe is sourced from a
    static catalog; **promoted, Universe should read the discovered
    `AgentRegistration.agent`'s declared composition** (the "catalog coupling"
    open question below), and Sessions from `/conversations`.
  - The `ChatPanel` (cockpit `components/chat/`) is a reusable, streaming-first
    chat organism (atoms → molecules → `Part` renderers) with a `useChat`
    multi-turn driver and an `applyParts` reducer that folds the `AgentEvent`
    union (`message.chunk` / `tool.start|end|rejected` / `thinking` / `error` /
    `message.complete`) into a `Part[]` (`text|thinking|tool_call|error`) —
    tolerant of both live camelCase and persisted rows. **It was itself ported
    FROM this repo's `agent-dashboard` chat lineage** (its tested `useChat`
    reducer + cc-viewer part renderers + atomic decomposition), so promoting it
    is *upstreaming a refined version* of the dashboard's own chat, now with
    streaming tool-calls/thinking inline and a `size="full"|"compact"` API. It
    carries `chat/model.test.ts` (10 reducer-contract tests).
  - **Two folds, one event union:** the constellation's `trace-from-events`
    (graph) and the chat's `applyParts` (conversation) are sibling reducers over
    the same `AgentEvent` stream. The framework gets one event-fold story driving
    both the graph and the chat from its SSE.
- **NOT framework (stays consumer-side or an optional dashboard plugin):** domain
  evaluators like the retrieval-agent's **Lens/Eval** slot-discipline grader.

## Consequences

- One dashboard, **graph-first**, driven by discovery + the event bus: `ap
  playground` → chat with and *watch* any discovered agent as a live constellation;
  the composition view doubles as "what can this agent do" for agent authoring.
- The **retrieval-agent cockpit becomes a consumer**: its three arms become
  `agents/*.agent.ts` registrations, it drives them through `ap playground` instead
  of its bespoke Bun `cockpit.ts`, and it keeps only its domain Lens/Eval as a
  plugin. (This is the consumer-side proof the discovery path drives real agents.)
- Transport + persistence consolidate on the framework (Hono server +
  `better-sqlite3` `EventStore`), retiring the cockpit's `bun:sqlite` evals.db for
  framework use.

## Open questions / risks

> **Verified during planning (2026-06-25, see playbook §5–6):** the server streams
> **named** SSE (`event: <name>\ndata: <snake_case payload>`) with `message.delta`
> (not `message.chunk`); `GET /admin/conversations` is referenced by the dashboard
> but **not implemented** (must be added to back the session list); `@pattern-stack/agentic-runtime`
> **already** has a `HybridModelResolver` doing prefix-based routing, so provider
> routing is *formalize-and-extend*, not build-from-scratch; and the dashboard
> already has a `hooks/useChat.ts` ancestor that the ChatPanel port replaces.


- **Per-run scope.** Stateful/scoped agents (e.g. retrieval's deal/as-of/scope) are
  dependency-injected per conversation, but `AgentRegistration.agent` is static.
  Needs a request-time context channel through `/conversations` — the one real
  integration question for scoped agents. Generic agents are unaffected.
- **Theming.** Decide one token system for the dashboard: adopt the cockpit's
  swe-brain CSS-var layer, or keep the dashboard's own atoms and re-skin the
  constellation onto them. (The engine is var-driven, so either works.)
- **Catalog coupling.** The cockpit's hard-coded `TOOL_CAPABILITY` catalog must be
  replaced by the agent's *declared* composition from the registration.
- **Packaging.** Engine in `@pattern-stack/agentic-dashboard` vs a new
  `@pattern-stack/agentic-react` consumable beyond the dashboard. Lean: start in the
  dashboard; extract when a second consumer appears.

## Non-goals

- Not changing discovery / server / runtime contracts.
- Not porting domain evaluators (Lens/Eval) into the framework.
- Not building the per-run-scope channel here (flagged as the follow-up).

## Migration sketch (phased)

1. Land the engine + SSE adapter in the dashboard → the **chain** graph appears for
   any agent's conversation.
2. Add the **composition** view from `/agents` registrations.
3. Bring the `ChatWorkspace` console shell (sessions · thread · context/universe/
   activity) as the chat view; restyle/absorb the existing pages (Agents /
   Conversations / Tokens / Tools / Live) under it.
4. Consumer-side: retrieval-agent arms → `agents/*.agent.ts`; drive via
   `ap playground`; Lens/Eval as a plugin.
