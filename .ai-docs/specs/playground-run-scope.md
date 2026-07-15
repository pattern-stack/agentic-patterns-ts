# Implementation strategy — issue #268: `playground: run-scope visibility + per-run context`

## Scope and PR slicing

Unify the playground's two disconnected context notions — composition-preview context (`instantiate(context)`) and execution scope (closure/promotion-bound `deps`) — at the registration seam, so the same JSON context that previews an agent's delivered composition also **resolves the scope a conversation executes under**, is **visible** in the chat header and run inspector, and is **changeable** from the playground.

Land in this order (runtime → server → dashboard → CLI is the dependency direction):

| PR | Scope | Tracking/versioning |
|---|---|---|
| **PR-1 — per-conversation instantiate + run-metadata stamping** | `RunStore.updateRunMetadata`, `POST /conversations` accepts `context`, delivered-instance binding + executor derivation, redaction, `GET /agents` instantiation surfacing, ADR | runtime + server changes; no publish until stack completes |
| **PR-2 — playground surfaces** | Scope chip in chat header, composer-side context editor, run-inspector context block, API client/types | dashboard only |
| **PR-3 — CLI parity** | `ap run --context` / `AP_CONTEXT` seeding via `instantiate` | cli only; may fold into PR-1 if trivial |

After the stack merges: one lockstep bump (runtime/server/cli) per the versioning policy ([CLAUDE.md:70](/Users/dug/Projects/dug/agentic-patterns-ts/CLAUDE.md:70)); dashboard rides along. **Core is untouched** — `ToolExecutionContext.host` already carries opaque scope across the tool seam ([toolbox.ts:29-46](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/toolbox.ts:29)).

---

## Current state (verified)

### The two context notions

1. **Composition preview** — `AgentRegistration.instantiate?: (context?) => Promise<AgentLike>` with `instantiateDefaults` seeding ([config.ts:66-80](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/config.ts:66)). Documented "introspection-only and may hit live sources, so it stays opt-in and can reject". Exercised solely by `POST /agents/:id/composition/delivered` ([composition.ts:713-757](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/composition.ts:713)), which validates `context` as object-or-absent, falls back to `instantiateDefaults`, echoes the effective context, and answers 501 (no hook) / 502 (hook rejected). The Agent lens drives it from a JSON textarea ([AgentLensPage.tsx:329](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-dashboard/src/pages/build/AgentLensPage.tsx:329)). Discovery threads `instantiate`/`instantiateDefaults` off the registration wrapper ([discover.ts:188-199](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/helpers/discover.ts:188)), and the playground passes them into `AgentRegistration` verbatim ([playground.ts:150-163](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/commands/playground.ts:150)).

2. **Execution scope** — `deps` is bound at promotion time (`asAgent({deps})` → frozen `agent.deps`, [as-agent.ts:167](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/as-agent.ts:167)); `NodeBackedRunner.run` reads it onto `NodeRunContext.deps` ([as-agent.ts:255-268](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/as-agent.ts:255)); `AgentStep` packs `host: { scratchpad, deps, eventBus }` per leaf ([agent-step.ts:137](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/agent-step.ts:137)); the runner copies `host` verbatim onto every tool ctx ([agent-runner.ts:218](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/runner/agent-runner.ts:218), the #124 single copy site). For plain (non-promoted) agents the scope isn't even `deps` — it's **closures** captured at agent build time (the dealbrain evidence). Per-request deps via `RunOptions` is explicitly deferred, "mirrors #97" ([as-agent.ts:67-73](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/as-agent.ts:67)).

Nothing connects them: chat bodies carry only `{ content, maxIterations? }` ([conversations.ts:189](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/conversations.ts:189)); `Conversation.send/stream` forward `messageHistory`/`toolExecutor`/`eventBus` but no scope ([conversation.ts:170](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/conversation/conversation.ts:170), [conversation.ts:245](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/conversation/conversation.ts:245)); `POST /conversations` always binds the **declared** instance `reg.agent` and derives the executor from it ([conversations.ts:47-76](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/conversations.ts:47)).

### Persistence & display substrate

- `runs` rows already have a free-form `metadata` JSON column ([run-store.ts:48-49](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/storage/run-store.ts:48), read back on `RunRow.metadata` [run-store.ts:86](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/storage/run-store.ts:86)); `RunStoreExporter.metadataFor` (#149) stamps it at `startRun` from the `message.start` **event** ([run-store.ts (exporter):105-151](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/exporters/run-store.ts:105)). The playground constructs the exporter with `shouldTrack` only ([playground.ts:571-575](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/commands/playground.ts:571)).
- The message route already captures the turn's top-level `runId` off the first `agent.message.start` ([conversations.ts:222-246](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/conversations.ts:222)) and emits it on the `done` frame.
- `GET /admin/runs/:id` returns the full `RunRow` including `metadata` ([runs.ts:46-56](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/runs.ts:46)); `conversationRoutes` does **not** currently receive a run store ([app.ts:40](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/app.ts:40) vs [app.ts:53](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/app.ts:53)).
- `GET /agents` summaries carry `id/name/description/role/readiness` — **no** instantiation info ([agents.ts:34-55](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/agents.ts:34)); only the composition payload has `instantiation: { available, defaults }` ([composition.ts:700-703](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/composition.ts:700), mirrored in [composition.ts (dashboard api):90](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-dashboard/src/api/composition.ts:90)).
- Dashboard: `createConversation(agentId)` posts `{ agent_id }` only ([chat-client.ts:102-111](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-dashboard/src/api/chat-client.ts:102)); the chat header already hosts per-run controls (the `maxIterations` input, [ChatPage.tsx:481](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-dashboard/src/pages/ChatPage.tsx:481)) and an agent badge ([ChatPage.tsx:507](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-dashboard/src/pages/ChatPage.tsx:507)).
- Redaction precedent: innate scratchpad-read previews persist with the frame's structure intact, text dropped, and an explicit `preview_redacted: true` marker — never silently ([conversation.ts:441-452](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/conversation/conversation.ts:441)).
- Integration-test precedent: a real HTTP/SSE chat against a `RunStore` + `RunStoreExporter` on a shared bus ([promoted-agent.test.ts:125-145](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/__tests__/promoted-agent.test.ts:125)).

### Corrections / deltas to the issue

1. **All cited line numbers hold** on current `main` (re-verified for this spec; `composition.ts` delivered route is at :713-757 with `instantiate` called at :746).
2. **"returns the agent AND its context-resolved deps" is not needed as a return-shape change.** For promoted pipelines the delivered agent already *carries* its deps (`asAgent({deps})` → `agent.deps`, read by `NodeBackedRunner` at [as-agent.ts:262](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/as-agent.ts:262)); for plain agents scope lives in tool closures rebuilt by `instantiate`. A rebuilt agent is a complete scope carrier in both worlds — see Decision 1.
3. **`RunStoreExporter.metadataFor` is the wrong stamping seam for this feature.** It is a function of the `message.start` event only, and the exporter is constructed CLI-side ([playground.ts:571](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/commands/playground.ts:571)) — the conversation's context is server-side state the event never carries. Threading context onto the event would grow the event vocabulary (and the SSE wire) for a persistence concern. Decision 3 stamps from the route instead, via a new narrow `RunStore.updateRunMetadata`.
4. **`run.ts:54-71` is the runner-resolution block**, not a context seam; the CLI change is to bind the delivered instance before constructing the `Conversation` at [run.ts:69-71](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/commands/run.ts:69). `playground.ts:156-162` already threads the hooks through — no playground CLI change is needed.

---

## Design decisions

### 1. Hook shape: `instantiate(context)` becomes the single delivered-instance factory — no sibling `resolveDeps`

**Decision:** Reuse the existing `instantiate(context): Promise<AgentLike>` signature unchanged. The delivered agent **is** the scope carrier:

- Plain agents: the hook rebuilds the agent with context-resolved closures (dealbrain's `getSharedLiveWorkspace` becomes `getWorkspace(context.workspaceId)` inside the hook).
- Promoted pipelines: the hook rebuilds via `asAgent(node, { role, deps: <resolved from context> })`. `NodeBackedRunner.run` already reads `agent.deps` off whatever promoted instance it is handed ([as-agent.ts:262](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/as-agent.ts:262)) — zero runner changes. The node itself is stateless and cheaply re-wrapped; only the frozen `PromotedAgent` shell is rebuilt.

What changes is the **contract**, not the signature: `instantiate` is promoted from "introspection-only" to *the delivered-instance factory* — the one seam both the composition lens and conversation creation call. Its doc comment ([config.ts:67-77](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/config.ts:67)) is rewritten to say: called once per composition preview and once per conversation creation; must return an agent runnable by the registration's runner (a promoted registration must return a `PromotedAgent` — `NodeBackedRunner` already fails loud otherwise, [as-agent.ts:222-226](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/as-agent.ts:222)); may hit live sources; may reject (rejection fails conversation creation loudly, Decision 5).

**On the #97-mirror deferral** ([as-agent.ts:67-73](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/as-agent.ts:67)) — the issue's central design call: it stays deferred **at the RunOptions layer**, and the comment is updated to point here. We un-defer the *capability* (different scope per chat) one level up — per-conversation delivered instances — without opening the per-run-deps channel. Rationale: `RunOptions.deps` would require threading through `Conversation` → `RunnerProtocol` → `NodeBackedRunner` plus a precedence rule (`options.deps` vs `agent.deps`), and it only pays off for per-message granularity, which Decision 2 rejects. Worse, it would split scope resolution into two registration hooks — `instantiate` for the composed prompt/Background, something else for deps — that can silently drift apart. Two disconnected context notions is the exact disease #268 diagnoses; one hook returning one instance is the cure. The lens now previews *literally the object* a conversation runs.

**Rejected — sibling `resolveDeps(context): DepReader`:** plumbing across three layers for the per-message case we're not building; reintroduces the two-notion split; leaves plain agents (closure-scoped, the actual consumer evidence) uncovered — `DepReader` means nothing to an `AgentRunner`-looped agent whose tools never read `ctx.host`.

**Rejected — widen the return to `{ agent, deps }`:** breaks every existing hook's return type, and the separated `deps` would then need a carrier into the runner (`RunOptions`/`host`) — the same plumbing as the sibling-hook option, with a migration on top.

### 2. Granularity: per-conversation; context is fixed at creation

**Decision:** `context` is accepted on `POST /conversations` only, resolved once, and immutable for the conversation's lifetime. Changing scope = new conversation (the existing "New Chat" affordance, [ChatPage.tsx:461](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-dashboard/src/pages/ChatPage.tsx:461)).

Rationale beyond "scope rarely changes mid-thread": a mid-conversation switch makes `messageHistory` a **cross-scope transcript** — prior exchanges' tool results (tenant A's data) get replayed into the prompt of a run executing as tenant B ([conversation.ts:383-405](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/conversation/conversation.ts:383)). That is scope bleed *inside the model input*, invisible to any gate. Per-conversation also matches the existing binding structure: agent and executor are constructor-bound (`readonly agent`, [conversation.ts:78-104](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/conversation/conversation.ts:78)) and the acceptance sketch only requires new-conversation switching. Per-message override is explicitly out of scope; nothing in the route shape precludes adding a fork-with-new-context affordance later.

### 3. Redaction: declared keys, redact-before-write, honest marker; contract that context carries identifiers, not credentials

**Decision:** three parts.

1. **Contract (ADR + hook doc):** context is displayable-by-design — it crosses HTTP from the dashboard, is echoed back, and is persisted. It carries *identifiers* (org id, workspace id, user id); anything secret stays inside the registration closure and is resolved server-side by the hook. This is the primary safety property; redaction is the escape hatch, not the design.
2. **Escape hatch:** the registration (wrapper + `AgentRegistration`) gains `contextRedactKeys?: readonly string[]` — top-level context keys whose *values* are replaced with `"[redacted]"` before the context is (a) echoed on the create response, (b) held on the conversation entry, or (c) stamped into run metadata. A `context_redacted: [...keys]` sibling field marks the substitution explicitly — the innate-scratchpad-read posture ([conversation.ts:441-452](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/conversation/conversation.ts:441)): structure survives, value dropped, never silent.
3. **Placement:** redaction happens **before any write or non-input return** in the route. `/admin/runs/:id` therefore cannot leak more than the row holds; there is no "redact on the way out" divergence between store and API. The raw context exists only in-flight, inside the `instantiate` call.

Default (no `contextRedactKeys`): verbatim. Redact-everything-by-default is rejected because it destroys the feature's point — "who does this run execute as" requires the identifying fields visible in the chip and inspector (the acceptance sketch says *name/id fields surfaced*).

### 4. Relationship to #252: same registration wrapper, orthogonal fields, separate deliverables

**Decision:** no combined "registration options" type. The discovery wrapper (`{ id, name, agent, instantiate, instantiateDefaults, evals }`, [discover.ts:184-203](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/helpers/discover.ts:184)) already *is* the registration-options shape both issues extend — #268 adds `contextRedactKeys` and strengthens `instantiate`'s contract; #252 will add `runner`. They stay separate PR streams.

The composition rule to pin **now** so #252 lands additively: **`instantiate` changes the agent, never the runner; a `runner` field changes the runner, never the agent.** They meet at conversation creation ([conversations.ts:72](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/conversations.ts:72)): `new Conversation(<declared-or-delivered agent>, reg.runner, …)`. Decision 1's "runnable by the registration's runner" contract covers the interaction: a promoted registration keeps returning promoted instances regardless of which runner #252 later installs. This is also why #268 must not absorb #252: an engine-pinned runner is per-*mount* configuration; scope is per-*conversation* input. Different lifetimes, different fields.

### 5. Trust boundary: the hook is the gate — same posture as `composition/delivered` and the admin API; no new auth layer

**Decision:** no auth machinery, no config kill-switch in v1.

- The impersonation-shaped capability **already exists**: `POST /agents/:id/composition/delivered` executes `reg.instantiate(context)` with caller-supplied context today ([composition.ts:746](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/composition.ts:746)). #268 extends the same registered-hook capability from preview to execution — no new class of caller power. The hook author is the gate: the hook decides what context resolves to (and can reject any context it refuses to serve).
- Agents without `instantiate` are structurally unaffected; sending `context` for one is a **400**, not a silent ignore — silently accepting would fake scope-switching, the worst outcome for a visibility feature.
- The server has no auth on `/admin/*` or `composition/delivered` today (verified: no auth middleware in `app.ts`); the standing guidance — embedders mounting agent-server outside dev put authn in front of the whole mount — is restated in the ADR and the `instantiate` doc. A `ServerConfig` opt-out (e.g. lens-only instantiate) is a named follow-up if a consumer materializes, not speculative config now.
- Hook failure at conversation creation → **502** with the `instantiate failed: <message>` grammar ([composition.ts:752-755](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/composition.ts:752)) — fail loud, never fall back to the declared instance, whose scope would be silently wrong.

**Consequence of Decisions 1+5 worth stating plainly:** when a registration has an `instantiate` hook, conversation creation now *always* runs it (with explicit context, else `instantiateDefaults`, else `undefined`) and binds the delivered instance. Existing hook-bearing registrations change behavior: chats bind the delivered instance instead of the declared one, and a rejecting hook now fails conversation creation. This is intentional — the declared instance's pinned scope is the bug being fixed, and the scope chip must never describe a guess — but it is called out in the ADR, CHANGELOG, and Risks.

---

## API design

### Registration (server config + discovery wrapper)

```ts
// packages/agent-server/src/config.ts — AgentRegistration additions/edits
export interface AgentRegistration {
  // ... existing fields ...

  /**
   * Delivered-instance factory (#268 — was "introspection-only").
   * Called by POST /agents/:id/composition/delivered (preview) and by
   * POST /conversations (execution): the conversation binds the returned
   * instance, so context-resolved closures/deps ARE the run scope.
   * Must return an agent runnable by this registration's `runner`
   * (promoted registrations return a PromotedAgent). May reject —
   * conversation creation then fails 502, never falls back to `agent`.
   */
  readonly instantiate?: (context?: Record<string, unknown>) => Promise<AgentLike>;
  readonly instantiateDefaults?: Record<string, unknown>;
  /**
   * Top-level context keys whose values are replaced with "[redacted]"
   * before the context is echoed, held, or persisted (#268 Decision 3).
   */
  readonly contextRedactKeys?: readonly string[];
}
```

`DiscoveredAgent` + the wrapper reader in [discover.ts:184-203](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/helpers/discover.ts:184) gain the same optional `contextRedactKeys` (array-of-strings validation, same defensive style as `instantiateDefaults`); [playground.ts:150-163](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/commands/playground.ts:150) threads it through.

### Server routes

```
POST /conversations
  body: { agent_id: string, context?: Record<string, unknown> }
  → 400  context present but not a JSON object (composition.ts:733 grammar)
  → 400  context present but registration has no instantiate hook
  → 404  agent not found (unchanged)
  → 502  instantiate rejected ("instantiate failed: <msg>" grammar)
  → 201  hook-less registration: { id, agent_id } — byte-identical to before this feature, `context` key OMITTED entirely
  → 201  hook-bearing registration: { id, agent_id, context: <redacted effective context> | null, context_redacted?: string[] }
```

Behavior: `effectiveContext = context ?? reg.instantiateDefaults` (mirror [composition.ts:744](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/composition.ts:744)); if `reg.instantiate` exists, `agentToBind = await reg.instantiate(effectiveContext)`, else `agentToBind = reg.agent`. `deriveToolboxExecutor(agentToBind)` — the delivered instance's tools, not the declared one's ([conversations.ts:67](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/conversations.ts:67) moves to the bound agent). `ConversationEntry` gains `context?: Record<string, unknown>` (the redacted effective form; `undefined` when no hook).

```
POST /conversations/:id/messages   (body unchanged)
```

After the SSE drain loop (row guaranteed finalized), if a run store is wired and `turnRunId` was captured and `entry.context` is defined: `runStore.updateRunMetadata(turnRunId, { context: entry.context, ...(redacted ? { context_redacted: keys } : {}) })`. Failure logs to stderr and never breaks the stream (exporter posture). `conversationRoutes(...)` gains a trailing `runStore?: RunStore` param; `app.ts` passes `config.runStore ?? config.evalStore` (the [app.ts:53](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/app.ts:53) fallback rule).

```
GET /agents   → summaries gain: instantiation: { available: boolean, defaults: Record<string, unknown> | null }
```

Same sub-shape as the composition payload ([composition.ts:700-703](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/composition.ts:700)) so the ChatPage seeds its editor without extra round trips. Additive — existing consumers ignore it.

### Runtime storage

```ts
// packages/agent-runtime/src/storage/run-store.ts
/**
 * Shallow-merge `patch` into the run's metadata JSON (#268). Full runId only
 * (no prefix resolution — producers hold the real id). Returns false when no
 * row exists; never throws for a missing row.
 */
updateRunMetadata(runId: string, patch: Record<string, unknown>): boolean;
```

Implementation: `SELECT metadata FROM runs WHERE run_id = ?` → JS shallow merge → `UPDATE runs SET metadata = ?`. No schema change (`metadata` column exists, [run-store.ts:141](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/storage/run-store.ts:141)).

**Explicitly unchanged:** `Conversation`, `RunOptions`, `NodeBackedRunner`, `AgentStep`, the event vocabulary, the SSE wire, `RunStoreExporter` (its `metadataFor` seam stays for eval axes), and all of core.

### Dashboard

- `api/types.ts`: `AgentSummary` + `instantiation`; `ConversationCreated` + `context`; ensure `RunRow.metadata` parity with runtime.
- `chat-client.ts`: `createConversation(agentId, context?)`.
- `useChat`: accepts a `context` option alongside `maxIterations` ([ChatPage.tsx:179](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-dashboard/src/pages/ChatPage.tsx:179)); passed at conversation creation only.
- ChatPage: **scope editor** — JSON textarea (AgentLens pattern, [AgentLensPage.tsx:329](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-dashboard/src/pages/build/AgentLensPage.tsx:329)) seeded from `instantiation.defaults`, shown only when `instantiation.available`, editable **until** the conversation exists, then locked with a "New Chat to change scope" hint (Decision 2 made visible). **Scope chip** — header chip next to the agent badge ([ChatPage.tsx:507](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-dashboard/src/pages/ChatPage.tsx:507)) showing the first 1–2 scalar context entries (`key: value`), full JSON on click (popover); renders `(no scope)` when the agent has a hook but the effective context is null; hidden entirely for hook-less agents. Source of truth: the create response's echoed context — the server's word, not the editor text.
- Run inspector: render `metadata.context` (+ `context_redacted` badge) as a labeled JSON block in the run detail surface fed by `lib/runsApi.ts`.
- Honest degradation: replayed sessions ([lib/sessions.ts](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-dashboard/src/lib/sessions.ts)) don't carry context (ConversationStore doesn't persist it — out of scope); the chip is simply absent on replay, and the run inspector (via the `done` frame's `run_id` link) remains the durable record.

### CLI (`ap run`)

At [run.ts:69-71](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/commands/run.ts:69): if `reg.instantiate` exists, resolve `context` from `--context '<json>'` flag → `AP_CONTEXT` env (JSON) → `instantiateDefaults`, call the hook, bind the delivered instance in the `Conversation` (and derive the executor from it), and print one banner line: `scope: <compact json>` (redacted form). Invalid JSON in flag/env fails loud pre-run. No hook → flag/env presence is an error (parity with the server's 400).

---

## File-by-file change plan

### PR-1 — runtime + server

| File | Change |
|---|---|
| `packages/agent-runtime/src/storage/run-store.ts` | Add `updateRunMetadata` + prepared statement. |
| `packages/agent-runtime/src/storage/__tests__/run-store.test.ts` (or sibling) | Merge/missing-row/null-metadata cases. |
| `packages/agent-runtime/src/workflows/as-agent.ts` | Comment-only: update the #97-mirror deferral note ([:67-73](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/as-agent.ts:67)) to point at the registration-seam path (#268); per-run `RunOptions` deps remains deferred. |
| `packages/agent-server/src/config.ts` | `instantiate` contract rewrite + `contextRedactKeys`. |
| `packages/agent-server/src/routes/conversations.ts` | `context` on create; delivered-instance binding; executor from bound agent; redaction helper (file-local, route-helper convention); `ConversationEntry.context`; post-loop metadata stamp; `runStore` param. |
| `packages/agent-server/src/routes/agents.ts` | `instantiation` on summaries. |
| `packages/agent-server/src/app.ts` | Thread `config.runStore ?? config.evalStore` into `conversationRoutes`. |
| `packages/agent-server/src/__tests__/` (new: `conversation-context.test.ts`) | Integration tests below. |
| `packages/agent-server/src/openapi.ts` (or wherever the route schemas live) | New request/response fields on the two routes + agents summary. |
| `docs/adr/0004-instantiate-as-execution-seam.md` | The Decision-1/2/5 record (0003 is taken by in-flight #269). |
| `CHANGELOG.md` | Feature bullet + the behavior-change callout for hook-bearing registrations. |

### PR-2 — dashboard

| File | Change |
|---|---|
| `packages/agent-dashboard/src/api/types.ts` | `AgentSummary.instantiation`, `ConversationCreated.context`, `RunRow.metadata` parity. |
| `packages/agent-dashboard/src/api/chat-client.ts` | `createConversation(agentId, context?)`. |
| `packages/agent-dashboard/src/chat/useChat.ts` | `context` option; thread to creation. |
| `packages/agent-dashboard/src/pages/ChatPage.tsx` | Scope editor + scope chip + lock-after-create. |
| Run detail surface (via `lib/runsApi.ts` consumers) | Context block + redaction badge. |
| Tests (`chat-client` / fold tests as applicable) | Create-with-context; chip renders from echoed context. |

### PR-3 — CLI

| File | Change |
|---|---|
| `packages/agent-cli/src/commands/run.ts` | `--context`/`AP_CONTEXT` seeding; delivered-instance binding; banner line. |
| `packages/agent-cli/src/helpers/discover.ts` | `contextRedactKeys` on the wrapper (needed by PR-1's registration type; move into PR-1 if the type dependency demands it). |
| `packages/agent-cli/src/commands/playground.ts` | Thread `contextRedactKeys` into registrations ([:150-163](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/commands/playground.ts:150)). |
| CLI tests | Flag/env parsing; no-hook error. |

---

## Test plan

### PR-1 server integration (`conversation-context.test.ts`, harness per [promoted-agent.test.ts:137-145](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/__tests__/promoted-agent.test.ts:137))

1. **Plain agent, hook rebinds closures** — registration whose `instantiate(ctx)` builds an agent with a tool answering `ctx.tenant`; two conversations with different contexts get demonstrably different tool results (the acceptance sketch's dealbrain analogue).
2. **Promoted registration, deps resolved from context** — `instantiate` rebuilds via `asAgent(node, { deps })`; `NodeBackedRunner` chat reflects the per-conversation dep value; `isPromotedAgent` still satisfied.
3. **Create response echoes effective context** — explicit context; defaults fallback when omitted; `null` for hook-with-no-defaults-and-no-context.
4. **400** — non-object context; context for a hook-less registration (and the hook-less registration is otherwise byte-identical: same create response shape as today minus `context: null`).
5. **502** — rejecting hook; no conversation entry is created.
6. **Executor derived from the delivered instance** — declared instance capability-less, delivered instance with tools → tools fire (and the inverse: delivered capability-less → no phantom executor).
7. **Run metadata stamped** — full HTTP/SSE chat with `RunStore` + `RunStoreExporter` on the shared bus; after `done`, `GET /admin/runs/:id` returns `metadata.context` equal to the echoed context; a second turn in the same conversation stamps its own run too.
8. **Redaction** — `contextRedactKeys: ["userId"]` → create response, and run metadata both carry `"[redacted]"` + `context_redacted: ["userId"]`; the raw value appears nowhere in the store (assert on the raw row).
9. **No-store degradation** — no run store wired → chat works, no stamp, no error.
10. **`GET /agents`** — `instantiation.available/defaults` present and correct for hook/hook-less registrations.

### PR-1 runtime

- `updateRunMetadata`: merges into existing metadata; creates metadata object when column NULL; returns `false` for unknown runId; does not touch other columns (status/finalAnswer intact).

### PR-2 dashboard

- `createConversation` posts `context` only when provided.
- Chip shows echoed (server) context, not editor text; `(no scope)` and hidden states; editor locks after first message; New Chat unlocks with defaults re-seeded.
- Run detail renders `metadata.context` and the redaction badge.

### PR-3 CLI

- `--context` invalid JSON fails before any model call; env fallback order; no-hook + flag errors; banner line shows redacted form.

### Verification commands

Each PR: `bun run check` plus the touched package's `bun run --filter=<pkg> test`.

---

## Risks and compatibility

| Risk | Mitigation |
|---|---|
| **Behavior change for existing hook-bearing registrations** (chat now binds the delivered instance; rejecting hooks now fail creation) | Intentional (Decision 5's consequence note). ADR + CHANGELOG callout. Registrations without hooks are byte-identical. In-repo presets/examples have no `instantiate` hooks — blast radius is external consumers who opted into the lens hook, i.e. exactly the audience asking for this. |
| **`instantiate` latency/cost at conversation creation** (may hit live sources) | One call per conversation — same cost profile the lens's compose button already accepts; POST-never-cached posture carried over. Documented in the hook contract. |
| **Race: metadata stamp vs run-row creation** | Stamp happens after the SSE drain loop — the exporter opened (and finalized) the row on events that necessarily preceded the drain's completion. `updateRunMetadata` returning `false` logs and moves on; it can never 500 the stream. |
| **Context leaks via `/admin/runs`** | Redaction is applied before write (Decision 3), so the API can't return more than the row holds; contract says credentials never ride context at all. |
| **Scope bleed across a conversation** | Structurally impossible in v1: context is immutable per conversation (Decision 2); mixed-scope `messageHistory` cannot arise. |
| **Promoted registration returns a non-promoted instance from its hook** | `NodeBackedRunner.run` already throws loud ([as-agent.ts:222-226](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/as-agent.ts:222)); contract documents the requirement; test 2 covers the happy path. |
| **#252 collision** | Decision 4's orthogonality rule (agent vs runner) pinned now; both extend the same wrapper without shared new types. |
| **Session replay shows no scope** | Honest degradation, documented; the run inspector is the durable record. Persisting context on the ConversationStore is a named non-goal (protocol + schema change with its own migration story). |

## Out of scope (explicit)

- Per-message context override / conversation forking with a new scope (Decision 2).
- `RunOptions.deps` / per-run deps threading — the #97-mirror deferral stands at that layer (Decision 1).
- #252's registration-level runner override (Decision 4) and any auth/kill-switch config (Decision 5).
- Persisting context into `ConversationStore` rows; eval-path scope (`EVAL_TRACE_PREFIX` runs are skipped by the exporter and keep their own metadata seam).
- Core changes of any kind.

## Acceptance mapping

| Issue acceptance criterion | Planned satisfaction |
|---|---|
| Chat header shows active scope (name/id surfaced, full JSON on expand); "(no scope)" otherwise | Scope chip fed by the create response's echoed context (PR-2); `(no scope)`/hidden states specified. |
| Editing context + new conversation demonstrably changes tool behavior | Per-conversation `instantiate` binding + executor from delivered instance (PR-1, tests 1–2); editor + New Chat flow (PR-2). |
| Run detail (API + inspector) shows the redacted context the run executed under | `updateRunMetadata` stamp post-drain → `RunRow.metadata.context` on `/admin/runs/:id` (PR-1, tests 7–8); inspector block (PR-2). |
| Agents without `instantiate` unaffected; existing conversations unaffected | Hook-less path byte-identical (test 4); in-flight conversations predate the field and simply have no `context`. |

## Diff Review — Adherence
<!-- written by: reviewer · gate 2.5 · /sdlc:review · lens=adherence -->

**Target:** `git diff main...HEAD` (branch `feat/268-playground-run-scope`, PR #276, head `ee8fb94`) — PR-1 scope, issue #268
**Against:** this spec (PR-1: § Design decisions, § API design, § File-by-file change plan § PR-1, § Test plan § PR-1)
**Verdict:** PASS_WITH_NOTES

PR-1 is built as specified. `instantiate(context)`'s promotion from introspection-only to delivered-instance factory, the per-conversation binding + executor derivation from the bound (not declared) agent, the 400/502 grammar, `contextRedactKeys` + the three-surface redaction (create response, `ConversationEntry`, run metadata), `RunStore.updateRunMetadata`, the post-drain stamping seam, and the `GET /agents` `instantiation` field all match their spec sections. Every PR-1 file-plan line item is present; no PR-2 (dashboard) or PR-3 (CLI) files are touched. All ten named PR-1 server-integration test-plan items are implemented as their own test(s), plus the `updateRunMetadata` runtime test-plan bullet. Two interpretation calls in the spec's own prose were validated against the test plan and found faithful, not deviations: (1) the create-response shape for a hook-less registration reads as byte-identical to today (`{ id, agent_id }`, no `context` key) per test-plan item 4's explicit wording, even though the API-design one-liner previously stated `context: ... | null` unconditionally; (2) `context_redacted` belongs on the create response as well as run metadata, per test-plan item 8, even though the API-design response line didn't spell out that field. Both are now reflected in the spec's own response-shape line (tidied in this commit) so the API-design section and test plan no longer disagree.

**Blockers (0):**
- _None._

**Notes (0):**
- _None — the two interpretation calls above are recorded as validated-faithful, not outstanding items._

**Nits (1):**
- The API-design § Server routes response line for `POST /conversations` stated a single unconditional `201` shape; it undersold the hook-less/hook-bearing split the test plan (item 4) already specified. Tidied directly in the spec (this commit) rather than left as a standing discrepancy between two spec sections.

**Reviewed by:** reviewer agent (paired lens=adherence) · 2026-07-15

## Diff Review — Quality
<!-- written by: reviewer · gate 2.5 · /sdlc:review · lens=quality -->

**Target:** `git diff main...HEAD` — PR #276, branch `feat/268-playground-run-scope`, code commit `ee8fb94`
**Against:** quality canvas (`.claude/canvases/quality-checks/categories.yaml`) — spec-blind
**Verdict:** PASS_WITH_NOTES

Well-built. The redaction/context-echo/executor-derivation logic is straightforward and honest — no convenient_fallback (a rejecting hook never falls back to the declared agent), no silent coercion (non-object/`null` context is a `400`, not a best-effort parse), no magic_constants. Zero blockers; three should-fix notes and two nits, all addressed in the immediate follow-up commit (`64a5b4d`, this stack):

**Blockers (0):**
- _None._

**Notes (3) — all fixed in `64a5b4d`:**
1. [`packages/agent-server/src/routes/conversations.ts`, run-metadata stamp] The stamp sat after the SSE drain loop inside `try`. On a turn error, `Conversation.stream` yields `conversation.end` then re-throws, so the loop throws and the stamp was skipped — errored runs, the ones an operator most needs to inspect, never got `metadata.context`. Same gap for a client disconnect (`stream.writeSSE` rejecting). _Fix:_ moved the stamp into `finally` (guard unchanged); new test asserts a throwing-runner turn leaves `status: 'error'` AND `metadata.context` stamped — verified to fail pre-fix, pass post-fix.
2. [`packages/agent-server/src/routes/conversations.ts`, context resolution] When the caller omits `context`, the hook received `reg.instantiateDefaults` BY REFERENCE; a hook that mutates its argument would corrupt defaults for every later conversation on that registration. _Fix:_ hand the hook a shallow copy (`undefined` preserved when there are no defaults declared); new test proves a mutating hook's second conversation still observes the pristine default.
3. [`docs/adr/0004-instantiate-as-execution-seam.md`, `CHANGELOG.md`] Doc honesty follows note 1 — both claimed the stamp landed unconditionally "after the SSE drain completes," true only for successful turns pre-fix. _Fix:_ both now state the stamp lands for successful AND errored/disconnected turns (finally-scoped), matching the code.

**Nits (2) — documented in `64a5b4d`:**
- [`packages/agent-runtime/src/storage/run-store.ts`, `updateRunMetadata`] `parseJsonRecord(row.metadata) ?? {}` silently discards existing metadata on a corrupt/non-object JSON parse. Documented as deliberate: the column is written only by this class (always valid object JSON), so the fallback path is unreachable from a row this store produced, not a real data-loss risk.
- [`packages/agent-server/src/routes/conversations.ts`, `redactContext`] The shallow copy leaves nested object/array values under non-redacted keys shared by reference with what the hook received. Left as-is (the context contract is scalar identifiers at the top level, per Decision 3) and documented explicitly rather than silently relied upon.

**Reviewed by:** reviewer agent (paired lens=quality) · 2026-07-15
