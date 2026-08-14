# @pattern-stack/agentic-core

Core primitives for building compositional agents. This package provides the atom-to-organism hierarchy: frozen data models, molecules (toolbox/manual/capability), section-based prompt rendering, and builders for roles and agents.

## Installation

```bash
bun add @pattern-stack/agentic-core zod
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
import { Persona, Mission, Judgment } from "@pattern-stack/agentic-core";

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
| `SessionScope` | Declarative per-conversation configuration: composed Zod schema, validated defaults + named presets, redaction keys |

```typescript
import { z } from "zod";
import { capability, defineTool, TextManual, toolbox } from "@pattern-stack/agentic-core";

const docsToolbox = toolbox("docs", "Documentation tools", {
  search_docs: defineTool({
    description: "Search documentation",
    parameters: z.object({ query: z.string(), limit: z.number().nullable() }),
    returns: z.array(z.string()),
    execute: async ({ query, limit }) => searchDocs(query, limit ?? 10),
  }),
});

const documentation = capability({
  name: "documentation",
  description: "Documentation search",
  toolbox: docsToolbox,
  manual: new TextManual("docs-manual", "Use search_docs to find relevant documentation."),
});
```

`defineTool` infers `execute`'s argument types from `parameters`, compile-checks the return value
against `returns`, and validates output at runtime by default (violations throw a tool-named
error). Subclassing `Toolbox` and calling the positional `Capability` constructor both still work —
the factories are sugar over the same classes. See
[docs/authoring-a-toolbox.md](../../docs/authoring-a-toolbox.md) for the full guide.

#### Playbook

Playbooks define named "plays" with Zod-validated parameters and error-envelope semantics. Errors
in `PlayDefinition.execute` are caught by `Playbook.execute` and returned as `{ error: message }`
instead of thrown — unknown play, parameter-validation failure, or execution error alike.

```typescript
import { z } from "zod";
import { definePlay, playbook } from "@pattern-stack/agentic-core";

const analysis = playbook("analysis", "Data analysis plays", {
  summarize: definePlay({
    description: "Summarize a dataset",
    parameters: z.object({ data: z.string() }),
    returns: z.object({ summary: z.string() }),
    execute: async ({ data }) => ({ summary: `Analyzed: ${data}` }),
  }),
});

// Integrate into a Capability
const analysisCapability = capability({
  name: "analysis",
  description: "Data analysis",
  toolbox: docsToolbox,
  playbook: analysis,
});
analysisCapability.getTools(); // includes both toolbox tools and playbook play schemas
```

`definePlay` infers `execute`'s argument types from `parameters`, compile-checks the return value
against `returns` (REQUIRED, unlike `defineTool` where it's optional metadata), and validates
output at runtime by default — violations are caught at `Playbook.execute` and returned as a
play-named `{ error }` envelope, never thrown. Subclassing `Playbook` and hand-writing a plain
`PlayDefinition` object both still work unchanged — a plain object's `returns` stays metadata-only,
exactly as before; only `definePlay`-built plays opt into validation. `playbook(name, description,
plays)` is the literal counterpart to subclassing, mirroring `toolbox(...)`. See
[docs/authoring-a-toolbox.md](../../docs/authoring-a-toolbox.md#authoring-a-play) for the full
guide, including the D2 validate-before-serialize caveat.

Definitions module provides Zod schemas for workflow configuration: `WorkflowStep`, `RuleDefinition`, `TemplateDefinition`, `EscalationTrigger`, `StateDefinition`, `PriorityDefinition`, `IssueTypeDefinition`, `HealthSignal`.

#### SessionScope

Declarative, per-conversation configuration. `sessionScope(items, options)` composes named `scopeItem(schema, options)` field declarations into one Zod object schema. `defaults` and every named `preset` are validated against that composed schema at construction — a malformed declaration throws immediately, at agent-authoring time, rather than on the first request.

```typescript
import { scopeItem, sessionScope, type ScopeValue } from "@pattern-stack/agentic-core";
import { z } from "zod";

const workspaceScope = sessionScope(
  {
    workspace: scopeItem(z.string().min(1), { description: "Tenant workspace" }),
    user: scopeItem(z.string().email(), { description: "Acting user" }),
    region: scopeItem(z.string().min(1), { description: "Data region" }),
  },
  {
    defaults: { workspace: "acme-sales", user: "sam@acme.dev", region: "us-east" },
    presets: {
      "sam @ acme": { workspace: "acme-sales", user: "sam@acme.dev", region: "us-east" },
    },
  },
);

type WorkspaceScope = ScopeValue<typeof workspaceScope>;
```

`scopeItem(schema, { description, redact })` documents one field and, when `redact: true`, adds its key to `SessionScope.redactKeys` — read by consumers that echo or log scope values. `ScopeValue<typeof scope>` infers the parsed shape for typed use elsewhere (a toolbox constructor, a tool's return type).

Give the agent a scope-derived identity line with `Awareness.fromScope(scope, fn)` — a render-time-only function whose output `Awareness.toPrompt()` appends when the caller supplies `{ scope }`, and silently omits otherwise:

```typescript
import { Awareness } from "@pattern-stack/agentic-core";

const awareness = Awareness.fromScope(
  workspaceScope,
  (s) => `Acting on behalf of ${s.user} in workspace ${s.workspace} (${s.region}).`,
);
```

`SessionScope` itself is a core-only declaration. Carrying a parsed value across a run (`host.scope`), reading it from a tool, and wiring it through `POST /conversations` are `@pattern-stack/agentic-runtime` and `@pattern-stack/agentic-server` concerns — see those packages' READMEs.

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
} from "@pattern-stack/agentic-core";

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
import { RoleBuilder } from "@pattern-stack/agentic-core";

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
import { AgentBuilder } from "@pattern-stack/agentic-core";

const agent = new AgentBuilder(role)
  .withBackground(background)
  .withAwareness(awareness)
  .withMission(mission)
  .withModel("claude-sonnet-4-20250514")
  .build();

// Prompt rendering
const initialPrompt = agent.renderInitialPrompt();
```

The `Agent` class provides:
- `renderInitialPrompt()` -- full system prompt (identity + boundaries +
  capabilities + context + mission + methodology) via PromptRenderer
- `renderSections()` -- the same prompt as attributed sections (`{name, source, text}`)
- `renderContinuationPrompt(state)` -- state + mission + methodology for follow-ups
- `getTools()` -- all ToolSchema instances from capabilities
- `getModel()` -- model string from agent or role default
