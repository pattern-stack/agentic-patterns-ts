---
name: build-on-agentic-patterns
description: How to build agents and products on the @agentic-patterns framework — register agents the convention way (`ap` discovers any Agent exported from an `agents/<name>/agent.ts`), treat the framework as a compositional algebra (Capability = Toolbox+Manual+Playbook; Role = Persona+Judgments+Capabilities+Responsibilities), declare per-conversation identity via SessionScope (requireScope/readScope in tools, Awareness.fromScope for prompt identity), and compose multiple steps/agents through the typed Node layer (AgentStep/FunctionStep, the sequentialAgent/parallelAgent stage sugar with typed emit + input:'prior', Sequential/Parallel/FanOut/Loop, Scratchpad, agent-as-tool, CoordinatorStep) — not a prompt-assembly library. Use when scaffolding or extending an agent, toolbox, capability, playbook, manual, or role, when wiring a multi-step workflow or a model-driven coordinator over subagents, when an agent "doesn't show up" in `ap playground`, or when a build "isn't working" (tools no-op, prompt edits do nothing, an agent is one giant mission string).
when_to_use: "build an agent on agentic-patterns", "register / discover an agent", "my agent doesn't show up in the playground / `ap agents`", "point ap at a folder of agents", "add a toolbox / capability / playbook / manual / role", "scaffold a new agent project", "compose a workflow / pipeline of steps", "make a coordinator that routes to subagents", "agent-as-a-tool", "my tools aren't firing", "the model says the tool errored", "where does this prompt text go", "declare a session scope / per-user config", "requireScope threw ScopeUnavailableError", "instantiateDefaults is deprecated, what replaces it", working in a repo that imports @pattern-stack/agentic-core or @pattern-stack/agentic-runtime.
# --- SDLC metadata (documentation only; not consumed by the Claude Code runtime) ---
status: active
---

# Building on @agentic-patterns

**The one rule: this framework is a compositional algebra, not a prompt-assembly library.** Almost every failed build comes from treating it as the latter — pouring all the agent's knowledge into one giant `mission` string and leaving every other slot empty. Don't. You are *placing knowledge into the slot that fits its kind*, then composing the slots upward.

> `Agent = Role × Background × Awareness × Mission` · `Role = Persona + Judgments + Capabilities + Responsibilities` · `Capability = Toolbox + Manual? + Playbook?`

## 0. Register & run (how `ap` discovers your agent)

Before any of the algebra matters, your agent has to be *found*. Discovery is **convention-bounded + type-driven**: a glob decides which files get imported, and within those files `ap` keeps whatever export **is an Agent** — by structural shape, so the export name is irrelevant.

**Convention:** one agent per folder, at `agents/<name>/agent.{ts,js,mjs}`. Discovery is recursive, so a nested `{domain}/agents/<name>/agent.ts` is found too (point `ap` at an umbrella and it sweeps every domain).

**Export any of these — all discovered, no registration wrapper required:**

```ts
// 1. bare default — the simplest form
export default buildMyAgent();

// 2. a named `rootAgent` (the conventional name)
export const rootAgent = buildMyAgent();

// 3. any named export that is an Agent — multiple per file is fine
export const reviewer = buildReviewer();
export const planner  = buildPlanner();

// 4. a factory (sync/async) returning an Agent or a registration
export default () => buildMyAgent();

// 5. the explicit registration (use when you want a custom id/name/description,
//    or several agents with hand-set ids in one file)
export default { id: "my-agent", name: "My Agent", description: "…", agent: buildMyAgent() };
```

> **Factory caveat:** the factory form (#4) is invoked only for `default` and `rootAgent` exports. A *named* export must be an **already-built Agent** — `export const reviewer = buildReviewer()`, not `() => buildReviewer()` (a named function export is skipped, not called).

**Identity is inferred** when you don't set it: the **name** comes from a meaningful export key (`reviewerAgent` → `Reviewer`), else the folder/filename; the **id** is that local name, **namespaced by `{domain}`** when the file sits under a nested `{domain}/agents/…` (`dealbrain/agents/retrieval/agent.ts` → `dealbrain/retrieval`). A top-level `agents/` stays un-namespaced. Namespacing means two domains can each ship a `retrieval` agent with no collision.

**Don't set the runner.** `ap` injects it after discovery via `createRunner()` (env-detected — see §5 "Provider surprise"). Your file exports only the Agent.

**Run it:**

```bash
ap playground                 # discover this project's agents/ + open the dashboard
ap playground <dir>           # point at any agents root → discover every child recursively
ap playground --agents-dir <dir>   # same, as a flag
ap agents                     # list what was discovered (+ any load errors)
ap run <id> "your message"    # chat in the terminal — no browser
```

If an agent "doesn't show up": check the file is under the discovery glob, that it actually **exports an Agent** (a built `Agent`, not a Role or a config), and read `ap agents` — a file with no Agent export reports a clear load error rather than failing silently. Detection is structural (duck-typed on `role`/`mission`/`awareness`/`background`), so it works even when your agent imports core through a built `dist/` entry.

**Session-scoped agents** use the explicit registration form (#5) plus one more field, `scope` — see §1.

## 1. Session scope: per-conversation identity

Who's asking, which tenant, which tier — per-conversation identity is a **declared** scope, not ad-hoc deps threaded by hand. Add one field to the wrapper registration (§0 form #5):

```ts
import { sessionScope, scopeItem, type ScopeValue, Awareness } from "@pattern-stack/agentic-core";
import { requireScope } from "@pattern-stack/agentic-runtime";
import { z } from "zod";

const supportDeskScope = sessionScope(
  {
    operator: scopeItem(z.string().email(), { description: "The support agent this run is scoped to" }),
    tier: scopeItem(z.enum(["free", "pro", "enterprise"]), { description: "Customer plan tier" }),
    apiKey: scopeItem(z.string().optional(), { description: "Upstream helpdesk API key", redact: true }),
  },
  { defaults: { operator: "duty@support.example", tier: "free" }, presets: { "enterprise on-call": { /* … */ } } },
);
type SupportDeskScope = ScopeValue<typeof supportDeskScope>;

export default { id: "support-desk", name: "Support Desk", agent: buildSupportDeskAgent(), scope: supportDeskScope };
```

`sessionScope(items, { defaults, presets })` composes each field's Zod schema into one object schema (the shipped examples also write `new SessionScope(items, options)` — same constructor, either form works). It **subsumes** the older `instantiateDefaults`/`contextRedactKeys` wrapper fields (deprecated) — declare a scope instead of hand-rolling both. `defaults` and every named `preset` are validated against the composed schema **at construction**, so a malformed declaration throws at agent-authoring time, not at first request. Wire behavior, in one breath: the server validates the incoming scope on `POST /conversations` (malformed input is a 400 carrying the raw zod `issues`), redacts every `redact: true` field down to `"[redacted]"` in echoes/logs, and injects the *unredacted* parsed value onto every turn for the rest of the conversation.

**Reading scope in tools — two legitimate styles:**

- **Mode A — closure capture** (`examples/agents/workspace`): pair `scope` with an `instantiate(context)` hook on the wrapper; it re-`parse`s the incoming context and rebuilds the agent, so a toolbox's constructor closes over one fixed, typed scope value. Reach for this when a tool needs the value at *construction* time — e.g. to build a per-user backend client — but know it means one fresh agent per conversation.
- **Mode B — call-time reads** (`examples/agents/support-desk`): declare `scope` on the wrapper with **no** `instantiate` hook. The agent is built once, at module load; each tool reads the live value at dispatch time instead:
  ```ts
  execute: async (_args, ctx?: ToolExecutionContext) => {
    const scope = requireScope(ctx) as SupportDeskScope;   // throws ScopeUnavailableError if absent
    return { operator: scope.operator, tier: scope.tier };
  },
  ```
  `requireScope(ctx)` is the fail-loud default read path. `readScope(ctx)` is the soft twin (returns `undefined` instead of throwing) — use it only for a tool that must genuinely tolerate running scope-less. `readScopeAs<T>(ctx)` is the same soft read with a typed cast; it trusts the server already ran `scope.parse()` and deliberately does **not** re-parse per call. All three (from `@pattern-stack/agentic-runtime`) accept either a tool's `ToolExecutionContext` (`ctx.host.scope`) or a node's `NodeRunContext` (`ctx.scope` — see §7). Default to Mode B; reach for Mode A only when a tool must build something at construction time.

**Prompt identity — `Awareness.fromScope`.** Render the "who am I acting for" line from the scope itself, on ONE shared `Awareness` instance instead of rebuilding the agent:

```ts
const supportDeskAwareness = Awareness.fromScope(
  supportDeskScope,
  (s) => `Acting for ${s.operator}, scoped to the ${s.tier} tier.`,
);
```

Pure text-from-scope — no fetching, no side effects. `toPrompt(ctx)` appends the rendered line when a render-time `ctx.scope` is supplied and renders byte-identically (no line) when it isn't, so the same instance serves every conversation. `instantiate` stays the escape hatch for genuinely async, per-conversation assembly (building a client, warming a cache) — don't reach for it just to get scope-aware text, and don't rebuild the whole agent per message.

**Playground — presets are named identity combos.** A scope's `presets` (`"enterprise on-call"`, `"sam @ acme"`) surface in the playground's typed scope form as one-click switches — "test as this user" without hand-typing a JSON body every time.

## 2. The slot table (read this first)

When you have a piece of knowledge, find its row before you write a line of code:

| What you have | Goes in | NOT in |
|---|---|---|
| A raw external action — one HTTP call / one verb | **Toolbox** tool (`{description, parameters: zod, execute}`) | a play; mission text |
| A validated, named, multi-step recipe (rank→window→cite) | **Playbook** play | frozen in code; re-taught in the prompt |
| Domain reference / how-the-data-works / DSL guide | **Manual** (sectioned `ManualSection`s) | the mission |
| A stable decision rule ("prefer not-enough-evidence over guessing") | **Judgment** | `persona.principles`; the mission |
| Who the agent is (identity, tone, priorities) | **Persona** | the mission |
| HOW the agent communicates — a reusable voice with examples + anti-patterns | **Tone** (`role.withTone(...)`) | the persona `tone` string (fine for one-liners; Tone when it deserves examples) |
| HOW the agent works — a work protocol with a checklist | **Methodology** (`role.withMethodology(...)`) | the mission; a judgment's heuristics (those are *decision* rules) |
| What to do when a step fails (retry policy, escalation) | **Recovery** (`role.withRecovery(...)`) | the mission; scattered "if that fails…" prose |
| What the agent is accountable for | **Responsibility** | the mission |
| Per-run grounding (this deal, this user, as-of) | **Mission**, rendered from a context `AgenticModel` | hardcoded strings; a fat protocol |
| The mutable backend (API client, secret, store) | **injected into the Toolbox via a factory** (closure capture) | a module global; the prompt |
| Per-conversation identity/config (user, tenant, tier) | **SessionScope** on the wrapper (§1) + `requireScope`/`readScope` in tools | `host.deps`; closures baked at module load; hand-rolled `instantiateDefaults` |

If your mission is more than ~objective + success-criteria + grounding, knowledge has leaked into the wrong slot. Move it.

## 3. The layout (toolshed / roles / agents)

Proven structure. Dependency arrows point **down only**: `cli → agents → roles → toolshed → lib`. The `agents/<name>/agent.ts` files are exactly the entry points §0's discovery loads.

```
src/                           (library code — toolboxes, roles, etc. may live here or in packages)
  lib/                       generic, app-agnostic substrate (rest-client, etc.)
  toolshed/<context>/        a bounded context = the tool store for one external system
    toolbox.ts               canonical export: a Toolbox subclass (raw verbs)
    endpoints.ts             first-class endpoint fns the toolbox wraps
    manual.ts                <Context>Manual — sectioned reference (optional slot)
    playbook.ts              <Context>Playbook — validated recipes as plays (optional slot)
    capabilities.ts          buildXCapability(deps) factories + a CapabilityResolver
    index.ts                 thin barrel — agents import ONLY from here
  roles/                     the assembly library (no I/O)
    judgments.ts personas.ts <role>.ts   named, reusable
agents/<name>/               composition ONLY — Role × Mission(context) × deps wiring
  agent.ts                   ← the discovered entry: exports the built Agent (§0)
  persona.ts mission.ts tools.ts
runtime/                     env/model config + non-agent consumption regimes
```

Vocabulary: **toolshed** (the store) · **toolbox** (one bounded context, exported from `toolbox.ts`) · **tools** (what an agent wires up). New agent behaviors are new *assemblies* (a role/agent file), not new tools or new prompt text.

## 4. The build recipe

Bottom-up. Each step fills one slot; factories take a `deps` bundle so live clients/secrets stay out of the library.

1. **Toolbox** — subclass `Toolbox`; `tools` is a `Record<name, ToolDefinition>`. Each `execute` closes over the injected client. Expose via `buildXToolbox(deps)`.
2. **Manual** *(optional)* — `ManualSection`s of domain reference. `manual.scoped([...])` gives progressive disclosure (full sections + a TOC of the rest).
3. **Playbook** *(optional)* — subclass `Playbook`; `plays` are named recipes; `Playbook.execute` returns an `{ error }` envelope instead of throwing (so a malformed play can't abort the loop). A play may declare `returns: z.object({...})` alongside `parameters` — the output shape is erased at runtime otherwise, and `returns` makes it visible to consumers like the Tool Workbench. Expose via `buildXPlaybook(deps)`.
4. **Capability** — `new Capability(name, description, toolbox, manual?, playbook?)`. **Toolbox is required.** Wrap in `buildXCapability(deps)`:
   ```ts
   export function buildQuerySurfaceCapability(deps: QueryDeps): Capability {
     return new Capability(
       'query-surface',
       'Read the data graph + evidence index by hand: describe, search/rank, fetch.',
       new QuerySurfaceToolbox(deps.client),   // ← real toolbox, client injected
       querySurfaceManual,                      // ← Manual slot populated
     );
   }
   ```
5. **Judgment + Persona** (`roles/`) — decision rules and identity as named exports. **Don't start from zero:** `@pattern-stack/agentic-runtime` ships preset judgments (`RETRIEVAL_STRATEGY`, `EVIDENCE_QUALITY`, `ROUTING`, `QUALITY_REVIEW`, …), responsibilities, and whole roles (`retrievalRole`, `analystRole`, `coordinatorRole`) — clone or compose those before authoring new ones.
6. **Role** — `new RoleBuilder(name).withPersona(p).withJudgment(j).withCapability(c).withDefaultModel(id).build()`. Requires a persona. Optional knowledge slots: `.withTone(t)` (voice with examples/anti-patterns, renders under `### Tone` and wins over the persona tone string), `.withMethodology(m)` (work protocol + checklist, leads `## Methodology`), `.withRecovery(r)` (failure policy, renders as `### Recovery` under Boundaries).
7. **Mission** — thin: `new Mission({ objective, successCriteria, /* grounding rendered from a context AgenticModel */ })`. No protocol text.
8. **Agent** — `new AgentBuilder(role).withMission(m).withModel(id).build()`. Requires a mission. **This built Agent is what your `agents/<name>/agent.ts` exports** (§0).
9. **Run** — `ap playground` / `ap run` wire the bus + exporter + executor for you. When driving `AgentRunner` directly, wire **the executor** yourself:
   ```ts
   const bus = new AgentEventBus();
   new ConsoleExporter().attach(bus);                 // also unmasks gate behavior
   const { runner } = await createRunner({ eventBus: bus, tier });
   const toolExecutor = createToolboxExecutor(agent); // ← do NOT skip this
   await runner.run(agent, message, { toolExecutor, eventBus: bus, maxIterations: 12 });
   ```
   **Gate destructive tools.** The runtime ships a gate chain (safety / approval / rate-limit / audit). The moment an agent gets a tool that writes or deletes, attach `HumanApprovalGate` (or the relevant gate) to the bus alongside the exporter — that's the "gate behavior" the `ConsoleExporter` surfaces.
10. **Declarative route** *(optional)* — export `createXResolver(deps): CapabilityResolver` (name → live `Capability`), then `buildAgentFromConfig(config, { resolver })` where `config.capabilities` is `string[]`. The `roleTemplate` accepts the same knowledge slots (`tone`/`methodology`/`recovery` as plain data). The library never touches credentials; the app supplies `deps`.

**Where the prompt text goes (one path).** `agent.renderInitialPrompt()` is the single section-composed prompt every runner ships: Identity → Boundaries → Capabilities → Context → Mission → Methodology. `agent.renderSections()` returns the same content as `{name, source, text}[]` with role-vs-instance provenance; `role.toPrompt()` previews just the role half. There is no separate `getSystemPrompt()` path anymore (removed in core 0.9.0) — if a slot edit "does nothing", check the slot is actually wired into the Role, not whether you hit the right render path.

## 5. Anti-patterns (the reasons builds fail)

- **Agent doesn't appear.** The file exports a Role, a config object, or a *factory that returns the wrong thing* — not a built Agent. → Export the result of `new AgentBuilder(role)…build()` (or a registration `{ agent }`). `ap agents` prints a load error for files with no Agent export; read it.
- **Fat mission.** A 90-line hand-walked protocol in `mission`. → Discipline → `Judgment`; how-to → `Manual`; the recipe itself → a `Playbook` play. Mission keeps only objective + success-criteria + per-run grounding.
- **`EmptyToolbox`.** Reaching for a toolbox-less capability to expose "plays only" (a stub `Toolbox` with `tools = {}`). The toolbox is the **required atom** — faking it is the canonical smell. What you actually want is *curated exposure* (hide raw verbs, show plays): that's a framework exposure feature, **not** a toolbox-less capability. **Today:** give the capability the real verbs its plays compose, or keep the play-only capability *library-resident* (exported/tested, consumed by no role) until the exposure feature lands.
- **Forgotten executor.** Build an agent with tools, call `runner.run(agent, msg)` without `toolExecutor` → every tool call silently returns `{ error: "No tool executor configured" }`, the loop continues, nothing throws. *Symptom:* "my tools aren't firing" / "the model says the tool errored." → Always pass `toolExecutor: createToolboxExecutor(agent)`. (`ap playground`/`ap run` and the HTTP entry points wire it for you; the low-level `AgentRunner.run` does not.)
- **Deps via globals.** There is still no `RunContext`-into-every-tool channel for *arbitrary* deps (a known framework gap) — `host.deps` is a `DepReader`, not a general bag. → **Closure capture**: a factory takes `deps = { context, client }`; the toolbox/playbook close over it. Mark the site `// FRAMEWORK GAP: deps injection`. **Exception:** per-conversation *identity/config* is no longer in this gap — declare a `SessionScope` (§1) and read it with `requireScope`/`readScope` instead of closure-capturing it.
- **Scope in `host.deps`.** Stuffing a parsed scope value into the deps bag because "it's just another dep." → `host.deps` is a `DepReader` — a plain scope object there crashes the first `ctx.deps.get()` a leaf makes. Scope rides as the sibling `host.scope` key; read it via `requireScope`/`readScope`/`readScopeAs`, never `ctx.deps`.
- **Re-parsing scope per tool call.** Calling `scope.parse(...)` again inside a tool "to be safe." → The server already validated it once on `POST /conversations`; every accessor (`readScopeAs<T>`, `Awareness.fromScope`'s render fn) is explicitly a **cast, not a validation**. Re-parsing means shipping the whole `SessionScope` instance down every seam just to read one field — don't.
- **Mutating the scope bag.** `ctx.host.scope.tier = "enterprise"` (or similar) to fake a different identity mid-run. → The bag is frozen at the injection seam (shared by every render and every tool read for the conversation's life) — a write throws. Build a new conversation with a different scope instead.
- **Baking identity into closures at module load.** Hardcoding `const operator = "duty@support.example"` (or reading it from an env var) instead of declaring a scope field. → If the value should vary per conversation/user, it belongs in a declared `SessionScope`, read via Mode A or Mode B (§1) — not frozen into the module at import time.
- **Secrets in `defaults`/`presets`.** Putting a real API key in a scope's `defaults` or a named `preset` because `redact: true` is set on the field. → Redaction is **echo-only** — it masks what's shown back in responses/logs, not what's stored or served. `defaults`/`presets` are served verbatim to whoever can hit `POST /conversations`. Use `redact` for values a legitimate caller supplies per-run; never for baked-in secrets.
- **Provider surprise.** `createRunner` env-detects in priority order (`ANTHROPIC_API_KEY` → … → `OLLAMA_HOST`). For a local model: set `OLLAMA_HOST`, blank competing keys (`ANTHROPIC_API_KEY=`). `@ai-sdk/*` packages must be hand-installed for non-Ollama providers; Ollama works out of the box. With **no** provider env set, `createRunner` falls back to the local `claude` CLI runner if `claude` is on PATH — which emits a *limited event vocabulary*, so the graph/trace can look sparse; set a real key to get full events.
- **Extract without assemble** (the subtle one). You correctly move discipline → `Judgment`, recipe → `Playbook`, how-to → `Manual` — and *stop there*, leaving the running agents on their old fat missions. Now the knowledge lives in **two** places and the agents ignore the slots. Extracting is half the job: **rewire the agents to consume the slots and delete the fat-mission copies.**
- **Backward dependency arrow.** A toolbox/capability factory that takes an *agent-level* `deps` bundle creates `toolshed → agents` — a backward arrow (often a cycle). A factory should take **only what it uses** (the client/secret), not the agent's run-context bundle. Keep arrows one-way: `cli → agents → roles → toolshed → lib`.
- **Promoted-pipeline bare Build pages.** Every `asAgent` mount renders EMPTY playground Build pages (Universe "declares no capabilities", Roles persona blank) — regardless of what you pass: `asAgent` uses a full core `Role` ONLY to render the system prompt, then registers `role: { name }` + `getTools: () => []` unconditionally (as-agent.ts). This narrowing is deliberately load-bearing: the registered role drives the server's `deriveToolboxExecutor`, and carrying capabilities on the promoted shell would arm an OUTER executor that shadows nested `AgentStep`s' own tool derivation (the #13 disarmed-tools class). → DO pass the real spine role anyway (`buildXAgent` returns `{ node, coordinator }`; promote with `role: coordinator.role`) — it upgrades the delivered prompt from the `joined fallback` one-liner to the full Identity/Boundaries/Capabilities render. The Build pages themselves populate only once upstream's `PromotedAgent.displayRole` display seam lands (decouples display from execution). Chat-transcript tool chips are unaffected either way — they come from the run's event stream. (Found headed 2026-07-14, dealbrain workspace agent; canvas-workstation's promotions share the gap.)

## 6. Validate it (the loop)

- **Hermetic harness first.** Implement the toolbox's backend interface (port/client) with an in-memory fake, build the agent over it, and run against a small local model (Ollama). No creds, repeatable, fast. This proves the *loop* — composition + tool dispatch + state mutation — before touching a real backend.
- **Poke the tools with no LLM.** `ap tools list <id>` shows every tool an agent exposes; `ap tools call <id> <tool> --field=value …` invokes one directly. Prove the capability floor before involving the model.
- **Benchmark is the gate, not eyeballing.** Any prompt/slot change runs a ground-truth suite old-vs-new on the same model. Small models magnify slot mistakes, so they're the better stress test: *strengthen the protocol (Manual/Playbook/Judgment) before upgrading the model.*

## 7. Compose: the typed Node layer (multi-step & multi-agent)

§0–6 build **one** agent. To run several steps or several agents as a typed, composable graph, use the **Node layer** in `@pattern-stack/agentic-runtime` (the "PatternStack"). One contract underneath everything:

> `Node<TIn, TOut>` — `run(input, ctx): Promise<NodeResult<TOut>>`. Typed object in, typed object out, plus a token rollup. **Every leaf AND every composite is a `Node`**, so they nest freely — that single contract is the whole point.

**Leaves (do the work):**

- `AgentStep<TIn, TOut>` — input → LLM → typed output. **Structured output is the default:** give it an `output` zod schema and it routes through `runStructured`; omit it (or pass `z.string()`) for the raw-text path. A leaf **never throws** — on failure it returns `{ succeeded:false, error }` so the composite is the single place that decides continue-vs-abort.
- `FunctionStep<TIn, TOut>` — deterministic glue, no LLM: transforms, branch-prep, Scratchpad writes.

**Scope rides delegation for free.** A conversation's `SessionScope` value reaches every leaf as `NodeRunContext.scope` — the same `readScope`/`requireScope`/`readScopeAs` accessors a tool uses (§1), just off `ctx.scope` instead of `ctx.host.scope`, forwarded automatically across `AgentStep` → `nodeTool` → nested sub-node. `examples/agents/scope-echo` is the minimal proof: one promoted `FunctionStep` that reads `ctx.scope` and echoes it back — no LLM, no closure — showing the value survives the full rail from `POST /conversations` through `buildScopeHost` and `NodeBackedRunner` down to the leaf.

**Composites (orchestrate statically — fixed shape, known order):**

- `Sequential` — thread typed output node→node: `Sequential.start(a).then(b).build()`.
- `Parallel` / `FanOut` — concurrent branches with **deterministic fan-in**: forks `join()` in INDEX order (not completion order), so merges are reproducible.
- `Loop` — repeat a body until a predicate on the typed output holds (critique/revise, capped).
- `Accumulate` — fold a stream of items into a running aggregate.

**`Scratchpad`** — a run-scoped shared slot store (`slot({...})`, `createScratchpad()`). Pass it on `ctx.scratchpad`; steps `set`/`get` typed slots; `FanOut` branches read it from inside their forks. The name signals SHARED.

### The stage sugar: `sequentialAgent` / `parallelAgent` (start here for agent pipelines)

The raw composites above thread typed seams but make you hand-seat every agent in an `AgentStep` (prompt builder in, wiring out). The **stage layer** removes that ceremony: a stage/branch is a bare `AgentLike`, a bare `Node`, or a spec with knobs (`name`/`output`/`prompt`/`slot`/`onEmit`/`stop`/`reads`/`writes`/`retry`), all over one shared Scratchpad — and per-stage tool executors derive from each agent's OWN capabilities, so the forgotten-executor failure can't happen inside one.

- **`sequentialAgent(stages)`** — stages in order; each later stage's prompt implicitly carries the prior emission (chain visibility; `render: renderSharedState` for all-prior). A stage may BE a node (`{ node }`): a `CoordinatorStep` spine, a `FunctionStep` tail, a nested composite. Two 0.26 features close the contract-carrying gap (#255):
  - **Typed output**: designate the emitting stage at the COMPOSITE level — `sequentialAgent<TContract>(stages, { emit: 'answer' })` types the pipeline `Node<TIn, TContract>` and its output IS that stage's emission verbatim (no envelope, zero casts, `asAgent`-ready). Type args REQUIRE `emit` (compile error without it); stage-level `emit: true` does not exist and is rejected loudly — composite-level is the convention that generalizes to the parallel sibling. A `stop` before the emitting stage fails the node (the contract was never produced); a failure anywhere fails it too — only a stop AT/AFTER the emit stage is a successful early exit.
  - **`input: 'prior'`** (node stages only): hands the leaf the immediately-prior emission instead of the pipeline input — the compiler-checked spine → tail seam, e.g. `{ node: answerTail /* FunctionStep<TEmission, TContract> */, input: 'prior' }` with no nullable slot read.
- **`parallelAgent(branches)`** — FIXED, named branches over the shared input (section drafts, parallel lookups, judge panels); `FanOut` stays the tool for dynamic-N over runtime lists. Deterministic INDEX-ORDER join keyed by branch name: `{ branches, failed, stopped }`. **Leaf-never-throws is lifted into the join** — a failed branch is a `{ succeeded: false, error }` outcome, never a composite failure (check `failed.length` to hard-fail). Stop policy is **complete-all**: a branch's `stop` is a SIGNAL (`stopped` = first in index order), not a cancellation — nothing in-flight can be aborted yet. Type the join with a declared record: `parallelAgent<{ overview: string; pricing: Pricing }>(...)`. Guards reject the races concurrency creates (duplicate emission-slot keys, cross-branch reads of sibling writes) and the knobs with no parallel analogue (`input`, `emit`).

Both compose — the canvas shape, typed end to end with zero casts:

```ts
const assemble = new FunctionStep<ParallelAgentResult<Sections>, Canvas>({
  name: "assemble",
  fn: (join) => renderCanvas(join.branches),   // input compiler-checked; branches typed per name
});
const pipeline: Node<string, Canvas> = sequentialAgent<Canvas, string>(
  [{ node: parallelAgent<Sections>([introDrafter, bodyDrafter]), name: "sections" },
   { node: assemble, input: "prior" }],
  { emit: "assemble" },
);
```

### Agent-as-a-tool (let the model route)

A static graph is deterministic. When you want an **LLM to decide** which sub-node to call, expose sub-nodes as tools:

- `NodeToolbox` / `nodeTool` — wrap any `Node` as a callable tool. Its `parameters` IS the node's input schema (typed args down), the node's typed `output` returns inline (typed result up). **Call-and-return:** the caller stays in control; a failed sub-node returns `{ error }` instead of throwing.
- `delegateTo(runner, [subagents])` — the "just pass subagents" sugar (ADK `sub_agents=[...]`): one tool per subagent, name = agent name, **description = the routing signal** (be specific — it is the router's API doc), input `{ task }`.

### Coordinator (a model-driven coordinator that is itself a Node)

`CoordinatorStep<TIn, TOut>` makes a model-driven coordinator a `Node` leaf:

```ts
const canvasAuthor = new CoordinatorStep({
  name: "CanvasAuthor",
  agent: canvasAuthorAgent,                 // a full CORE Agent (e.g. from coordinatorRole())
  team: delegateTo(runner, [                // the hidden team it decomposes into
    { agent: writer,  description: "drafts a canvas section from the brief" },
    { agent: planner, description: "decomposes a template into sections" },
    { agent: repair,  description: "fixes a section that failed validation" },
  ]),
  output: CanvasTemplate,                   // typed contract back to the caller
  prompt: (req) => req.instruction,
});
// canvasAuthor is now a Node<AuthorRequest, CanvasTemplate>.
```

The mental model that makes this click: **a Coordinator IS the agent the user works with** (one "CanvasAuthor"); its subagents are how that single identity decomposes its *own* work, sealed inside. So a coordinator is a **leaf** — a black box `TIn→TOut` — even though the LLM routes among children internally. The engine never iterates those children; the model does, via tool calls. Encapsulation is the leaf property.

Because it's a `Node`, it composes like any other: a coordinator can be a `Sequential` stage, a `FanOut` branch, or a sub-tool of **another** coordinator (recursion — a hierarchy of coordinators). *"ADK unifies on Agent; we unify on Node."*

- `CoordinatorStep` takes a **core `Agent`** (not the minimal `AgentLike`), because the team is wired into its real `Role` so it is both *advertised* to the model and *executable*. The call-site just passes the agent — `withTeamCapability` does the wiring for you.
- **Reframe for product graphs:** a generator stream is usually a **deterministic workflow** (writer/planner/repair = fixed `AgentStep`s), and only the *top* coordinator does dynamic routing. Don't make everything a coordinator.

### Choosing the shape

| You have | Use |
|---|---|
| Fixed steps, known order | `sequentialAgent` / `parallelAgent` (the stage sugar — typed emit, shared pad, per-stage executors); drop to raw `Sequential`/`FanOut` for hand-wired output→input seams or dynamic-N fan-out |
| LLM must pick among specialists | `CoordinatorStep` / `delegateTo` — call-and-return routing |
| Concurrent peers, NO single owner | the async `AgencyRuntime` swarm — choreography, not orchestration; the one mechanism *outside* the Node type, so reach for it last |

## Deeper references

- Framework layer model + import rules: the framework repo's `CLAUDE.md` and `AGENTS.md`.
- The dev loop: `ap playground` (server + dashboard with a live agent **graph** + streaming chat), `ap run` (terminal), `ap agents` / `ap tools` (introspection).
- Building *inside* the framework monorepo itself (vs a consuming app): `bun run dev` boots server `:3456` + dashboard `:5173`; point it at your agent with `DEMO_FILE=examples/my-agent.ts`, copying `packages/agent-server/examples/live-demo.ts` for the full observability wiring (EventBus → collector → SSE exporter).
- Mixed-model routing (a cheaper model per capability): `HybridModelResolver` + `models.yaml` profiles in `@pattern-stack/agentic-runtime`.

---
*Lightweight and living. Update in place as the framework's discovery + exposure features evolve; this is the distillation of the proven pattern, not a spec.*
