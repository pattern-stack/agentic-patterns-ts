# Backpack & Scratchpad state visualization in the playground chat — concept exploration

**Status:** ideation complete, concept mockup approved-pending-review — no product code changed.
**Mockup:** [`2026-07-12-backpack-scratchpad-state-viz.mockup.html`](./2026-07-12-backpack-scratchpad-state-viz.mockup.html) (open in a browser; interactive).
**Process:** 12-agent ideation run — 5 codebase readers → 4 independent concept designers → 3 judge lenses (debugging, first-contact, implementation). Delta Frames won all three votes.
**Demo scenario:** the CRM retrieval agent (`retrieve → correlate → brief`, built on the `retrievalRole` preset) answering "Where does the Meridian Health deal stand?" — `search_deal_context` drops **observations** about the deal into `backpack.observations`; `hydrateThenDrop` + `list_artifacts` expands them to their **associated artifacts** via `source_refs.artifact_id`; correlate cuts stale/redundant items and emits `brief.highlights`. Deal content is fictional; field shapes match the Deal Brain CRM tools (`observation_id`, `deal_id`, `artifact_id`, artifact types `meeting`/`email`, sources `gong`/`gmail`).

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

- **DROP** `Δ backpack.observations +3 ~1 ø1 · 9 → 12` — expands to a per-raw diff table (`+` added / `~` merged / `ø` skipped rows keyed by `[#N]` handles); each `+` row expands to the **expansion pane**: `raw (TIn)` → `expand()` / `identify()` → `entry [#N] (TEntry)` before/after. `expand()` throw → auto-open error frame with the runtime's verbatim message.
- **READ** `◇ finalized() · memo miss (gen 2) · 6 entries → ranked list` — memo hits render as 24px one-line strips. Prompt-injection reads expand to the **exact injected prompt text**.
- **WRITE** `Δ brief.highlights · set · ↳ onEmit(correlate)` — before/after CodeBlocks.
- **TRAVEL** `⇄ backpack.observations travels → correlate · 6 items [#1..#6]` — manifest strip segmented per DropRecord (width ∝ covered, colored by origin agent). Honest when nothing changed ("no new drops since retrieve").
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

## State rail v2 — the "Carry Gauge" (enhancement pass, 2026-07-12)

Owner feedback on v1: concept approved; timeline clutter acceptable when collapsed; the rail needs design passes. A second 7-agent run (4 redesign lenses — hierarchy, temporality, provenance, live behavior — judged by owner/operator/builder lenses) converged unanimously on the **hierarchy pass ("Carry Gauge")** as spine:

- **Thesis:** the rail answers one question in 3 seconds — *how much does the agent carry, has it moved, is anything wrong* — so every group gets exactly one focal number, every list lives behind disclosure, and healthy states are nearly silent.
- **Structure:** sticky header (`State` + mode slot: live dot / nothing / as-of pill — the pill only when scrub-displaced), scrollable body with whitespace-only group separation, sticky health footer.
- **Per pack — hero row:** chevron (own 24px target, toggles ledger) + mono key + sub-line `2 drops · 2 excluded · 1 skipped` (nonzero segments only) + right-aligned focal count (`--fz-lg` 700 mono, tabular-nums — the loudest element on the rail). Ledger **collapsed by default**; expanded it keeps the `[#N]` row grammar with strike-through cuts, an `N excluded · show` collapse past 12 items, and its own 40vh scroll past 24.
- **Stages as ONE row:** 6px status ticks (filled ok / hollow pending / err failed) + `2/3` fraction; per-stage rows (with the `innate` chip and `→ prompt` suffixes) behind the chevron.
- **Slots:** quiet 22px rows, no chips, mute right-aligned value previews, rendered only after first write.
- **Peek line:** hovering a `[#N]` cite chip while the ledger is collapsed overlays one absolutely-positioned line under the hero row (zero reflow) — preserves cross-highlight over a closed ledger.
- **Recency tick:** a 3px violet left border on the most-recently-written row, fading over 2s — the sole "what just moved" signal; rows never reorder.
- **Health footer:** healthy = `✓ ledger consistent` in `--mute` (manifest numbers on hover); a mismatch is the only loud element the rail is ever allowed (`--err-soft` band, click seeks the divergence). Derived mode adds `derived from N drop events`.

**Grafts:** (Pulse Rail) the **RailDelta contract** — all choreography is a pure function of `diff(fold(0..cursor-1), fold(0..cursor))`; cursor+1 animates one-shot, any jump settles instantly — one machine for live/replay/scrub; verdict-withheld footer while streaming; teaching empty state ("nothing carried yet — writes appear as they land" + ghost rows); failed-drop strip; reduced-motion = static fold-derived tick. (Chain of Custody) 2px minted-by ticks in carrier hue on expanded ledger rows only, `title`-attr detail, "unattributed" never guessed. (Timewrite, invisible only) fold snapshot memoization every 16 write-ordinals; the rail never owns a private cursor.

**Rejected as clutter:** the write-track second scrubber, gen dots (all forms), per-stage `set ✓` pill rows, always-expanded index lists, provenance hover-card popover (v2 once read/absorb events exist), auto-open-follows-writer, carrier color confetti at rest, always-green reconciliation prose.

**Disclosure implementation note:** don't use `<details>` for hero rows — chevron-toggles vs row-seeks requires two sibling buttons (disclosure + seek), open state keyed by pack key.

## Rail v3 — the self-captioning Memory rail (clarity pass, 2026-07-12)

Owner feedback on v2, verbatim: *"I don't really understand what 'state' is — what is that rail I click on and what's happening in each one? It feels arbitrary to me."* A third design run (naming / information-architecture / shared-grammar / progressive-teaching lenses, judged by owner-replay, new-developer, and craft lenses) diagnosed the failure precisely: the rail was grouped by **implementation channel** (backpack slots / innate emissions / explicit slots) with no resting ink saying who writes each group or why it exists; "State" names the substrate, predicting nothing; "SLOTS · 1" is dishonest by underinclusion (everything on the rail is a slot); "stages · 2/3" reads as pipeline progress, not memory.

**The fix — the answer lives in resting structure, not hover text:**

- **Vocabulary**: tab `State` → **`Memory`**; rail header **"Memory · the run's scratchpad"** (the suffix is the permanent API-honesty anchor); density toggle relabels to `memory:`. Rejected: "Scratchpad" as the tab (predicts jotted notes), "Carry" (names motion, not contents).
- **Three-writer captions** (permanent, one line each, mute): **`EVIDENCE ↳ dropped by tools`** / **`STAGE OUTPUTS ↳ saved by the framework`** / **`KEPT VALUES · N ↳ written by agent code`** — the grouping *is* the taxonomy: three different hands writing into one shared memory. The `↳` is the timeline's own provenance glyph. Rejected as captions: BACKPACK, SLOTS (implementation words as headlines), HANDOFFS (purpose-metaphor lost to plain noun + attribution), "stages" (control-flow word on a memory rail).
- **Two-register rule** (enforced globally): sans words say what things *mean*; mono tokens stay byte-exact what the runtime *calls* them (`backpack.observations`, `agents.retrieve`, `✓ set`, `drop #1`). Mono is the visible join key between rail and timeline; no API word is displaced, only glossed (`backpack.` namespace de-emphasized in mute, never removed).
- **Stage group**: key becomes the actual chain `retrieve → correlate → brief` (done/current/pending toned), fraction gains the 5-character fix **"2/3 saved"** — kills the progress-meter misread. Chip `innate` → **`auto`** (tooltip preserves "innate"); same swap on timeline innate frames, whose annotation becomes "← stage output · saved for next stage".
- **Bridge, both directions**: rail row click → seek producing frame (existing); **reverse seek** — clicking a mono `.d-key` in any Δ frame scrolls the rail to the row holding that slot's current value; byte-identical mono keys + shared ↳ glyph carry the correspondence at rest.
- **Footer in receipt language**: healthy `✓ matches all write receipts`; mismatch `⚠ receipts disagree — receipts say 6, memory shows 5`; derived `rebuilt from 2 drop receipts`.
- **Teaching lifecycle, no state machine**: the empty state is the lesson (orientation line "What this run carries between stages.", the rail↔timeline contract line, three caption skeletons with one-line explainers that dissolve at first write); hover carries depth only; at steady state the captions themselves are the teaching. Permanent cost vs v2: ~40px (two caption lines + header suffix + "saved" suffix). Rejected: per-user graduation state machines, "got it" buttons, "?" pills, legend panels.

**Open product flags for owner sign-off**: "Memory" vs a future conversation-memory feature (mitigated by the scratchpad suffix); "EVIDENCE" editorializes the Backpack's dominant use (spec a per-BackpackSpec caption override; generic fallback "GATHERED ↳ dropped by tools"); "KEPT VALUES" vs the keep-by-default "kept:" tool output (the attribution line disambiguates; fallback "AGENT-KEPT"); the single-pack no-caption rule is deliberately reversed (+20px as structure, not teaching).

## Known risks

- Timeline noise on chatty runs — the density default, coalescing, one-frame-per-`drop()`, and memo-hit strips are load-bearing, not optional.
- Preview payloads must be truncated server-side or SSE frames / persisted rows bloat.
- Drop-frame nesting depends on threading `tool_call_id` through the accessor emitter; FunctionStep writes need the standalone `fn()` path handled explicitly.
- Persisted replay currently only stores `user_prompt`/`text` parts — `state_delta` needs stored-part forward-compat or replay degrades to text blobs.
- Trace tab and timeline will double-render state events without deliberate curation in `eventsToSteps`.
- Captured injected-prompt text may contain sensitive content — needs the same redaction posture as thinking's "reasoned privately".
