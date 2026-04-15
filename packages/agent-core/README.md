# @pattern-stack/agent-core

Core primitives for building compositional agents. This package provides the atom-to-organism hierarchy: frozen data models, protocol interfaces, molecules (toolbox/manual/capability), section-based prompt rendering, and builders for roles and agents.

## Installation

```bash
pnpm add @pattern-stack/agent-core zod
```

## API Overview

### Atoms (`src/atoms/`)

Frozen, immutable data models validated by Zod schemas. Every atom implements `toPrompt()` returning markdown for LLM consumption.

| Atom | Purpose |
|------|---------|
| `Persona` | Agent identity: name, role, identity statement, tone |
| `Mission` | Objective + output schema + constraints |
| `Judgment` | Decision heuristic: when/guidelines/examples |
| `Responsibility` | Named duty with guidelines |
| `Background` | Company/team/project context |
| `Awareness` | Knowledge domains with confidence levels |
| `Methodology` | Process approach description |
| `State` | Runtime state: phase, progress, context |
| `Tone` | Communication style guidelines |
| `Example` | Few-shot example: situation/action/result |
| `Recovery` | Error recovery strategies |
| `Agency` | Multi-agent topology definition |
| `Roster` | Agent deployment roster |

```typescript
import { Persona, Mission, Judgment } from "@pattern-stack/agent-core";

const persona = new Persona({
  identity: "a data analyst who analyzes datasets with precision",
  tone: "professional",
});

console.log(persona.toPrompt());
// You are a data analyst who analyzes datasets with precision.
// Communication style: professional
```

### Base Classes

- `AgenticModel<T>` -- base class for all atoms. Wraps a Zod schema, freezes parsed data, provides `.data` accessor and `.toPrompt()`.
- `ProtocolModel<T>` -- base for protocol data models with `toPrompt()` support.

### Protocols (`src/protocols/`)

Vendor-agnostic async interfaces for external systems. Each protocol defines Zod schemas for its data types and an interface for CRUD operations.

| Protocol | Operations |
|----------|-----------|
| `TaskProtocol` | list, get, create, update, addComment, getComments |
| `ProjectProtocol` | list, get, create, update, listMembers |
| `TagProtocol` | list, get, create, update, delete |
| `UserProtocol` | list, get, getTeams, whoAmI |
| `SprintProtocol` | list, get, create, update |
| `CommentProtocol` | list, get, create, update, delete, addReaction |
| `DocumentProtocol` | list, get, create, update, delete |
| `EnvironmentProtocol` | list, get, create, update, delete |

Shared enums: `Priority`, `StatusCategory`, `IssueType`, `RelationType`, `WorkPhase`, `ProjectStatus`, `SprintStatus`, `DocType`, `TagGroup`, `UserType`, `UserRole`, etc.

### Molecules (`src/molecules/`)

Composable building blocks that combine atoms into functional units.

| Molecule | Purpose |
|----------|---------|
| `ToolSchema` | Tool definition with Zod parameter schema; converts to OpenAI/Claude/Vercel formats |
| `Toolbox` | Named collection of tools with `toPrompt()` |
| `Manual` | Instructional content (text, scoped, simple variants) |
| `ManualToolbox` | Manual that also provides tools |
| `Playbook` | Abstract class for named plays with Zod schemas and error-envelope semantics |
| `Capability` | Toolbox + Manual + optional Playbook describing what an agent can do |

```typescript
import { z } from "zod";
import { ToolSchema, Toolbox, Manual, Capability } from "@pattern-stack/agent-core";

const searchTool = ToolSchema.fromZod(
  "search_docs",
  "Search documentation",
  z.object({ query: z.string(), limit: z.number().optional() }),
);

const toolbox = new Toolbox("docs", [searchTool]);
const manual = new Manual("docs-manual", [
  { title: "Search", content: "Use search_docs to find relevant documentation." },
]);
const capability = new Capability("documentation", toolbox, manual);
```

#### Playbook

Playbooks define named "plays" with Zod-validated parameters and error-envelope semantics. Errors in `PlayDefinition.execute` are caught and returned as `{ error: message }`.

```typescript
import { z } from "zod";
import { Playbook, type PlayDefinition } from "@pattern-stack/agent-core";

class AnalysisPlaybook extends Playbook {
  readonly name = "analysis";
  readonly description = "Data analysis plays";
  readonly plays: Record<string, PlayDefinition> = {
    summarize: {
      description: "Summarize a dataset",
      parameters: z.object({ data: z.string() }),
      execute: async (args) => ({ summary: `Analyzed: ${args.data}` }),
    },
  };
}

// Integrate into a Capability
const capability = new Capability("analysis", toolbox, manual, new AnalysisPlaybook());
capability.getTools(); // includes both toolbox tools and playbook play schemas
```

Definitions module provides Zod schemas for workflow configuration: `WorkflowStep`, `RuleDefinition`, `TemplateDefinition`, `EscalationTrigger`, `StateDefinition`, `PriorityDefinition`, `IssueTypeDefinition`, `HealthSignal`.

### Rendering (`src/rendering/`)

Section-based prompt composition. The `PromptRenderer` assembles sections into a complete system prompt.

| Section | Content |
|---------|---------|
| `IdentitySection` | Persona, tone, recovery |
| `BoundariesSection` | Responsibilities |
| `CapabilitiesSection` | Capabilities with tools and manuals |
| `ContextSection` | Background, awareness |
| `MissionSection` | Objective, constraints, output schema |
| `MethodologySection` | Judgments, process guidelines |
| `StateSection` | Current state, phase, progress |

```typescript
import {
  PromptRenderer,
  IdentitySection,
  BoundariesSection,
  CapabilitiesSection,
  ContextSection,
  MissionSection,
  MethodologySection,
} from "@pattern-stack/agent-core";

const renderer = new PromptRenderer(
  new IdentitySection(persona, responsibilities),
  new BoundariesSection(judgments),
  new CapabilitiesSection(capabilities),
  new ContextSection(background, awareness),
  new MissionSection(mission),
  new MethodologySection(judgments),
);

const systemPrompt = renderer.renderInitial();
```

### Organisms (`src/organisms/`)

High-level builders that compose atoms and molecules into complete agent definitions.

**RoleBuilder** -- fluent API for reusable agent templates:

```typescript
import { RoleBuilder } from "@pattern-stack/agent-core";

const role = new RoleBuilder("analyst")
  .withPersona(persona)
  .withJudgment(judgment)
  .withResponsibility(responsibility)
  .withCapability(capability)
  .withDefaultModel("claude-sonnet-4-20250514")
  .build();
```

**AgentBuilder** -- instantiate a role with runtime context:

```typescript
import { AgentBuilder } from "@pattern-stack/agent-core";

const agent = new AgentBuilder(role)
  .withBackground(background)
  .withAwareness(awareness)
  .withMission(mission)
  .withModel("claude-sonnet-4-20250514")
  .build();

// Prompt rendering
const systemPrompt = agent.getSystemPrompt();
const initialPrompt = agent.renderInitialPrompt();
```

The `Agent` class provides:
- `getSystemPrompt()` -- full system prompt via PromptRenderer
- `renderInitialPrompt()` -- system + context + mission for first message
- `renderContinuationPrompt(state)` -- state + mission + methodology for follow-ups
- `getTools()` -- all ToolSchema instances from capabilities
- `getModel()` -- model string from agent or role default
