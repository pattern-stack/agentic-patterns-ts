---
title: "Playground redesign — the object graph is the product"
description: "Design shifting the playground from run observability to composition inspection: three doors (Roles/Agents/Capabilities), provenance chips, slice order."
sidebar:
  label: "Playground redesign"
---

> Status: **DRAFT for review** (2026-07-01, Doug + Claude). Supersedes the "observability
> console" framing of `ap playground`. Companion doctrine:
> a private consumer repo's retrieval-workflow design doc (slot
> placement, the lens, the no-LLM workbench methodology).

## 1. Motivation

Today's Playground (`ap playground` → agent-server + agent-dashboard) is a **runtime
observability console**: Dashboard, Chat, Agents (a stats table), Tools, Tokens, Live,
Graph, Conversations, Claude Code. Every surface answers "what did a run do." No surface answers
"what IS this agent" — and that second question is the one a structured building
methodology lives on.

The concrete failure this fixes is the **dump-file failure mode** (retrieval doc, slot
placement section): a preset judgment ("start narrow, stop after 2-3") collided with a
local judgment ("read broadly") and nobody noticed, because no single place showed the
agent's total slot stack. The cure is **the lens**: one place that renders an agent's
complete composition, where each slot came from, and how the delivered prompt is
assembled from it (per-section source attribution in v1; slot-granular span mapping is
a later upgrade — the slot stack + provenance chips alone already surface the collision
class, because the two colliding judgments sit side by side with their origins).

The reframe: **the Playground's primary object changes from the run to the composition.**
Runs remain — demoted to one mode of two.

## 2. The object graph

The framework already defines a compositional lattice; the Playground makes every node
inspectable, traversable in both directions, and exercisable at its own layer — without
spending a token unless you ask for one.

```
Toolbox ──┐
Manual  ──┼─► Capability ──┐
Playbook ─┘                │
Persona ───────────────────┼─► Role ──► Agent ──► Node/Workflow ──► Run
Judgments ─────────────────┤              ▲
Responsibilities ──────────┘   Mission ───┘
                    Background ───────────┘
                    Awareness ────────────┘
```

### The two-tier algebra (the load-bearing distinction)

```
Role  = Persona + Judgments + Capabilities + Responsibilities   ← WHO   (timeless identity, reusable)
Agent = Role × Background × Awareness × Mission (× model)       ← WHO, situated (instance)
```

- **Background** — what the agent KNOWS (team/project context, conventions, current state).
- **Awareness** — what the agent CAN know (domains with access methods, exploration capabilities).
- **Mission** — what it's for right now.

When all specialization is pushed into Role-level slots (forked judgments, per-agent
personas) and Background/Awareness sit empty, the two tiers collapse and the Role/Agent
distinction feels like ceremony. The Playground's job is to make the seam visible so the
tiers stay honest: **one role, many situated instances** is the candidate end-state the
instantiation matrix exists to adjudicate — e.g. IF the retrieval build's forked-at-birth
slots converge under tuning, the merge target is a single retrieval role with per-step
Background/Awareness/Mission tuning for interpret / navigate / curate / answer. The
opposite verdict is equally legitimate: step-specific judgments (formulationDiscipline is
the interpreter's craft — retrieval doc, decisions 3/7/8) may keep the roles honestly
distinct. The matrix shows; it does not moralize.

### Edges are questions

| Direction | Question it answers | Example |
|---|---|---|
| down (composition) | What is this agent made of? | curator = persona + curationDiscipline + no tools |
| **up (usage)** | Who uses this toolbox / judgment / role? | query-surface toolbox → navigator + analyst |
| across (variants) | Which agents carry which *version* of a judgment? | `workingSetCuration` vs its fork `curationDiscipline` |
| forward (delivery) | Where does this slot land in the rendered prompt? | the lens verifying a judgment edit shipped |

The **up** direction is what today's Playground cannot do at all. Usage edges are also
the evidence the promote/demote placement rules run on: "used by 2 agents" is literally
the promotion trigger.

## 3. The three doors (IA)

The nav mirrors the algebra. Three co-equal entry doors into the graph, plus the run side:

```
BUILD                                    RUN
  Roles         ← identity door            Runs        (streams, replay, constellation)
  Agents        ← instance door            Live        (cross-cutting live view)
  Capabilities  ← substrate door           Claude Code (session browser, as today)
                  (Capability = Toolbox + Manual + Playbook)
```

There is no separate "Workbench" surface: the exercise verbs live on the BUILD detail
pages that own them (tool runner on Capability detail, contract bench / chat on Agent
detail). RUN holds only cross-cutting runtime views. The legacy global Chat page
survives unchanged until slice 5 relocates it under Agent detail.

**Roles and Agents are co-primary** — two doors into the same graph answering different
questions (catalog of identities vs roster of deployed instances; cf. Docker
images/containers). Co-primary works only with strict **view ownership** — the
anti-pattern is both pages rendering everything until they blur back into one tier:

### Role detail (identity-centric) — owns:
- The **slot stack**: persona, judgments, responsibilities, capabilities — each with a
  provenance chip.
- The **slot drawer**: expanding any slot card shows its up- and across-edges — which
  other roles carry this slot (used-by; the promotion evidence) and which slots
  elsewhere are *similar* to it (the variant/fork view, e.g. `workingSetCuration` vs
  `curationDiscipline`). This is where judgment-level usage edges live; without it the
  §2 "who uses this judgment" edge has no home. Ships with slice 3.
- The **instantiation matrix**: this role's agents as rows; Background × Awareness ×
  Mission × model as diff columns. "One role, four situated steps" rendered as a table.
  This is the tunability instrument — the evidence for the converge-vs-diverge verdict
  described in §2.
- The rendered **base prompt** — the role-derived sections of whichever render path the
  executing runner actually uses (see §6: two render paths exist; the lens must show
  the delivered one, or it re-creates the very misverification it exists to fix).

### Agent detail (instance-centric) — owns:
- **Identity card**: compact reference to the Role, linking up. NOT a re-dump of its slots.
- The **instantiation delta**: Background, Awareness, Mission, model override — the
  tuning that makes this agent this agent.
- **Coherence check**: awareness domains ↔ capability tools, cross-referenced. A domain
  with no tool that reaches it, or a mounted toolbox no domain describes, is surfaced as
  a warning. Free to compute; catches silent drift.
- The rendered **full prompt** with **per-section source attribution**: each section
  labeled with what produced it (persona → Identity, judgments → Boundaries +
  Methodology, background/awareness → Context, mission → Mission). Note this is NOT a
  single role/situation seam — role-derived Methodology renders *after* the situated
  Mission in the renderer path, so attribution is per-section, not prefix/suffix.
- The **exercise verbs** (chat / contract bench / run history) — you run instances, not
  identities.

### Capability detail (substrate-centric) — owns:

The substrate door is **capability-keyed**: one page per Capability = one
Toolbox + Manual + Playbook triple, because Manual and Playbook bind at the Capability
layer, not the Toolbox (a toolbox mounted by N capabilities has N manual/playbook
pairings). A shared toolbox is reachable from each mounting capability, with a
cross-link listing its other mounts.

- Tools with their zod schemas and blast radius (read / write / external / **unknown**
  — blast radius is a new optional `blastRadius` field on `ToolDefinition`, a small
  core addition budgeted in slice 4; undeclared tools render `unknown` and always
  confirm-gate).
- The capability's Manual and Playbook (plays listed).
- **Used-by**: which roles mount this capability; which agents inherit it; which other
  capabilities share its toolbox. The full up-chain.
- The **programmatic tool runner** (see verbs below).

## 4. Three verbs, applied per layer

Every surface gets the same verb set, scoped to its layer:

**Inspect** (no-LLM, always free) — slot stacks, provenance, schemas, rendered prompts,
usage edges, fork lineage, coherence checks. The default mode; a build session should be
able to run entirely here at zero token cost (the no-LLM workbench doctrine).

**Exercise** (cheapest execution that answers the question):
- Capability → **tool runner**: pick a tool, a form generated from its zod schema, execute
  programmatically. No agent, no model. This is the probe→encode instrument — where a
  manual recipe gets hand-verified against the live toolbox before being compiled into a
  FunctionStep.
- Agent → **contract bench / chat**: contract-aware. When the agent declares structured
  output, the bench is schema-in/schema-out (paste or capture a `RequestSet`, see the
  typed result). When it doesn't, it's chat. Tool-less pipeline agents get the bench;
  conversational agents get chat.
- Node/Workflow → **step runner**: run one step of a composed pipeline with a pasted
  input contract, or the whole pipeline. Contract seams are the test points.

**Trace** (runtime, folded INTO the structural pages) — runs, token spend, tool-call
stats become tabs on the entity they describe (a toolbox's live call stats on the
toolbox page; an agent's runs on the agent page). The current global Dashboard / Tools /
Tokens pages dissolve into these. Live / Runs / Constellation remain as the RUN mode for
cross-cutting views.

## 5. Provenance (inferred, not stored — and not guessed)

swe-brain stores `source` per role because its roles are DB rows. Here agents are
discovered from frozen code, so provenance is **inferable** — but the mechanism must be
specified honestly, because two naive approaches do not work:

- **Reference identity against presets is unreliable.** Role presets are *factory
  functions* (`analystRole()` returns a fresh instance per call), so reference matching
  is structurally impossible for roles; and even const preset judgments can resolve to a
  different module instance across the dual-package (src vs dist) boundary the CLI's
  discover layer already documents. Preset detection is therefore **name + structural
  content match**; a name-only match renders as `preset?`, never silently as `preset`.
- **The per-agent discovery file path cannot attribute individual slots.** At runtime a
  judgment imported from a context library is indistinguishable from one constructed
  inline — both are frozen objects reachable from `agent.role`. Library-vs-local
  attribution requires **enumerating the library modules** (a configured glob, e.g.
  `src/<ctx>/roles/**`, imported once in-process by the CLI at discovery time) and
  matching slot instances against their exports — reference match where module identity
  holds, name+content match across the boundary.

Tier vocabulary for the chips: `preset` / `preset?` / `library` / `local` / `inline`.
Where a slot can't be attributed, the chip says `inline` — an honest label. The design
rule stands: uncertain provenance renders as uncertain; the lens never shows a
confident-but-wrong chip.

Plumbing note (slice 1): the discovery file path currently dies inside the CLI —
`AgentRegistration` has no `file` field and the playground drops it when building
registrations. Slice 1 threads a provenance blob (computed CLI-side at discovery, where
module identity is available) through `AgentRegistration` to the server.

## 6. Server surface

Extend the introspection route family (agent-server), sourced from live registrations as
today (`/agents/:id/capabilities` already proves the pattern):

- `GET /agents` — instance roster (exists; gains role ref + readiness).
- `GET /agents/:id/composition` — full two-tier introspection: role slots (persona,
  judgments, responsibilities, capabilities→toolbox/manual/playbook), instantiation
  delta (background, awareness, mission, model), provenance per slot, rendered prompt
  as a **section list** (`{name, source, text}[]`), and coherence-check results.
  Two caveats the payload must carry:
  - **Render path.** (Historical: two prompt paths once existed — an inline
    `Agent.getSystemPrompt()` vs the `PromptRenderer` sections path. As of the
    primitive-knowledge rework there is a single section-composed path,
    `renderInitialPrompt()`, so the delivered prompt and the section list always
    agree.)
  - **Per-section rendering needs a small core helper.** `Agent` today exposes only
    joined strings (its renderer is private). Rather than fork the section wiring in the
    server, slice 1 adds e.g. `Agent.renderSections(): {name, source, text}[]` to core.
- `GET /roles` + `GET /roles/:id` — the identity catalog, derived by grouping
  registrations by role identity; includes the instantiation matrix data and per-slot
  used-by/similar edges (the slot drawer's data).
- `GET /capabilities` + `GET /capabilities/:id` — substrate catalog (capability-keyed,
  per §3) with used-by edges, manual/playbook, and tool schemas (JSON-schema-rendered
  from zod for form generation).
- `POST /capabilities/:id/tools/:tool/run` — the programmatic tool runner. Gated:
  `read` runs freely; `write` / `external` / `unknown` require explicit confirm.

All introspection endpoints are read-only and token-free. The tool runner is the only
new execution surface and runs code, not models.

## 7. UI implementation convention — atomic component structure

The dashboard already has an atomic hierarchy
(`agent-dashboard/src/components/{atoms,molecules,organisms,templates}` → `pages/`);
every new surface builds **within** it, never alongside it. Same discipline the core
package applies to prompt composition (atoms → molecules → organisms), applied to UI:

- **atoms** — existing: Badge, Button, Card, Spinner, icons. Add here only true
  primitives needed by the new surfaces (e.g. Chip for provenance/tier tags, Avatar).
- **molecules** — small compositions: SectionHeader, LabeledField, SlotCard (one slot +
  provenance chip), CoherenceWarning.
- **organisms** — DataTable (exists), plus: SlotStack (the ordered slot-card list),
  SlotDrawer (per-slot used-by + similar/variant edges), InstantiationMatrix,
  RenderedPromptView (per-section source attribution; slot-granular span highlighting
  is a later upgrade), ToolRunnerForm (zod-schema-generated), UsedByList,
  DetailPageShell.
- **templates** — AppShell (exists; gains the BUILD/RUN mode split), DetailPage layout.
- **pages** — thin route-level composition only; no styling or data-shaping logic that
  belongs lower.

Rule of thumb: if two doors need it, it is an organism or below; pages never share code
sideways with pages — shared structure gets promoted down the hierarchy (the same
promote-on-second-consumer rule as slot placement).

## 8. What this is NOT (scope fences)

- **No editing in v1.** The lens is read-and-exercise. Editing raises the code-vs-data
  representation axis (retrieval doc, horizon note) — where slot edits persist (source
  TS vs data overlay) is a separate, deliberate decision. The diff path in the repo
  remains the declaration of an edit's blast radius (in the placement-doctrine sense —
  distinct from the per-tool `blastRadius` field of §3/§6).
- **No slot-granular prompt-span mapping in v1.** The rendered-prompt view attributes
  per *section*, not per slot. The dump-file failure mode is killed by the slot stack +
  provenance chips (the colliding judgments sit side by side with origins), not by span
  mapping; slot-level spans are a later upgrade of RenderedPromptView.
- **No re-slotting of the retrieval agents.** Fork-at-birth (retrieval doc, decision 8)
  is locked for Phase 1; the instantiation matrix is how the eventual merge/keep verdict
  gets *seen*, not a mandate to act early.
- **Workflow/Node layer: static shape only in v1.** Render the composed pipeline
  (Sequential/FanOut/Loop/CoordinatorStep tree) as structure; the step runner may land
  crude. Full workflow authoring/visualization is its own arc.
- **swe-brain is prior art, not a template.** Its Agents · Roles · Capabilities family
  tabs and role-detail shape (persona/judgments/responsibilities cards + used-by)
  validate the IA; its DB-backed editing model does not transfer.

## 9. Slice order

| # | Slice | Delivers | Depends on |
|---|---|---|---|
| 1 | **Composition introspection** — `/agents/:id/composition` + `/roles` + `/capabilities` route family; provenance mechanics per §5 (library-module enumeration, preset name+content match, `AgentRegistration` provenance threading); core helper `Agent.renderSections()`; coherence check | the data spine every surface reads | — |
| 2 | **The three doors, read-only** — Roles / Agents / Capabilities list+detail with view ownership as specified; BUILD/RUN nav split; old pages (incl. Claude Code) re-homed under RUN | the lens: slot stack + provenance chips + per-section prompt attribution — kills the dump-file failure mode | 1 |
| 3 | **Instantiation matrix + slot drawer** on Role detail (per-slot used-by + similar/variant edges) | the tunability instrument + judgment-level usage edges | 2 |
| 4 | **Tool runner** (programmatic, schema-formed, confirm-gated) — includes the core `ToolDefinition.blastRadius` field addition; undeclared → `unknown` → always confirm | probe→encode instrument; first exercise verb | 1 |
| 5 | **Contract bench** — schema-aware agent exercise (structured in/out), chat fallback; relocate chat under Agent detail; retire global Chat page | talk-to-every-agent, contract-first | 2 |
| 6 | **Trace fold-in** — per-entity run/token/tool tabs; retire global stats pages | one home per fact | 2 |
| 7 | **Workflow shape view** (static Node tree; step runner if cheap) | the composition-of-agents layer | 2 |

Slices 3–6 are independent of each other once 2 lands; 4 needs only 1.

## 10. Open questions

- **Role identity for grouping** (slice 1): registrations hold `Agent` instances; two
  agents "share a role" when they hold the same `Role` reference. Reference identity is
  fragile across the dual-package (src vs dist) module boundary the discover layer
  documents — same hazard as preset matching (§5). Structural-equality fallback for the
  reference-broken case: flag as `similar`, never silently merge.
- **Judgment fork lineage** ("forked-at-birth from X"): no metadata exists to record
  it. v1 can detect *similarity* (name/text) and label it `similar to`; true lineage
  needs an authoring convention later.
- **Tool runner allowlist**: gating policy is decided (§6 — confirm on
  `write`/`external`/`unknown`); whether playground options additionally support a
  hard allowlist/denylist of runnable tools is open.
- **Library-module glob configuration** (slice 1): where the context-library glob for
  provenance enumeration lives — CLI flag, `ap` config file, or convention-only
  (`src/**/roles/`). Convention-only is the likely v1 answer.
