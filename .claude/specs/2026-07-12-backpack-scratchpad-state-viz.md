# Backpack & Scratchpad state visualization in the playground chat — concept exploration

**Status:** ideation complete, concept mockup approved-pending-review — no product code changed.
**Mockup:** [`2026-07-12-backpack-scratchpad-state-viz.mockup.html`](./2026-07-12-backpack-scratchpad-state-viz.mockup.html) (open in a browser; interactive).
**Process:** 12-agent ideation run — 5 codebase readers → 4 independent concept designers → 3 judge lenses (debugging, first-contact, implementation). Delta Frames won all three votes.

## Goal

The playground chat flow should clearly represent, across runs:

1. what gets added/removed to Backpacks,
2. how backpack content gets **expanded** — backpacks ship functions (`expand()`) that transform datasets as they are added — showing the transformation itself,
3. how agents write to and read from the scratchpad, **including implicit/innate under-the-hood reads/writes**, displayed as steps even though the agent doesn't explicitly take them.

Multi-agent sessions matter: backpacks travel across agents.

## What the research established (load-bearing facts)

- **Backpack** (`packages/agent-runtime/src/workflows/backpack.ts`) is a run-scoped accumulator riding the existing Slot/Scratchpad plumbing (`backpackSlot(spec)` → `Slot<Backpack>` keyed `backpack.<key>`). Hooks are pure & synchronous: `expand()` (on-write coercion, `null` = skip recorded in manifest, throw = fail-loud), `identify()` (dedup identity), `merge()` (collision reducer, winner keeps first-seen index), `finalize()` (on-read cross-entry pass, memoised per write generation), `renderEntry()`. `drop()` is atomic (staging → commit); async I/O only via `hydrateThenDrop`. Canonical `[#N]` indexes are 1-based, append-only, never renumbered — a shown handle never dangles. `DropReceipt` / `DropRecord` / `WriteManifest` (with `tagsFor(id)`) already mint every number the UI needs.
- **Backpack emits zero events by construction** — a test structurally asserts the module contains no emit/publish. Instrumentation must live in the accessor layer (`requireBackpack`/`openBackpack` proxies) and a decorated Scratchpad, never in `backpack.ts`.
- **Scratchpad** writes split into explicit (FunctionStep `fn`, `onEmit`, tool-mediated) and **innate** (sequentialAgent's per-stage `agents.<name>` emission, FanOut fork/join). Reads reach the model via prompt injection (`renderPriorEmission` etc.) — "what did the model actually see" is currently unrecoverable. Branch slots without a merge reducer are **silently discarded** at join — a classic debugging trap worth surfacing.
- **Chat UI** (`packages/agent-dashboard/src/chat/`): one `Part` discriminated union (5 kinds), one reducer `applyParts(parts, event)`, one dispatcher `PartView`. The documented extension recipe: new Part variant + `applyParts` case + `PartView` case + `storedPartsToParts` case. Card grammar: `<details>` cards, 3px left-border status color, mono names, collapsed by default, auto-open on error; `.chat-step` doubles the border for delegation; dashed border = thinking ("the framework, not the agent").
- **Eventing gap**: `step.start/end` are declared, SSE-mapped, and rendered — but have **zero production emitters**. The SSE transport deliberately has no name allowlist, so new events flow to the client for free; `applyParts` ignores unknown types (they still reach `traceEvents`).

## Concepts explored & verdicts

| Concept | Angle | Debug | First-contact | Impl | Mean /50 |
|---|---|---|---|---|---|
| **Delta Frames** ✅ | per-step state diffs, inline | 42 | 41 | 43 | **42.0** |
| Ledgerline | transcript as a git log of state | 37 | 34 | 39 | 36.7 |
| Carry | live inventory rail | 34 | 35 | 38 | 35.7 |
| Provenance Loom | items as threads across agents | 29 | 31 | 34 | 31.3 |

## The winning design — Delta Frames (with grafts)

A sixth `Part` kind, **`state_delta`**, rendered as collapsed diff cards in the existing tool-card grammar, violet family, placed immediately beneath the causal tool call (or standalone at boundaries). Frame family:

- **DROP** `Δ backpack.sources +3 ~1 ø1 · 9 → 12` — expands to a per-raw diff table (`+` added / `~` merged / `ø` skipped rows keyed by `[#N]` handles); each `+` row expands to the **expansion pane**: `raw (TIn)` → `expand()` / `identify()` → `entry [#N] (TEntry)` before/after. `expand()` throw → auto-open error frame with the runtime's verbatim message.
- **READ** `◇ finalized() · memo miss (gen 2) · 6 entries → ranked list` — memo hits render as 24px one-line strips. Prompt-injection reads expand to the **exact injected prompt text**.
- **WRITE** `Δ curation.shortlist · set · ↳ onEmit(curate)` — before/after CodeBlocks.
- **TRAVEL** `⇄ backpack.sources travels → curate · 6 items [#1..#6]` — manifest strip segmented per DropRecord (width ∝ covered, colored by origin agent). Honest when nothing changed ("no new drops since gather").
- **ABSORB** `⇄ absorb branch 2/3 · +2 ~1 · appended [#13..#14]` — FanOut determinism visible; join's silent-discard case explicitly called out.
- **INNATE** variants (dashed border + `INNATE` chip) for stage emissions, fork/join, prompt reads — the framework's moves displayed as steps.

Grafts adopted from runner-ups:

1. **State rail** (from Carry): third rail tab (Universe | Trace | **State**) — cumulative inventory built as a pure `foldInventory(events[0..cursor])` (mirrors `computeFrame`), scrub-aware, with a manifest reconciliation line (`2 records · 6 covered · 1 skipped ✓ matches`).
2. **Linkified `[#N]` chips** (Ledgerline): handles in assistant prose become live chips — hover shows `renderEntry` + `tagsFor(id)` provenance, click seeks the minting frame.
3. **Lineage lighting** (Loom): clicking a handle highlights every frame that touched that identity.
4. **Coalescing rule** (Ledgerline): 3+ consecutive frames from one write site collapse to one `▸ N state ops` summary — load-bearing for Loop / parallel-drop runs.
5. **Density toggle**: header segmented control `state: All | Writes | Off`, default **Writes**.
6. **Honest degradation** (Carry/Loom): "unattributed" when span joins fail, `derived` chip on UI-synthesized travel frames, byte-capped previews with "(preview only)" notes.
7. **Gate-absence taught line**: rejected tool cards gain "backpack: no writes (gate blocked before execution)".
8. **Single write ordinal** (Ledgerline): one monotonic per-run `w#` stream across backpack + scratchpad, minted at the emission layer.

## Eventing plan

New `AgentEvent` variants (compiler forces `toSSEMapping` branches): `backpack.drop`, `backpack.read`, `backpack.absorb`, `scratchpad.write`, `scratchpad.read`, `scratchpad.fork/join` — each carrying `origin: innate|explicit`, receipt counts, byte-capped previews, `tool_call_id`/span ids for nesting. `backpack.travel` is **UI-derived in v1** (drop events + step boundaries; no new emitter). Prerequisite: actually wire `agent.step.start/end` emission in sequentialAgent (declared today, zero production emitters).

**Emission strategy honoring the no-emit invariant:** (a) `ObservedScratchpad` decorator installed by composites when `ctx.eventBus` is present; (b) `requireBackpack`/`openBackpack` return an instrumented proxy that forwards `drop()`/`absorb()` then publishes; (c) `backpack.ts` and its structural no-emit test stay untouched.

**UI path:** `state_delta` Part variant → `applyParts` case → `StateDeltaPart` in `PartView` → `storedPartsToParts` case (replay). State rail as a pure fold sharing an accessor module with `applyParts`, pinned against a captured event fixture (à la `trace-from-events.test.ts`).

## Known risks

- Timeline noise on chatty runs — the density default, coalescing, one-frame-per-`drop()`, and memo-hit strips are load-bearing, not optional.
- Preview payloads must be truncated server-side or SSE frames / persisted rows bloat.
- Drop-frame nesting depends on threading `tool_call_id` through the accessor emitter; FunctionStep writes need the standalone `fn()` path handled explicitly.
- Persisted replay currently only stores `user_prompt`/`text` parts — `state_delta` needs stored-part forward-compat or replay degrades to text blobs.
- Trace tab and timeline will double-render state events without deliberate curation in `eventsToSteps`.
- Captured injected-prompt text may contain sensitive content — needs the same redaction posture as thinking's "reasoned privately".
