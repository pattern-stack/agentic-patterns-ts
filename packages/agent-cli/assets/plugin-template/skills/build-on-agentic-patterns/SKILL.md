---
name: build-on-agentic-patterns
description: How to build agents and products on the @agentic-patterns framework — register agents the convention way (`ap` discovers any Agent exported from an `agents/<name>/agent.ts`), and treat the framework as a compositional algebra (Capability = Toolbox+Manual+Playbook; Role = Persona+Judgments+Capabilities+Responsibilities), not a prompt-assembly library. Use when scaffolding or extending an agent, toolbox, capability, playbook, manual, or role, when an agent "doesn't show up" in `ap playground`, or when a build "isn't working" (tools no-op, prompt edits do nothing, an agent is one giant mission string).
when_to_use: "build an agent on agentic-patterns", "register / discover an agent", "my agent doesn't show up in the playground / `ap agents`", "point ap at a folder of agents", "add a toolbox / capability / playbook / manual / role", "scaffold a new agent project", "my tools aren't firing", "the model says the tool errored", "where does this prompt text go", working in a repo that imports @agentic-patterns/core or @agentic-patterns/runtime.
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

**Don't set the runner.** `ap` injects it after discovery via `createRunner()` (env-detected — see §4 "Provider surprise"). Your file exports only the Agent.

**Run it:**

```bash
ap playground                 # discover this project's agents/ + open the dashboard
ap playground <dir>           # point at any agents root → discover every child recursively
ap playground --agents-dir <dir>   # same, as a flag
ap agents                     # list what was discovered (+ any load errors)
ap run <id> "your message"    # chat in the terminal — no browser
```

If an agent "doesn't show up": check the file is under the discovery glob, that it actually **exports an Agent** (a built `Agent`, not a Role or a config), and read `ap agents` — a file with no Agent export reports a clear load error rather than failing silently. Detection is structural (duck-typed on `role`/`mission`/`awareness`/`background`), so it works even when your agent imports core through a built `dist/` entry.

## 1. The slot table (read this first)

When you have a piece of knowledge, find its row before you write a line of code:

| What you have | Goes in | NOT in |
|---|---|---|
| A raw external action — one HTTP call / one verb | **Toolbox** tool (`{description, parameters: zod, execute}`) | a play; mission text |
| A validated, named, multi-step recipe (rank→window→cite) | **Playbook** play | frozen in code; re-taught in the prompt |
| Domain reference / how-the-data-works / DSL guide | **Manual** (sectioned `ManualSection`s) | the mission |
| A stable decision rule ("prefer not-enough-evidence over guessing") | **Judgment** | `persona.principles`; the mission |
| Who the agent is (identity, tone, priorities) | **Persona** | the mission |
| What the agent is accountable for | **Responsibility** | the mission |
| Per-run grounding (this deal, this user, as-of) | **Mission**, rendered from a context `AgenticModel` | hardcoded strings; a fat protocol |
| The mutable backend (API client, secret, store) | **injected into the Toolbox via a factory** (closure capture) | a module global; the prompt |

If your mission is more than ~objective + success-criteria + grounding, knowledge has leaked into the wrong slot. Move it.

## 2. The layout (toolshed / roles / agents)

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

## 3. The build recipe

Bottom-up. Each step fills one slot; factories take a `deps` bundle so live clients/secrets stay out of the library.

1. **Toolbox** — subclass `Toolbox`; `tools` is a `Record<name, ToolDefinition>`. Each `execute` closes over the injected client. Expose via `buildXToolbox(deps)`.
2. **Manual** *(optional)* — `ManualSection`s of domain reference. `manual.scoped([...])` gives progressive disclosure (full sections + a TOC of the rest).
3. **Playbook** *(optional)* — subclass `Playbook`; `plays` are named recipes; `Playbook.execute` returns an `{ error }` envelope instead of throwing (so a malformed play can't abort the loop). Expose via `buildXPlaybook(deps)`.
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
5. **Judgment + Persona** (`roles/`) — decision rules and identity as named exports. **Don't start from zero:** `@agentic-patterns/runtime` ships preset judgments (`RETRIEVAL_STRATEGY`, `EVIDENCE_QUALITY`, `ROUTING`, `QUALITY_REVIEW`, …), responsibilities, and whole roles (`retrievalRole`, `analystRole`, `coordinatorRole`) — clone or compose those before authoring new ones.
6. **Role** — `new RoleBuilder(name).withPersona(p).withJudgment(j).withCapability(c).withDefaultModel(id).build()`. Requires a persona.
7. **Mission** — thin: `new Mission({ objective, success_criteria, /* grounding rendered from a context AgenticModel */ })`. No protocol text.
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
10. **Declarative route** *(optional)* — export `createXResolver(deps): CapabilityResolver` (name → live `Capability`), then `buildAgentFromConfig(config, { resolver })` where `config.capabilities` is `string[]`. The library never touches credentials; the app supplies `deps`.

## 4. Anti-patterns (the reasons builds fail)

- **Agent doesn't appear.** The file exports a Role, a config object, or a *factory that returns the wrong thing* — not a built Agent. → Export the result of `new AgentBuilder(role)…build()` (or a registration `{ agent }`). `ap agents` prints a load error for files with no Agent export; read it.
- **Fat mission.** A 90-line hand-walked protocol in `mission`. → Discipline → `Judgment`; how-to → `Manual`; the recipe itself → a `Playbook` play. Mission keeps only objective + success-criteria + per-run grounding.
- **`EmptyToolbox`.** Reaching for a toolbox-less capability to expose "plays only" (a stub `Toolbox` with `tools = {}`). The toolbox is the **required atom** — faking it is the canonical smell. What you actually want is *curated exposure* (hide raw verbs, show plays): that's a framework exposure feature, **not** a toolbox-less capability. **Today:** give the capability the real verbs its plays compose, or keep the play-only capability *library-resident* (exported/tested, consumed by no role) until the exposure feature lands.
- **Forgotten executor.** Build an agent with tools, call `runner.run(agent, msg)` without `toolExecutor` → every tool call silently returns `{ error: "No tool executor configured" }`, the loop continues, nothing throws. *Symptom:* "my tools aren't firing" / "the model says the tool errored." → Always pass `toolExecutor: createToolboxExecutor(agent)`. (`ap playground`/`ap run` and the HTTP entry points wire it for you; the low-level `AgentRunner.run` does not.)
- **Deps via globals.** There is no `RunContext`-into-every-tool channel (a known framework gap). → **Closure capture**: a factory takes `deps = { context, client }`; the toolbox/playbook close over it. Mark the site `// FRAMEWORK GAP: deps injection`.
- **Provider surprise.** `createRunner` env-detects in priority order (`ANTHROPIC_API_KEY` → … → `OLLAMA_HOST`). For a local model: set `OLLAMA_HOST`, blank competing keys (`ANTHROPIC_API_KEY=`). `@ai-sdk/*` packages must be hand-installed for non-Ollama providers; Ollama works out of the box. With **no** provider env set, `createRunner` falls back to the local `claude` CLI runner if `claude` is on PATH — which emits a *limited event vocabulary*, so the graph/trace can look sparse; set a real key to get full events.
- **Extract without assemble** (the subtle one). You correctly move discipline → `Judgment`, recipe → `Playbook`, how-to → `Manual` — and *stop there*, leaving the running agents on their old fat missions. Now the knowledge lives in **two** places and the agents ignore the slots. Extracting is half the job: **rewire the agents to consume the slots and delete the fat-mission copies.**
- **Backward dependency arrow.** A toolbox/capability factory that takes an *agent-level* `deps` bundle creates `toolshed → agents` — a backward arrow (often a cycle). A factory should take **only what it uses** (the client/secret), not the agent's run-context bundle. Keep arrows one-way: `cli → agents → roles → toolshed → lib`.

## 5. Validate it (the loop)

- **Hermetic harness first.** Implement the toolbox's backend interface (port/client) with an in-memory fake, build the agent over it, and run against a small local model (Ollama). No creds, repeatable, fast. This proves the *loop* — composition + tool dispatch + state mutation — before touching a real backend.
- **Poke the tools with no LLM.** `ap tools list <id>` shows every tool an agent exposes; `ap tools call <id> <tool> --field=value …` invokes one directly. Prove the capability floor before involving the model.
- **Benchmark is the gate, not eyeballing.** Any prompt/slot change runs a ground-truth suite old-vs-new on the same model. Small models magnify slot mistakes, so they're the better stress test: *strengthen the protocol (Manual/Playbook/Judgment) before upgrading the model.*

## Deeper references

- Framework layer model + import rules: the framework repo's `CLAUDE.md` and `AGENTS.md`.
- The dev loop: `ap playground` (server + dashboard with a live agent **graph** + streaming chat), `ap run` (terminal), `ap agents` / `ap tools` (introspection).
- Building *inside* the framework monorepo itself (vs a consuming app): `bun run dev` boots server `:3456` + dashboard `:5173`; point it at your agent with `DEMO_FILE=examples/my-agent.ts`, copying `packages/agent-server/examples/live-demo.ts` for the full observability wiring (EventBus → collector → SSE exporter).
- Mixed-model routing (a cheaper model per capability): `HybridModelResolver` + `models.yaml` profiles in `@agentic-patterns/runtime`.

---
*Lightweight and living. Update in place as the framework's discovery + exposure features evolve; this is the distillation of the proven pattern, not a spec.*
