# TypeScript Language Primitive

Instructions for TypeScript workflows in this project.

## File Patterns

- Source: `packages/*/src/**/*.ts`
- Tests: `packages/*/src/**/__tests__/*.test.ts`
- Config: `tsconfig.base.json`, `packages/*/tsconfig.json`, `package.json`
- Build: `packages/*/tsup.config.ts`

## Toolchain

| Tool | Command | Purpose |
|------|---------|---------|
| Package manager | `pnpm` | Workspace-aware dependency management |
| Format | `biome format` | Code formatting (double quotes, semicolons, 2-space indent) |
| Lint | `biome check` | Linting + import organization |
| Typecheck | `tsc --noEmit` | Strict TypeScript checking |
| Test | `vitest run` | Test runner with workspace support |
| Build | `tsup` | Bundle ESM + CJS outputs |
| All gates | `pnpm check` | build + typecheck + lint + test |

## Conventions

- **Zod schemas** define all data models -- `z.object({})` then `z.infer<>` for types
- **Immutability** -- `Object.freeze()` + `Readonly<>` types on atom data
- **ESM-first** -- tsup produces both ESM and CJS, source uses ESM imports
- **Strict mode** -- `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- **Async throughout** -- protocol methods return `Promise<T>`
- **Fluent builders** -- `.with*()` methods return `this` for chaining
- Avoid `any` -- use `unknown` with type guards
- Use barrel exports (`index.ts`) for public APIs
- Prefer `interface` for object shapes consumed by external code, `type` for internal unions/intersections

## Module System

- All packages use `"type": "module"` (ESM)
- `moduleResolution: "bundler"` in tsconfig
- Target: `ES2022`
