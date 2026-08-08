---
title: "ADR 0008 — Compositional memory: matured memories compile into the agent's composition, not into a context appendix"
description: "Matured memories compile into the agent's composition via typed targets and applyMemoryOverlay, with tiered gated promotion, attribution, and a ledger."
sidebar:
  label: "ADR 0008 — Compositional Memory"
---

- **Status:** PROPOSED — design review. Companion to [ADR-0007](0007-memory-store.md) (the store substrate; this ADR changes nothing there). Program #414; the Phase-2/3 north star for epic #415.
- **Date:** 2026-08-06
- **Context owner:** Doug
- **Scope:**
  - `packages/agent-core` — `MemoryTarget` schema (referenced by ADR-0007's `MemoryRecord.target`); `organisms/apply-memory-overlay.ts` (new pure function `applyMemoryOverlay(config, records)`); `organisms/agent.ts` (`AgentPromptSectionData.source` gains `"memory"` + `memoryIds`); no changes to any atom's schema or rendering.
  - `packages/agent-runtime` — MemoryStore protocol extension (`promote`/`demote`/`corroborate` + promotion rows, conformance-pinned); promotion/demotion Plays; gate-tier wiring (`SafetyGate`/`HumanApprovalGate` on promotion operations); evolution events (`agent.memory.promote`, `agent.memory.demote`, `agent.memory.overlay`); overlay application at the instantiate seam; recall pinning + `agent`-key post-filter in the recall assembler; composition lint (`lintComposition`).
  - `packages/agent-dashboard` — evolution lens: conflicts panel + pending-review queue with composition-diff preview (later phase).
  - External (design alignment only): codegen-patterns `agents` subsystem persists overlays and carries its event-based change logging; the curation "gardening" job runs on the jobs tier.

## Context

ADR-0007 gives us a scoped, invalidation-first `MemoryStore` with two recall surfaces. Every system we surveyed (ADK, Letta, mem0, LangMem, Zep, OpenClaw, Hermes) stops at the same final move: retrieve relevant text and **append it to the prompt as an undifferentiated blob**. The model is told "here is what you remembered." Memory stays outside the agent's structure, narrated to it each session.

This framework has something none of them do: a **typed anatomy of an agent's mind**, where each primitive already answers a distinct epistemic question — and each already has its own renderer:

| Primitive (slot) | Question it answers | Memory type it IS |
|---|---|---|
| `Background` — `teamContext` / `projectContext` / `conventions` / `currentState` | what do I know? | semantic memory (settled facts) |
| `Judgment` — `heuristics` / `constraints` / `escalationTriggers` | how do I decide? | procedural memory (learned rules) |
| `Example` — `scenario` / ✓`good` / ✗`bad` / `reasoning` | what has worked? | episodic memory, **compiled** — not retold |
| `Awareness` — `domains` (name / description / accessMethod) | what can I know? | meta-memory (the index of the rememberable) |
| `Playbook` / `Manual.workflows` | what procedures do I have? | skills |
| `Recovery` | what do I do when I fail? | failure lore |
| `Persona` — `priorities` / `principles` | who am I? | identity — the tier memory touches last, if ever |
| `Scratchpad` | what am I holding right now? | working memory (exists, run-scoped) |

The cognitive taxonomy other frameworks bolt on as labels (semantic / episodic / procedural / working) is, here, load-bearing structure. That creates a move only this framework can make: **a matured memory does not render as an appendix — it compiles into the composition.** A learned project fact appears *in* `Background.projectContext` under the same heading as authored context. A lesson from a failed run compiles into an `Example` on the relevant `Judgment` — episodic memory becomes few-shot automatically. A discovered information source becomes an `Awareness` domain. The agent doesn't read its diary each morning; it wakes up already changed.

Three properties make this mechanically natural, and their conjunction exists nowhere else in the surveyed field:

1. **Agents are pure data.** `AgentConfig → buildAgentFromConfig` (RFC-0007 lineage) means memory application can be a pure function over frozen Zod data, applied at the per-conversation instantiate seam (ADR-0004).
2. **Prompt sections carry attribution.** `AgentPromptSectionData.source` is already `"role" | "instance"`; extending it means every learned prompt line traces to the memory record that produced it — and through ADR-0007 `provenance`, to the conversation and run where it was learned.
3. **Gates and evals exist.** Promotion into behavior-changing slots can be gated (ADR-style approval flows already work end-to-end), and because agents are config, an overlay is **A/B-evaluable**: run the eval suite on `config` vs `config′` and measure whether a learning helps before it sticks.

The risk this ADR must own: we are **evolving agents over time**. Uncontrolled, that means losing sight of where and how an agent changed, compositions bloating toward context limits, contradictory judgments accumulating, and one bad episode minting a bad rule. The design below treats evolution lineage and growth governance as first-class requirements, not afterthoughts.

## Decision

1. **Memory records may carry a typed `target` into the anatomy.** `MemoryTarget` (core, Zod) is a discriminated union naming a primitive slot:

   ```ts
   MemoryTarget =
     | { primitive: "background"; section: "teamContext" | "projectContext"
                                         | "conventions" | "currentState"; key: string }
     | { primitive: "judgment";   domain: string;
         slot: "heuristics" | "constraints" | "escalationTriggers" }
     | { primitive: "example";    judgmentDomain: string }   // compiles to Example on that Judgment
     | { primitive: "awareness" }                            // compiles to an AwarenessDomain
     | { primitive: "recovery" }                             // guarded tier only
     | { primitive: "manual";     capability: string; section: "workflows" }   // later phase
   ```

   Untargeted records — everything in ADR-0007 v1 — behave exactly as before: recall blob + toolbox. `target` is a *proposal*, not a promotion; promotion is a separate, gated act (Decision 4).

   Structured targets carry a structured **`payload`** alongside the prompt-ready `content` prose — an `example` target stores `{scenario, good, bad?, reasoning?}`, an `awareness` target `{name, description, accessMethod}` — so `applyMemoryOverlay` never parses prose. A targeted record missing its required payload cannot promote.

2. **`applyMemoryOverlay(config, records) → config′` is a pure core function.** It folds *promoted, valid* targeted records into an `AgentConfig` deterministically:
   - **Authored config always wins.** A memory `background` entry whose key collides with an authored key is dropped from the overlay (and flagged by lint, Decision 6) — never overwrites.
   - Merge rules per primitive: `background` entries insert under their section keyed by `key`; `judgment` heuristics append to the *existing* judgment with matching `domain` (a memory may not create a new judgment domain in v1 — that is a structural change reserved for humans); `example`s append to the matching judgment's examples; `awareness` domains append.
   - The function is total and order-independent for non-conflicting records. Memory-vs-memory collisions are treated as a reconciliation failure that already happened upstream: `memory_save` on a targeted record searches its scope+target first, and on collision must either `supersedes` the existing record (the correction case — newer wins *via explicit invalidation*, audit chain intact) or choose a different key. For the residual (genuinely concurrent learnings), the overlay renders the **newest** deterministically, keeps *both* records valid, flags the conflict in the overlay report and ledger, and curation proposes the permanent supersede — surfaced side-by-side in the dashboard **conflicts panel**. Nothing renders silently wrong; nothing is silently deleted.
   - It runs at the **instantiate seam** (ADR-0004): the delivered per-conversation agent is built from `config′`. The stored authored `AgentConfig` is never mutated — the overlay is a derived view, recomputed each instantiate from the store's current valid records. This is what makes rollback trivial (Decision 5).

3. **Attribution: learned lines are traceable.** `AgentPromptSectionData` gains `source: "role" | "instance" | "memory"` at the fragment level, with `memoryIds: string[]` on memory-derived fragments. "Why does the agent believe X?" resolves as: prompt line → memory record → `provenance.conversationId`/`runId` → the stored conversation. The dashboard's existing section-attribution surface (Playground lens) extends to render this. No surveyed memory system has line-level attribution; this is the sightline that makes evolution safe to allow.

4. **Promotion is tiered and gated.** A targeted record starts as a *candidate*: it still reaches the agent, but only through the ADR-0007 recall surfaces (visible as memory, not yet part of the self). Promotion moves it into the overlay. Tiers:

   | Tier | Targets | Bar to promote |
   |---|---|---|
   | **Auto** | `background.*`, `awareness` domains | Written + reconciled (audited via events; no approval) |
   | **Earned** | `judgment.heuristics`, `example` | Recurrence (≥N supporting episodes, N configurable, default 2) **or** eval-pass (suite green on `config′`), through the gate chain |
   | **Guarded** | `judgment.constraints`, `escalationTriggers`, `recovery` | Human approval (`HumanApprovalGate`) — these change what the agent refuses or escalates |
   | **Locked (v1)** | `persona`, `tone`, `methodology`, new judgment domains, `mission` | Not promotable. Identity is authored. Revisit only with field experience. |

   **Recurrence mechanics:** a repeated lesson does not mint a duplicate record — `memory_save` detects the near-duplicate candidate and **corroborates** it, appending `{conversationId, runId, at}` to the record's `supports` list. N counts **distinct conversations**, so a single long session cannot self-promote a rule. And candidates earn exposure rather than relying on query luck: targeted candidates get a small reserved slice of the recall budget (up to K, recency-rotated) so the agent keeps meeting its own provisional lessons and can corroborate them against reality. Contradicting evidence never decrements a counter — it routes to the conflict flow (Decision 2). Counters that move both ways are how promotions flap.

   **Demotion: the bar to remove a learning equals the bar that added it.** Auto-tier records the agent may invalidate/supersede freely (audited via events). Earned-tier demotion needs the same class of evidence that earned promotion — accumulated contradiction, eval regression, or a human decision. Guarded-tier: an agent-initiated `memory_invalidate` or `supersedes` against a guarded-promoted record does **not** take effect — it becomes a *pending demotion proposal*, and the learning keeps rendering until a human confirms. An agent cannot unlearn what it was made to learn; it can only propose to. Proposals ride the existing human-input approval round-trip (pending-input registry, fail-closed timeout) and surface in the dashboard **pending-review queue** with a composition-diff preview ("this line would leave your agent"). An invalidated auto/earned record leaves the overlay at the next instantiate, automatically.

5. **Evolution is a ledger — store-resident — and rollback is free.** Promotion state lives in the MemoryStore, not on the telemetry spine: ADR-0007's protocol is extended with `promote(id)` / `demote(id, reason?)` / `corroborate(id, provenance)` operations backed by promotion rows, so "valid + promoted for this scope" is one bounded query, pinned by the conformance kit — and the ledger survives event retention-pruning (the exact lifecycle mismatch that kept memory off the telemetry file in ADR-0007). The typed events — `agent.memory.promote`, `agent.memory.demote`, plus a per-instantiate `agent.memory.overlay` summary (record count, bytes per primitive, conflict count) — are the ledger's *mirror* on the standard four-guard SSE path, powering live observability. Because overlays are derived views over invalidation-first records:
   - **Rollback** = invalidate the record (or the promotion). Next instantiate compiles without it. No migration, no config surgery.
   - **Point-in-time reconstruction** = replay the ledger: which records were valid+promoted at time T fully determines the composition at time T.
   - **Communicating learnings** is a query, not a feature: "what did you learn this week" = promote events since T, each with human-readable content and provenance. Agents get a `memory_learnings` view via the toolbox so they can *tell the user* how they've changed; the app-side (codegen-patterns agents subsystem) aligns its event-based change logging with the same ledger so persisted definitions and framework overlays share one history.

6. **Growth governance: agents must grow naturally, not malignantly.** Three mechanisms, all mandatory in the design (phasing in §Follow-ups):
   - **Budgets:** per-primitive overlay budgets (chars), enforced inside `applyMemoryOverlay` — over-budget records fall back to the recall tier (never silently discarded), and truncation is marked (house rule). A composition-wide ceiling triggers a hard lint failure long before context limits.
   - **Contradiction checks:** promotion into a judgment slot requires a reconciliation search first (ADR-0007 `search` over the same domain); a candidate that contradicts an existing heuristic/constraint cannot auto-promote — it surfaces as a conflict for curation (agent-proposed `supersedes`, or human pick). Authored-vs-learned conflicts always resolve authored-wins and are reported.
   - **Curation ("gardening"):** a periodic pass — a Play on the jobs/scheduler tier in production, invocable manually in the framework tier — that dedupes near-identical records, merges fragmenting entries, proposes invalidation of stale `currentState` facts, re-runs evals on earned-tier promotions, and emits a **composition health report** (`lintComposition`: size per primitive, conflict list, unused-recall stats, staleness candidates). Curation *proposes*; the same gate tiers approve. No opaque auto-rewriting — the exact failure ChatGPT's Dreaming was criticized for.

7. **Eval-gated promotion is the differentiating loop.** For earned-tier candidates, the promotion Play may run the agent's eval suite against `config` and `config′` and require non-regression (or improvement) to promote. The eval certifies the candidate applied to the base config plus already-promoted records **in the candidate's own scope** — a promotion bar, not a per-user guarantee, with the same epistemics as CI: green on the branch, not on every deploy target. Gardening may re-run evals per major scope as a later hardening step. Self-improvement becomes measured, reviewable, and reversible — versus the field's "edit MEMORY.md and hope."

8. **Scope hygiene: the reserved `agent` key.** Records specific to one agent carry `agent: "<name>"` in their scope; records without it are deliberately shared across the user's agents (which is exactly what user-preference memories want). Because subset-match alone cannot express "shared + mine, not theirs" — a filter of `{user}` also matches `{user, agent: other}` records — the framework's recall assembler and overlay query post-filter to `agent ∈ {me, unset}`. This is a runtime helper, not a store change: the protocol stays pure subset-match, and the convention is documented and conformance-noted rather than encoded as a query operator.

## Consequences

**Good**

- Memory becomes indistinguishable from authored composition in the prompt while remaining fully distinguishable in the tooling — the exact inversion of the appendix pattern, and unique in the surveyed field.
- Episodes compile into few-shot `Example`s; rules land in typed `Judgment` slots; facts land under existing `Background` headings. No new render sections, no new atoms — the anatomy absorbs memory with zero schema changes to atoms.
- Full evolution sightlines: line → record → conversation; ledger-replayable history; one-step rollback; learnings communicable to the user as a query.
- Growth is bounded and audited by construction (budgets, contradiction checks, gardening with gated proposals).

**Costs / risks**

- `applyMemoryOverlay` merge semantics are real design surface (collision rules, ordering, budget spill) — mitigated by purity: exhaustively unit-testable over frozen data.
- The instantiate path gains a store read + fold per conversation; needs a bounded query (valid+promoted records for scope) and is skippable when no store is wired.
- Recurrence/eval thresholds add operational knobs; wrong settings either freeze learning or let noise through. Defaults must be conservative (slow growth beats bad growth).
- Two-repo alignment (framework overlay ledger ↔ codegen agents-subsystem change logging) must be designed once, early, or the histories fork.

**Known limits, stated rather than hidden**

- v1 promotable targets are `background`, `awareness`, `judgment.heuristics`, `example` only. Constraints/escalation/recovery are guarded (human-gated, later phase); persona/tone/methodology/mission and *new* judgment domains are not promotable at all.
- Play/skill synthesis from memory (the Hermes "autonomous skill creation" analog) is deferred — a learned procedure lands as prose (`manual.workflows`, later phase) before it ever lands as executable code.
- Contradiction detection is lexical/search-grade, not semantic proof; it narrows the window, it does not close it. Gardening + human review are the backstop.
- CC-runner path: attribution inside Claude Code sessions is limited to what the prompt carries; the ledger remains complete server-side.
- A candidate record that never earns promotion just remains recall-tier — that is the correct failure mode, not a bug.

## Rejected alternatives

- **Rewrite-the-system-prompt procedural memory (LangMem).** Whole-prompt mutation destroys structure, attribution, and selective rollback. Our prompt is compiled from typed parts; we keep it that way.
- **Untyped memory blocks (Letta).** Blocks are opaque prose with a char cap — no slots, no per-slot gating, no merge semantics. The anatomy is the whole advantage; flattening it wastes it.
- **Mutating the stored `AgentConfig` in place.** Simplest to build, and it destroys the authored/learned distinction, rollback, and point-in-time replay in one stroke. Overlays are derived views; sources persist.
- **Skill-file emission only (Hermes).** Covers procedures, ignores epistemics (facts, judgment, sources) — the larger share of what an assistant learns.
- **Automatic promotion everywhere.** One bad episode minting a constraint is the nightmare scenario; the tier table exists because slots differ in blast radius.
- **Opaque background consolidation (ChatGPT Dreaming).** Auto-rewriting memory with reduced audit trail is the field's documented trust failure. Gardening proposes; gates decide; the ledger records.

## Follow-ups

1. **Phase A (with ADR-0007 v1):** reserve `target` on the record (done in 0007); no behavior.
2. **Phase B:** `MemoryTarget` schema + `applyMemoryOverlay` + attribution extension + overlay/promote/demote events + auto-tier only (background/awareness). Dashboard shows memory-sourced fragments.
3. **Phase C:** earned tier (recurrence + eval-gated judgment heuristics and examples), guarded tier approvals, `lintComposition`, manual gardening Play.
4. **Phase D (production):** scheduled gardening on the jobs tier; codegen agents-subsystem ledger alignment; evolution lens in the dashboard; manual/workflow targets.
5. **Docs:** developer guide + worked evolution examples (design-preview docs accompany this ADR: `docs/memory/`).
