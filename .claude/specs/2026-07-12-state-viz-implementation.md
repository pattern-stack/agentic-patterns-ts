---
title: "State-viz implementation — Delta Frames timeline + Scratchpad rail"
stack: playground-state-viz
phase: spec
date: 2026-07-12
issue: 226
branch: claude/prime-66nzhc
design: .claude/specs/2026-07-12-backpack-scratchpad-state-viz.md   # the approved design contract
mockup: .claude/specs/2026-07-12-backpack-scratchpad-state-viz.mockup.html  # exact copy/visual spec — open in a browser
provenance: >
  Produced by an 11-agent planning workflow (4 seam-verification readers at
  file:line precision, 4 work-item planners, 3 adversarial critics — the
  scope/shippability critic hit a session limit; its cut-line questions are
  carried as Open Questions rather than decisions). Seam references below were
  verified against commit 3329c4c.
---

# Spec — implement Delta Frames + the Scratchpad rail

## Goal

Make Backpack and Scratchpad activity visible in the playground chat: every
drop/read/write/travel renders as a `state_delta` part inline in the timeline,
and a third rail tab ("Scratchpad · what this run carries between stages")
shows the cumulative inventory as a pure fold over the event stream. The
design spec + mockup in this directory are the contract; this spec is the
build plan.

## Verified seam corrections (trust these over the design spec)

The seam-verification pass found four places where the design's assumptions
were incomplete. These are load-bearing:

1. **Two allowlists, not zero.** The SSE transport itself needs no changes
   (`agent-server/src/sse.ts:40-44` delegates to `toSSEMapping`), but new
   events die silently unless added to BOTH:
   - `RELAYED_STREAM_EVENTS` (`agent-runtime/src/workflows/as-agent.ts:378-389`)
     — gates what `NodeBackedRunner.stream` relays to the conversation SSE.
     This is the playground path.
   - `PROFILE_EVENT_TYPES` (`agent-runtime/src/events/event-profiles.ts:28-96`)
     — gates every profile-attached exporter. Note `agent.step.start/end` are
     in NO profile today.
2. **`NodeRunContext` has no `runId`** (`workflows/node.ts:29-70`), but
   `BaseEvent` requires one (`events/types.ts:30-37`). Add optional
   `NodeRunContext.runId`, set it in `NodeBackedRunner` (`as-agent.ts:231`
   mints it; ctx built at `:188-200`).
3. **`requireBackpack`/`openBackpack` live INSIDE `backpack.ts`**
   (`:567-596`), which is untouchable (structural no-emit test at
   `workflows/__tests__/backpack.test.ts:344-353` regex-bans
   createEvent/.publish/emit(/AgentEventBus). Instrumented accessors must be a
   NEW module (`workflows/observed-backpack.ts`) swapped in the barrel
   (`workflows/index.ts:160-161` — verified: no external consumers import the
   raw accessors directly).
4. **`ObservedScratchpad` must extend `DefaultScratchpad`** — `join()` guards
   `instanceof DefaultScratchpad` (`workflows/slot.ts:133`); a plain wrapper
   silently no-ops FanOut merges.

Also verified: tool correlation rides `ToolExecutionContext.parentToolCallId`
(== tool span id, `runner/agent-runner.ts:197-206`); the only tool-side
publish channel today coerces everything to `agent.tool.progress`
(`agent-runner.ts:227-247`) and must be extended or bypassed via a publisher
on `host` (`workflows/agent-step.ts:119`). Byte-capping must happen at event
construction — formatter and every exporter pass payloads through verbatim.

## Plan

### WI-1 — Runtime eventing (`@agentic-patterns/runtime`)

Ships alone: events exist on the bus; nothing consumes them yet.

1. **Event variants** — `events/types.ts:244-265`: add
   `BackpackDropEvent`, `BackpackReadEvent`, `BackpackAbsorbEvent`,
   `ScratchpadWriteEvent`, `ScratchpadReadEvent`, `ScratchpadForkEvent`,
   `ScratchpadJoinEvent` following the `agent.<domain>.<verb>` / camelCase
   convention. Shared fields: `origin: "innate" | "explicit"`, `ordinal`
   (monotonic per-run write ordinal minted at the emission layer),
   `toolCallId?`. Drop events carry receipt counts
   (accepted/merged/skipped/indexes), sizeBefore/After, per-row previews
   (byte-capped at construction, with an explicit truncation marker — never
   silently clipped). `createEvent` (:300-312) generalizes automatically.
2. **ObservedScratchpad** — new `workflows/observed-scratchpad.ts`:
   `class ObservedScratchpad extends DefaultScratchpad` (see correction 4),
   publishing `scratchpad.write/read/fork/join`. Install at
   `as-agent.ts:193` (`scratchpad: createScratchpad()` → wrap when the bus at
   `:199` is present). Default origin `"explicit"`; the innate tag comes from
   the call site (next step).
3. **Innate tagging + step events in sequentialAgent** —
   `workflows/sequential-agents.ts`: publish `agent.step.start` immediately
   before `node.run` at `:291` and `agent.step.end` in a `finally` spanning
   `:291-334` (covers failure return, stop short-circuit, onEmit throw). Tag
   the per-stage emission write at `:305` as `origin: "innate"`. Skip all
   emission when `ctx.eventBus` is absent (today's silent behavior).
4. **Instrumented backpack accessors** — new `workflows/observed-backpack.ts`
   exporting `requireBackpack`/`openBackpack` proxies that forward
   `drop()`/`absorb()` to the real pack then publish `backpack.drop/absorb`
   (receipt → payload); `finalized()` reads publish `backpack.read` with
   memo hit/miss. Swap the barrel export at `workflows/index.ts:160-161`.
   `backpack.ts` stays byte-untouched.
5. **runId threading** — `workflows/node.ts`: add optional `runId`; set in
   `NodeBackedRunner` (`as-agent.ts:188-200`, minted at `:231`).

Tests: extend `workflows/__tests__/backpack-topology.test.ts` with an
event-capture bus asserting drop/absorb/read emission across Retry/Loop/
FanOut; a `sequential-agents` test asserting step.start/end pairing and the
innate tag; the untouched no-emit structural test keeps passing.

### WI-2 — Wire + persistence (`@agentic-patterns/runtime` + `@agentic-patterns/server`)

Ships alone: events reach the wire and persist; no UI yet. Depends on WI-1.

1. **SSE mapping** — `transport/sse-formatter.ts`: add 7 wire names to
   `SSEEventName` (:21-44; convention drops the `agent.` prefix →
   `backpack.drop`, `scratchpad.write`, …), branches in the `toSSEMapping`
   switch (:66-242, compiler-forced by the `never` default at :234-240;
   payload keys snake_case per the `step.start` branch at :210-220), and
   entries in `SSE_EVENT_NAMES` (:255-277, Record-complete). Bump the count
   pin in `__tests__/transport/sse-formatter.test.ts:53-55` from 21 → 28.
2. **Allowlists** — add all 7 (plus verify `agent.step.start/end`) to
   `RELAYED_STREAM_EVENTS` (`as-agent.ts:378-389`) and to the UX profile in
   `event-profiles.ts:28-96`; add the compiler-forced cases in
   `admin/collector.ts:320-378` (record-only list at :356-370).
3. **Server transport** — verified zero changes:
   `agent-server/src/sse.ts:40-44` and `routes/conversations.ts:200-201`
   forward whatever `toSSEMapping` produces. State this in the PR.
4. **Persistence** — `conversation/conversation.ts:344-370` persists only
   `user_prompt` + `text` parts today (design claim verified). Add a
   `state_delta` canonical part written alongside, carrying the wire payload,
   so session replay can rebuild frames. Redaction: injected-prompt preview
   text follows the same posture as thinking content.

Tests: sse-formatter per-event format assertions; a conversation round-trip
test asserting `state_delta` parts persist and degrade to labeled text on old
readers (the `stored-parts.ts:106` default-case contract).

### WI-3 — Timeline UI (`@agentic-patterns/dashboard`)

Ships alone against WI-1+2; without events it renders nothing (graceful).

1. **Model** — `chat/model.ts`: add `state_delta` Part variant
   (op: drop/read/write/travel/absorb; origin; receipt; rows; previews) and
   `applyParts` cases — nest under the causing tool via `childTarget`
   (:117-124) keyed on `tool_call_id`, standalone at boundaries; derive
   TRAVEL frames client-side from drop events + `step.start` boundaries (v1,
   per design).
2. **Components** — `chat/parts.tsx` (dispatcher switch at :195-203): add
   `StateDeltaPart` family per the mockup — DROP diff table + expansion pane,
   READ/memo one-line strips, WRITE before/after, TRAVEL manifest strip,
   ABSORB, innate dashed + `auto` chip, error auto-open. Extend `chat.css`
   with the `.chat-delta` grammar (violet family) — copy verbatim from the
   mockup, which already uses the real tokens.
3. **Wire types** — `api/sse-events.ts:11-84`: add the 7 ClientEvent entries
   (documentation-only; transport has no allowlist).
4. **Density + coalescing** — `pages/ChatPage.tsx` header (Segmented already
   imported at :49): `scratchpad: All | Writes | Off`, default Writes;
   coalesce 3+ consecutive same-site frames into one expandable summary row.
5. **Replay** — `chat/stored-parts.ts`: `state_delta` case (:90 area);
   unknown-type default (:106) already degrades safely.
6. **Trace curation** — `graph/trace-from-events.ts` `eventsToSteps` (:157):
   ignore or specially style state events so Trace tab and timeline don't
   double-render one mutation.
7. **[#N] chips** — linkify canonical handles in assistant markdown; hover
   shows renderEntry + provenance; click seeks the minting frame.

Tests: `chat/model.test.ts` cases for each applyParts fold (incl. nesting +
coalescing); a component test per frame type; `trace-from-events.test.ts`
addition pinning the curation.

### WI-4 — Scratchpad rail (`@agentic-patterns/dashboard`)

Ships alone against WI-1+2; with no events it shows the teaching empty state.

1. **Fold** — new `chat/fold-inventory.ts`: pure
   `foldInventory(events[0..cursor])` sharing one event-accessor module with
   `applyParts` (both consume the same snake_case/camelCase tolerant
   helpers), pinned against a captured event fixture in the style of
   `__tests__/trace-from-events.test.ts`.
2. **Rail component** — new `chat/ScratchpadRail.tsx` implementing the mockup
   exactly: header "Scratchpad · what this run carries between stages";
   three-writer captions (EVIDENCE ↳ added by tools / STAGE OUTPUTS ↳ saved
   by the framework / KEPT VALUES ↳ written by agent code); hero rows with
   focal numerals + collapsed ledgers; stage chain + "2/3 saved"; quiet slot
   rows; receipt-language health footer with the mismatch state as the only
   loud element; teaching empty state.
3. **Third tab** — `pages/ChatPage.tsx` rail Segmented: Universe | Trace |
   Scratchpad.
4. **Interactions** — bidirectional seeks (row → producing frame within the
   chat scroll container, never the page; frame `.d-key` → rail row);
   evidence provenance popover (500ms hover) + click-pinned detail card with
   jump-to-write (density-reveal fallback — never seek to nothing) and
   light-lineage; peek line over collapsed ledgers; recency tick.
5. **Motion** — the RailDelta contract: choreography is a pure function of
   `diff(fold(0..cursor-1), fold(0..cursor))`; cursor+1 animates one-shot,
   any jump settles instantly; reduced-motion renders the fold-derived static
   tick.

Tests: fold fixture test (shared-accessor drift pin); rail state tests
(empty/streaming/scrubbed/mismatch); seek/popover interaction tests.

## Sequencing

WI-1 → WI-2 → (WI-3 ∥ WI-4). Each lands independently with the graceful
degradation named above. WI-3 and WI-4 share the event-accessor module —
whichever lands first creates it.

## Acceptance criteria

- [ ] Running the playground pipeline demo shows drop/read/write frames inline
      and a live Scratchpad rail whose counts reconcile with the manifest
      (`✓ matches all write receipts`).
- [ ] `backpack.ts` is byte-identical; its structural no-emit test passes.
- [ ] A run with no event bus behaves exactly as today (zero emission).
- [ ] Session replay rebuilds state frames from persisted `state_delta` parts;
      old sessions degrade to labeled text, never crash.
- [ ] FanOut joins still merge (ObservedScratchpad passes the
      `instanceof` guard at `slot.ts:133`) — covered by a topology test.
- [ ] Frame counts in tool receipts, Δ frame headers, and the rail footer
      always agree on the demo run.
- [ ] `bun run check` passes.

## Open questions

- **v1 cut-line** (the scope critic didn't complete): are `absorb`/`fork`/
  `join` events and the write ordinal v1, or defer with the UI hiding those
  frame types? Leanest defensible v1: drop/read/write + step events + rail;
  absorb/fork/join behind a follow-on.
- Per-BackpackSpec rail caption override ("EVIDENCE" vs generic "GATHERED") —
  API addition, needs owner sign-off.
- Byte-cap thresholds for previews (suggest 512B/row, 2KB/frame to start).
