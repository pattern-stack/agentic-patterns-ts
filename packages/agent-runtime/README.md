# @pattern-stack/agentic-runtime

Execution runtime for agentic-patterns agents. Provides the runner loop (Vercel AI SDK), typed event bus, gate chain, workflow compositions and loops, multi-agent transport and runtime, conversation persistence, observability exporters, and pre-built role presets.

## Installation

```bash
bun add @pattern-stack/agentic-runtime @pattern-stack/agentic-core ai zod
```

## API Overview

### Runner (`src/runner/`)

The `AgentRunner` executes agents using a tool loop on the Vercel AI SDK.

```typescript
import { AgentRunner } from "@pattern-stack/agentic-runtime";

const runner = new AgentRunner(model, eventBus);

const result = await runner.run(agent, "Analyze this data", {
  toolExecutor: myExecutor,
  maxIterations: 10,
  history: previousMessages,
});

// result: { response, inputTokens, outputTokens, toolCallsCount, iterations, finishReason }
```

Key types:
- `RunResult` -- execution outcome with token counts and finish reason
- `RunOptions` -- configuration: toolExecutor, maxIterations, history
- `RunnerProtocol` -- interface for custom runner implementations
- `ToolExecutor` -- tool execution handler interface
- `AgentLike` -- minimal agent shape required by the runner
- `CanonicalMessage` / `CanonicalMessagePart` -- normalized message format
- `convertHistory()` -- convert CanonicalMessage[] to CoreMessage[] for the AI SDK

#### MockRunner

Deterministic runner for testing agents without LLM calls. Pattern-based response routing with tool call simulation.

```typescript
import { MockRunner } from "@pattern-stack/agentic-runtime";

const mock = new MockRunner()
  .addResponse("analyze", { content: "Revenue up 15%", inputTokens: 10, outputTokens: 20 })
  .addResponse("summarize", {
    content: "Summary complete",
    toolCalls: [{ name: "write_file", arguments: { path: "out.md" }, result: "ok" }],
  })
  .addResponse("*", { content: "Default fallback" }); // wildcard

const result = await mock.run(agent, "analyze Q4");

// Verify calls
mock.callHistory; // [{ message, agentName, model, timestamp }]

// Streaming mode
for await (const event of mock.stream(agent, "analyze")) {
  // yields full event lifecycle: message.start -> tool events -> message.complete
}

// Reset
mock.clear();
```

Features:
- Substring trigger matching, `*` wildcard, auto-fallback
- Tool call simulation with results
- Delay and error simulation (`delayMs`, `error` fields)
- Full event lifecycle emission in `stream()` mode
- Fluent API and call history recording

#### ClaudeCodeRunner

Runner backed by the Claude Agent SDK. Delegates to Claude Code's subprocess architecture.

```typescript
import { ClaudeCodeRunner } from "@pattern-stack/agentic-runtime";

const runner = new ClaudeCodeRunner({
  defaults: { model: "sonnet" },
});

const result = await runner.run(agent, "Fix the bug in auth.ts");
```

### Events (`src/events/`)

Typed pub/sub event system with discriminated union events.

**Event Types:**
`MessageStartEvent`, `MessageChunkEvent`, `MessageCompleteEvent`, `ReasoningEvent`, `ToolCallIntent`, `ToolCallRejectedEvent`, `ToolCallStartEvent`, `ToolCallEndEvent`, `IterationStartEvent`, `IterationEndEvent`, `LLMCallStartEvent`, `LLMCallEndEvent`, `ErrorEvent`

All events carry trace fields: `traceId`, `runId`, `spanId`, `parentSpanId`, `timestamp`.

**Sandbox Events** for multi-agent communication:
`AgentMessageEvent`, `AgentBroadcastEvent`, `AgentJoinEvent`, `AgentLeaveEvent`, `TaskCreateEvent`, `TaskUpdateEvent`, `TaskAssignEvent`, `HealthPingEvent`, `HealthPongEvent`, `NodeLifecycleEvent`

```typescript
import { EventBus, AgentEventBus, EventProfile, subscribeProfile } from "@pattern-stack/agentic-runtime";

const bus = new AgentEventBus();

bus.subscribe("agent.message.complete", (event) => {
  console.log(event.response);
});

subscribeProfile(bus, EventProfile.UX, (event) => {
  // Receives message.start, message.chunk, message.complete, tool events, errors
});
```

**Event Profiles:** `UX`, `OBSERVABILITY`, `DEBUG`, `TOOLS`, `STREAMING`

### Gates (`src/gates/`)

Gate chain intercepts tool call intents for safety, approval, rate limiting, and auditing.

```typescript
import { AgentEventBus, SafetyGate, HumanApprovalGate, AuditGate } from "@pattern-stack/agentic-runtime";

const bus = new AgentEventBus();

// Gates are checked in category order: SAFETY -> RATE_LIMIT -> APPROVAL -> AUDIT
bus.addGate(new SafetyGate(["rm", "drop_table"]));
bus.addGate(new HumanApprovalGate(async (event) => {
  return confirm(`Allow ${event.toolName}?`);
}));
bus.addGate(new AuditGate((event) => auditLog.append(event)));
```

Gate types: `SafetyGate`, `HumanApprovalGate`, `RateLimitGate`, `AuditGate`

### Workflows (`src/workflows/`)

Composable workflow patterns for multi-step and iterative agent execution: the typed `Node` layer (below) and the original string-pinned pattern layer (further down).

#### Typed Node compositions

Everything implements one contract — `Node<TIn, TOut>` (`run(input, ctx)` → `{ output, succeeded, error?, totalInputTokens, totalOutputTokens }`) — so leaves and composites nest freely: `AgentStep` (LLM leaf, structured output by default), `FunctionStep` (deterministic glue), typed `Sequential`/`Parallel`/`FanOut`/`Loop`/`Retry`/`Accumulate`, `CoordinatorStep` (a model-driven coordinator as a leaf), and the run-scoped `Scratchpad` slot store.

##### sequentialAgent

Agents AND nodes in sequence over one implicitly shared Scratchpad. Stage knobs: `name` / `output` / `prompt` / `slot` / `onEmit` / `stop` / `reads` / `writes` / `retry` / `input`. Per-stage tool executors derive from each agent's own capabilities.

```typescript
import { type Node, FunctionStep, sequentialAgent } from "@pattern-stack/agentic-runtime";

// Untyped: Node<unknown, SequentialAgentResult> — { outputs, stopped }
const pipeline = sequentialAgent([interpretAgent, { agent: judge, output: Verdict }]);

// Typed: a COMPOSITE-designated emitting stage types the node — the output IS
// that stage's emission, zero casts. input:'prior' hands a node stage the
// previous stage's emission (the compiler-checked spine → tail seam).
const typed: Node<string, Contract> = sequentialAgent<Contract, string>(
  [{ node: coordinatorSpine }, { node: answerTail, input: "prior" }],
  { emit: "answer" }, // type arguments REQUIRE emit; there is no stage-level marker
);
```

##### parallelAgent

Fixed, NAMED branches fanned out over a shared input (`FanOut` remains the tool for dynamic-N over runtime lists). Deterministic index-order join keyed by branch name; leaf-never-throws is lifted into the join — a failed branch becomes a `{ succeeded: false, error }` outcome while the composite still succeeds (check `failed.length` to hard-fail). Stop policy is complete-all: a branch's `stop` is a first-in-index-order signal, never a cancellation.

```typescript
const sections = parallelAgent<{ overview: string; pricing: Pricing }>(
  [
    { agent: overviewDrafter, prompt: (_state, input) => `overview for: ${input}` },
    { agent: pricingDrafter, output: PricingShape },
  ],
  { maxConcurrency: 2 },
);
// → Node<unknown, ParallelAgentResult<…>>: { branches, failed, stopped }
```

Full semantics (stop lanes, emission slots, build-time race guards) live in the module docs: `src/workflows/sequential-agents.ts`, `src/workflows/parallel-agents.ts`.

#### Scope host (`src/workflows/scope-host.ts`)

A parsed `SessionScope` value (`@pattern-stack/agentic-core`) rides across a run as a SIBLING key on the host bag — `RunOptions.host.scope` — never inside `host.deps` (a `DepReader`; a plain scope object there would crash the first `ctx.deps.get()`). `buildScopeHost(parsed)` builds the injection-side fragment; merge it with any other host bits at the call site (the server and CLI wire it in right after `scope.parse()`):

```typescript
import { buildScopeHost } from "@pattern-stack/agentic-runtime";

const host = { ...otherHostBits, ...buildScopeHost(parsedScope) };
```

Reads go through three accessors that all accept BOTH a tool's `ToolExecutionContext` (`ctx.host.scope`) and a node's `NodeRunContext` (`ctx.scope` directly) — a `FunctionStep` author and a tool author call the same function:

- `readScope(ctx)` — soft probe; `undefined` when the run carries no scope
- `requireScope(ctx)` — fail-loud default read path; throws `ScopeUnavailableError` with remediation
- `readScopeAs<T>(ctx)` — typed cast sugar over `readScope`, trusting that the server-side `scope.parse()` already ran; it does NOT re-parse per call

```typescript
import { requireScope } from "@pattern-stack/agentic-runtime";
import type { ScopeValue } from "@pattern-stack/agentic-core";

const scope = requireScope(ctx) as ScopeValue<typeof myScope>;
```

`Conversation` accepts scope the same way — `new Conversation(agent, runner, { store, host: buildScopeHost(parsedScope) })`. The host bag is fixed at construction and forwarded verbatim into every `send()`/`stream()` call for the conversation's lifetime. Scope also survives delegation: a nested `AgentStep` and an agent invoked as a tool (`node-tool.ts`, agent-as-tool) both forward the parent's `host.scope` onto the sub-run's context, so a promoted-node leaf or a delegated sub-agent sees the same bound scope as the top-level run.

`AgentRunner` and `ClaudeCodeRunner` both narrow `RunOptions.host.scope` into the `RenderContext` passed to `agent.renderInitialPrompt()`, so scope-derived prompt text (`Awareness.fromScope`, see `@pattern-stack/agentic-core`'s README) renders on every turn. `ClaudeCodeRunner` is the one asymmetric case, and it's worth being honest about: scope reaches its rendered system prompt but NOT its tool execution — the Claude Agent SDK's MCP tool loop has no context seam to carry `host.scope` through, so CC-native and MCP-bridged tools on that runner stay scope-less until that seam exists.

#### Legacy string-pinned patterns

The original pattern layer. All patterns implement `PatternProtocol` and share common types.

#### Base Types

- `PatternContext` -- shared context (`Record<string, unknown>`) threaded through steps
- `MessageTemplate` -- static string or `(context) => string` function
- `Step` -- agent + message template + optional output key + context extractor
- `StepResult` -- execution result with `.content` accessor
- `PatternResult` -- interface: totalInputTokens, totalOutputTokens, succeeded, finalContent
- `PatternEvent` -- discriminated union: start, step.start, step.complete, step.error, iteration.start, iteration.complete, complete
- `PatternHooks` -- callbacks for pattern lifecycle events
- `GoalEvaluatorProtocol` -- `evaluate()` returning `[achieved, reason, confident]`

Helpers: `resolveMessage()`, `makeStepName()`, `executeStep()`

#### Sequential

Chain agents in sequence, threading context through the pipeline.

```typescript
import { Sequential } from "@pattern-stack/agentic-runtime";

const pipeline = new Sequential([
  { agent: researcher, messageTemplate: "Research the topic", outputKey: "research" },
  { agent: writer, messageTemplate: (ctx) => `Write about: ${ctx.research}` },
], { continueOnError: false });

const result = await pipeline.run({ topic: "AI" }, { runner });
result.steps;        // StepResult[]
result.finalContext;  // accumulated context
```

Supports nested patterns (Sequential/Parallel as steps) and `continueOnError`.

#### Parallel

Fan-out agents in parallel with optional concurrency limiting and result consolidation.

```typescript
import { Parallel, collectByName, collectContents } from "@pattern-stack/agentic-runtime";

const fanout = new Parallel(
  [
    { agent: analystA, messageTemplate: "Analyze market", name: "market" },
    { agent: analystB, messageTemplate: "Analyze tech", name: "tech" },
  ],
  { maxConcurrency: 2, consolidator: collectByName },
);

const result = await fanout.run({}, { runner });
result.successful;          // StepResult[]
result.failed;              // [index, Error][]
result.allSucceeded;        // boolean
result.consolidatedOutput;  // { market: "...", tech: "..." }
```

Built-in consolidators: `collectContents` (string[]), `collectByName` (Record). Custom consolidators accepted.

#### Goal Evaluators

Four implementations of `GoalEvaluatorProtocol`, ranked cheapest to most expensive:

| Evaluator | Strategy | LLM? |
|-----------|----------|------|
| `SimpleGoalEvaluator` | Pattern matching against output | No |
| `SelfEvalGoalEvaluator` | Parses `GOAL_STATUS`/`PROGRESS` markers | No |
| `LLMGoalEvaluator` | Sends goal + result to evaluator agent | Yes |
| `EvaluatorChain` | Tries in order, stops on first confident result | Mixed |

All return `[achieved: boolean, reason: string, confident: boolean]`.

```typescript
import { EvaluatorChain, SimpleGoalEvaluator, LLMGoalEvaluator } from "@pattern-stack/agentic-runtime";

const chain = new EvaluatorChain([
  new SimpleGoalEvaluator({ successPatterns: ["TASK_COMPLETE"] }),
  new LLMGoalEvaluator({ agent: evaluatorAgent, runner }),
]);
```

#### TaskLoop

Goal-driven iteration: run agent, evaluate progress, repeat.

```typescript
import { TaskLoop, SimpleGoalEvaluator } from "@pattern-stack/agentic-runtime";

const loop = new TaskLoop(agent, new SimpleGoalEvaluator({
  successPatterns: ["TASK_COMPLETE"],
  failurePatterns: ["CANNOT_PROCEED"],
}), { maxIterations: 5 });

const result = await loop.run("Fix all failing tests", {}, { runner });
result.exitReason;  // "goal_achieved" | "max_iterations" | "explicit_stop" | "error"
result.iterations;  // number of iterations executed
```

Features: history summarization in prompts, configurable stop phrases, goal evaluation per iteration.

#### EvaluatorLoop

Producer-evaluator refinement: producer generates, evaluator scores + critiques, producer refines.

```typescript
import { EvaluatorLoop, RubricEvaluator, CompositeRefinementEvaluator } from "@pattern-stack/agentic-runtime";

const rubric = new RubricEvaluator([
  { name: "clarity", description: "Clear and concise", weight: 0.4 },
  { name: "accuracy", description: "Factually correct", weight: 0.6 },
], { runner });

const loop = new EvaluatorLoop(producer, rubric, {
  maxRefinements: 3,
  qualityThreshold: 0.8,
});

const result = await loop.run("Write a blog post about RAG");
result.exitReason;  // "quality_met" | "max_refinements" | "no_improvement" | "error"
result.bestOutput;  // highest-scoring version across all refinements
```

Evaluator implementations: `LLMRefinementEvaluator`, `RubricEvaluator`, `CompositeRefinementEvaluator` (weighted average).

#### RetryLoop

Generic async retry wrapper. Not agent-specific -- wraps any `() => Promise<T>`.

```typescript
import { RetryLoop, ExponentialBackoff, JitteredBackoff, FixedBackoff } from "@pattern-stack/agentic-runtime";

const retry = new RetryLoop({
  maxAttempts: 5,
  backoff: new ExponentialBackoff({ initialMs: 100, maxMs: 5000 }),
  retryableErrors: [RateLimitError],
  timeoutMs: 30_000,
  onRetry: (attempt, error) => console.log(`Retry ${attempt}: ${error.message}`),
});

const result = await retry.run(() => callExternalAPI());
```

Backoff strategies: `FixedBackoff`, `ExponentialBackoff`, `JitteredBackoff`.

#### ConversationLoop

Multi-turn conversation orchestration with external input/output callbacks.

```typescript
import { ConversationLoop } from "@pattern-stack/agentic-runtime";

const loop = new ConversationLoop(agent, {
  maxExchanges: 10,
  exitPhrases: ["goodbye", "exit"],
  inputFn: async () => getUserInput(),
  outputFn: async (response) => displayToUser(response),
});

const result = await loop.run({ runner });
result.exitReason;     // "exit_phrase" | "max_exchanges" | "error"
result.exchangeCount;  // number of exchanges completed
```

Integrates with `ConversationStore` for persistence via `InMemoryConversationStore`.

### Transport (`src/transport/`)

Message transport for multi-agent communication.

```typescript
import { InProcessTransport, MessagingToolbox } from "@pattern-stack/agentic-runtime";

const transport = new InProcessTransport();
transport.subscribe("agency.*.messages", (msg) => { /* ... */ });
await transport.publish("agency.worker.messages", payload);

const toolbox = new MessagingToolbox(transport, senderAddress, agency);
```

`Transport` interface can be implemented for external systems (NATS, Redis, etc.).

### Runtime (`src/runtime/`)

Multi-agent execution runtime.

```typescript
import { Agency } from "@pattern-stack/agentic-core";
import { AgencyRuntime, AgentNode } from "@pattern-stack/agentic-runtime";

const runtime = new AgencyRuntime(agency, runner, "run-123");
await runtime.start();
await runtime.injectCoordinator("Begin processing");
const status = runtime.status(); // { coordinator: "running", worker: "running" }
await runtime.stop();
```

`AgentNode` wraps a single agent with message batching, idle timeout, max turns, and lifecycle events.

### Conversation (`src/conversation/`)

Conversation state management with structured persistence.

```typescript
import { Conversation, InMemoryConversationStore } from "@pattern-stack/agentic-runtime";

// In-memory persistence
const store = new InMemoryConversationStore();

const convo = new Conversation(agent, runner, { id: "conv-123", store });
const exchange = await convo.send("Hello!");
console.log(exchange.assistant);
```

`ConversationStore` provides full CRUD for conversations, messages, and message parts:
- `createConversation()`, `getConversation()`, `updateConversation()`
- `addMessage()`, `getMessages()`, `getMessageParts()`

`InMemoryConversationStore` is the built-in in-memory implementation. Implement `ConversationStore` for database-backed persistence.

### Exporters (`src/exporters/`)

Observability exporters that subscribe to EventBus events.

| Exporter | Output |
|----------|--------|
| `ConsoleExporter` | Terminal output via configurable logger |
| `LangfuseExporter` | Langfuse trace spans |
| `OTelExporter` | OpenTelemetry trace spans |

```typescript
import { ConsoleExporter, createConsoleExporter } from "@pattern-stack/agentic-runtime";

const exporter = createConsoleExporter(bus);
exporter.start();
// ... run agent ...
exporter.stop();
```

All exporters extend `BaseExporter` which manages EventBus profile subscription lifecycle.

### Presets (`src/presets/`)

Pre-built roles, judgments, and responsibilities for common agent patterns.

**Roles:**
- `coordinatorRole(name, persona)` -- orchestration coordinator
- `orchestratorRole(name, persona)` -- task orchestrator
- `analystRole(name, persona)` -- research/analysis specialist
- `retrievalRole(name, persona)` -- information retrieval specialist

**Judgments:** `ROUTING`, `QUALITY_REVIEW`, `INTENT_CLASSIFICATION`, `RETRIEVAL_STRATEGY`, `EVIDENCE_QUALITY`

**Responsibilities:** `ORCHESTRATION`, `QUALITY_GATE`, `INTENT_ROUTING`, `RESPONSE_SYNTHESIS`, `INFORMATION_RETRIEVAL`, `ANALYSIS`

```typescript
import { coordinatorRole, ROUTING, ORCHESTRATION } from "@pattern-stack/agentic-runtime";

const role = coordinatorRole("lead", persona);
```

**No model defaults (#179/#222).** No preset — role or demo agent — pins a
`defaultModel`. A framework DECLARATION never names a vendor's model: you would
inherit a model you never chose, on a provider you may not use, and introspection
(the playground's Roles page) would render it as THE model. Set the model where
you compose the agent (`AgentBuilder.withModel(id)` / your own
`role.withDefaultModel(id)`), or let the runner resolve it from the environment
(`AGENT_TIER` / `AGENT_MODEL`, a gateway, or `models.yaml` profiles). Resolving a
model from the ENVIRONMENT at run time is the supported mechanism; pinning one in
a declaration is not. An agent that declares no model on a resolver-backed runner
fails loud rather than defaulting to a vendor.

## Known limitations

**`RunOptions.timeout` (#521) — `AgentRunner` only, cooperative, never a hard kill:**

- **Unbounded by default.** Without `timeout`, `run()`/`stream()`/`runStructured()`
  behave exactly as before — no per-call, per-tool, or per-run budget. `CodingAgentRunner`
  subclasses and `MockRunner` ignore `RunOptions.timeout` entirely (same posture as
  `modelParams`).
- **`modelMs`/`runMs` only interrupt providers that honor `abortSignal`.** Delivery is
  signal-based (the SDK merges `timeout` into the provider call's own abort signal, and
  `runMs` composes into the same effective signal every provider call receives) — a
  provider call that ignores its signal hangs regardless of either budget.
- **On `runStructured()`'s capable path (tools + a model verified for single-call
  structured output), `modelMs` bounds a whole SDK *step* — one model call PLUS every
  SDK-run tool execution it triggered — not the model call alone**, because `ai@7` has no
  model-call-only knob. `toolMs > modelMs` is silently capped by that same step timer on
  this one path; keep `toolMs <= modelMs` there as guidance, not a sufficiency guarantee.
- **Expiry abandons, never kills, an in-flight promise.** A `toolMs` dispatch that times
  out lets the losing tool-executor promise keep running in the background; `runMs`
  alone does not interrupt a blocked tool either — only the next iteration/dispatch
  boundary observes the deadline.
- **`ToolExecutionContext.signal` is cooperative-only**, and present ONLY when `toolMs`
  is set for the run — a tool must opt into observing it (`ctx.signal?.aborted`); the
  runner never forcibly cancels a tool. A `runMs`-only run that blocks in a
  never-returning tool exceeds its budget without bound (the deadline is honored at the
  next boundary, not mid-dispatch).
