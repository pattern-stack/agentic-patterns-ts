# @agentic-patterns/runtime

Execution runtime for agentic-patterns agents. Provides the runner loop (Vercel AI SDK), typed event bus, gate chain, multi-agent transport and runtime, conversation persistence, observability exporters, and pre-built role presets.

## Installation

```bash
pnpm add @agentic-patterns/runtime @agentic-patterns/core ai zod
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

// Subscribe to individual events
bus.subscribe("agent.message.complete", (event) => {
  console.log(event.response);
});

// Subscribe to curated event profiles
subscribeProfile(bus, EventProfile.UX, (event) => {
  // Receives message.start, message.chunk, message.complete, tool events, errors
});
```

**Event Profiles:** `UX`, `OBSERVABILITY`, `DEBUG`, `TOOLS`, `STREAMING`

**SandboxEventBus** extends EventBus for multi-agent environments with serialization/deserialization of sandbox events.

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
bus.addGate(new AuditGate((event) => {
  auditLog.append(event);
}));
```

Gate types:
- `SafetyGate` -- blocks dangerous tool patterns
- `HumanApprovalGate` -- requires human confirmation
- `RateLimitGate` -- token-bucket rate limiting
- `AuditGate` -- logs all tool intents

### Transport (`src/transport/`)

Message transport for multi-agent communication.

```typescript
import { InProcessTransport, MessagingToolbox } from "@agentic-patterns/runtime";

// In-process transport with subject-based pub/sub
const transport = new InProcessTransport();

// Subscribe with wildcard patterns
transport.subscribe("agency.*.messages", (msg) => { ... });

// Publish messages
await transport.publish("agency.worker.messages", payload);

// MessagingToolbox provides send_message/broadcast tools for agents
const toolbox = new MessagingToolbox(transport, senderAddress, agency);
```

`Transport` interface can be implemented for external systems (NATS, Redis, etc.).

### Runtime (`src/runtime/`)

Multi-agent execution runtime.

```typescript
import { Agency } from "@agentic-patterns/core";
import { AgencyRuntime, AgentNode } from "@agentic-patterns/runtime";

const agency = new Agency({
  name: "team",
  description: "Multi-agent team",
  agents: [
    { role: "coordinator", is_coordinator: true, model: "claude-sonnet-4-20250514" },
    { role: "worker", is_coordinator: false, model: "claude-sonnet-4-20250514" },
  ],
});

const runtime = new AgencyRuntime(agency, runner, "run-123");
await runtime.start();
await runtime.injectCoordinator("Begin processing");

// Check status
const status = runtime.status(); // { coordinator: "running", worker: "running" }

await runtime.stop();
```

`AgentNode` wraps a single agent with message batching, idle timeout, max turns, and lifecycle events.

### Conversation (`src/conversation/`)

Conversation state management with exchange tracking.

```typescript
import { Conversation } from "@agentic-patterns/runtime";

const convo = new Conversation("conv-123", "agent-name");

convo.addExchange({
  userMessage: "Hello",
  assistantMessage: "Hi there!",
  inputTokens: 10,
  outputTokens: 8,
  toolCalls: [],
  timestamp: new Date().toISOString(),
});

// ConversationStore interface for persistence backends
```

### Exporters (`src/exporters/`)

Observability exporters that subscribe to EventBus events.

| Exporter | Output |
|----------|--------|
| `ConsoleExporter` | Terminal output via configurable logger |
| `LangfuseExporter` | Langfuse trace spans |
| `OTelExporter` | OpenTelemetry trace spans |

```typescript
import { ConsoleExporter, createConsoleExporter } from "@agentic-patterns/runtime";

// Quick setup
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
// Pre-configured with orchestration judgments and responsibilities
```
