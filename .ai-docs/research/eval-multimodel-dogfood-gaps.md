# Eval & Multi-Model Dogfood — Framework Gap Register

**Date:** 2026-06-14
**Status:** Scoped & decided (2026-06-14 — see §Decisions). Target: **patch all gaps + ship a framework release in the next few hours**, then update the `retrieval-agent` consumer onto the clean primitives so the agents can be *really* tested + visualized, and ultimately wired to triggers. Each gap below is an independently-plannable unit.
**Companion to:** [`dogfood-readiness-audit.md`](./dogfood-readiness-audit.md) (first dogfood: the Capability/Toolbox model). This is the **second** dogfood, from a different angle.

**Context:** The sibling consumer repo **`retrieval-agent`** (`/Users/dug/Projects/retrieval-agent`) built (a) an **eval harness** — question bank → run an agent → store events → LLM-judge → cockpit — and (b) a **forced multi-model pipeline** (gather → curate → answer, with a cheap model for retrieval and a strong model for synthesis). Doing this against the framework surfaced three concrete gaps, each of which the consumer had to **work around in app code**. This doc captures the workarounds (with file + PR references) so we can **fix the gap at the source rather than bless the hack** — same principle as the EmptyToolbox note in the readiness audit.

> **Framing note (carried from the readiness audit):** a consumer's incidental hack is a *symptom*, not a spec. Read the workaround to understand the *need*, then design the clean primitive. All consumer references below point at real, merged code in `retrieval-agent` (PRs #26–#34 on `main`).

---

## The three gaps

### G1 — No per-step model/runner in workflow patterns

**The need.** A pipeline where the **gather** (retrieval) step runs on a cheap model and the **curate/answer** (synthesis) steps run on a strong model. (Empirically: retrieval is mechanical and model-agnostic; clustering/synthesis is the quality bottleneck.)

**Framework limitation (confirmed):**
- The model is bound to the runner: `AgentRunner` constructor takes `LanguageModelV1` and stores `private readonly _model` — `agent-runner.ts:66,68`. `run()` has **no** per-call model override (`RunOptions`, `runner/types.ts:94`).
- Workflow patterns share **one** runner for all steps: `PatternRunOptions.runner` is a single instance (`workflows/base.ts:162`); `Step` has no runner/model field (`workflows/base.ts:28`); `Sequential.run` calls the same `runner.run(step.agent, …)` for every step (`workflows/sequential.ts:95`). Same in `Parallel` (`parallel.ts:123`) and `EvaluatorLoop` (`evaluator-loop.ts:128`).

**Consumer workaround.** Bypassed `Sequential` entirely and hand-rolled a two-runner loop:
- `retrieval-agent/packages/benchmarks/agent-eval/run-sequential.ts` (PR #34) — builds `gatherRunner` + `answerRunner`, iterates the steps manually, routes step 0 → gather runner, steps 1+ → answer runner. The `EvidenceSet` persists across runners because it's closure-captured in the shared agent's toolbox.
- It reuses `buildRetrievalSteps(agent, evidence)` from `retrieval-agent/src/agents/query-analyst/workflow.ts` but cannot use the framework's `Sequential` to drive them.

**Proposed fix (small).** Add `runner?: RunnerProtocol` to `Step` (`workflows/base.ts:28`). In `Sequential.run`, use `(step.runner ?? runner).run(...)` (`sequential.ts:95`); mirror in `Parallel` and `EvaluatorLoop`. No change to `RunnerProtocol`, `RunOptions`, or `AgentRunner`. ~5 lines. This deletes the consumer's manual orchestration — split-model becomes a clean `Sequential`.

---

### G2 — No run-scoped state channel into tools (the "RunContext" gap)

**The need.** A run-scoped, mutable **working set** ("backpack") that `search`/`fetch` tools accumulate into and that `inspect`/`curate` tools read — shared across the tool loop (and, with G1, across pipeline steps).

**Framework limitation (confirmed; also noted in the readiness audit's deps-injection item):** there is **no** channel to pass run-scoped state to a tool. `ToolDefinition.execute(args)` takes only args (`molecules/toolbox.ts:21`); `ToolExecutor.execute(name, args)` likewise (`runner/types.ts:65`); the runner calls it with only `(name, args)` (`agent-runner.ts:377`). The framework's own SKILL.md names this: *"There is no `RunContext`-into-every-tool channel (a known framework gap)."*

**Consumer workaround.** Closure-capture via a deps bundle:
- `retrieval-agent/src/toolshed/query-surface/evidence-set.ts` — the `EvidenceSet` class (a per-run mutable store), explicitly noting it is **not** a framework primitive.
- `retrieval-agent/src/agents/context.ts` — `QueryDeps` carries `{ context, client, evidence }`; the header reads *"FRAMEWORK GAP: deps injection … both the live client and this mutable evidence reach tools by closure capture."*
- `retrieval-agent/src/toolshed/query-surface/toolbox.ts` — the toolbox constructor closes over the `EvidenceSet`; `search`/`fetch` stash into it; `inspect`/`curate` read it. (PR #26.)

**Proposed fix (deeper).** Thread an optional run-scoped `context` from `RunOptions` → the executor → `ToolDefinition.execute(args, ctx)` (`molecules/toolbox.ts:21`, `runner/types.ts:65`, populated at `agent-runner.ts:377`). `Toolbox.execute` forwards it. This is *the* documented gap; it moves per-run state (and arguably the injected client) off the closure onto a first-class channel. Larger blast radius (the tool execute signature) — design carefully (back-compat: `ctx` optional).

---

### G3 — Steps only thread strings (no structured step result)

**The need.** Pass a **structured** value (the curated rows) from one pipeline step to the next, not a re-serialized string the next step must re-parse.

**Framework limitation:** `StepResult.content` is a `string` (`workflows/base.ts:40`); `RunResult.response` is a `string`. `PatternContext` is `Record<string, unknown>` (can hold structured data), and `outputKey` writes only the string content (`sequential.ts:101`). The only structured escape hatch is `step.contextExtractor(result, ctx)` (`workflows/base.ts:34`), which must parse the string itself.

**Consumer workaround.** Used `contextExtractor` to lift structured data out of the closure-held `EvidenceSet` into context:
- `retrieval-agent/src/agents/query-analyst/workflow.ts` — step 2's `contextExtractor` does `evidence.curated()` → `ctx.curatedRows`, with the comment *"the framework's Sequential only threads strings between steps … the backpack carries the structured rows across the pass boundary."*

**Proposed fix (small, optional).** Add `typedResult?: unknown` to `StepResult` (`workflows/base.ts:40`) and/or a `resultExtractor?: (result: RunResult) => unknown` on `Step`, so a step can emit a structured payload alongside `content`. Reduces parse-in-every-extractor boilerplate. Lower priority than G1/G2; partly subsumed if G2 lands (the working set becomes the carrier).

---

## Config-driven "agent setups" — what exists, and the one wiring gap

The consumer's larger goal is to **cycle between agent setups** (slots × pipeline × model) for evaluation. The framework already supports most of this — worth stating so we don't re-invent it:

- **`AgentConfig`** (`agent-core/atoms/agent-config.ts:53`) is a clean, Zod-validated, **serializable** bundle: `roleTemplate` (persona + judgments + responsibilities + `defaultModel`) + `mission` + `background` + `awareness` + `capabilities: string[]` + `model`.
- **`buildAgentFromConfig(config, { resolver, modelOverride })`** (`organisms/build-agent-from-config.ts:52`) hydrates it; `CapabilityResolver` injects live capabilities by name. **Model is config-native** with precedence `modelOverride > config.model > roleTemplate.defaultModel` (`build-agent-from-config.ts:13-14,84`).

**The one wiring gap for clean cycling:** `config.model` is a **string of intent** — but `AgentRunner` dispatches its own bound `LanguageModelV1`, not `agent.getModel()` (`agent-runner.ts:66`; `getModel()` is used only for event attribution). So a harness must map `config.model` → a live model itself. (The consumer does this in `retrieval-agent/src/runtime/config.ts` `buildModel`.) A small framework convenience — e.g. `buildAgentFromConfig` returning a ready `(agent, runner)` pair, or a `modelId → LanguageModelV1` factory bound to the provider-detection in `create-runner.ts` — would close the "model is in the config but you still wire the runner by hand" friction. **This is the clean substrate for the eval harness's setup registry.**

---

## G4 — Workflow-as-config (the centerpiece — DECIDED, ASAP)

**This completes the platform's composition stack.** Today it's declarative up to the agent, then hits an imperative wall:

```
Slots → Role (RoleTemplateConfig) → Agent (AgentConfig + buildAgentFromConfig) → ║imperative║ → new Sequential([...])
                                                                                    ↑
                                                       WorkflowConfig + buildWorkflowFromConfig  ← the missing tier
```

**Vision (the product shape this unlocks):** define **Roles** (`extraction`, `synthesis`, `presentation`) → build **Agents** on them (`DealExtraction`, `DealContextValidator`, `DealSummaryAgent`) → declare **Workflows** that compose those agents as steps, **overriding the already-defined agent config per step** (model/judgments/mission for that workflow's use). Fully serializable, swappable, overridable end-to-end.

**Design sketch** (mirrors `buildAgentFromConfig` one tier up):
- **`WorkflowConfig`** — schema in `agent-core` (serializable, no runtime dep); builder in `agent-runtime` (it instantiates runtime patterns + runners). Cf. `AgentConfig` lives in core, `createRunner` in runtime.
  - `{ name, mode: 'sequential' | 'parallel', steps: WorkflowStepConfig[] }` (start with these two modes; `EvaluatorLoop`/etc. later).
  - `WorkflowStepConfig: { agent: string /* name → AgentResolver */, messageTemplate, name?, outputKey?, modelOverride?, configOverride?: Partial<AgentConfig> }`.
- **`buildWorkflowFromConfig(config, { agentResolver, capabilityResolver, runnerFactory })` → `PatternProtocol`:** per step, resolve agent name → `AgentConfig`, apply `configOverride`, `buildAgentFromConfig`, pick `runnerFactory(modelOverride ?? agent.model)` (**needs G1 per-step runner**), then construct `Sequential`/`Parallel` with per-step runners.
- **Override semantics** (Doug's "override the already-instantiated config"): a step references a *named* agent (defined once) and may **patch its config per-use** (model/judgments/mission). Plus a run-time override escape hatch on `workflow.run` (mirrors `buildAgentFromConfig`'s `modelOverride`).
- **Distinct from `Agency`** (`agency.ts`): `Agency` = a **team** (agents messaging, coordinator/workers); `WorkflowConfig` = a **pipeline** (ordered steps, data threaded). Complementary — document the boundary so they don't get conflated.

**Depends on:** the model→runner factory (below) + **G1**. **Composes with:** **G3** (structured step threading).

---

## Decisions (2026-06-14)

| Item | Decision |
|---|---|
| **G4 — Workflow-as-config** | **IN, ASAP** — completes the platform (Roles → Agents → Workflows, all config + override). |
| **Model→runner factory** (`modelId → LanguageModelV1` / `runnerFor(id)`) | **IN** — foundation; generalizes `create-runner.ts` provider detection. Unblocks G1 + G4. Closes the "model is in config but you wire the runner by hand" gap. |
| **G1 — per-step runner** (`Step.runner?` + `maxIterations?`) | **IN** — small; the per-step-model enabler. |
| **G3 — structured step result** | **IN** — small; composes with G4. |
| **G2 — RunContext (state into tools)** | **IN** — in the release if it lands cleanly, else immediate fast-follow (bigger blast radius: the tool execute signature). |
| **Eval layer** | **IN as a framework concern** — *"we have runtime, close the eval loop."* Bank loader + offline judge (records scores) + score store + (optional) cockpit primitive. **Fast-follow** after the core release; build from the `retrieval-agent` harness as the reference (see §eval below). |
| **Dual-renderer footgun** + **forgotten-executor** | **CAPTURE only** this thread — track as cleanup (already in the readiness audit; link them). Do NOT resolve here. |

---

## Sequenced release plan (next few hours) + horizon

**Phase 0 — Foundation**
1. **Model→runner factory** — `runnerFor(modelId)` / `modelId → LanguageModelV1`, reusing `create-runner.ts` provider detection. (Unblocks G1 + G4.)

**Phase 1 — Per-step + Workflow-config (the core release)**
2. **G1** — `Step.runner?` (+ `maxIterations?`); `(step.runner ?? runner)` in Sequential/Parallel/EvaluatorLoop. *(~5 lines.)*
3. **G3** — `StepResult.typedResult?` / `Step.resultExtractor?`. *(small)*
4. **G4** — `WorkflowConfig` (core) + `buildWorkflowFromConfig` (runtime) + tests. *(the centerpiece)*

**Phase 2 — RunContext (release or immediate fast-follow)**
5. **G2** — thread optional `context` into `ToolDefinition.execute(args, ctx)` via `RunOptions` (back-compat: optional). Moves run-state off the closure.

**Phase 3 — Release**
6. Version bump + changelog (`dug/release-0.1.14` → next). Publish.

**Fast-follow**
7. **Eval layer** (framework) — bank loader + offline judge + score store (align with `EventStore`/`SQLiteExporter` conventions), built from the `retrieval-agent` reference.
8. **DX cleanup** — dual-renderer unify, forgotten-executor guard.

**Then — consumer update (`retrieval-agent`), to delete the hacks:**
- two-runner orchestration → `Sequential` with per-step runners (G1);
- the pipeline → a `WorkflowConfig` (G4); query-analyst variants → `AgentConfig`s + a setup registry;
- `EvidenceSet` closure → `RunContext` (G2);
- re-run the eval suite on the clean primitives.

**Horizon (north star — NOT this release):** **trigger-dependent workflows** — bind a `WorkflowConfig` to an event (`"Transcript received"` → run the deal pipeline). Once workflows are declarative + observable + gradable, triggers are the activation layer. The config + eval work *is* the foundation for it.

---

## Eval layer (fast-follow) — build from this consumer reference

**Decided: the framework ships eval** ("we have runtime, close the loop"). It's currently entirely app-level in `retrieval-agent`; that harness is the reference to lift from (and review with the framework agent — Doug: *"I don't really know how evals are working atm"*). The artifacts to read:

- `retrieval-agent/packages/benchmarks/agent-eval/questions.jsonl` — the leveled (L0–L7) question bank: per-question `expected`, `expected_obs_ids`, `grade` mode, `hazard`.
- `retrieval-agent/packages/benchmarks/agent-eval/store.ts` — `bun:sqlite` event/run store (`run`, `event`, `tool_def`, `eval_result` tables); attaches to the framework's `AgentEventBus`.
- `retrieval-agent/packages/benchmarks/agent-eval/run.ts` (single-loop) + `run-sequential.ts` (forced pipeline) — the run entry points.
- `retrieval-agent/packages/benchmarks/agent-eval/grade.ts` — Layer-2 LLM-judge (5-axis rubric + set-membership), provider-flexible.
- `retrieval-agent/packages/benchmarks/agent-eval/lens.ts` — the "slot-discipline lens" (did the manual's rule reach the model + was it honored).
- `retrieval-agent/src/cli/cockpit.ts` — the read-only eval cockpit SPA over the store.

**Observability note:** the framework already has a strong observability spine — `AgentEventBus` + `Exporter` (`ConsoleExporter`, `SQLiteExporter → EventStore`, `LangfuseExporter`, `OTelExporter`, `SSEExporter`) + the `agent-dashboard` SPA. That dashboard is **session/trace-centric** (operations), whereas the cockpit is **question/score-centric** (eval) — different data models, coexist cleanly. The consumer's store already follows the bus→sink pattern (`store.attach(bus)`), so any eval-store primitive should align with `SQLiteExporter`/`EventStore` conventions (schema versioning via `PRAGMA user_version`, WAL, optional-dep loader).

---

## Reference index

**Framework (this repo) — limitation sites:**
- `packages/agent-runtime/src/runner/agent-runner.ts:66,68,377` — model on runner; tool call-site.
- `packages/agent-runtime/src/runner/types.ts:65,94` — `ToolExecutor.execute`, `RunOptions`.
- `packages/agent-core/src/molecules/toolbox.ts:21` — `ToolDefinition.execute`.
- `packages/agent-runtime/src/workflows/base.ts:28,34,40,162` — `Step`, `contextExtractor`, `StepResult`, `PatternRunOptions`.
- `packages/agent-runtime/src/workflows/{sequential.ts:95,101, parallel.ts:123, evaluator-loop.ts:128}` — single-runner call-sites.
- `packages/agent-core/src/atoms/agent-config.ts:53` + `organisms/build-agent-from-config.ts:13-14,52,84` — config-driven agents + model precedence.

**Consumer (`/Users/dug/Projects/retrieval-agent`, `main`) — workaround sites:**
- `packages/benchmarks/agent-eval/run-sequential.ts` (PR #34) — G1 two-runner hack.
- `src/toolshed/query-surface/evidence-set.ts` + `src/agents/context.ts` + `src/toolshed/query-surface/toolbox.ts` (PR #26) — G2 closure-capture.
- `src/agents/query-analyst/workflow.ts` (PR #26/#34) — G3 contextExtractor string-bridge.
- `src/runtime/config.ts` (PRs #21/#32) — the `modelId → LanguageModelV1` mapping a config-cycling harness needs.
