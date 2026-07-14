# @agentic-patterns/runtime

Execution runtime for agentic-patterns agents. Provides the runner loop (Vercel AI SDK), typed event bus, gate chain, workflow compositions and loops, multi-agent transport and runtime, conversation persistence, observability exporters, and pre-built role presets.

## Installation

```bash
bun add @agentic-patterns/runtime @agentic-patterns/core ai zod
```

## API Overview

### Runner (`src/runner/`)

The `AgentRunner` executes agents using a tool loop on the Vercel AI SDK.

```typescript
import { AgentRunner } from "@agentic-patterns/runtime";

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
import { MockRunner } from "@agentic-patterns/runtime";

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
import { ClaudeCodeRunner } from "@agentic-patterns/runtime";

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
import { EventBus, AgentEventBus, EventProfile, subscribeProfile } from "@agentic-patterns/runtime";

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
import { AgentEventBus, SafetyGate, HumanApprovalGate, AuditGate } from "@agentic-patterns/runtime";

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

Composable workflow patterns for multi-step and iterative agent execution. All patterns implement `PatternProtocol` and share common types.

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
import { Sequential } from "@agentic-patterns/runtime";

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
import { Parallel, collectByName, collectContents } from "@agentic-patterns/runtime";

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
import { EvaluatorChain, SimpleGoalEvaluator, LLMGoalEvaluator } from "@agentic-patterns/runtime";

const chain = new EvaluatorChain([
  new SimpleGoalEvaluator({ successPatterns: ["TASK_COMPLETE"] }),
  new LLMGoalEvaluator({ agent: evaluatorAgent, runner }),
]);
```

#### TaskLoop

Goal-driven iteration: run agent, evaluate progress, repeat.

```typescript
import { TaskLoop, SimpleGoalEvaluator } from "@agentic-patterns/runtime";

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
import { EvaluatorLoop, RubricEvaluator, CompositeRefinementEvaluator } from "@agentic-patterns/runtime";

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
import { RetryLoop, ExponentialBackoff, JitteredBackoff, FixedBackoff } from "@agentic-patterns/runtime";

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
import { ConversationLoop } from "@agentic-patterns/runtime";

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
import { InProcessTransport, MessagingToolbox } from "@agentic-patterns/runtime";

const transport = new InProcessTransport();
transport.subscribe("agency.*.messages", (msg) => { /* ... */ });
await transport.publish("agency.worker.messages", payload);

const toolbox = new MessagingToolbox(transport, senderAddress, agency);
```

`Transport` interface can be implemented for external systems (NATS, Redis, etc.).

### Runtime (`src/runtime/`)

Multi-agent execution runtime.

```typescript
import { Agency } from "@agentic-patterns/core";
import { AgencyRuntime, AgentNode } from "@agentic-patterns/runtime";

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
import { Conversation, InMemoryConversationStore } from "@agentic-patterns/runtime";

// In-memory persistence
const store = new InMemoryConversationStore();

const convo = new Conversation("conv-123", "agent-name", { store });
convo.addExchange({
  userMessage: "Hello",
  assistantMessage: "Hi there!",
  inputTokens: 10,
  outputTokens: 8,
  toolCalls: [],
  timestamp: new Date().toISOString(),
});
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
import { ConsoleExporter, createConsoleExporter } from "@agentic-patterns/runtime";

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
import { coordinatorRole, ROUTING, ORCHESTRATION } from "@agentic-patterns/runtime";

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
