---
title: "ADR 0004 — `instantiate(context)` becomes the execution seam: per-conversation delivered instances, redaction, run-metadata stamping"
description: "Promotes instantiate(context) from preview-only to the per-conversation delivered-instance factory, with redaction rules and run-metadata stamping."
sidebar:
  label: "ADR 0004 — instantiate() Execution Seam"
---

- **Status:** Accepted (2026-07-15) — PR-1 (runtime + server) of the
  [#268](https://github.com/pattern-stack/agentic-patterns-ts/issues/268) stack.
  PR-2 (dashboard surfaces) and PR-3 (CLI parity) land separately.
- **Date:** 2026-07-15
- **Context owner:** Doug
- **Scope:** `@pattern-stack/agentic-runtime` (`RunStore.updateRunMetadata`,
  `as-agent.ts` doc comment) + `@pattern-stack/agentic-server`
  (`AgentRegistration.instantiate`/`contextRedactKeys`, `POST /conversations`,
  `POST /conversations/:id/messages`, `GET /agents`). Core is untouched.

## Context

The playground had two disconnected notions of "context":

1. **Composition preview** — `AgentRegistration.instantiate?(context)`,
   exercised only by `POST /agents/:id/composition/delivered`. Documented as
   "introspection-only … stays opt-in and can reject." Nothing about it
   affected an actual chat.
2. **Execution scope** — for promoted pipelines, `deps` bound once at
   `asAgent()` time; for plain agents, whatever closures the registration's
   author happened to build with. `POST /conversations` always bound the
   registration's **declared** instance (`reg.agent`) and derived the tool
   executor from it — a chat could never reflect a caller-supplied scope, and
   two tenants sharing one registration shared one pinned scope.

The result: a caller could preview "what would this agent look like for
tenant B" but could never actually **talk** to that version — the chat header
had no way to show, and no way to change, who a run executes as (issue #268's
framing).

## Decision

**`instantiate(context)` is promoted from introspection-only to the single
delivered-instance factory, called at both composition-preview time and
conversation-creation time.** The five design calls, in order:

1. **One hook, no sibling `resolveDeps`.** The delivered agent the hook
   returns **is** the scope carrier — a plain agent's rebuilt closures, or a
   promoted pipeline's `asAgent(node, { deps })`. `NodeBackedRunner.run`
   already reads `agent.deps` off whatever promoted instance it's handed, so
   deps-carrying pipelines cost zero runner changes. Rejected: a sibling
   `resolveDeps(context): DepReader` (reopens the exact two-notion split
   #268 diagnoses; means nothing to a plain, closure-scoped agent) and
   widening the return to `{ agent, deps }` (breaks every existing hook,
   still needs a `deps` carrier into the runner).
2. **Per-conversation granularity; context is fixed at creation.** Changing
   scope means a new conversation — the existing "New Chat" affordance. A
   mid-conversation switch would make `messageHistory` a cross-scope
   transcript (tenant A's tool results replayed into a prompt executing as
   tenant B) — scope bleed inside the model input, invisible to any gate.
3. **Redaction is an escape hatch, not the design.** The primary safety
   property is a documented contract: context carries *identifiers* (org id,
   workspace id), never credentials — secrets stay inside the registration
   closure, resolved server-side by the hook. `contextRedactKeys?: readonly
   string[]` lets a registration additionally blank specific top-level values
   (`"[redacted]"` + a `context_redacted: [...keys]` marker — the
   innate-scratchpad-read posture: structure survives, value dropped, never
   silent) before any write or non-input return — the create response, the
   held `ConversationEntry.context`, and the stamped run metadata all apply
   the same redaction, so `/admin/runs` can never leak more than the row
   holds.
4. **Orthogonal to #252's registration `runner` field.** `instantiate` changes
   the agent, never the runner; a future `runner` field changes the runner,
   never the agent. They meet once, at conversation creation
   (`new Conversation(<declared-or-delivered agent>, reg.runner, …)`).
5. **The hook is the trust boundary — no new auth layer.** The
   impersonation-shaped capability already existed (`POST
   /agents/:id/composition/delivered` runs `reg.instantiate(context)` with
   caller-supplied context today); #268 extends it from preview to execution,
   not a new class of caller power. A hook-less registration receiving
   `context` is a **400** (silently ignoring it would fake scope-switching —
   the worst outcome for a visibility feature). A rejecting hook is a
   **502**, and conversation creation **never** falls back to the declared
   instance — its scope would be silently wrong.

### Consequence worth stating plainly

**Existing hook-bearing registrations change behavior.** Once a registration
declares `instantiate`, conversation creation now *always* runs it (explicit
context, else `instantiateDefaults`, else `undefined`) and binds the
delivered instance — chats no longer run the declared instance verbatim, and
a rejecting hook now fails conversation creation instead of falling back.
This is intentional (the declared instance's pinned scope is the bug being
fixed), but it is a real behavior change for any external consumer who
adopted the lens-only `instantiate` hook. In-repo presets/examples carry no
`instantiate` hooks, so blast radius here is zero; hook-less registrations are
byte-identical (verified: same create-response shape, same executor
derivation).

### Where run metadata gets stamped (delta from the issue's framing)

`RunStoreExporter.metadataFor` (the existing per-run metadata seam) is a
function of the `message.start` **event** only, and the exporter is
constructed CLI-side — the conversation's context is server-side route state
the event never carries. Rather than growing the event vocabulary (and the
SSE wire) to thread context through, `POST /conversations/:id/messages`
stamps it directly via a new narrow `RunStore.updateRunMetadata(runId, patch)`
(shallow JSON merge, `UPDATE runs SET metadata = ?`), called from a `finally`
wrapping the SSE drain loop — **for both a successful turn and an errored or
disconnected one**. It is not merely a post-success step: when a turn errors
mid-run, `Conversation.stream` yields `agent.conversation.end` and then
RE-THROWS, so a stamp placed only after the drain loop (inside `try`) would
never run for exactly the runs an operator most needs to inspect — same for a
client disconnect (`stream.writeSSE` rejecting mid-loop). By the time
`finally` runs, `RunStoreExporter` (subscribed on the same event bus) has
necessarily already opened, and — for a clean or errored finish — finalized
the row; `updateRunMetadata` is status-independent (it stamps a still-running
row identically to a finalized one), so the stamp can never race row creation
and always lands, whatever the turn's outcome. Best-effort: a store failure is
logged, never allowed to shadow the stream/generator's own outcome.

### Rejected alternatives

- **Per-message context override / conversation forking with new scope** —
  explicit non-goal; nothing in the route shape precludes adding it later.
- **`RunOptions.deps` (per-run deps threading)** — the #97-mirror deferral
  stands at that layer; #268 un-defers the *capability* one level up
  (per-conversation delivered instances) instead of opening a second
  parallel scope channel.
- **Redact-everything-by-default** — rejected: destroys the feature's point
  (the chip needs the identifying fields visible by default).
- **Auth/kill-switch config in v1** — no auth exists on `/admin/*` or
  `composition/delivered` today; embedders mounting the server outside dev
  are expected to put authn in front of the whole mount. A `ServerConfig`
  opt-out is a named follow-up if a consumer materializes.

## Consequences

- **Breaking (behavioral, not type-level) for hook-bearing registrations** —
  see "Consequence worth stating plainly" above. Hook-less registrations are
  unaffected byte-for-byte.
- `AgentRegistration.instantiate`'s doc comment is rewritten
  (`agent-server/src/config.ts`) to state the dual call sites and the
  "runnable by this registration's runner" contract explicitly.
- `POST /conversations` gains an optional `context` body field and echoes the
  redacted effective context (`context` + optional `context_redacted`) on the
  `201` response; `400` for a non-object/`null` context or context sent to a
  hook-less registration; `502` (`instantiate failed: <message>`) for a
  rejecting hook, with no conversation entry created.
- `GET /agents` summaries gain `instantiation: { available, defaults }` (same
  sub-shape as the composition/delivered payload) so a future playground can
  seed its context editor without an extra round trip.
- `docs/openapi.ts`'s route catalog (`docs/catalog.ts`) documents the new
  request/response fields; `x-drift` stays clean.
- Follow-ups (PR-2/PR-3, tracked on #268): the dashboard scope chip + context
  editor + run-inspector context block; `ap run --context`/`AP_CONTEXT` CLI
  parity via the same `instantiate` seam.
