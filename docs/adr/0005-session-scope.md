---
title: "ADR 0005 — `SessionScope`: a declarative, typed per-conversation scope, carried as `host.scope`, rendered on one shared agent instance"
---

- **Status:** Accepted (2026-07-18) — shipped as the
  [#308](https://github.com/pattern-stack/agentic-patterns-ts/issues/308)
  stack: PRs [#309](https://github.com/pattern-stack/agentic-patterns-ts/pull/309)
  → [#310](https://github.com/pattern-stack/agentic-patterns-ts/pull/310)
  → [#311](https://github.com/pattern-stack/agentic-patterns-ts/pull/311)
  (`feat/session-scope` → `feat/scope-form` → `feat/scope-render`).
  Published: `core@0.13.0`, `runtime`/`server`/`cli@0.28.0`.
- **Date:** 2026-07-18
- **Context owner:** Doug
- **Scope:** `@agentic-patterns/core` (new `molecules/session-scope.ts`;
  `RenderContext` in `atoms/base.ts`; `Awareness.fromScope` +
  render-ctx widening), `@agentic-patterns/runtime`
  (`workflows/scope-host.ts`, the `host.scope` bag, `NodeRunContext.scope`,
  runner `_renderCtx`), `@agentic-patterns/server` + CLI (server-side
  validation, echo redaction, wire grammar, `SessionScopeLike` duck type),
  and the dashboard scope form.

## Context

[ADR-0004](0004-instantiate-as-execution-seam.md) gave conversation creation a
real scope *seam* — `instantiate(context)` became the delivered-instance
factory — but the scope **object** flowing through it was still whatever
untyped bag the registration author invented. Every consumer hand-rolled the
same per-tenant identity plumbing, three ways:

1. **Closure-bound at build time.** Tools closed over a scope object baked in
   at `buildAgent()` — one tenant per process; a second tenant meant a second
   build.
2. **Per-message agent rebuilds.** `instantiate` rebuilt the *entire* agent
   per conversation just to swap an identity string into a prompt line — the
   heavyweight escape hatch used for the lightweight case.
3. **Env-pinned playground identity.** The playground read identity from the
   environment, so every operator on one deployment saw the same tenant, with
   no per-conversation switch.

None of the three had a validated shape, a redaction contract, or any way for
a surface to discover *what fields* an agent expects. The industry has
converged the other way: **define the agent once; pass a typed context object
per run** — Pydantic AI's `deps_type`, the OpenAI Agents SDK's `context`,
LangGraph's typed state, Google ADK's session context. #308 brings that
convergence into the framework as a first-class core primitive.

## Decision

**A declarative core molecule — `sessionScope({ field: scopeItem(zodSchema,
…) })` — is the typed contract for per-conversation identity, and ONE shared
agent instance carries a distinct scope per conversation, validated
server-side and rendered into the prompt.** The design calls:

1. **A declared shape, not another closure.** `SessionScope` composes
   `ScopeItem` field declarations into one Zod object schema, plus
   `redactKeys`, `defaults`, and named `presets`. The constructor parses
   `defaults` and *every* preset against the composed schema at
   authoring time — a malformed declaration throws naming the offender
   (`preset "…" failed validation`), never at first request. Rejected:
   leaving scope an author-threaded closure — the entire point is a
   *declared* shape the server and every surface can introspect
   (`toJsonSchema()`), validate against, and seed an editor from.
2. **"Scope", never "context".** *Context* is reserved for the LLM context
   window — the thing scope renders *into*. *Scope* is who/what the run acts
   on behalf of. Every new noun is `scope`; `context` survives only as the
   **deprecated wire alias** for ADR-0004 back-compat (the dashboard posts
   under `context` so an independently-deployed pre-#308 server doesn't
   silently `201`-and-discard an unknown `scope` key; the server aliases it).
3. **Typed via Zod, validated server-side.** The server parses caller scope
   against the composed schema; failure is a **400** `{ error: "scope
   validation failed", issues }`. Detection is duck-typed `err.issues`
   (`Array.isArray`), never `instanceof ZodError` and never `.flatten()` — the
   zod peer range is `^3.25 || ^4` and instances cross a module boundary. The
   **parsed** value (Zod defaults + coercions applied) is the single thing
   that flows onward: to `instantiate`, to redaction, to the run-metadata
   stamp, and to the host bag.
4. **Redaction is echo-only.** The *unredacted* parsed scope reaches tools and
   the prompt; only the response echo and the `/admin/runs` metadata stamp are
   redacted (per-field `redact: true`, unioned with a registration's
   `contextRedactKeys`). This is not the safety boundary — scope carries
   *identifiers*, not credentials (ADR-0004's contract holds); redaction blanks
   identifying-but-sensitive fields out of logs, not secrets out of a channel
   that should never carry them.
5. **Presets materialize client-side.** There is no `preset` wire key. A
   surface expands a named preset to concrete values *before* posting, so the
   wire only ever carries materialized scope. The server stays dumb about
   preset semantics; a required-field, defaults-less scope makes a bare
   `POST /conversations` a deliberate **400** (the agent declared it needs a
   scope).
6. **One shared instance; scope per conversation.** This is the crux against
   ADR-0004. Where `instantiate` *rebuilds* the agent per conversation, a
   scope-only agent is built **once** and the same instance renders
   differently per conversation from the scope handed to *that render*. No
   per-message rebuild for the common case.

## Carriage: `host.scope`, a sibling of `host.deps` (delta from the issue's framing)

Issue #308 wrote `host.deps.scope`. **That is a crash.** `host.deps` is a
`DepReader` — a `.get()`-shaped accessor (`workflows/deps.ts`) that
`node-tool.ts` forwards as one — so a plain scope object placed inside it dies
at the first `ctx.deps.get()` a leaf makes. Scope therefore rides as a
**sibling** key: `RunOptions.host = { scratchpad?, deps?, eventBus?, scope? }`,
with `NodeRunContext.scope` for the node-side shape. The accessor module
(`workflows/scope-host.ts`) is deliberately single so the injection side and
the read side share one key: `buildScopeHost(parsed)` builds the fragment;
`readScope` / `requireScope` / `readScopeAs<T>` read it, and **each accepts
both context shapes** — a tool's `ctx.host.scope` and a node's `ctx.scope` — so
a `FunctionStep` author and a tool author call the same function.
`readScopeAs<T>` is a *cast, not a re-parse*: shipping the `SessionScope`
instance down every seam to re-validate one field read is the cost that buys
nothing once the server already parsed. The bag is **frozen** (shallow) at the
injection seam — one bag shared by every render and every tool read for the
conversation's lifetime, so a downstream write throws loud instead of silently
corrupting scope for everything after it. No `DepKey` singleton was minted:
that reopens exactly the ESM/CJS dual-build identity hazard the sibling-key
design sidesteps.

## Prompt seam: `Awareness.fromScope` — pure render, byte-compatible

- **Mechanism.** `Awareness.fromScope(scopeLike, fn, base?)` attaches a
  `scopeRender` fn to the Awareness instance; `toPrompt(ctx?)` appends
  `"\n\n" + fn(ctx.scope)` *after* existing content (including the no-sources
  fallback line) when both a fn and a `ctx.scope` exist, skips the empty
  string, and is byte-identical nullary. No new section class.
- **`RenderContext` lives at Layer 0** (`atoms/base.ts`), re-exported upward,
  so both rendering and the atom-level render hook reference it without atoms
  importing rendering or molecules. `fromScope`'s scope argument is typed
  *structurally* (a `{ parse }` anchor, value via `ReturnType<S["parse"]>`) and
  **never re-parsed at render time** — the same "cast, not validation" stance
  as `readScopeAs`.
- **`replace()` must preserve the fn.** `AgenticModel.replace()` reconstructs
  via the 1-arg ctor and silently drops instance fields; `Awareness` overrides
  `replace()` to re-attach `scopeRender`, so the fn survives
  `withDomain` / `withDomains` / `withCapabilities` (proven by test).
- **Purity is a hard gate.** No fetching inside a render fn, no prompt caching;
  the same instance renders differently per `{scope}` and byte-identically
  without one — existing rendering/organism snapshots pass with **no `-u`**.
  `renderInitialPrompt(ctx?)` widens; `toPrompt()` stays nullary (an abstract
  method can't widen, though an override may add optional params).
- **Scope-render is pure-text-from-scope ONLY.** When a run needs async
  assembly — resolve deps, swap tools by tenant, rebuild the role —
  **`instantiate` (ADR-0004) REMAINS the escape hatch.** This ADR *narrows*
  the common case (typed identity → a prompt line, one instance) out of
  `instantiate`; it does not *supersede* 0004. The two meet at conversation
  creation: a scope-declaring registration parses + injects scope; a
  hook-declaring registration rebuilds; a registration may declare both, and
  the parsed scope is what its `instantiate` receives.

## Consequences

- **New public surface.** Core: `sessionScope` / `scopeItem` / `SessionScope`
  / `ScopeItem` / `ScopeValue`, `Awareness.fromScope`, `RenderContext`.
  Runtime: `buildScopeHost` / `readScope` / `requireScope` / `readScopeAs`.
  The workspace example is the reference consumer — `SessionScope` +
  `scopeItem`, `type WorkspaceScope = ScopeValue<…>`, an
  `Awareness.fromScope` line, one shared instance — and its old
  `instantiateDefaults` / `contextRedactKeys` are dropped (scope subsumes both).
- **`instantiation.available` widens to `hasHook || hasScope`** identically in
  the `/agents` and `composition` payloads — a scope-only registration now
  accepts a scope on `POST /conversations`, echoes a redacted `scope` (plus the
  `context` alias) on the `201`, and gets a run-metadata stamp. A hook-less
  *and* scope-less registration's create response stays byte-identical
  (`{ id, agent_id }`, pinned).
- **Known limits, stated rather than hidden:**
  - **CC runners' tools don't see scope.** `host.scope` reaches the
    ClaudeCode/CC-API *prompt* (scope-aware render), but NOT CC *tool
    execution* — the SDK-MCP tool loop and `Playbook.execute` have no
    `ToolExecutionContext` seam to thread it through. Half-wiring it would be
    worse than the uniform absence; it ships as a documented `TODO(#308)`.
    Non-CC runners thread scope to both prompt and tools.
  - **Declared defaults/presets are served verbatim.** The roster exposes an
    agent's `defaults`/`presets` as authored; there is no per-caller
    server-side resolution of them.
  - **Scope-rendered `systemPrompt` events are un-redacted.** Redaction is
    echo- and metadata-only; a scope value rendered into the system prompt
    appears in the prompt event stream verbatim. Scope carries identifiers, not
    secrets — but an operator watching events sees the rendered line as-is.
  - **No async `resolveScope` hook (deferred).** A future hook that resolves
    scope server-side (fetch tenant config → scope) is deliberately out of
    scope: today scope is client-supplied and Zod-validated, and `instantiate`
    already covers the async-rebuild case. Nothing in the wire shape precludes
    adding it later.

### Rejected alternatives

- **`host.deps.scope`** (the issue's literal wording) — crashes on the first
  `ctx.deps.get()`; carriage is a sibling key instead (see above).
- **A reserved `DepKey` singleton for scope** — reopens the ESM/CJS dual-build
  identity hazard; the sibling-key + single-module design sidesteps it.
- **Re-parsing scope at each tool read / each render** — means shipping the
  `SessionScope` instance down every seam; the server-side parse is authoritative
  and the seams cast (`readScopeAs`, `fromScope`'s structural anchor).
- **A new `Section` subclass for the scope line** — an instance-level
  `scopeRender` fn on `Awareness` keeps `toPrompt()` byte-compatible and needs
  no section-ordering surgery.
- **Redact-everything-by-default** — destroys the feature's point; scope's
  identifying fields must be visible by default (mirrors ADR-0004's stance).
