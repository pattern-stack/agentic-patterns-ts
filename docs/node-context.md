# Node context & runner threading — how a run's runner + scratchpad reach every subagent

> Status: **DESIGN / PLAN (LOCKED)** (2026-07-03). Companion to `docs/store-family.md`.
> This doc owns the two tracks that are **not Stores** but are what let canvas-workstation's
> `with-persistence.ts` dissolve: **#116** (per-node runner policy) and **#99** (scratchpad +
> deps propagation across the agent-as-tool seam). Plus the deferred **AgentNode ↔ Node-world**
> consolidation. All claims below were verified against the runtime source and the downstream
> consumer (`~/retrieval-agent-2.0/canvas-workstation`) on 2026-07-03.

## Background: what a run threads down the Node tree

Every `Node` receives a `NodeRunContext` (`workflows/node.ts:28`):

```ts
interface NodeRunContext {
  readonly runner: RunnerProtocol;      // the LLM executor
  readonly toolExecutor?: ToolExecutor;
  readonly scratchpad?: Scratchpad;     // run-scoped shared state (slot.ts)
  readonly deps?: DepReader;            // injected clients/resolvers (deps.ts)
  readonly traceId?: string;
  readonly parentSpanId?: string;
}
```

Composites (Sequential/Parallel/FanOut/CoordinatorStep) propagate it to children via `{ ...ctx }`.
Two fields are the subject of this doc: **`runner`** (#116) and **`scratchpad`** (#99). Both are
*ambient* today — threaded by reference — and both hit the same wall: they can't cross the
**runner → tool** boundary, where an agent-as-tool subagent actually executes.

## Where our `Runner` sits (the ADK split)

Our `Runner` is **not** the ADK agent — it's the *executor half* of ADK's fat `Runner`. ADK's one
`Runner` does three jobs; we split them:

| ADK `Runner` does… | …in our world |
|---|---|
| run the LLM + tool loop for one agent | **`AgentRunner`** (`RunnerProtocol.run` / `runStructured`) |
| carry the services (session/memory/artifact) into that run | **`NodeRunContext`** (`{ runner, scratchpad, deps, … }`) threaded down the call-tree |
| orchestrate multiple agents | the **composites** (`Sequential`/`Parallel`/`CoordinatorStep`) *or* **`AgencyRuntime`** |

`AgentRunner` only turns `(agent, message) → response`. It holds no stores and orchestrates no one.
That narrowness is what lets the same runner power a Node graph, a coordinator, or an `AgentNode`.
The `Role` layer (`Role = Persona + Judgments + Capabilities + Responsibilities`) has **no ADK
equivalent** — it's our reusable template below `Agent`, and it's the thing that keeps sibling
subagents from drifting (persona/judgments tuned in one place). It is the "clean clear consistency
between subagents" mechanism.

---

## #116 — Per-node runner / execution policy

### The problem (verified)

Per-node **model** override already exists: `AgentStepSpec.model` → `applyStepModel` (`base.ts:169`).
But its own comment (`base.ts:168`) is explicit: *"a per-step agent view with a different declared
model, **NOT a per-step runner**."* The runner is ambient — one `ctx.runner`, threaded by reference
(`node.ts:29`). There is **no way to declare "this node runs on a different runner."**

The consequence is canvas-workstation's **runner closure hack** (`with-persistence.ts:124-133`):
to force one subtree onto a direct-Google `LanguageModelV2` (because ambient `AP_GATEWAY_*` flips
`createRunner` into resolver mode → structured output routes through a gateway that rejects
json-schema `responseFormat` → classify fails 100%), the code builds its own runner and **overwrites
`ctx.runner`** in a hand-written decorator:

```ts
baseRunner = (await createRunner({ model: google(opts.model), … })).runner;
const { runner } = countingRunner(baseRunner);
const childCtx: NodeRunContext = { ...ctx, runner, hooks };   // ← the hack
const res = await node.run(input, childCtx);
```

The node's real requirement ("I need native structured output") is **invisible in its declaration**
and lives out-of-band in a wrapper. That is exactly the inconsistency the north star rejects.

### The fix

Make runner a **declarative per-node property**, and provide a blessed **subtree** override that
formalizes the hack:

1. Add `runner?: RunnerProtocol` to `AgentStepSpec` (`agent-step.ts:44`) and `CoordinatorStepSpec`
   (`coordinator-step.ts:69`).
2. In `AgentStep.run`, resolve `const runner = this.spec.runner ?? ctx.runner;` and route the
   `run` / `runStructured` calls through it (`agent-step.ts:114,117,127`).
3. Add a `withRunner(node, runner)` combinator (new, `workflows/`) that returns a `Node` running
   `inner.run(input, { ...ctx, runner })` — the *declared* version of the closure hack, for when a
   whole subtree (e.g. the four pipeline organs) needs one runner.

Result: canvas-workstation's override becomes `withRunner(pipelineNode, directGoogleRunner)` declared
at assembly, visible in review — not a decorator that rewrites context.

### Open design choice (decide during impl)

- **v1 (recommended):** the override is a raw `RunnerProtocol` instance — pragmatic, minimal, and a
  1:1 replacement for what the hack already builds.
- **future:** a capability/policy requirement (`requires: { structuredOutput: 'native' }`) that the
  runtime resolves to a satisfying runner. More elegant, more machinery — defer until a second case
  appears.

Interaction: a per-node runner override and the existing per-node *model* override are orthogonal.
A concrete runner override also sidesteps the "model override only bites with a resolver-backed
runner" caveat for that node.

---

## #99 — Scratchpad + deps propagation across the agent-as-tool seam

### The problem (verified)

The `Scratchpad` (`workflows/slot.ts`) is the run-scoped shared-context primitive — run-scope shared
across the tree, branch-scope forked per Parallel/FanOut branch and merged back deterministically.
It **is** the mechanism by which delegated subagents share context. But it is **not workflow-only**:
a coordinator handing to truly-delegated subagents needs it too, and it currently doesn't get it.

Why: an agent-as-tool subagent doesn't run in the Node call-tree — it runs **inside the runner's
tool loop**, and the only object that crosses that runner → tool boundary is core's
**`ToolExecutionContext`** (`core/molecules/toolbox.ts:29`), which carries `emit / runId / traceId /
parentToolCallId`. The runner builds it per tool-call in `buildToolCtx` (`agent-runner.ts:207`).
`nodeTool` already reads the *trace* fields from it (`node-tool.ts:60-62`, the #102 work) — but takes
`scratchpad` and `deps` from a **construction-time closure**, not from the live context:

```ts
// node-tool.ts:55 — the re-root
spec.node.run(input, {
  runner,
  scratchpad: scratchpad ?? createScratchpad(),   // ← closure / fresh, NOT the caller's  ✗
  deps,                                            // ← closure, NOT the caller's          ✗
  traceId: ctx?.traceId,                           // ← from the boundary ctx              ✓
  parentSpanId: ctx?.parentToolCallId,             // ← from the boundary ctx              ✓
});
```

Its own comment names this: *"Automatic parent→child propagation across the agent-as-tool seam is
scoped to #99/#102."* Trace already rides the rail; scratchpad/deps don't yet. **This is #99.**

### The fix — **Design A** (chosen): ride the same rail via an opaque passthrough

The scratchpad must travel *through* the runner. Put it on the one object that already crosses the
boundary, as an **opaque passthrough field** — the exact philosophy `emit` uses (core declares a
slot; the host wires the meaning). Core stays dependency-clean (the field is `unknown`; core never
imports runtime's `Scratchpad`/`DepReader`).

```
AgentStep.run(ctx)                              has ctx.scratchpad ✓
  └─ runner.runStructured(agent, msg, { …opts, host:{scratchpad,deps} })   ← (2) carry on RunOptions
       └─ [LLM emits tool call]
            └─ buildToolCtx() → ToolExecutionContext{ …trace, host }        ← (3) copy one field
                 └─ NodeToolbox tool.execute(args, ctx)
                      └─ nodeTool → spec.node.run(input, {
                           scratchpad: ctx.host.scratchpad.fork() ?? fresh, ← (4) inherit, fork
                           deps:       ctx.host.deps ?? deps,
                         })
```

Four small, additive edits:

1. **core `ToolExecutionContext`** (`toolbox.ts:29`) — add `readonly host?: unknown;` (opaque; doc it
   like `emit`: "host-declared passthrough; core never interprets it").
2. **runtime `RunOptions`** (`runner/types.ts:113`) — add `host?: unknown;`.
3. **`AgentStep.run`** (`agent-step.ts:105`) — set `host: { scratchpad: ctx.scratchpad, deps: ctx.deps }`
   in the `RunOptions` it passes to the runner. (CoordinatorStep inherits this via `AgentStep`.)
4. **runner `buildToolCtx`** (`agent-runner.ts:207`) — copy `options.host` onto the returned
   `ToolExecutionContext` (thread `options.host` into `buildToolCtx`'s args — impl detail; there are
   three dispatch sites the doc-comment already notes converge here).
5. **`nodeTool`** (`node-tool.ts:57`) — read `const host = ctx?.host as { scratchpad?: Scratchpad;
   deps?: DepReader } | undefined;` and prefer `host?.scratchpad` (forked — see below) over the
   closure/fresh, and `host?.deps` over the closure.

### The one semantic decision: **fork, don't alias**

A coordinator's LLM can fire tool calls **in parallel** (`agent-runner.ts:118`). Sharing one mutable
scratchpad by reference across parallel subagent calls reintroduces the exact race the run/branch
split was built to prevent. So the seam passes **`parentScratchpad.fork()`** (`slot.ts:127`), not the
raw instance:

- **run-scoped slots** → shared by reference through the fork → the subagent reads/writes the same
  shared state (*the ask*).
- **branch-scoped slots** → fresh per subagent call → concurrency-safe.

Merge-back (`join()`) is **off for v1**, matching "a branch with no `merge` discards its scratch" —
call-and-return delegation has no clean index order to merge on. Revisit only if a use case needs it.

### What it unlocks (the mental model)

The scratchpad is per-**run** state (in `NodeRunContext`), *not* a build-time field on the agent.
With #99 in place, you run the top node with a scratchpad and it flows to every subagent with **no
wiring**:

```ts
const coordinator = delegateTo(runner, [dataAgent, dealResolver, answerAgent]);   // subagents=[…]
await coordinator.run(input, { runner, scratchpad });   // ← scratchpad now reaches every subagent
```

Today that requires threading `scratchpad` into `delegateTo(…, { scratchpad })` by hand (and even
then it's captured, not inherited). #99 makes it ambient.

### Tests to add

- Coordinator writes a run-scoped slot, delegates to a subagent that reads it → subagent sees the
  value.
- Two subagent tool-calls in parallel each write a branch-scoped slot → no clobber (isolated forks).
- Deps declared at the root are readable inside a delegated subagent (same rail).

---

## `toolExecutor` at the same seam — **derive, don't forward**

`toolExecutor` is the third `NodeRunContext` field that meets the runner → tool boundary
(`node.ts:32`), and it exposed the same class of bug as #99: a delegated subagent got **no executor
for its OWN tools**. The coordinator's LLM routes to the subagent fine (the team executor
`CoordinatorStep` derives covers the *team* tools one level up), but when the subagent's own LLM then
calls one of *its* tools, every call returned `{ error: "No tool executor configured" }` and the
subagent answered "data unavailable". Root cause: `nodeTool` re-roots the sub-run ctx **without** a
`toolExecutor` (correctly — see below), and `AgentStep` only forwarded `ctx.toolExecutor`, never
deriving one from the agent it runs.

The resolution is the **opposite** of #99/#102's. Trace, scratchpad, and deps are *parent run state*
that must be **forwarded** across the seam because they can't be reconstructed. A `toolExecutor` is
**not** parent state — it is a pure function of the agent (`createToolboxExecutor(agent)`), and each
agent needs **its own**: forwarding the coordinator's executor to a subagent would wrongly expose the
coordinator's tools instead of the subagent's. That is exactly *why* `nodeTool` does not forward
`toolExecutor` — and the fix is not to start forwarding it, but to **derive** it at the leaf:

```ts
// agent-step.ts — AgentStep.run
const toolExecutor = ctx.toolExecutor ?? deriveToolboxExecutor(agent);
```

- **Explicit wins.** An executor already in `ctx.toolExecutor` (e.g. `CoordinatorStep`'s team
  executor, covering team + the coordinator's direct tools) is used verbatim — `deriveToolboxExecutor`
  never runs. `CoordinatorStep` is unchanged and byte-identical.
- **Capability-less is byte-identical.** `deriveToolboxExecutor` returns `undefined` when the agent
  has no capabilities (a structural, non-`instanceof` check — the repo's dual-core makes `instanceof
  Agent` unreliable across the package boundary), so `RunOptions.toolExecutor` stays unset exactly as
  before. A tool-less agent can't emit a tool call anyway.
- **General, not seam-local.** Because the derivation lives in `AgentStep` (the one node that holds a
  concrete agent), it fixes *every* AgentStep leaf — not just `delegateTo`, but any bare
  `Sequential`/`Parallel`/`Loop` of agents that carry their own capabilities. Behavioral note:
  tool calls in such bare pipelines that were **silently no-ops** now execute — intended.

This is the last of the three boundary fields to be reconciled: trace rides the rail (#102),
scratchpad/deps ride the rail (#99), and the executor is derived per-agent at the leaf.

---

## Deferred-with-intent: AgentNode ↔ Node-world consolidation

We have **two agent-orchestration paradigms**, and they overlap at the continuity layer:

| | **Node world** (AgentStep / CoordinatorStep / Sequential / Parallel / NodeToolbox) | **Agency world** (`AgentNode` / `AgencyRuntime`) |
|---|---|---|
| shape | typed in-process **call-tree** — `run(input, ctx) → typed output` | event-driven **actor mesh** — long-lived mailbox workers |
| coordination | deterministic (Seq/Par) *or* model-driven routing (Coordinator) | async peer messaging over `SandboxEventBus` |
| data flow | typed returns + `Scratchpad` in `NodeRunContext` | messages on the bus |
| continuity | `AgentStep` + (future) `ConversationStore` | **hand-rolled** `_conversation: CanonicalMessage[]` (`agent-node.ts:86,279`) |

`AgentNode` is **not** a duplicate of `AgentRunner` — it *uses* one (`agent-node.ts:263`). The real
overlap is **orchestration + continuity**: `AgentNode` re-implements by hand (its worker loop:
format → `runner.run` → append request/response → continue) what the Node world gets from `AgentStep`
+ a `ConversationStore` + `Scratchpad`.

**Stance:** the Node world is the spine for "a unified conversational agent around sequential/parallel
nodes." The Agency actor-mesh is a separate, heavier capability (autonomous peers). **Not in scope
this session.** The consolidation — re-base `AgentNode`'s continuity onto `ConversationStore` and its
run onto `AgentStep`/runner, so there's one execution+continuity core with two *entry* paradigms
(call-tree vs mailbox) — is a filed follow-up. It **depends on #118** (ConversationStore) landing
first, which is a tidy argument that we're sequencing correctly.
