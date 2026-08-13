---
title: "ADR 0011 — One conversation identity, and resume by re-supplied scope"
description: "A conversation's live id and its durable row id become one value, and a conversation the server no longer holds is rehydrated from the store; scope is never persisted, so a scoped conversation requires its scope re-sent on the resuming turn."
sidebar:
  label: "ADR 0011 — Conversation Identity"
---

- **Status:** ACCEPTED — implemented in the PR that lands this file.
- **Date:** 2026-08-13
- **Context owner:** Doug
- **Issue:** [#480](https://github.com/pattern-stack/agentic-patterns-ts/issues/480)
- **Scope:**
  - `packages/agent-runtime/src/conversation/store.ts` — `ConversationStore.createConversation` gains a third `CreateConversationOptions` argument (`id`, `metadata`).
  - `packages/agent-runtime/src/storage/conversation-store.ts` — `SQLiteConversationStore` honors both.
  - `packages/agent-runtime/src/conversation/conversation.ts` — persists under `this.id`, adopting a pre-created row; new `persistedId` getter.
  - `packages/agent-runtime/src/conversation/rehydrate.ts` — **new**, `exchangesFromMessages`.
  - `packages/agent-server/src/routes/conversations.ts` — eager row creation with a binding stamp; `bindRegistration` extracted; `resumeConversation` added.
  - **No schema migration.** The `metadata` column already exists (v5); `TARGET_SCHEMA_VERSION` is unchanged.

## Context

Conversations had two id spaces and reconciled neither.

`Conversation.id` was minted in the constructor and keyed the server's in-memory map — the id `POST /conversations` returned, and the only id `POST /:id/messages` accepted. `StoredConversation.id` was minted independently inside `createConversation`, lazily at the first persisted exchange — the id `GET /conversations` listed and `GET /:id/messages` read. `Conversation` never told the store its id and never exposed the one it got back, so the two values could never be equal.

Four things followed, all reproduced against the routes:

1. `POST /conversations/{durable}/messages` → 404. Nothing in the list could be replied to.
2. `GET /conversations/{route}/messages` → `[]`, not 404 — the failure looked like an empty thread.
3. The route id died with the process, so no conversation survived a restart.
4. Creation returned the id that could write but not read; the list returned the id that could read but not write.

The reported symptom also included conversations "fragmenting" into one row per turn. That mechanism was misdiagnosed: `_persistExchange` memoizes correctly and two turns do land in one row. The 58-of-66 single-turn rows in a real playground database were a *consequence* of continuation being impossible — every exposure started a fresh thread — not a separate defect. The store's write path was sound; identity and an inverse were what was missing.

## Decision

**D1 — One id.** `createConversation` accepts the id to store under, and `Conversation` supplies its own. The id a caller holds is the id the store answers to, across create, list, read, reply and cancel.

**D2 — Adopt, then create.** `Conversation` looks the row up before creating it, so an eagerly-created row (the server), an existing row (a resume) and no row at all (a bare library caller) all converge without duplicating.

**D3 — Create the row eagerly.** The server writes the row at `POST /conversations` rather than at first persist, so a created-but-unmessaged conversation still lists and can still be resumed.

**D4 — Rehydrate on miss.** An in-memory miss falls through to the store: the row is loaded, the registration re-bound, the messages zipped back into `Exchange`es, and the conversation continues. A live conversation always wins, so this never re-binds a resident one.

**D5 — Scope is never persisted; the caller re-supplies it.** A scope can carry credentials — it is redacted before it is ever echoed — so writing it to the SQLite file to make resume seamless would put secrets at rest in exactly the place the redaction path exists to keep them out of. The row records only *whether* a scope was supplied at creation; the value comes back on the resuming request and is parsed and re-bound exactly as at creation. Omitting it is a 400, never a silent re-bind against defaults: a differently-scoped agent answering under the same conversation id is an authorization bug, not a convenience gap.

**D6 — Degrade loudly, never silently.** A third-party store that ignores the supplied id still persists coherently under whatever it returned, but warns that the conversation is not resumable. Silence is how this class of bug stayed invisible for as long as it did.

**D7 — Drop an unpaired trailing request when rebuilding.** A turn whose request landed but whose response never did is not replayable: feeding it back would send two consecutive user turns to the provider, which several reject outright. Exchange numbers are re-derived densely so the drop leaves no hole.

## Consequences

- The `ConversationStore` protocol changed. The new argument is optional, so existing implementations still compile; one that ignores it produces the pre-#480 split id and now says so.
- Conversations written before this ADR carry no binding stamp. They remain listable and readable, and return `409` with an explicit reason on a resume attempt — honest rather than a misleading 404.
- Scope-bearing conversations are resumable only by a caller that still holds the scope. That is the intended trade: the alternative is secrets at rest.
- `host.recall` is re-derived rather than restored. A resumed conversation re-arms the turn-1 recall latch, so memory is re-queried against the resuming message instead of replaying a stale block (ADR-0007's D8a ordering is preserved *within* each process).
- `updateConversation` remains without a production caller, but the `metadata` column it writes is now load-bearing for resume.

## Alternatives rejected

- **Persist the parsed scope in `metadata`.** Seamless resume with no client involvement, at the cost of credentials at rest in `events.db`. Rejected on D5's reasoning.
- **Persist only the redacted scope.** No secrets at rest, but redacted fields return missing, so the resumed agent behaves subtly differently from the original under the same id. Rejected as the worst of both.
- **Resume only scope-less conversations.** Safe and simple, but the ambient demos are exactly the scoped ones, so it would leave the reported case unfixed.
- **Route the durable id into the map without rehydrating.** Fixes the 404 within one process and nothing across a restart — half of #480.
