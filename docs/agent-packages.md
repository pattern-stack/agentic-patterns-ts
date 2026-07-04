# Agent Packages — self-contained plugin units for an agent system

> Status: **DESIGN / MOCKUP** (2026-07-03). Companion to `docs/closed-composition.md`
> (whose primitives — `asAgent`, Node DI, retry, AccumulatingLoop, eval, bus threading —
> all shipped in runtime 0.7.0 and are assumed here). This doc proposes the *packaging*
> convention that closed composition makes possible: an agent directory as a plugin that
> contributes roles, agents, and pipelines to a central agent system. Intended to be
> exercised against two real agent systems before anything is formalized in the framework.

## 1. The idea in one paragraph

An **agent package** is a directory that is a self-contained unit of agentic capability:
it owns its internal helpers and subagents privately, and it publishes a deliberate,
typed export surface — reusable Role-algebra parts (personas, judgments, roles), bare
**query agents** (talk to the specialist directly), and **composed agents** (pipelines of
those same roles, promoted via `asAgent()` under a *new name* — this is how roles combine
into smarter agents). A central **agent system** does no orchestration logic of its own:
it aggregates packages, provides shared dependencies, and hands everything to discovery /
the runtime. Packages plug in; the system composes.

## 1.5 The naming hierarchy: Roles > Subagents > Agents

The packaging convention resolves the naming/hierarchy question with three layers that
map exactly onto the existing algebra — no new concepts, just names for the levels:

| Layer | What it is | Algebra | Visibility |
|---|---|---|---|
| **Role** | reusable capability template — persona + judgments + capabilities. A *what*, not a *who*. | `Role` | exported (Tier 1) |
| **Subagent** | a Role instantiated toward ONE aspect. Three subagents from the same role = same Role × three different Missions/Awareness. | `Agent = Role × Background × Awareness × Mission` | private (`subagents/`, plain filenames) |
| **Agent** | a published composition of subagents under a NEW identity — the only layer operators see. | `asAgent(...)` / re-export | exported (`agent.ts`, Tiers 3–4) |

The composition modes are the promotion patterns, all existing primitives:

| Agent kind | Composition | Built from (all shipped, all `implements Node`) |
|---|---|---|
| **PassthroughAgent** | one subagent exposed directly | re-export from `agent.ts` (the deliberate promotion act) |
| **SequentialAgent** | assembly line — output threads to the next sub | `asAgent(Sequential(AgentStep(sub1), AgentStep(sub2), …))` |
| **ParallelAgent** | *panel* — N named subs over the SAME input, opinions merged | `asAgent(Parallel({ branches, consolidate }))` |
| **FanOutAgent** | *mapper* — ONE sub over a runtime list of items, concurrent | `asAgent(FanOut({ over, step, consolidate }))` |
| **LoopAgent** | iterate until a condition (± fold channel) | `asAgent(Loop(...))` / `AccumulatingLoop` when state folds between passes |
| **CoordinatorAgent** | model-driven routing over subs | `asAgent(CoordinatorStep({ subs }))` |

(`Accumulate` — the ordered static-list fold — rounds out the set for "each item must
see the prior result"; it's FanOut's sequential sibling, rarely a whole agent on its own.)

**Parallel vs FanOut is the distinction worth teaching:** ParallelAgent is *many roles,
one input* (a review panel); FanOutAgent is *one role, many inputs* (batch work). Both
share the `Consolidate` reduce contract. Three subagents cut from one Role compose
naturally either way — as a panel (each sub takes a different aspect of the same
question) or as a mapper (one aspect-specialist across many items).

The hierarchy's nudge: the default path becomes "specialize narrow subagents, compose
upward" instead of "grow one giant agent" — while the shared Role keeps sibling
specialists from drifting, because their persona/judgments are tuned in one place.

## 2. Directory shape

```
agents/
  research/                      ← one agent package
    agent.ts                     ← PUBLIC agents live here (discovery entrypoint)
    index.ts                     ← the package's full export surface (the "plugin API")
    roles.ts                     ← Role definitions (persona + judgments + capabilities)
    personas.ts                  ← reusable Persona atoms (optional split)
    judgments.ts                 ← reusable Judgment atoms (optional split)
    deps.ts                      ← the package's depKey declarations (its DI contract)
    pipeline.ts                  ← Node composition (Sequential/Retry/Loop wiring)
    subagents/                   ← INTERNAL agents — building blocks, not products
      curator.ts                 ←   plain names: invisible to discovery by convention
      gap-checker.ts
    capabilities/                ← toolboxes + manuals scoped to this package
      search.ts
    __eval__/                    ← the package ships its own evals
      cases.ts
      scorers.ts
    README.md                    ← what this package contributes, one screen
  synthesis/                     ← another package, same shape
  ...
```

**Load-bearing conventions:**

1. **`agent.ts` is the shop window.** Discovery's glob (`agent.{ts,js,mjs}` /
   `*.agent.*`) only imports intentional files — so *everything a package wants
   launchable sits in `agent.ts`*, and nothing else matches the glob. Files under
   `subagents/` use plain names (`curator.ts`, not `curator.agent.ts`) precisely so
   they are **not** discovered: they're internal organs, wired into pipelines, never
   launched standalone by an operator. If a subagent graduates to a product, you
   *promote it* by re-exporting from `agent.ts` — a deliberate one-line act, visible
   in review.
2. **`index.ts` is the plugin contract** (§3). `agent.ts` is what `ap` sees;
   `index.ts` is what *other packages and the system* see. They overlap but aren't
   identical — `agent.ts` exports runnable agents; `index.ts` additionally exports the
   reusable algebra parts and the deps contract.
3. **Domain comes free.** Discovery already derives a domain from nested
   `{domain}/agents/` paths — so two agent systems can mount packages under
   `systemA/agents/…` and `systemB/agents/…` and get namespacing without any new
   machinery.

## 3. The export surface (what a package publishes)

Four tiers, from raw material to finished product:

```ts
// agents/research/index.ts — the plugin contract

// ── Tier 1: Role algebra parts (raw, recombinable) ─────────────────────
export { researcherPersona, skepticPersona } from "./personas.js";
export { citeSources, preferPrimary } from "./judgments.js";
export { researcherRole, curatorRole } from "./roles.js";

// ── Tier 2: DI contract — the deps this package NEEDS ─────────────────
// The system satisfies these; the package never constructs its own clients.
export { SEARCH_CLIENT, DOC_STORE } from "./deps.js";     // depKey<SearchClient>, …

// ── Tier 3: bare query agents — one role, directly conversational ─────
// "Talk to each individual agent" (the ADK ask). Thin: Role × Mission, no pipeline.
export { researchQueryAgent } from "./agent.js";

// ── Tier 4: composed agents — roles combined into a smarter agent ─────
// A pipeline of this package's roles/subagents, promoted under a NEW identity.
// The new Role is the composition's face; the constituent roles are its organs.
export { deepResearchAgent } from "./agent.js";

// ── Evals: the package ships its own measuring stick ──────────────────
export { researchEvalCases, researchScorers } from "./__eval__/cases.js";
```

And the shop window:

```ts
// agents/research/agent.ts — what `ap` discovers and an operator can launch

import { asAgent, retry, Sequential } from "@agentic-patterns/runtime";
import { researcherRole } from "./roles.js";
import { fetchStep, respondStep } from "./pipeline.js";
import { curatorStep } from "./subagents/curator.js";   // internal — wired, not exported

// Tier 3 — the bare specialist. Useful alone; also the eval baseline.
export const researchQueryAgent = new AgentBuilder()
  .withRole(researcherRole)
  .withMission(queryMission)
  .build();

// Tier 4 — roles combined into a smarter agent, under a new name.
export const deepResearchAgent = asAgent(
  Sequential.start(fetchStep)
    .then(retry(curatorStep, { maxAttempts: 3 }))
    .then(respondStep)
    .build(),
  {
    role: { name: "DeepResearch", description: "fetch → curate → respond over the research role set" },
    // deps deliberately NOT bound here — the SYSTEM binds them (§4)
  },
);
```

Why both tiers 3 and 4 matter: the bare agent is how you **tune** (chat with the
specialist, run its evals in isolation); the composed agent is how you **ship**
(consistent multi-step execution). Same roles, two products — and because of
`asAgent`, both are equally discoverable, chattable, and eval-able.

## 4. The agent system (the central aggregator)

The system is small on purpose — it does three things:

```ts
// systemA/system.ts
import { provideDeps } from "@agentic-patterns/runtime";
import * as research from "./agents/research/index.js";
import * as synthesis from "./agents/synthesis/index.js";

// 1. Satisfy every package's DI contract, once, centrally.
export const deps = provideDeps()
  .set(research.SEARCH_CLIENT, makeSearchClient(env))
  .set(research.DOC_STORE, docStore)
  .set(synthesis.RENDERER, renderer)
  .build();

// 2. Compose ACROSS packages (this is where the system earns its keep):
//    cross-package pipelines are just more Nodes — package boundaries don't leak.
export const flagshipAgent = asAgent(
  Sequential.start(new AgentStep({ agent: research.deepResearchAgent /* Agent→Node */ }))
    .then(synthesis.composeStep)
    .build(),
  { role: { name: "Flagship" }, deps },
);

// 3. Everything else is convention: `ap playground systemA` discovers each
//    package's agent.ts plus this file's flagship (if exported per convention).
```

Notes:

- **Deps bind at the edge, not in packages.** Packages *declare* (`depKey` exports);
  the system *provides*. That's the #98 DI channel used as an inter-package contract —
  the compiler enforces that the system satisfies each package's typed keys.
- **The system can also re-promote.** `AgentStep(deepResearchAgent)` drops a composed
  agent back into a bigger chain — closed composition means packages nest arbitrarily.
- **Two systems, shared packages.** Because a package's deps are injected and its
  internals are private, `systemA` and `systemB` can mount the *same* research package
  with different clients, different flagship compositions, and different eval baselines.
  That's the plugin test: if a package can't move between your two systems without
  edits, its export surface is leaking.

## 5. Evals as part of the package contract

Each package ships `__eval__/` (cases + scorers). The system then has three eval
altitudes, all through one `runEval` API:

| Altitude | Target | Question |
|---|---|---|
| Role | `researchQueryAgent` (bare) | is the specialist itself good? |
| Package | `deepResearchAgent` (composed) | does the package's pipeline beat its bare role? |
| System | `flagshipAgent` (cross-package) | does the whole assembly work end-to-end? |

The bare-vs-composed comparison per package is the tuning loop the whole architecture
exists for: same cases, two targets, one report diff.

## 6. What might need framework support (watch during the trial)

Deliberately **not** building these yet — run the convention against both systems first
and see which gaps are real:

1. **Discovery exclusion for `subagents/`.** Today privacy is by *naming* convention
   (plain filenames don't match the glob). If it proves error-prone, teach
   `discover.ts` to skip `**/subagents/**` explicitly — a 3-line change, but only if
   the convention actually gets violated in practice.
2. **A `defineAgentPackage()` manifest helper.** If both systems end up hand-writing
   the same `{ roles, agents, deps, evals }` aggregation, a typed manifest (and maybe
   `ap`-level awareness of it) is the formalization. Resist until the shape repeats.
3. **System-level deps for discovered agents.** `ap playground` discovers `agent.ts`
   exports that were built *without* the system's deps bound. Options: a conventional
   `system.ts`/`deps.ts` that `ap` loads to obtain the registry, or packages exporting
   a `bind(deps)` factory alongside the pre-bound default. This is the most likely
   real gap — note what pipeline2 (#114) learns about keyless/dep-less launching.
4. **Cross-package judgment/persona reuse.** If Tier-1 exports get imported across
   packages a lot, consider a shared `algebra/` package per system rather than
   package-to-package imports (which create coupling the plugin model tries to avoid).

## 7. Tomorrow's runbook (for the two systems)

1. Pick the system with the messier pipeline; carve ONE package out of it along §2's
   shape (don't migrate everything — one package proves or breaks the convention).
2. Write its `index.ts` contract first, *before* moving code — deciding Tier 1–4 up
   front is the design act; the file moves are mechanical.
3. Mount it in both systems with different deps; note every edit the second mount
   forces (each one is an export-surface leak → fix the contract, not the system).
4. Run the bare-vs-composed eval diff (§5) with even 5 cases — the report structure
   matters more than the scores on day one.
5. Log gaps against §6's watchlist; anything not on the list is new signal.

## 8. One-line summary

Closed composition made pipelines into agents; agent packages make directories into
plugins — private `subagents/`, a four-tier export contract (algebra parts, deps keys,
bare query agents, pipeline-composed agents under new names), package-shipped evals —
so a central agent system only *provides deps and composes*, and the same package can
plug into any system that honors the contract.
