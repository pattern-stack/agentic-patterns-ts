# agentic-patterns (TypeScript)

A compositional agent framework for TypeScript. Agents are built by
composing frozen, immutable primitives upward through layers -- from
atoms to organisms -- then executed by a runtime with events, gates,
and exporters.

## Packages

| Package | Description |
|---------|-------------|
| `@agentic-patterns/core` | Atoms, protocols, molecules, rendering, organisms |
| `@agentic-patterns/runtime` | Runner, events, gates, transport, multi-agent, exporters |

Runtime depends on core. Core never imports runtime.

## Quick Start

```bash
pnpm install
pnpm build
pnpm test
```

## Building an Agent

Agents are composed from small, frozen primitives. Each primitive
answers one question about the agent's behavior.

### Persona -- WHO the agent is

A Persona defines identity and communication style.

```typescript
import { Persona } from "@agentic-patterns/core";

const persona = new Persona({
  identity: "a research assistant specializing in data analysis",
  tone: "professional and precise",
  priorities: ["accuracy over speed"],
});
```

### Mission -- WHAT the agent is doing

A Mission defines the current objective and constraints.

```typescript
import { Mission } from "@agentic-patterns/core";

const mission = new Mission({
  objective: "Analyze the provided dataset and produce a summary.",
  success_criteria: [
    "Identify top 3 trends",
    "Include statistical backing",
  ],
  constraints: ["Only use provided data, no external sources"],
});
```

### Judgment -- HOW the agent decides

A Judgment defines decision-making heuristics for a specific domain.

```typescript
import { Judgment } from "@agentic-patterns/core";

const sourceQuality = new Judgment({
  domain: "source-quality",
  heuristics: [
    "Prefer peer-reviewed sources",
    "Cross-reference statistics across multiple sources",
  ],
  escalation_triggers: [
    "Contradictory data from equally credible sources",
  ],
});
```

### Responsibility -- WHAT the agent handles

A Responsibility declares a category of work the agent owns.

```typescript
import { Responsibility } from "@agentic-patterns/core";

const analysis = new Responsibility({
  key: "analysis",
  name: "Data Analysis",
  description: "Produce accurate, well-sourced quantitative analysis",
  examples: ["Revenue trend reports", "Cohort comparisons"],
});
```

### Role -- reusable agent template

A Role composes primitives into a reusable template. Build one with
the fluent `RoleBuilder`.

```typescript
import { RoleBuilder } from "@agentic-patterns/core";

const role = new RoleBuilder("research-assistant")
  .withPersona(persona)
  .withJudgment(sourceQuality)
  .withResponsibility(analysis)
  .build();
```

### Agent -- role + runtime context

An Agent is a Role instantiated with a Mission and optional context.
Create a new Agent for each task.

```typescript
import { AgentBuilder } from "@agentic-patterns/core";

const agent = new AgentBuilder(role)
  .withMission(mission)
  .withModel("claude-sonnet-4-20250514")
  .build();
```

## Running an Agent

The runtime package provides `AgentRunner`, an event bus, and
exporters for observability.

```typescript
import {
  AgentRunner,
  AgentEventBus,
  ConsoleExporter,
} from "@agentic-patterns/runtime";

const bus = new AgentEventBus();
const exporter = new ConsoleExporter(bus);
exporter.start();

const runner = new AgentRunner(model, bus);
const result = await runner.run(
  agent,
  "Analyze Q4 revenue trends.",
);

console.log(result.response);
exporter.stop();
```

## Multi-Agent Teams

For coordination across multiple agents, define an Agency and run it
with the `AgencyRuntime`.

```typescript
import { Agency } from "@agentic-patterns/core";
import { AgencyRuntime } from "@agentic-patterns/runtime";

const agency = new Agency({
  name: "sales-team",
  description: "Coordinates lead research and outreach",
  agents: [
    {
      role: "coordinator",
      is_coordinator: true,
      model: "claude-sonnet-4-20250514",
    },
    {
      role: "researcher",
      is_coordinator: false,
      model: "claude-sonnet-4-20250514",
    },
  ],
});

const runtime = new AgencyRuntime(agency, runner);
await runtime.start();
await runtime.injectCoordinator("Research Acme Corp");
await runtime.stop();
```

## Architecture

```
Agent = Role x Background x Awareness x Mission

Role = Persona + Judgments + Capabilities + Responsibilities
Capability = Toolbox + Manual
```

### Layer Hierarchy

| Layer | Package | Location | Purpose |
|-------|---------|----------|---------|
| 0 | core | `src/atoms/` | Frozen Zod-validated models with `toPrompt()` |
| 1 | core | `src/protocols/` | Vendor-agnostic domain interfaces |
| 2 | core | `src/molecules/` | Toolbox, Manual, Capability, ToolSchema |
| 3 | core | `src/rendering/` | PromptRenderer with composable sections |
| 4 | core | `src/organisms/` | RoleBuilder, AgentBuilder, Role, Agent |
| 5 | runtime | `src/events/` | Typed EventBus, AgentEventBus |
| 6 | runtime | `src/gates/` | Safety, approval, rate-limit, audit |
| 7 | runtime | `src/runner/` | AgentRunner (Vercel AI SDK) |
| 8 | runtime | `src/transport/` | InProcessTransport, MessagingToolbox |
| 9 | runtime | `src/runtime/` | AgentNode, AgencyRuntime |
| 10 | runtime | `src/exporters/` | Console, Langfuse, OpenTelemetry |
| 11 | runtime | `src/presets/` | Pre-built roles and judgments |

### Key Conventions

- **Zod schemas** for all data models -- define schema, `z.infer<>` for types
- **Immutability** -- `Object.freeze()` + `Readonly<>` on atom data
- **ESM-first** -- tsup produces both ESM and CJS outputs
- **Strict TypeScript** -- `noUncheckedIndexedAccess`, `noUnusedLocals`
- **Async throughout** -- all protocol methods return `Promise<T>`
- **Fluent builders** -- `.with*()` methods return `this` for chaining

## Development

```bash
pnpm build       # tsup compile both packages
pnpm typecheck   # tsc --noEmit strict mode
pnpm test        # vitest run all tests
pnpm lint        # biome check
pnpm check       # all of the above
```

## Dependencies

- **zod** -- schema validation and type inference
- **ai** (Vercel AI SDK) -- LLM provider abstraction
- **tsup** -- bundler (ESM + CJS)
- **vitest** -- test runner
- **biome** -- formatter and linter
- **TypeScript 5.7+** -- strict mode compilation

## License

MIT
