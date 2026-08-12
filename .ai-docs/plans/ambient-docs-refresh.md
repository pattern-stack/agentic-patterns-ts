# Docs refresh — make the site tell the ambient story

> Written 2026-08-12. Plan of record for the second pass on the Starlight docsite
> (first pass = #457/#458, PR #459). Two vision-level calls were made by Doug at the
> top of this session and are **settled**, not open:
>
> 1. **Ambient is the headline.** The hero, the "where to start" path, and the sidebar
>    reposition around ambient/always-on agents. Composition becomes the *how*, not the *what*.
> 2. **Rewrite the memory docs to ADR-0009 now, docs-first.** Do not wait for Phase B code.
>    This deliberately repeats the loop the ambient brief credits with surfacing 33 design
>    questions before the memory build — this time it pressure-tests ADR-0009 while it is
>    still PROPOSED.
>
> Governance for every change here lives in `.claude/skills/docs-management/SKILL.md`.
> Read it before touching a page — frontmatter contract, linking rules, truth gates.

## Baseline (verified 2026-08-12, not recalled)

| | |
|---|---|
| Site build | **green** — 27 pages, `check-docs-links: 646 internal refs OK` |
| Versions | core **0.18.0** · runtime/server/cli **0.40.0** · dashboard 0.10.2 |
| Events reference | current — manifest and `docs/reference/events.md` both at **40 wire events** |
| Sidebar groups | Guides · Memory · Reference · Architecture Decisions · Design notes (collapsed) |
| Deploy | CF Pages git integration. There is no manual deploy path and never will be. |

## The diagnosis

The site documents the framework as it stood in early July: compose primitives, run an
agent. Every ambient capability shipped since is either absent or buried.

**The ignition seam is shipped, exported, and undocumented.** `#437` landed in core 0.18 /
lockstep 0.39. All three primitives are in the public barrels
(`packages/agent-core/src/atoms/index.ts:95`, `packages/agent-runtime/src/runtime/index.ts`):

- `TriggerSource` — `packages/agent-core/src/atoms/trigger-source.ts`, six-kind vocabulary,
  `toPrompt()` so an ambient agent can legitimately know what woke it
- `AgentRegistry` — `packages/agent-runtime/src/runtime/registry.ts:38`, the "named agent"
  protocol hosts adapt to
- `runFromTrigger()` — `packages/agent-runtime/src/runtime/run-from-trigger.ts:75`

`grep -r "runFromTrigger\|AgentRegistry" docs/` returns **nothing**. A developer cannot
discover the ambient entry point from the site.

**The memory pages teach a vocabulary already decided against.** `docs/memory/guide.md`
(797 lines) and `docs/memory/evolution-cookbook.md` (873 lines) are built on `target` /
`payload`. ADR-0009 (PROPOSED, revised 2026-08-08) deletes both. Verified unimplemented:
no `molecules/memory-routing.ts`, no `organisms/apply-memory-overlay.ts`, `Background`
still carries the four legacy records (`atoms/background.ts:13`), `MemoryRecord` still
carries `target`/`payload`. ADR-0009's own scope names these doc corrections as debt
(Decisions 1, 8, 13 + Follow-up 6).

**The gateway is an appendix.** `runners.md` covers `AP_GATEWAY_*` correctly and is current
post-ADR-0010 — but it starts at line 698 of a 752-line document titled "Runner & Provider
Strategy — ADR". The gateway is now the *recommended* production configuration: it is the
only path on which an agent's **declared** model is honored, and #478 just fixed its
packaging (`@ai-sdk/openai-compatible` was still a devDependency — #472's defect one rung
down, on the configuration we recommend).

**No conversation/threading page.** The loop proven live on 2026-08-10 — schedule fires,
agent writes a brief into a thread, a reply hours later reaches the same agent with the
brief in context — has no doc. `Conversation`/`ConversationStore` (runtime layer 11) appear
only in design notes.

---

## The work

Four slices. Each is a PR (`main` is protected — required status `check`).

### Slice 1 — the Ambient group (new content, no rewrites)

New directory `docs/ambient/`, four pages, wired as a new sidebar group **between Guides
and Memory** in `docs-site/astro.config.mjs`.

| Page | Owns | Honesty bar |
|---|---|---|
| `docs/ambient/index.md` | The loop end to end: trigger → resolve → run → thread → memory. `runFromTrigger` as the executable spine. A shipped-vs-roadmap table. | Must not imply AgencyHost (M3) or channels (M4) exist. Table states each explicitly. |
| `docs/ambient/triggers.md` | `TriggerSource` (six kinds, `toPrompt()`), `AgentRegistry` contract incl. the ADR-0004 resolve rule, `runFromTrigger` deps/request/handle, the provenance chain `RunOptions.trigger` → `MessageStartEvent.trigger` → `RunMeta.metadata.trigger`. Host-adapter recipe. | Every guarantee claimed must be one the source actually makes (`run-from-trigger.ts:9-23`). |
| `docs/ambient/conversations.md` | `Conversation` + `ConversationStore`; thread continuity across triggers; what makes a reply reach the same agent with context. | **Must state the gap:** `runFromTrigger` deliberately excludes conversation continuity, queue/reject policy, and transport — that is M3 (`run-from-trigger.ts:25-27`). Do not let the proven swe-brain demo read as a shipped framework feature. |
| `docs/ambient/gateway.md` | Operational page lifted from `runners.md` §5: the `AP_GATEWAY_*` table, resolver mode at rung 2.5, the declared-model-is-honored property, virtual keys + basic auth, `ProviderPackageError`, bundled-provider set. | Carry the caveats, not just the happy path: #243 override-vs-gateway precedence is open, and **an agent with no declared model fails loud** under a gateway. |

`runners.md` keeps the ADR reasoning and gains a pointer to `ambient/gateway.md`; the
env-var table moves rather than duplicating (a duplicated table is a drift source).

**Code-fence discipline (docs-management gate 3):** every executable block gets an
executable twin proven against the built packages *before* commit. Proposal — improve on
the getting-started precedent by committing the twin as `examples/ambient-trigger.ts`
rather than a throwaway script, so it is re-runnable and can be picked up by #457 slice 3
(automated fence checking) later.

### Slice 2 — the landing page

`docs/index.md`. Hero rewritten around ambient:

- tagline: agents that run on their own — schedules and events wake them, memory carries
  across sessions, gates keep humans in the loop
- actions: **Get started** · **Build an ambient agent** (→ `/ambient/`) · GitHub
- body: the ambient loop first, composition second as the mechanism, then install, then a
  "where to start" that leads with Ambient

Prose/source agreement (gate 4) means the README and `CLAUDE.md` opening must not contradict
the new hero. Check both in this slice; fix or file.

### Slice 3 — memory rewritten to ADR-0009

`docs/memory/guide.md` + `docs/memory/evolution-cookbook.md`, ~1,670 lines between them.

Replace throughout:
- `target` / `payload` → the developer-declared **routing spec** (`Placement`, `placementKey`,
  `MemoryRoutingSpec`) plus the additive `label` on the record
- the four legacy `Background` records → one nested `sections[]` rendered as prompt fragments
- `applyMemoryOverlay` at the instantiate seam, per ADR-0009 Decision 1

**The status convention is the hard part.** These pages will carry three different states at
once, and a cold reader must be able to tell them apart without opening the ADR:

1. shipped and unchanged by ADR-0009 (store, scoping, invalidation, events, recall)
2. **shipped today but changed by ADR-0009** (the model-facing toolbox schema loses
   `target`/`payload`, gains `label`) — the trap: prose that is simultaneously true of the
   published package and false of the accepted design
3. never built (all of Phase B)

Pick one marker vocabulary and apply it mechanically. Frontmatter `description` must state
design-preview status per the skill's contract.

This slice is where the docs-first payoff lands: write it as if ADR-0009 shipped, and every
place the prose will not come out clean is a design question to take back to the ADR before
Phase B code exists.

### Slice 4 — promote what's earned it

Design notes have accumulated near-shipped material and nothing has been promoted since the
site launched. Audit `store-family`, `node-context`, `closed-composition` against the runtime
and promote only after rewriting to present tense + shipped surface (the skill's rule). If a
doc cannot be rewritten that way, it stays quarantined — that is the system working.

Lower priority than 1–3; split out if the stack gets heavy.

---

## Sequencing

Slices 1 and 3 are independent and can run in parallel. Slice 2 should land *after* slice 1
so the hero's "Build an ambient agent" action has a target — otherwise the link gate reds,
correctly. Slice 4 last.

## Gates every slice must clear

1. `bun run --filter=@agentic-patterns/docs-site build` — includes the link gate
2. `bun run check:docs-events` — only if the SSE vocabulary moved (it should not here)
3. Executable twins run green before commit for any new code fence
4. Frontmatter: `title` + `description` on every new page; no h1 in the body

## Open items surfaced during the review — not blocking

- `TriggerSource` has no generated reference page. There is no manifest to generate from, so
  the generated-page pattern does not apply; hand-written in `ambient/triggers.md` is correct
  for now.
- The 40-event catalog is current but unnarrated — nothing explains what `memory.*` or
  `guardrail.*` mean during an ambient run. Candidate for a future "reading an ambient run"
  page rather than bloating the generated reference.
- #470 (`TRIGGER_KINDS` has no member for an internal domain event; decision recorded to add
  `event` with a subkind) will change the six-kind vocabulary. `ambient/triggers.md` should be
  written so that adding a seventh kind is an edit, not a restructure.
