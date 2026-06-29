# PatternStack — Typed `Node<TIn, TOut>` Workflow Layer

> **Status:** Design-only (no code yet). A *foundational* refactor of the `@agentic-patterns/runtime` workflow layer (`packages/agent-runtime/src/workflows/**`) that generalizes the string-pinned Step/Pattern contract to typed object I/O.
> **Sequencing:** PatternStack-first — the framework lands the typed foundation with **zero consuming-app changes**; the consuming-agent migration is a separate, pressure-free later track.
> **Blast radius:** contained to `workflows/**` + `runner/{types,agent-runner,mock-runner}.ts` + `core/atoms/workflow-config.ts` + their tests. No server / dashboard / preset / runner-consumer depends on this layer.

---

## 1. Motivation — the verified gaps

Today every unit of work is `(PatternContext bag) -> StepResult{ content: string }`. The string is hardwired at four levels and the "node" contract is fractured across five incompatible shapes.

| Gap | Evidence (current `file:line`) |
|---|---|
| Result has no typed output channel — only `finalContent: string` + tokens | `workflows/base.ts:82-87` (`PatternResult`) |
| Step output is always raw text | `workflows/base.ts:55-62` (`StepResult.content: string`), set from `runResult.response` in `createStepResult` `base.ts:67-75` |
| Threading is by string key into an untyped bag | `workflows/base.ts:19` (`PatternContext = Record<string, unknown>`); written at `sequential.ts:103-105` (`outputKey`) + `:106-111` (`contextExtractor`) |
| `PatternProtocol` is implemented by only 2 of 6 patterns | `base.ts:187-189`; only `Sequential` (`sequential.ts:50`) + `Parallel` (`parallel.ts:77`). `RetryLoop`/`EvaluatorLoop`/`TaskLoop`/`ConversationLoop` each have a *different* `run()` shape |
| `Parallel` fans **hand-authored** steps, not a map over runtime data | `parallel.ts:77` ctor takes flat `Step[]`; no `over`-list primitive exists anywhere |
| Parallel hands branches an immutable snapshot they cannot write back | `parallel.ts:107` (`contextSnapshot`); consolidated output never merged into a parent's context (`sequential.ts:119,123` discard nested `finalContext`) |
| Refinement evaluator returns flat `{score, feedback, qualityMet}` — no structured `issues[]` | `evaluator-loop.ts:29-35` |
| The runner never calls `generateObject` — no structured-output path | confirmed: `grep generateObject` over `packages/` → none; only `generateText` (`agent-runner.ts:237`) + `streamText` (`:585`) |

**The foundational decision (chosen over "additive"):** generalize the core node contract to typed object I/O. Every node is conceptually `(input: object) => Promise<output: object>`. Today's string `Step` becomes the special case `Node<…, string>`. This reworks the core execution types; back-compat for existing string consumers is preserved by re-expressing the legacy types as string specializations of the new generic ones (§4, §9).

---

## 2. The converged model

```
Today:  unit = (PatternContext bag) -> StepResult{ content: string }
New:    unit = (input: TIn, ctx) -> NodeResult<TOut>
        today's string Step = Node<TIn, string>  (TOut pinned to string)
```

- **One contract:** `Node<TIn, TOut>` — implemented by every leaf and every composite. Unifies the five incompatible `run()` shapes.
- **Two leaves** (same signature): `AgentStep` (input → LLM → typed output, *structured by default*) and `FunctionStep` (input → async fn → typed output, no LLM).
- **Five composites** (all `implement Node`, all nestable): `Sequential`, `Parallel`, `FanOut`, `Accumulate`, `Loop`.
- **Two data mechanisms, both first-class, not redundant:**
  1. **Threaded typed I/O** — node N's `output` *is* node N+1's `input`. Return-value chaining. Local, explicit.
  2. **Shared scoped Slot (the "Backpack")** — a typed store living *outside* the chain; many nodes hold a handle and read/write it; read final state after. Replaces `PatternContext`'s shared-state duty.

`PatternContext` stops doing double duty: threading moves to typed I/O; the context becomes **purely** the shared-state facility, upgraded from untyped `Record` to typed scoped slots.

### The 2×2 grid (the organizing principle)

Two orthogonal axes: **execution order** × **branch source**. Each cell is a *distinct contract*, not a flag on a shared one.

| | **named, hand-authored branches** | **one op over a runtime list** |
|---|---|---|
| **in-order** | `Sequential` | `Accumulate` |
| **at-once** | `Parallel` | `FanOut` |

`Loop` (repeat-until) is the fifth composite, orthogonal to the grid — it repeats a single body node.

The grid is *why* four composites exist instead of two-with-flags. `Accumulate` is deliberately **not** `FanOut({ maxConcurrency: 1 })`: collapsing the axes would let a caller set `concurrency > 1` on an order-dependent fold and silently corrupt the accumulator. The order guarantee is a structural (type-level) property, not a runtime setting.

---

## 3. Core contract — `Node`, `NodeResult`, `NodeRunContext`

```ts
// packages/agent-runtime/src/workflows/node.ts  (NEW — the new substrate)

/** Ambient services every node receives. A *superset* of today's PatternRunOptions
 *  (base.ts:175-180 = { runner; hooks?; toolExecutor?; traceId? }). Every field added
 *  here is OPTIONAL or engine-defaulted, so any existing PatternRunOptions value is a
 *  valid NodeRunContext — this is the back-compat hinge (see §9). */
export interface NodeRunContext {
  readonly runner: RunnerProtocol;
  readonly hooks?: PatternHooks;
  readonly toolExecutor?: ToolExecutor;
  readonly traceId?: string;
  /** The shared scoped-slot store (the Backpack, §6). OPTIONAL: when absent the engine
   *  lazily constructs an empty store at the top-level run() call. Existing callers that
   *  pass { runner } keep compiling and behave identically (they never touch slots). */
  readonly slots?: SlotStore;
}

/** Typed aggregate result. Generalizes PatternResult (base.ts:82-87): `output` replaces
 *  the string-pinned `finalContent`; `succeeded` + token fields are UNCHANGED in name. */
export interface NodeResult<TOut> {
  readonly output: TOut;             // the typed payload (was: finalContent: string)
  readonly succeeded: boolean;       // SAME NAME as PatternResult.succeeded — not renamed
  readonly error?: Error;            // present iff succeeded === false
  readonly totalInputTokens: number; // subtree rollup, same fields as PatternResult
  readonly totalOutputTokens: number;
}

/** The universal contract. Every leaf AND composite implements this — the thing that
 *  unifies the five incompatible run() shapes. */
export interface Node<TIn, TOut> {
  readonly name?: string;
  run(input: TIn, ctx: NodeRunContext): Promise<NodeResult<TOut>>;
}
```

**Field-name decisions (resolving the verifier's `succeeded`-vs-`ok` blocker):** `NodeResult` keeps `succeeded` and `totalInputTokens`/`totalOutputTokens` — the *exact* names on today's `PatternResult` (read at e.g. `parallel.test.ts:42`). No silent rename. The legacy `PatternResult` then refines `NodeResult<string>` without dropping any field (§4).

**Token accounting (resolving the `meter` blocker):** there is **no required `meter` field** on the run context. Each composite rolls up its children's `totalInputTokens`/`totalOutputTokens` into its own `NodeResult` — the same bottom-up summation the existing patterns already do (`parallel.ts`, `sequential.ts` accumulate token totals). Rollup lives in the result, not in a mandatory context object, so existing `.run({}, { runner })` calls keep compiling.

### Per-child record (generalizes `StepResult`)

```ts
/** What a composite records per child. Generalizes StepResult (base.ts:55-62):
 *  `output: TOut` replaces `content: string`; `runResult` is OPTIONAL because a
 *  FunctionStep has no LLM call. */
export interface NodeOutcome<TOut> {
  readonly nodeName: string;
  readonly output: TOut;
  readonly succeeded: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly runResult?: RunResult;   // present for AgentStep, absent for FunctionStep
  readonly error?: Error;
}
```

## 4. Back-compat string special-case (the legacy types reframed, not deleted)

The old declarations are **reframed as string specializations**, so every existing reader (`.finalContent`, `.content`, `.succeeded`, `finalContext`) keeps compiling.

```ts
// base.ts — additive reframing

export type PatternResult = NodeResult<string> & {
  /** Alias of `output`; retained so existing `.finalContent` readers keep working. */
  readonly finalContent: string;
};

export type StepResult = NodeOutcome<string> & {
  readonly stepName: string;       // alias of nodeName
  readonly content: string;        // alias of output (still === runResult.response)
  readonly runResult: RunResult;   // narrowed back to REQUIRED on the string path
};

/** PatternProtocol is structurally a string Node. Kept as a named interface for nominal
 *  back-compat and as buildWorkflowFromConfig's return type. The second param is OPTIONAL
 *  (widened from NodeRunContext) so `new Sequential(steps).run({}, { runner })` still
 *  type-checks (per-step-model.test.ts:66,83,99). */
export interface PatternProtocol extends Node<PatternContext, string> {
  run(context?: PatternContext, ctx?: NodeRunContext): Promise<PatternResult>;
}
```

**`createStepResult` is updated, not "unchanged"** (resolving the verifier's gap): it must now also populate `nodeName` (= `stepName`) and `output` (= `content`) so its return value satisfies `NodeOutcome<string>`. The body is a one-line additive change; all existing call sites and readers are unaffected because the legacy aliases remain.

| Today | Becomes | Back-compat |
|---|---|---|
| `PatternResult { finalContent: string; succeeded; totalIn/OutTokens }` | `NodeResult<TOut> { output: TOut; succeeded; totalIn/OutTokens }` | `PatternResult = NodeResult<string> & { finalContent }` — `.finalContent`/`.succeeded` survive |
| `StepResult { stepName; content: string; runResult; tokens }` | `NodeOutcome<TOut> { nodeName; output; runResult?; tokens }` | `StepResult = NodeOutcome<string> & { stepName; content; runResult }` |
| `PatternProtocol.run(context?, options?)` | `Node<TIn,TOut>.run(input, ctx)` | `PatternProtocol extends Node<PatternContext,string>`; params widen, not narrow |
| `Step { agent; messageTemplate; outputKey?; contextExtractor?; … }` | `AgentStep` (§5.1) + `FunctionStep` (§5.2) | legacy `Step` kept verbatim, consumed only by legacy `Sequential`/`Parallel` + `buildWorkflowFromConfig` |

---

## 5. The two leaf nodes

### 5.1 `AgentStep<TIn, TOut>` — input → LLM → typed output (structured by default)

```ts
// packages/agent-runtime/src/workflows/agent-step.ts  (NEW)

export interface AgentStepSpec<TIn, TOut = string> {
  readonly name?: string;
  readonly agent: AgentLike;

  /** Typed prompt builder — replaces MessageTemplate (base.ts:22). Receives the typed
   *  input (NOT an untyped bag) and a read view of slots. Returns the user message. */
  readonly prompt: (input: TIn, slots: SlotReader) => string;

  /** Output schema → runner.runStructured. THIS IS THE DEFAULT.
   *  Omit (or pass z.string()) to get the legacy generateText text path, enabling a
   *  byte-identical migration of today's string steps. There is NO separate StructuredStep —
   *  structured IS the norm; raw string is the special case TOut = string. */
  readonly output?: ZodType<TOut>;

  /** Per-step model override (via applyStepModel, base.ts:236 — unchanged semantics).
   *  Defaults to the agent's own model. */
  readonly model?: string;

  /** System prompt. Default = agent.renderInitialPrompt() (the renderer the runner already
   *  uses, agent-runner.ts:204). Override with a string, or `null` to omit entirely —
   *  supports a future fat-prompt→Role migration with no behavior change. */
  readonly system?: string | null;

  readonly maxIterations?: number;
}

export class AgentStep<TIn, TOut = string> implements Node<TIn, TOut> {
  constructor(private readonly spec: AgentStepSpec<TIn, TOut>) {}
  readonly name = this.spec.name;

  async run(input: TIn, ctx: NodeRunContext): Promise<NodeResult<TOut>> {
    const agent   = applyStepModel(this.spec.agent, this.spec.model);  // base.ts:236
    const message = this.spec.prompt(input, slotReader(ctx.slots));
    const opts: RunOptions = {
      toolExecutor:  ctx.toolExecutor,
      maxIterations: this.spec.maxIterations,
      traceId:       ctx.traceId,
    };

    try {
      if (this.spec.output && !isStringSchema(this.spec.output)) {
        if (!ctx.runner.runStructured) throw new StructuredOutputUnsupported(this.name);
        const r = await ctx.runner.runStructured(agent, message, this.spec.output, opts);
        return { output: r.object, succeeded: true,
                 totalInputTokens: r.inputTokens, totalOutputTokens: r.outputTokens };
      }
      // string special case — identical to today's executeStep path (generateText)
      const r = await ctx.runner.run(agent, message, opts);
      return { output: r.response as TOut, succeeded: true,
               totalInputTokens: r.inputTokens, totalOutputTokens: r.outputTokens };
    } catch (error) {
      // Leaf ALWAYS returns a failed result; the composite decides continue-vs-abort (§5.3).
      return { output: undefined as TOut, succeeded: false, error: error as Error,
               totalInputTokens: 0, totalOutputTokens: 0 };
    }
  }
}
```

`AgentStep<TIn, string>` with no `output` schema is the exact semantic of today's `Step` (rendered system, `generateText`, raw text out) — the migration anchor. **Replaces** `Step`/`MessageTemplate`/`executeStep` (`base.ts:29-48, 22, 250`).

### 5.2 `FunctionStep<TIn, TOut>` — input → async fn → typed output (no LLM)

```ts
// packages/agent-runtime/src/workflows/function-step.ts  (NEW)

export interface FunctionStepSpec<TIn, TOut> {
  readonly name?: string;
  /** Deterministic glue: data fetch, join, consolidation. May read/write slots. */
  readonly fn: (input: TIn, slots: SlotAccess, ctx: NodeRunContext) => TOut | Promise<TOut>;
}

export class FunctionStep<TIn, TOut> implements Node<TIn, TOut> {
  constructor(private readonly spec: FunctionStepSpec<TIn, TOut>) {}
  readonly name = this.spec.name;

  async run(input: TIn, ctx: NodeRunContext): Promise<NodeResult<TOut>> {
    try {
      const output = await this.spec.fn(input, slotAccess(ctx.slots), ctx);
      return { output, succeeded: true, totalInputTokens: 0, totalOutputTokens: 0 };
    } catch (error) {
      return { output: undefined as TOut, succeeded: false, error: error as Error,
               totalInputTokens: 0, totalOutputTokens: 0 };
    }
  }
}
```

Genuinely new — there is no deterministic-node concept today; consolidation was only the untyped `Consolidator` on `Parallel` (`parallel.ts:22`). `SlotAccess` (read+write) lets a `FunctionStep` consolidate into a Backpack slot (the canonical CitationBook write, §6).

### 5.3 Failure ownership (resolving the verifier's leaf-failure blocker)

**A leaf NEVER inspects its parent.** Both leaves catch internally and return `{ succeeded: false, error }`. The **composite** is the single place that decides continue-vs-abort by inspecting `child.succeeded`:

- **Sequential** honors `continueOnError` (default `false` ⇒ stop on first `succeeded:false`, preserving `SequentialOptions.continueOnError` semantics, `sequential.ts`).
- **Parallel / FanOut** honor `continueOnError` (replacing/equivalent to today's `returnExceptions`, `parallel.ts:54-59`, default collect-and-continue): a failed branch lands in a `failed: [index, Error]` channel; siblings proceed.

**Bridging legacy throwing steps:** the existing `executeStep` (`base.ts:250`) and legacy `Sequential`/`Parallel` are built around `try/catch` on a *throwing* step. The composite engines normalize both regimes: when running a child `Node`, inspect `result.succeeded`; when running a legacy `Step` (string path), the engine's own `try/catch` produces the equivalent `{ succeeded:false }` outcome. One uniform rule — `succeeded:false` (however produced) is what `continueOnError` branches on.

This is the locked **Open-Q3** resolution: a throwing `FunctionStep` behaves *exactly* like a throwing `AgentStep`. Identical signature ⇒ identical failure contract. Fatality remains opt-in per error (the `RetryLoop.fatalErrors` precedent, `retry-loop.ts:70-77`), never hardwired per node type.

---

## 6. The five composites

All implement `Node<TIn, TOut>` and are freely nestable (generalizing today's "Sequential accepts `Array<Step | PatternProtocol>`", `sequential.ts:50`, to "any node accepts any node"). Nesting **fixes** the asymmetries the trace found: nested writes propagate via typed `TOut` (not dropped as at `sequential.ts:119,123`), and slots propagate via the explicit scope rule (§7).

> **Design choice (resolving the verifier's "kept-verbatim vs replaced" blocker):** the existing `Sequential`/`Parallel` **classes are kept VERBATIM** as the legacy string path (their constructors, `SequentialResult`/`ParallelResult` shapes, `consolidatedOutput`, `finalContext` all preserved — so `parallel.test.ts:113,132,42` and `sequential.test.ts` stay green). The typed grid is delivered as **siblings**: `TypedSequential` (fluent builder), `TypedParallel`, plus the three new composites `FanOut`/`Accumulate`/`Loop`. We do **not** replace the legacy classes' constructors or return types. This is the only path consistent with the contained, non-breaking blast-radius claim.

### 6.1 Shared typed consolidation contract (Parallel + FanOut)

```ts
// packages/agent-runtime/src/workflows/consolidate.ts  (NEW — types the untyped Consolidator)

/** Optional reduce of N branch outputs into one. Omit => result is the array TOut[].
 *  This TYPES today's `Consolidator = (results: StepResult[]) => unknown` (parallel.ts:22)
 *  and its defaults collectContents/collectByName (parallel.ts:25-36). The reduce now
 *  operates on typed TOut[] and its result BECOMES the node's TOut — so a downstream node
 *  receives it by threading (fixing the "consolidatedOutput is a dead-end" asymmetry). */
export type Consolidate<TOut, TConsolidated> = (outputs: readonly TOut[]) => TConsolidated;
```

### 6.2 `TypedSequential` — N named steps in order, thread typed output node→node

A fluent builder (chosen over a recursive-conditional tuple type — the verifier flagged the tuple as fragile with poor error messages). Each `.then()` seam type-checks `step[i].TOut === step[i+1].TIn`.

```ts
// packages/agent-runtime/src/workflows/sequential-typed.ts  (NEW)

class TypedSequentialBuilder<TIn, TCur> {
  private constructor(private readonly nodes: Node<any, any>[], private readonly opts: SeqOpts) {}
  static start<A, B>(first: Node<A, B>, opts?: SeqOpts) {
    return new TypedSequentialBuilder<A, B>([first], opts ?? {});
  }
  /** Compile error if `node`'s TIn ≠ TCur — this typed seam REPLACES outputKey threading. */
  then<TNext>(node: Node<TCur, TNext>): TypedSequentialBuilder<TIn, TNext> {
    return new TypedSequentialBuilder<TIn, TNext>([...this.nodes, node], this.opts);
  }
  build(name?: string): Node<TIn, TCur> { /* fold: out_n = in_{n+1}; roll up token totals */ }
}
export const TypedSequential = TypedSequentialBuilder;
// usage: TypedSequential.start(plan).then(implement).then(judge).build()  →  Node<Goal, Verdict>
```

`SeqOpts = { continueOnError?: boolean }`, default `false` (break on first `succeeded:false`). **Replaces** the string-key threading (`outputKey`, `sequential.ts:103-105`) with return-value chaining.

### 6.3 `TypedParallel<TIn, TBranch, TConsolidated = TBranch[]>` — N named branches at once over a shared input

```ts
// packages/agent-runtime/src/workflows/parallel-typed.ts  (NEW)

class TypedParallel<TIn, TBranch, TC = TBranch[]> implements Node<TIn, TC> {
  constructor(
    branches: ReadonlyArray<{ name: string; node: Node<TIn, TBranch> }>,
    opts?: {
      name?: string;
      consolidate?: Consolidate<TBranch, TC>;   // omit => TBranch[]
      maxConcurrency?: number;                  // reuse runWithConcurrency (parallel.ts:220)
      continueOnError?: boolean;                // default true (collect failures), §5.3
    },
  ) {}
}
```

Every branch receives the **same** `input` (the shared-read scope — now an explicit input, not a context snapshot, `parallel.ts:107,122`). Run concurrently (bounded by `maxConcurrency`, reusing `runWithConcurrency`, `parallel.ts:220`). Collect outputs **in branch order**. With `consolidate` → return `consolidate(outputs)`; else → `TBranch[]`. Now (a) typed, (b) nestable (legacy Parallel was flat `Step[]` only), (c) its consolidated output is threadable `TC`.

### 6.4 `FanOut<TIn, TItem, TOut, TConsolidated = TOut[]>` — ONE step over a RUNTIME list, concurrently

```ts
// packages/agent-runtime/src/workflows/fan-out.ts  (NEW — genuinely new; no map-over-data exists today)

export interface FanOutSpec<TIn, TItem, TOut, TC = TOut[]> {
  readonly name?: string;
  /** Produce the list at runtime from upstream input + slots. List is DATA, not steps. */
  readonly over: (input: TIn, slots: SlotReader) => readonly TItem[];
  /** The operation as an uncalled VALUE; FanOut invokes it per item. Branches are INDEPENDENT. */
  readonly step: Node<TItem, TOut>;
  readonly consolidate?: Consolidate<TOut, TC>;
  readonly maxConcurrency?: number;
  readonly continueOnError?: boolean;
}
export class FanOut<TIn, TItem, TOut, TC = TOut[]> implements Node<TIn, TC> { /* … */ }
```

Compute `items = over(input, slots)`; run `step.run(item, branchCtx)` per item, concurrently (bounded). Branches are **independent** (no item sees another's output — that is `Accumulate`'s job; independence is what licenses concurrency). Each branch gets a **forked branch-scoped slot store** (§7.3). Consolidate or return `TOut[]`. Reuses `runWithConcurrency` (`parallel.ts:220`) and the typed `Consolidate` (§6.1).

### 6.5 `Accumulate<TIn, TItem, TAcc>` — ONE step over a runtime list IN ORDER, threading an accumulator

```ts
// packages/agent-runtime/src/workflows/accumulate.ts  (NEW)

export interface AccumulateSpec<TIn, TItem, TAcc> {
  readonly name?: string;
  readonly over: (input: TIn, slots: SlotReader) => readonly TItem[];
  readonly initial: (input: TIn) => TAcc;
  /** For EACH item, read prior accumulator + item -> next accumulator. The "for each section,
   *  with prior sections" dependent fold. */
  readonly step: Node<{ acc: TAcc; item: TItem; index: number }, TAcc>;
}
export class Accumulate<TIn, TItem, TAcc> implements Node<TIn, TAcc> { /* … */ }
```

`acc = initial(input)`; for each item **in order**, `acc = (await step.run({ acc, item, index }, ctx)).output`; return final `acc`. **Sequential by construction** — there is deliberately **no `maxConcurrency` field**, so nobody can set `>1` and corrupt the fold. The threaded accumulator **is** its consolidation (final `acc` = result). Generalizes the internal accumulators buried in `task-loop.ts:101` (`history`), `evaluator-loop.ts:108` (`refinements`) into a first-class typed fold.

### 6.6 `Loop<TState>` — repeat a body until a predicate on its typed output holds

```ts
// packages/agent-runtime/src/workflows/loop.ts  (NEW — the single repeat-until primitive)

export interface LoopSpec<TState> {
  readonly name?: string;
  readonly body: Node<TState, TState>;                          // output feeds next input
  readonly until: (output: TState, iteration: number) => boolean;
  readonly maxIterations: number;                               // REQUIRED safety cap
}
export interface LoopResult<TState> extends NodeResult<TState> {
  readonly iterations: number;
  readonly exitReason: "predicate_met" | "max_iterations";
}
export class Loop<TState> implements Node<TState, TState> {
  constructor(spec: LoopSpec<TState>) { /* throws if maxIterations is absent */ }
  async run(input: TState, ctx: NodeRunContext): Promise<LoopResult<TState>> { /* … */ }
}
```

`state = input`; loop: `state = (await body.run(state, ctx)).output`; if `until(state, i)` → exit `predicate_met`; if `i+1 >= maxIterations` → exit `max_iterations` returning **last** state. Generalizes the four divergent loop `run` shapes (`RetryLoop`/`EvaluatorLoop`/`TaskLoop`/`ConversationLoop`) into one `Node`-shaped loop. The producer/evaluator refinement of `EvaluatorLoop` becomes `body = TypedSequential.start(produce).then(evaluate)` whose `TState` carries `{ content, score, feedback, issues[] }` — the flat `{score,feedback,qualityMet}` (`evaluator-loop.ts:29`) upgraded to structured `issues[]` via an `AgentStep` with a Zod schema.

### 6.7 Worked example — the coding-agent workflow, end to end

Threading: plan → implement → stash(into Backpack) → Parallel(3 reviewers) → consolidate(FunctionStep) → FanOut(addressFeedback over findings) → Loop(fix until GOOD). The `codebase` Slot carries the artifact that would otherwise pollute every signature.

```ts
const Plan    = z.object({ steps: z.array(z.string()) });
const Impl    = z.object({ diff: z.string(), files: z.array(z.string()) });
const Finding = z.object({ file: z.string(), severity: z.enum(["nit","warn","block"]), note: z.string() });
const Review  = z.object({ reviewer: z.string(), findings: z.array(Finding) });
const Findings= z.object({ items: z.array(Finding) });
const Fix     = z.object({ file: z.string(), patch: z.string() });
const Verdict = z.object({ diff: z.string(), grade: z.enum(["GOOD","NEEDS_WORK"]) });

// Backpack: the implemented codebase — written once, read by everyone (the CitationBook analogue).
const codebase = slot<{ diff: string }>({ key: "codebase", scope: "run", init: () => ({ diff: "" }) });

const workflow = TypedSequential
  .start(new AgentStep({ name: "plan",      agent: planner, output: Plan,
                         prompt: (task: { goal: string }) => `Plan: ${task.goal}` }))
  .then(new AgentStep({ name: "implement",  agent: coder,   output: Impl,
                        prompt: (plan) => `Implement:\n${plan.steps.join("\n")}` }))
  // record the impl into the Backpack so reviewers/fixers read it without threading it everywhere
  .then(new FunctionStep({ name: "stash",
                           fn: (impl, slots) => { slots.set(codebase, { diff: impl.diff }); return impl; } }))
  .then(new TypedParallel<Impl, Review>(
      [{ name: "revA", node: review(reviewerA) },
       { name: "revB", node: review(reviewerB) },
       { name: "revC", node: review(reviewerC) }]))                 // omit consolidate => Review[]
  .then(new FunctionStep<Review[], Findings>({ name: "consolidate",
      fn: (reviews) => ({ items: reviews.flatMap(r => r.findings).filter(f => f.severity !== "nit") }) }))
  .then(new FanOut<Findings, Finding, Fix, Verdict>({ name: "address",
      over: (f) => f.items,                                          // runtime list
      step: new AgentStep({ name: "fix1", agent: fixer, output: Fix,
                            prompt: (finding, slots) => `Fix in ${slots.get(codebase).diff}: ${finding.note}` }),
      consolidate: (fixes) => ({ diff: applyAll(fixes), grade: "NEEDS_WORK" as const }) }))
  .then(new Loop<Verdict>({ name: "polish",
      body: TypedSequential
        .start(new AgentStep({ name: "fix",   agent: fixer,  output: z.object({ diff: z.string() }),
                               prompt: (v) => `Improve:\n${v.diff}` }))
        .then(new AgentStep({ name: "judge",  agent: grader, output: Verdict,
                             prompt: (x) => `Grade:\n${x.diff}` }))
        .build(),
      until: (v) => v.grade === "GOOD",
      maxIterations: 4 }))
  .build();

const result = await workflow.run({ goal: "add CSV export" }, { runner });
// result.output: Verdict ;  final codebase via the run-scoped slot after run()

function review(agent: AgentLike): Node<Impl, Review> {
  return new AgentStep({ agent, output: Review,
                         prompt: (_impl, slots) => `Review:\n${slots.get(codebase).diff}` });
}
```

What each piece replaces: `plan/implement` replace string `Step`s; `TypedParallel` replaces `parallel.ts:77` (now typed/nestable/threaded); the `consolidate` `FunctionStep` is the first-class form of the orphaned `Consolidator` (`parallel.ts:180-188`); `FanOut` is the brand-new runtime-map; `Loop` replaces `EvaluatorLoop` (`evaluator-loop.ts:74`) with structured `Verdict`; the `codebase` slot replaces the SLOT half of `contextExtractor`/`finalContext` (`sequential.ts:106-111,167`).

---

## 7. Typed scoped Slot / Backpack

### 7.1 Type

```ts
// packages/agent-runtime/src/workflows/slot.ts  (NEW — the typed replacement for PatternContext's shared-state duty)

export interface Slot<T> {
  readonly key: string;
  readonly scope: "run" | "branch";
  readonly init: () => T;
  /** Branch-scope reconciliation. DEFERRED (Open-Q1) — declared but not auto-invoked
   *  until concurrent branch-writes are actually enabled. See §8.1. */
  readonly merge?: (parent: T, child: T) => T;
}
export function slot<T>(def: Slot<T>): Slot<T> { return def; }

export interface SlotReader { get<T>(s: Slot<T>): T; }
export interface SlotAccess extends SlotReader {
  /** MUST be synchronous and self-contained (read-modify-write in one tick) — see §8.1. */
  set<T>(s: Slot<T>, value: T): void;
  update<T>(s: Slot<T>, fn: (cur: T) => T): void;
}
export interface SlotStore extends SlotAccess {
  reader(): SlotReader;
  /** FanOut/Parallel branch entry forks branch-scoped slots; run-scoped slots stay shared. */
  fork(): SlotStore;
  /** Merge a forked child back (applies Slot.merge for branch slots that define it). */
  join(child: SlotStore): void;
}
```

`run` scope = one shared instance for the whole workflow (the `CitationBook`/`codebase` case). `branch` scope = each FanOut/Parallel branch forks a fresh instance off `init()`. A node does **not** declare slots in its type — it closes over a module-level `Slot<T>` handle and accesses it via the `SlotReader`/`SlotAccess` passed into `prompt(input, slots)` / `fn(input, slots)`. This keeps the `Node<TIn,TOut>` signature clean (threaded I/O only) while slots stay ambient — the exact split the locked design demands.

### 7.2 Scope semantics

- **`run`** — exactly one shared instance for the whole tree, lazily `init()`-ed on first access. Read the final value off `ctx.slots` after `run()`.
- **`branch`** — each FanOut/Parallel branch forks its own fresh instance (`store.fork()` → branch slot re-`init()`-ed) so concurrent branches can't clobber each other's working state. Run-scoped slots are **not** forked (the same shared instance flows into every branch).

### 7.3 Fork-per-branch mechanics

FanOut/Parallel build each branch's `NodeRunContext` with `slots: ctx.slots.fork()`. `fork()` returns a store where run-scoped slots alias the parent's single instance and branch-scoped slots are fresh. After a branch completes, the engine calls `ctx.slots.join(branchStore)` (which applies `merge` only when defined — §8.1).

---

## 8. The three open questions — RESOLVED

### 8.1 Q1 — Slot scope + merge → ship `run`/`branch`; DEFER `merge`; guard the canonical ordering hazard

**Decision.** Ship `scope: "run" | "branch"`. Define `merge?` in the type but **do not auto-merge**: `join()` applies `merge` only when defined; branch slots shipped for real cases define no `merge`, so branch scratch is discarded at branch exit (parity with today — nested patterns already discard their writes upward, `sequential.ts:119,123`). When a future caller flips a write-path to genuine concurrency, they define `merge` and we design+test reconciliation against that concrete case. The field existing now makes adding it later non-breaking.

**Canonical-case ordering guard (resolving the verifier's run-scope hazard).** The CitationBook/`codebase` case has a gather `FanOut` (concurrent by default) writing a `run`-scoped slot read downstream. To make the canonical example safe *without* leaning on app discipline, we adopt two framework rules:
1. `SlotAccess.set`/`update` **must be synchronous** (read-modify-write within one tick, no `await` between read and write) — documented contract; an `update(slot, fn)` form is provided precisely so appends are atomic.
2. When a `FanOut` step writes a `run`-scoped slot, **append order is completion order, not item order** — non-deterministic. The framework therefore: (a) tags each branch with its `index`, and (b) `FanOut` exposes its consolidated `TOut[]` **in item order** via the *threaded* channel. **Guidance: order-sensitive aggregation (e.g. citation numbering) must use the threaded ordered `TOut[]`, NOT a slot append.** Slots are for order-insensitive shared accumulation. This keeps the canonical example correct under concurrency by construction, rather than requiring `maxConcurrency: 1`.

**Rejected alternative.** *Auto-merge branch slots via shallow object-spread (mirroring `contextExtractor`, `sequential.ts:106-111`).* Rejected: spread-merge silently last-wins on key collisions — exactly the corruption mode the locked design fears for `Accumulate`. It bakes a wrong-for-most-cases default into the foundation and makes the correct later policy a breaking change.

### 8.2 Q2 — Loop exit on cap-hit → return LAST, tagged `max_iterations`; no scoring knob

**Decision.** `until` is evaluated on the body's typed output after each iteration. First `true` ⇒ exit `predicate_met`. On reaching the **required** `maxIterations` without satisfaction ⇒ exit `max_iterations`, **return the last output produced**. `NodeResult.succeeded` stays `true` (it produced a usable value); the caller branches on `exitReason`. There is **no** `onMaxIterations: 'best' | 'last' | 'error'` knob and **no** `score` selector (resolving the verifier's three-way contradiction — DESIGN 2's `onMaxIterations` is dropped).

**Rationale.** Generic `Loop` ranges over arbitrary `TState` with **no ordering** — "best" is undefinable without a score, and forcing a comparator onto every `TState` pollutes the generic contract for one use case. "Last" is the only output guaranteed to exist for any `TState`, it is deterministic, and the predicate already had its say each iteration. A caller wanting best-by-score keeps a `run`-scoped Slot updated inside the body and reads it after — keeping scoring *out* of the core contract. `no_improvement` (a score-plateau concept) is dropped as a Loop exit reason; an `EvaluatorLoop`-style convenience can be rebuilt as a thin `Loop` whose body updates a best-score Slot and whose `until` returns true on quality-met OR plateau.

**Rejected alternatives.** *Return best-so-far* — requires a universal comparator the typed contract can't supply, imports score-specific exit reasons, and is a silent lie when `TState` is unordered. *Throw on cap-hit* — cap-hit is an expected designed outcome (the safety valve working), not an exception; surfacing it as `exitReason` lets callers branch without `try/catch`.

### 8.3 Q3 — FunctionStep failure → identical to AgentStep failure; honor existing `continueOnError`/`returnExceptions`

**Decision.** A throwing `FunctionStep.fn` is treated **identically** to a throwing `AgentStep` runner call: the leaf catches and returns `{ succeeded:false, error }` (§5.3); the enclosing composite decides via its existing `continueOnError` (Sequential, default `false`) / collect-failures (Parallel/FanOut, default true) surface. One `PatternStepErrorEvent` shape (`base.ts`, `type:"pattern.step.error"`) and one `onStepError` hook for both. Fatality is opt-in per error class (the `RetryLoop.fatalErrors` precedent, `retry-loop.ts:70-77`), never hardwired per node type.

**Rationale.** AgentStep and FunctionStep share the signature `(input) => Promise<output>`; if they share a signature they must share a failure contract. The composite that owns the node is the single place that decides continue-vs-abort, reusing the already-built, already-tested `continueOnError`/`returnExceptions` surfaces rather than inventing a third.

**Rejected alternative.** *FunctionStep throws are always fatal (bypass `continueOnError`).* Rejected: special-cases leaf type at the engine level, breaks signature symmetry, and removes the author's deliberate `continueOnError` control for no gain.

---

## 9. Runner structured-output path

`AgentStep`'s default is typed output, which requires a schema-validated object from the runner. Per the grounding insertion analysis.

### 9.1 Protocol surface — optional sibling method (chosen over an option on `run`)

```ts
// packages/agent-runtime/src/runner/types.ts  (EXTEND)

export type StructuredRunResult<T> = RunResult & { readonly object: T };

export interface RunnerProtocol {
  run(agent: AgentLike, message: string, options?: RunOptions): Promise<RunResult>;
  stream?(agent: AgentLike, message: string, options?: RunOptions): AsyncGenerator<AgentEvent>;
  runStructured?<T>(                                   // NEW, OPTIONAL
    agent: AgentLike,
    message: string,
    schema: ZodType<T>,
    options?: RunOptions,
  ): Promise<StructuredRunResult<T>>;
  dispose?(): void;
}
```

Rationale: optional sibling mirrors the existing `stream?`/`dispose?` precedent (`types.ts:136`); `T` is inferred from the Zod schema; no sometimes-present untyped `object?` field forced onto every `RunResult` caller; Claude-Code runners need not implement it immediately. `AgentStep` guards with `ctx.runner.runStructured?.(...)` and throws `StructuredOutputUnsupported` if a schema is requested against a runner lacking it.

### 9.2 `AgentRunner.runStructured` — terminal `generateObject` pass

Insertion point: the terminal "no tool calls = done" branch of `AgentRunner.run()` (`agent-runner.ts:330-368`). The gate-chain invariant requires the looping `generateText` call (`:237`) to keep `execute`-less tools, so structured generation must be a **terminal pass after the existing tool loop**, not an option on the looping call (which would risk the SDK auto-running tools).

```ts
async runStructured<T>(agent, message, schema, options): Promise<StructuredRunResult<T>> {
  const model   = await this._resolver.resolve(agent.getModel());   // agent-runner.ts:171
  const system  = agent.renderInitialPrompt();                      // agent-runner.ts:204
  const tools   = this.convertTools(agent.getTools());              // execute-less, gate-guarded
  let messages  = convertHistory(options?.messageHistory, message);

  // --- existing tool loop runs UNCHANGED: generateText + gate intents + toolExecutor,
  //     accumulating messages + token counts + emitting events exactly as today (:237-:368) ---

  // --- terminal structured pass (replaces the plain `return {response,...}` at :360) ---
  const result = await generateObject({ model, system, messages, schema });
  this._meterAdd(result.usage);                                     // same token accounting
  return {
    response:     JSON.stringify(result.object),  // raw text channel = serialized object
    object:       result.object,                  // parsed + schema-validated T
    inputTokens:  result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    toolCallsCount, iterations, finishReason: result.finishReason,
  };
}
```

Notes: uses `generateObject` (absent today — confirmed); the response schema is a **separate argument**, *not* derived from `ToolSchema.returns` (`tool-schema.ts:46`, which stays unused by the runner). Gates/events/model-resolver/token-accounting all flow because we go **through** the runner. **Cost note:** this incurs a second model round-trip (the tool loop, then a terminal structured pass) — accepted for correctness/gate-safety. (Abort/cancel plumbing: if/when an abort signal is threaded, it belongs on `RunOptions` first — today `RunOptions` (`types.ts:94-107`) has no `signal` field, so the structured pass omits it until that field exists.)

### 9.3 `MockRunner` impact (required for test parity)

```ts
// packages/agent-runtime/src/runner/mock-runner.ts  (EXTEND MockResponse :19-30)
interface MockResponse { content: string; toolCalls?: …; object?: unknown; /* NEW */ }

async runStructured<T>(agent, message, schema, options): Promise<StructuredRunResult<T>> {
  const matched = this._match(agent, message);
  const object  = schema.parse(matched.object);     // validate against caller's schema
  return { ...this._toRunResult(matched), object, response: JSON.stringify(object) };
}
```

Without this, the typed `AgentStep` path can't be exercised in tests. `ClaudeCodeRunner`/`ClaudeCodeAPIRunner` omit `runStructured` initially (optional method; a Claude-SDK-native structured strategy can be added later).

---

### 9.4 Execution strategy — capability-gated (model-safe by default)

`runStructured` chooses its path from the **resolved model**, defaulting to the safe path so swapping an agent's model can never silently break a schema:

```
step has NO tools?
  → single Output.object call                       ✅ every model (incl. gemini-3.1-flash-lite)
step HAS tools?
  → model in the capable set?
       yes → single experimental_output + tools      (1 call — the fast path)
       no / UNKNOWN → 2-tier: run the tool loop, then a no-tools Output.object finish
                                                      ✅ every model; UNKNOWN defaults HERE
```

The author writes **one** `AgentStep` (tools + schema); the runner swaps 1-call ↔ 2-call under the hood by model. **Correctness never depends on the capability flag** — it only decides whether a round-trip is saved. An unrecognized model id falls to the 2-tier path (slower, never wrong). The 2-tier's tier-2 is exactly the no-tools `Output.object` path of §9.2; its tier-1 is the existing `run` tool loop.

Built on **`Output.object`** (v5 `experimental_output` → v6 `output`; `generateObject` is deprecated in v6 — do not build on it).

**Per-model capability table** (`supportsToolsWithStructuredOutput`) — conservative, additive, empirically seeded (§9.5):

| Model | no-tools structured | single-call tools+structured |
|---|---|---|
| `openai/gpt-5`, `openai/gpt-4o` | ✅ | ✅ capable |
| `gemini/gemini-3.5-flash` | ✅ | ✅ capable |
| `gemini/gemini-3.1-flash-lite` | ✅ | ❌ → 2-tier |
| `gemini/gemini-2.5-pro`, `gemini/gemini-2.5-flash` | ✅ | ❌ → 2-tier |
| `anthropic/*` | untested (§9.5) | untested (§9.5) |

Adding a model to the capable set is one entry, after verification. Default for any id not in the table = **not capable** (2-tier).

### 9.5 Empirical validation (trial harness)

Verified live through the dealbrain Bifrost gateway via two throwaway harnesses — `packages/agent-runtime/scripts/structured-output-trial.ts` and `two-tier-fallback-trial.ts`:

- **No-tools `Output.object`: passed on every model tested** (gemini 2.5/3.1/3.5, openai gpt-4o/gpt-5) → the universal path; `runStructured`'s no-tools branch is safe everywhere.
- **Single-call tools+structured: `openai/*` ✓, `gemini-3.5-flash` ✓; `gemini ≤3.1 / 2.5` ✗** (invalid JSON / "No output specified", tool never fired) → this is the per-model gap the capability gate exists for.
- **2-tier fallback on `gemini-3.1-flash-lite`: PASS** — tool fired in tier 1, schema-valid object in tier 2. The model-safe path is proven on the exact failing model.
- **Anthropic: NOT yet tested** — the dealbrain Bifrost instance has only `gemini` + `openai` providers configured (`GET /api/providers`), and there is no native `ANTHROPIC_API_KEY`. Needs Anthropic added to Bifrost (or a native key) to validate the native `structuredOutputMode: "outputFormat"` row.

Incidental finding (fixed): local `node_modules` was stale — `ai@4.3.19` installed vs lockfile `ai@5.0.206`; resolved via `bun install`. Anyone building locally needs the synced install.

---

## 10. Migration + sequencing

**Strategy:** the typed `Node` contract becomes the real core; the legacy string types are *redefined as string specializations* and kept exported, so existing consumers compile. The declarative `WorkflowConfig` path is **pinned to `Node<PatternContext, string>`** — its schema (string-only `messageTemplate`/`outputKey`, `workflow-config.ts:37,41`) cannot carry type params, which is the intended ceiling. FanOut/Accumulate/Loop/Slots/typed I/O are **code-API only** (consistent with `contextExtractor`/`consolidator` already being code-only).

### Ordered PRs

| PR | Scope | Breaking? |
|---|---|---|
| **1** | Runner structured-output: `StructuredRunResult`, optional `runStructured?` on `RunnerProtocol`, `AgentRunner.runStructured` (`generateObject`), `MockRunner.runStructured`. Zero workflow coupling. | Additive only |
| **2** | `node.ts` (`Node`/`NodeResult`/`NodeRunContext`/`NodeOutcome`) + `slot.ts`. Reframe `PatternResult`/`StepResult`/`PatternProtocol` as string refinements (§4); update `createStepResult` to populate `nodeName`/`output`. | Contained to `workflows/**`; legacy aliases preserve all readers |
| **3** | Leaves: `AgentStep`, `FunctionStep`. Legacy `Step` reframed as degenerate `AgentStep<_, string>`; `stepToNode`/`nodeToStep` shim. | Additive |
| **4a** | Typed siblings `TypedSequential` (builder) + `TypedParallel`. Legacy `Sequential`/`Parallel` classes kept **verbatim**. | Additive |
| **4b** | New composites `FanOut`, `Accumulate`, `Loop` (reuse `runWithConcurrency` `parallel.ts:220`, `applyStepModel` `base.ts:236`). | Additive |
| **5** | Keep `RetryLoop`/`EvaluatorLoop`/`TaskLoop`/`ConversationLoop` exported and behavior-unchanged; document `Loop`/`Accumulate` as the primitives they conceptually instantiate. No forced migration. | None |
| **6** | Declarative config gate: `WorkflowConfig` stays string-pinned; `buildWorkflowFromConfig` keeps emitting string-contract `Sequential`/`Parallel`; `{{key}}`/`outputKey` interpolation preserved (`build-workflow-from-config.test.ts:74` stays green). | None |
| **7** | `docs/HANDOFF.md` workflow note (the only published-doc reference). | None |

### Breaking vs preserved

| Preserved (no consumer break) | Reworked (contained to `workflows/**` + tests) |
|---|---|
| `PatternResult.finalContent` / `.succeeded` / token fields (refinement of `NodeResult<string>`) | `PatternContext` *as the threading carrier* → demoted to pure Slot store; threading now via typed return values |
| `Sequential`/`Parallel` constructors + `SequentialResult`/`ParallelResult`/`consolidatedOutput`/`finalContext` (kept verbatim) | The five incompatible loop `run()` shapes unified under `Node.run` (legacy loops kept behind their current signatures, so not user-visible) |
| Declarative `WorkflowConfig` JSON (schema unchanged) | `Consolidator` typed (`Consolidate<TOut,TC>`) — source-compatible for untyped callers |
| All barrel-exported symbols remain exported | `createStepResult`/`StepResult.content` reshaped (no external callers) |
| `runner.run()` / `RunResult` unchanged; `runStructured` additive optional | — |

### PatternStack-first

PRs 1–7 land entirely in the framework with **zero consuming-app changes** — nothing downstream depends on the workflow layer (no server/dashboard/runner/preset consumers; only `docs/HANDOFF.md` needs a note). The consuming-agent migration (CitationBook → Slot, per-subject FanOut, fat-prompt → Role) is a **separate later track** with no migration pressure, because the legacy string surface stays live throughout.

---

## 11. Naming rationale + Non-Goals

### Names

- **`Sequential` / `Parallel`** — kept (legacy classes verbatim; typed siblings `TypedSequential`/`TypedParallel`). Already public, already mean their grid cell.
- **`FanOut`** — industry-standard for one operation dispatched concurrently over N runtime items. Distinguishes from `Parallel` precisely: Parallel = N *different* hand-written branches over a *shared* input (count known at authoring time); FanOut = the *same* step over a *runtime-derived list* (`over: (ctx) => TItem[]`, count known only at execution). Independent branches → licenses concurrency.
- **`Accumulate`** (over runner-up `Cumulative`) — names the *act* (threading an accumulator forward), an imperative node verb consistent with `FanOut`/`Loop`. Its threaded accumulator IS its consolidation.
- **`AgentStep` / `FunctionStep`** — the two leaves, same `(input) => Promise<output>` signature, named by *what produces the output*. "Step" (not "Node") for leaves keeps continuity with today's `Step` and reserves bare `Node` for the universal contract. Structured output is the DEFAULT — no `StructuredStep`; raw string is `TOut = string`.
- **`Loop`** — the single repeat-until primitive that today's four loop classes conceptually instantiate.

### Explicit Non-Goals

1. **Fat-prompt → Role rendering migration** — eval-gated, separate. `AgentStep.system` defaults to `renderInitialPrompt()` and allows override/omission *specifically* so a byte-identical migration is possible later — not now.
2. **Declarative-config schema gaining type params** — `WorkflowConfig` stays string-typed by design (serialized JSON is the erasure boundary). Slots, typed consolidate, FanOut's `over`-function, and Accumulate's fold are code-API only.
3. **Flipping `per_subject` (or any consuming-app gather) to real parallel** — observability/trace-ordering concern owned by the app, not the framework. (Also why Slot `merge` is deferred — §8.1.)
4. **Slot `merge` semantics under concurrency** — deferred until concurrency is actually flipped. Shipping run/branch scope without merge is parity with today's already-non-merging nested patterns.
5. **Router / conditional / orchestrator nodes** — none exist today and none are in scope. The grid is four composites + `Loop`; branching is out.
6. **Migrating the four legacy loops or the consuming agent** — foundation-first; later, pressure-free tracks because the legacy string surface stays live.

---

## 12. Open risks (carried from adversarial review)

| Risk | Mitigation in this design |
|---|---|
| Run-context additions breaking existing `.run({}, { runner })` calls | `slots` is **optional** (engine-defaulted); token rollup lives in `NodeResult`, **no required `meter`**; second `run` param widened to `NodeRunContext?` on `PatternProtocol`. §3, §4 |
| Sequential/Parallel "kept vs replaced" ambiguity | **Resolved:** legacy classes kept verbatim; typed grid is siblings (`TypedSequential`/`TypedParallel`). §6 |
| Loop cap-hit specified three ways | **Resolved:** return LAST + `exitReason: "max_iterations"`; no `onMaxIterations`/`score` knob. §8.2 |
| Leaf failure ownership | **Resolved:** leaf always returns `{succeeded:false}`; composite inspects `.succeeded`; engine normalizes throwing legacy steps. §5.3 |
| Concurrent run-scoped Slot write ordering (canonical CitationBook) | **Resolved:** `set`/`update` must be synchronous; order-sensitive aggregation uses the threaded ordered `TOut[]`, not slot appends; slots are for order-insensitive accumulation. §8.1 |
| `succeeded` vs `ok` rename | **Resolved:** `NodeResult.succeeded` keeps the existing name; token fields keep `totalInputTokens`/`totalOutputTokens`. §3 |
| `createStepResult` "unchanged" claim | **Corrected:** it is updated to also populate `nodeName`/`output` (one-line additive). §4 |
| Structured pass abort/cancel under-specified | Deferred with `RunOptions.signal` (no such field today); structured pass omits it until the field exists. §9.2 |
| Typed/legacy nesting boundary | Stated plainly: typed and legacy composites intercompose **only at `TOut = string` seams** via `stepToNode`/`nodeToStep`; no free mixing during migration. §10 |
| `generateObject` second round-trip cost/latency | Accepted for gate-chain safety; noted explicitly. §9.2 |
