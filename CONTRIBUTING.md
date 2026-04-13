# Contributing

## Setup

```bash
pnpm install
pnpm build
```

## Development

```bash
pnpm build       # tsup compile both packages
pnpm typecheck   # tsc --noEmit strict mode
pnpm test        # vitest run all tests
pnpm lint        # biome check
pnpm check       # all of the above
```

## Conventions

- **Zod schemas** for all data models -- define schema, then `z.infer<>` for types
- **Immutability** -- `Object.freeze()` + `Readonly<>` types on atom data
- **ESM-first** -- tsup produces both ESM and CJS outputs
- **Strict TypeScript** -- `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- **Async throughout** -- all protocol methods return `Promise<T>`
- **Fluent builders** -- `.with*()` methods return `this` for chaining

## Architecture

Core never imports runtime. Runtime depends on core.

```
Agent = Role x Background x Awareness x Mission
Role = Persona + Judgments + Capabilities + Responsibilities
Capability = Toolbox + Manual
```

## Commits

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert
```

## Tests

Tests live alongside source in `__tests__/` directories. Run a single package:

```bash
cd packages/agent-core && pnpm test
cd packages/agent-runtime && pnpm test
```
