# agentic-patterns-ts

TypeScript library for building composable LLM agents. Agents are built by composing frozen, immutable primitives upward through layers — from atoms to organisms — then executed by a runtime with events, gates, and exporters.

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `@agentic-patterns/core` | `packages/agent-core/` | Atoms, protocols, molecules, rendering, organisms |
| `@agentic-patterns/runtime` | `packages/agent-runtime/` | Runner, events, gates, transport, multi-agent, exporters, presets |
| `@agentic-patterns/server` | `packages/agent-server/` | Hono HTTP server — routes, SSE streaming, admin API |
| `@agentic-patterns/dashboard` | `packages/agent-dashboard/` | React SPA admin dashboard |

**Runtime depends on core. Server depends on runtime + core. Dashboard is standalone. Core never imports runtime.**

## Architecture

```
Agent = Role x Background x Awareness x Mission

Role = Persona + Judgments + Capabilities + Responsibilities
Capability = Toolbox + Manual
```

### Layer Hierarchy

| Layer | Package | Location | Purpose |
|-------|---------|----------|---------|
| 0 - Atoms | core | `src/atoms/` | Frozen Zod-validated models with `toPrompt()` |
| 1 - Protocols | core | `src/protocols/` | Vendor-agnostic domain interfaces |
| 2 - Molecules | core | `src/molecules/` | Toolbox, Manual, Capability, ToolSchema |
| 3 - Rendering | core | `src/rendering/` | PromptRenderer with composable sections |
| 4 - Organisms | core | `src/organisms/` | RoleBuilder, AgentBuilder |
| 5 - Events | runtime | `src/events/` | Typed EventBus, AgentEventBus |
| 6 - Gates | runtime | `src/gates/` | Safety, approval, rate-limit, audit chain |
| 7 - Runner | runtime | `src/runner/` | AgentRunner on Vercel AI SDK |
| 8 - Transport | runtime | `src/transport/` | InProcessTransport, MessagingToolbox |
| 9 - Runtime | runtime | `src/runtime/` | AgentNode, AgencyRuntime for multi-agent |
| 10 - Exporters | runtime | `src/exporters/` | Console, Langfuse, OpenTelemetry |
| 11 - Presets | runtime | `src/presets/` | Pre-built roles, judgments, responsibilities |

## Key Conventions

- **Zod schemas** for all data models — define schema, then `z.infer<>` for types
- **Immutability** — `Object.freeze()` + `Readonly<>` types on atom data
- **ESM-first** — tsup produces ESM output (ESM-only as of v0.31)
- **Strict TypeScript** — `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- **Async throughout** — all protocol methods return `Promise<T>`
- **Fluent builders** — `.with*()` methods return `this` for chaining
- **Barrel exports** — public API surfaced through `index.ts` files

## Development

```bash
bun install          # Install all dependencies
bun run build            # tsup compile both packages
bun run typecheck        # tsc --noEmit strict mode
bun run lint             # biome check
bun run test             # vitest run all tests
bun run check            # All of the above (build + typecheck + lint + test)
```

### Per-Package Commands

```bash
bun run --filter=@agentic-patterns/core test
bun run --filter=@agentic-patterns/runtime typecheck
```

### Landing changes

`main` is protected (required status: `check`) — **every commit lands via PR**, docs included. Versioning: runtime/server/cli bump in lockstep, core floats independently (`just bump-lockstep` / `bump-core` / `bump-both`); publish fires on merge to `main` when versions changed. Decision records live in `docs/adr/NNNN-*.md`.

## Tech Stack

- **TypeScript 5.7+** — strict mode compilation
- **bun** — workspace-aware package management + test runner + script runner
- **zod** — schema validation and type inference
- **ai** (Vercel AI SDK) — LLM provider abstraction for AgentRunner
- **tsup** — bundler (ESM-only)
- **vitest** — test runner
- **biome** — format + lint (double quotes, semicolons, 2-space indent, 100 char line width)

## Import Rules

- Layers can only import from lower-numbered layers within the same package
- `@agentic-patterns/runtime` can import from `@agentic-patterns/core`
- `@agentic-patterns/core` never imports from `@agentic-patterns/runtime`
- No circular dependencies between modules within a layer
