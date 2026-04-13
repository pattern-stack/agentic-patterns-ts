# agentic-patterns (TypeScript)

TypeScript port of the agentic-patterns compositional agent framework. Agents are built by composing frozen, immutable primitives upward through layers -- from atoms to organisms -- then executed by a runtime with events, gates, and exporters.

## Packages

| Package | Description |
|---------|-------------|
| `@agentic-patterns/core` | Atoms, protocols, molecules, rendering, organisms |
| `@agentic-patterns/runtime` | Runner, events, gates, transport, multi-agent runtime, conversation, exporters, presets |

Runtime depends on core. Core never imports runtime.

## Quick Start

```bash
pnpm install
pnpm build
pnpm test
```

### Build a single agent

```typescript
import {
  Persona, Mission, Responsibility, Judgment,
  RoleBuilder, AgentBuilder,
} from "@agentic-patterns/core";

import { AgentRunner, AgentEventBus, ConsoleExporter } from "@agentic-patterns/runtime";

// 1. Define atoms
const persona = new Persona({
  identity: "a research assistant specializing in data analysis",
  tone: "professional and precise",
});

const mission = new Mission({
  objective: "Analyze the provided dataset and produce a summary report.",
});

// 2. Build a Role (reusable template)
const role = new RoleBuilder("research-assistant")
  .withPersona(persona)
  .withJudgment(new Judgment({
    domain: "source-quality",
    heuristics: ["Prefer peer-reviewed sources", "Cross-reference statistics"],
  }))
  .withResponsibility(new Responsibility({
    key: "analysis",
    name: "Analysis",
    description: "Produce accurate, well-sourced analysis",
  }))
  .build();

// 3. Build an Agent (role + context)
const agent = new AgentBuilder(role)
  .withMission(mission)
  .withModel("claude-sonnet-4-20250514")
  .build();

// 4. Run with events
const bus = new AgentEventBus();
const exporter = new ConsoleExporter(bus);
exporter.start();

const runner = new AgentRunner(model, bus);
const result = await runner.run(agent, "Analyze Q4 revenue trends.");

console.log(result.response);
exporter.stop();
```

### Multi-agent agency

```typescript
import { Agency } from "@agentic-patterns/core";
import { AgencyRuntime } from "@agentic-patterns/runtime";

const agency = new Agency({
  name: "sales-team",
  description: "Coordinates lead research and outreach",
  agents: [
    { role: "coordinator", is_coordinator: true, model: "claude-sonnet-4-20250514" },
    { role: "researcher", is_coordinator: false, model: "claude-sonnet-4-20250514" },
  ],
});

const runtime = new AgencyRuntime(agency, runner);
await runtime.start();
await runtime.injectCoordinator("Research Acme Corp");
// ... agents communicate via in-process transport
await runtime.stop();
```

## Architecture

```
Agent = Role x Background x Awareness x Mission

Role = Persona + Judgments + Capabilities + Responsibilities
Capability = Toolbox + Manual
```

### Layer Hierarchy

| Layer | Location | Purpose |
|-------|----------|---------|
| 0 - Atoms | `core/src/atoms/` | Frozen Zod-validated models with `toPrompt()` |
| 1 - Protocols | `core/src/protocols/` | Vendor-agnostic domain interfaces (Task, Project, Tag, ...) |
| 2 - Molecules | `core/src/molecules/` | Toolbox, Manual, Capability, ToolSchema, definitions |
| 3 - Rendering | `core/src/rendering/` | PromptRenderer with composable sections |
| 4 - Organisms | `core/src/organisms/` | RoleBuilder, AgentBuilder |
| 5 - Events | `runtime/src/events/` | Typed EventBus, AgentEventBus, sandbox events |
| 6 - Gates | `runtime/src/gates/` | Safety, approval, rate-limit, audit gate chain |
| 7 - Runner | `runtime/src/runner/` | AgentRunner on Vercel AI SDK |
| 8 - Transport | `runtime/src/transport/` | InProcessTransport, MessagingToolbox |
| 9 - Runtime | `runtime/src/runtime/` | AgentNode, AgencyRuntime for multi-agent |
| 10 - Exporters | `runtime/src/exporters/` | Console, Langfuse, OpenTelemetry |
| 11 - Presets | `runtime/src/presets/` | Pre-built roles, judgments, responsibilities |

### Key Conventions

- **Zod schemas** for all data models -- define schema, then `z.infer<>` for types
- **Immutability** -- `Object.freeze()` + `Readonly<>` types on atom data
- **ESM-first** -- tsup produces both ESM and CJS outputs
- **Strict TypeScript** -- `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- **Async throughout** -- all protocol methods return `Promise<T>`
- **Fluent builders** -- `.with*()` methods return `this` for chaining

## Development

```bash
pnpm build       # tsup compile both packages
pnpm typecheck   # tsc --noEmit strict mode
pnpm test        # vitest run all tests
```

### Project Structure

```
typescript/
  package.json              # Workspace root
  pnpm-workspace.yaml
  tsconfig.base.json        # Shared strict TS config
  vitest.workspace.ts
  packages/
    agent-core/             # @agentic-patterns/core
      src/
        atoms/              # Persona, Mission, Judgment, ...
        protocols/          # Task, Project, Tag, User, ...
        molecules/          # Toolbox, Manual, Capability
        rendering/          # PromptRenderer, sections
        organisms/          # Role, Agent, builders
    agent-runtime/          # @agentic-patterns/runtime
      src/
        events/             # EventBus, event types, profiles
        gates/              # Safety, Approval, RateLimit, Audit
        runner/             # AgentRunner, types
        transport/          # InProcessTransport, MessagingToolbox
        runtime/            # AgentNode, AgencyRuntime
        conversation/       # Conversation store
        exporters/          # Console, Langfuse, OTel
        presets/            # Pre-built roles and judgments
```

## Dependencies

- **zod** -- schema validation and type inference
- **ai** (Vercel AI SDK) -- LLM provider abstraction for AgentRunner
- **tsup** -- bundler (ESM + CJS)
- **vitest** -- test runner
- **TypeScript 5.7+** -- strict mode compilation
