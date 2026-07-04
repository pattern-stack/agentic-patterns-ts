---
title: "Capture-as-eval-case UI — the deferred E5d follow-on (CaptureCasePanel)"
stack: eval-surface
phase: spec
date: 2026-07-04
issue: "140 (follow-on)"
branch: claude/frontend-eval-merge-summary-8xnj9w
related:
  - .ai-docs/stacks/eval-surface/specs/140.md   # E5d — shipped the capability, deferred THIS button; "Follow-on" note + Decision 1
  - packages/agent-dashboard/src/lib/evalApi.ts  # captureFromSession + fetchEvalSets (SHIPPED — consume, do not touch)
  - packages/agent-server/src/routes/eval.ts     # POST /eval/cases/from-session handler (SHIPPED — the contract below)
---

# Spec — CaptureCasePanel: capture a live chat exchange as an eval case

## Goal

Mount a **"Capture as eval case"** affordance on the live Chat page
(`ChatPage.tsx`, current `src/chat/` layout) that turns the current
conversation into a `StoredEvalCase` via the already-shipped
`evalApi.captureFromSession`. Dashboard-only: **no server, runtime, or client-lib
changes** — the write route and the client fn already exist. This is purely the
missing UI.

## Scope fences

- **IN:** one new component `src/chat/CaptureCasePanel.tsx`, its mount in
  `ChatPage.tsx`, and a vitest+testing-library suite.
- **OUT:** any edit to `evalApi.ts`, `routes/eval.ts`, `useChat.ts`, `model.ts`,
  `ChatPanel.tsx`. Do NOT target the stale `dug/dashboard-history-hydration`
  hooks/organisms layout. No `ConversationDetailPage` (Decision 1 — dormant).

## The shipped contract (verified against source — do not re-derive)

`evalApi.captureFromSession(body, {baseUrl?}) -> EvalFetch<CaptureFromSessionResponse>`
(also **throws** on 400/404 with the server `error` [+ `hint`] already folded in):

```
CaptureFromSessionRequest {
  conversationId: string          // REQUIRED — chat.conversationId
  setId: string                   // REQUIRED — existing set id OR new slug (with createSet)
  exchange?: number               // 1-based; SERVER DEFAULT = history[0] (FIRST, not latest)
  expected?: string               // omitted => server seeds from the real assistant answer
  split?: "train"|"dev"|"test"    // default "train"
  tags?: string[]                 // default ["captured","agent:<id>"]
  caseId?: string                 // default derived => idempotent re-capture
  createSet?: { name?; description? }  // required when setId is not an existing set
}
CaptureFromSessionResponse { setId; caseId; created; input; expected; tags; split }
```

Degraded states (mirror the `EvalRunsPage`/`EvalRunDetailPage` grammar):
- `{kind:"unconfigured"}` (503) → "Eval persistence isn't configured on this server."
- thrown Error (400/404, hint already appended) → render `err.message` inline.
- `data.created === true` → "Created new case" ; `false` → "Updated existing case"
  (the re-capture idempotence signal).

`evalApi.fetchEvalSets() -> EvalFetch<EvalSetSummary[]>` feeds the set picker.
`EvalSetSummary = { id, name, description, createdTs, caseCount, splitCounts }`.

## Component: `src/chat/CaptureCasePanel.tsx`

### Props
```ts
interface CaptureCasePanelProps {
  conversationId: string | null;   // chat.conversationId (null until first send)
  messages: ChatMessage[];         // chat.messages — to seed `expected` + build exchange options
  exchangeCount: number;           // # of user turns — latest exchange number
  disabled?: boolean;              // e.g. while streaming
  baseUrl?: string;                // test seam; default ""
}
```

### States / behavior (a small state machine)
1. **No conversation yet** (`conversationId == null` OR `exchangeCount == 0`):
   render a muted hint — "Send a message first, then capture it as an eval case." —
   and nothing else. Capture reads the *live server-side* conversation, so there is
   nothing to capture pre-send.
2. **Collapsed** (default once capturable): a single `Button variant="ghost" size="sm"`
   — "Capture as eval case". Click → expand + lazily `fetchEvalSets()`.
3. **Loading sets**: `Spinner`.
4. **Sets unconfigured** (`fetchEvalSets` → `unconfigured`): the 503 degraded line;
   no form.
5. **Form** (sets loaded):
   - **Exchange picker**: `<select>` of `1..exchangeCount`, labelled by a short
     snippet of that user turn (derive from `messages`), **defaulting to the latest**
     (`exchangeCount`). Always send `exchange` explicitly (server default is *first*).
   - **Set picker**: `<select>` of existing sets (label `name ?? id`, show `caseCount`)
     + a final `"➕ Create new set…"` option. Choosing it reveals a **set-id/slug**
     input (→ `setId`) + optional **name** + **description** (→ `createSet`).
   - **Split**: `<select>` train | dev | test, default `train`.
   - **Expected**: `<textarea>` pre-filled with the latest assistant answer text
     derived client-side from `messages` (helper `latestAssistantText`), editable.
     Submit the textarea value as `expected` (matches the server seed when untouched).
   - **Submit**: "Capture" button, disabled while in-flight or when required fields
     (setId for create-new) are empty.
6. **Submitting**: button shows a spinner; inputs disabled.
7. **Result**: success line — `created ? "Created new case <caseId>" : "Updated existing
   case <caseId>"` + the set id + split, `tone` emerald/muted respectively; error line
   (thrown Error message) in red. A "Capture another" reset returns to the form.

### Mapping notes
- `exchange` picker value is the 1-based exchange **number**; the Nth user turn.
  Derive per-exchange snippet from the user-role messages in order.
- `latestAssistantText(messages)`: last `role==="assistant"` message, concatenate its
  `parts` where `kind==="text"`; empty string if none (textarea just starts empty).
- On create-new, `setId` = the slug the user types; `createSet` carries name/description.
- Never send `caseId` — let the server derive it (idempotence is the point).

## Mount in `ChatPage.tsx`
Render `<CaptureCasePanel>` in the Header column (below the badge row) or in the
right rail area — pick the Header, under the existing `description`/error lines, so it
sits with the conversation metadata. Wire:
```
<CaptureCasePanel
  conversationId={chat.conversationId}
  messages={chat.messages}
  exchangeCount={exchangeCount}
  disabled={chat.streaming}
/>
```
No other `ChatPage` logic changes.

## Tests — `src/chat/__tests__/CaptureCasePanel.test.tsx`
vitest + `@testing-library/react`, mirroring `evalApi.test.ts`/page-test idioms
(mock `fetch`; assert request body + rendered states). Cover:
1. Pre-send hint when `conversationId` is null / `exchangeCount === 0` (no button).
2. Expanding fetches sets; renders the set picker with existing sets.
3. `fetchEvalSets` → unconfigured renders the 503 line, no form.
4. Submit against an existing set posts the right body (`conversationId`, `setId`,
   `exchange === exchangeCount`, `split`, `expected`) and shows "Created new case".
5. `created:false` response renders "Updated existing case" (idempotence signal).
6. Create-new-set path reveals slug/name inputs and sends `createSet`.
7. Split picker changes the posted `split`.
8. Expected textarea edit overrides the seeded answer in the posted body.
9. A thrown Error (404 w/ hint) renders the message inline in the error state.
10. Latest exchange is the default selected option; snippets come from user turns.

## Acceptance
- `bun run --filter=@agentic-patterns/dashboard test` green incl. the new suite.
- `bun run typecheck` + `bun run lint` (biome: double quotes, semicolons, 2-space,
  100 col) clean.
- No diff outside `src/chat/CaptureCasePanel.tsx`, `src/chat/__tests__/…`, and the
  `ChatPage.tsx` mount.
