---
title: "Closed Composition — the keystone that makes agents chainable"
description: "Design diagnosis: Agent and Node are two roots; adding asAgent() promotes any Node to a discoverable, chattable, eval-able agent, collapsing consumer sprawl."
sidebar:
  label: "Closed Composition"
---

> Status: **DESIGN / NORTH STAR** (2026-07-02). This is the architectural diagnosis and
> direction, not an implementation spec — `/sdlc develop` produces the spec from here.
> Companion: `docs/playground-redesign.md` (the lens/three-doors, already partly shipped),
> and the retrieval build at `~/retrieval-agent-2.0/canvas-workstation/src/query-surface`
> (the real consumer whose `workflow/` sprawl is the evidence).

## 1. The goal (in the author's words)

Build **multi-agent teams ("Agencies") around bounded contexts**, orchestrated by a
**centralized, tunable entrypoint agent that offloads to individual agents**. The Role
algebra maintains knowledge/tools/skillsets and passes them around; agents chain through
**clean sequential and parallel execution layers** (fetch → curate → analyze → respond)
for retrieval-into-generation.

The three concrete asks:
1. **Talk to each individual agent** (like ADK).
2. **Tune each against individual evals.**
3. **Chain them into workflows** for clean, consistent execution — *and talk to / eval the
   chain the same way you talk to / eval an agent.*

## 2. The root cause — composition is not *closed*

The framework has **two top-level runnable shapes that never unify**:

- **`Agent`** — conversational, identity-bearing (Role × Background × Awareness × Mission),
  talk-to-able, discoverable, eval-able. This is the differentiated IP (Role algebra +
  lens + provenance) and it works.
- **`Node<TIn,TOut>`** — the typed composition primitive: `run(input, ctx): NodeResult<TOut>`.
  `Sequential`/`Parallel`/`FanOut`/`Loop`/`CoordinatorStep`/`AgentStep` all `implement Node`.

The bridge is **one-directional**:
- `AgentStep<TIn,TOut> implements Node` — turns an **Agent into a Node** (drop an agent into
  a chain). ✅ exists (`packages/agent-runtime/src/workflows/agent-step.ts:95`).
- There is **no Node → Agent** anywhere. No `asAgent`, no conversational adapter.

**Proof it isn't closed** (verified this session):
- `Sequential(...).build()` returns `SequentialNode implements Node`
  (`workflows/sequential.ts:23,68`). It has `run(input, ctx)` — and *not* `role`,
  `getModel()`, `renderInitialPrompt()`.
- The runner / server / CLI discovery treat something as an agent only if it satisfies
  **`AgentLike`**: `{ role:{name}, getModel(), renderInitialPrompt(), … }`
  (`runner/types.ts:25`). CLI discovery keys on `isAgentShape` (role+mission)
  (`agent-cli/src/helpers/discover.ts:75`).
- Therefore **a composed pipeline can *execute* but cannot be *talked to*, discovered, or
  eval'd** as an agent.

### Why this generated all the sprawl

Every gap hit this session traces back to this one asymmetry — they are symptoms, not
independent features:

| Symptom (userland, canvas-workstation `query-surface/workflow/`) | Lines | Really is |
|---|---|---|
| `playground.ts` — hand-wraps the pipeline `Node` as a chat `Agent` (fresh bus/store/hooks/runner per call) | 496 | the missing **Node→Agent** adapter, done by hand |
| `structured-retry.ts` — bounded retry around a `Node` (its own header says "UPSTREAM … deletes this file") | 49 | a missing **Node-native retry** |
| `escalate.ts` — hand-rolled Loop-with-merge; header says "deps arrive by closure (**the framework-gap pattern**)" | 260 | missing **Loop-with-accumulator** + **Node DI** |
| "deps by closure" threaded through *every* builder | pervasive | missing **Node dependency injection** |
| sub-agent tool calls invisible in the playground | — | missing **tool-exec context / shared bus** (agent-as-tool) |

The tell: the gaps **all rhyme**. Random, unrelated gaps mean a rotten foundation; gaps
that all trace to one asymmetry mean you are one keystone away from *done with foundations*.

## 3. Was `Node` the wrong starting point? No.

`Node` is the **correct execution foundation** — typed `TIn→TOut` composition gives real
contracts on the data flow between steps (stronger than ADK, which passes a loosely-typed
shared session dict). Do **not** rewrite it.

The mistake was making `Agent` a **second, parallel root** instead of a **refinement of
Node**. The fix is to unify, not replace:

- **An `Agent` IS-A `Node`** — specifically a `Node<string,string>` (message in, message
  out) that *also* carries a `Role` identity and the render surface. `AgentStep` (Agent→Node)
  already fits this.
- **Add the missing direction — `asAgent(node, { role, coerceIn, renderOut })`** — promote
  *any* `Node<TIn,TOut>` into an `AgentLike`: give it a Role identity, coerce an incoming
  message → `TIn`, render `TOut` → message. Now
  `Sequential(fetch, curate, analyze, respond).asAgent({ role })` is **discoverable,
  chattable, and eval-able** — the pipeline finally *is* the agent, and `playground.ts`
  collapses to that one call.
- **Discovery already recognizes `AgentLike`** — so a promoted Node is discovered with no
  new machinery.

Composition closes. The Role algebra, the lens, provenance — all kept, now applying
uniformly to agents *and* pipelines.

## 4. What closing composition unlocks (the reordered roadmap)

Everything from the last several design turns reorganizes under the keystone. Sequenced:

1. **Keystone — closed composition.** `Agent` becomes a projection of `Node`; add
   `asAgent()` (Node→conversational + identity); discovery/server/runner treat a promoted
   pipeline exactly like an agent. *Deletes the 496-line hand-wrapper; makes "chain then
   talk/eval" work.*
2. **Node dependency injection.** Deps (runner/client/resolver/log) flow through
   `NodeRunContext`, not closures. *This IS the "pass knowledge/tools/skillsets around"
   algebra.* `NodeRunContext` today carries framework infra (runner/hooks/toolExecutor/
   scratchpad, `workflows/node.ts`) but no user-dep channel — add one. *Removes the
   pervasive "deps by closure" noise.*
3. **Agent-as-tool + shared bus (tool-exec context).** Give `ToolDefinition.execute` an
   optional context `{ emit, runId, traceId, parentToolCallId }` (core stays vendor-neutral:
   `emit` is a minimal sink, not runtime's `AgentEventBus`); thread the run's `eventBus`
   from `agent-runner.ts` → `toolbox-executor.ts` → `toolbox.execute(name, args, ctx)`.
   Then nested sub-agents (pipeline, CoordinatorStep, agent-as-tool) emit onto the parent
   bus → visible in chat/Live/Tools/Graph. *Note: `node-tool.ts` and `coordinator-step.ts`
   currently have **no** child→parent bus propagation — this fixes the general case, not
   just the pipeline.*
4. **First-class eval.** A typed-contract eval primitive on both `Agent` and `Node` (cases
   in, scores out) — promotes canvas-workstation's `__bench__/eval-*.ts` into the framework.
   *This is the "tune each against individual evals" ask, made native.*
5. **Bounded retry** (Node-native) → deletes `structured-retry.ts`.
6. **Loop-with-accumulator** — a Loop that folds/merges state between iterations
   (Scratchpad exists for FanOut merges; give Loop the same) → halves `escalate.ts`.

Result: `workflow/` collapses to **contracts + step logic + a clean `Sequential(...)`
composition**. The sprawl doesn't get refactored — it stops being necessary.

## 5. Scope / non-goals

- **Do not rewrite `Node`** — it's the right foundation. Unify `Agent` onto it.
- **Keep the Role algebra + lens + provenance** — the differentiator. Closing composition
  makes them apply to pipelines too.
- **Not ADK's loose shared-dict state** — keep typed `TIn→TOut` contracts on the seams.
- Persistence-per-call, the four-arm eval harness, and the direct-Google-vs-gateway runner
  choice are *consumer* concerns — the framework should make them optional hooks, not
  require the 496-line wrapper.

## 6. How you'll know the foundation is finally right

The diagnostic to end the "endless gaps" fear: when you hit the next gap, ask **does it
trace back to the core abstraction, or is it an independent leaf?** Today, everything traces
back (Agent/Node non-closure). After the keystone lands, a gap like "I want a `Race` node"
or "add a Redis exporter" is a **backlog**, not a wound. Foundational gaps that keep
tracing to the core → keep going. Independent leaf gaps → you're done with foundations and
have a healthy, growing framework.

## 7. Entry points for the build (grounding, so the dev agent doesn't re-derive)

- `packages/agent-runtime/src/workflows/sequential.ts` — `SequentialBuilder.build()` →
  `SequentialNode implements Node` (the thing to make promotable).
- `packages/agent-runtime/src/workflows/node.ts` — `Node`, `NodeRunContext`, `NodeResult`
  (DI channel goes here).
- `packages/agent-runtime/src/workflows/agent-step.ts` — the existing Agent→Node bridge;
  the model for the reverse.
- `packages/agent-runtime/src/runner/types.ts:25` — `AgentLike` (the surface `asAgent()`
  must synthesize).
- `packages/agent-core/src/molecules/toolbox.ts` — `ToolDefinition.execute` (add the
  optional context param).
- `packages/agent-runtime/src/runner/{agent-runner.ts,toolbox-executor.ts,sdk-bridge.ts}` —
  where the run's `eventBus` gets threaded into tool execution.
- `packages/agent-cli/src/helpers/discover.ts:75` — `isAgentShape` (already recognizes any
  `AgentLike`, so promoted Nodes get discovered for free).
- Consumer evidence: `~/retrieval-agent-2.0/canvas-workstation/src/query-surface/workflow/`
  — `playground.ts` (496), `escalate.ts` (260), `structured-retry.ts` (49) are the userland
  code that closing composition + DI + retry/loop primitives collapse.

## 8. One-line summary

You built a great Role algebra on a correct typed-Node foundation, but left **Agent and
Node as two roots** — so a chain of agents isn't itself an agent. Make `Agent` a projection
of `Node` and add `asAgent()`; composition closes, and "talk to each agent → eval each →
chain them and talk to / eval the chain" all fall out — with every downstream sprawl file
deleted or collapsed.
