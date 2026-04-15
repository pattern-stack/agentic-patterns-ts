# Strict Quality Profile

Maximum quality gates for this library.

## Gates

All gates must pass before PR:

| Gate | Command | Blocking |
|------|---------|----------|
| Build | `pnpm build` | Yes |
| Typecheck | `pnpm typecheck` | Yes |
| Lint | `pnpm lint` | Yes |
| Test | `pnpm test` | Yes |
| All | `pnpm check` | Yes (runs all above) |

## Per-Package Gates

```bash
# Run in a specific package
pnpm --filter @pattern-stack/agent-core test
pnpm --filter @pattern-stack/agent-runtime typecheck
```

## Testing Requirements

- Unit tests for all new public API surface
- Tests co-located at `src/**/__tests__/*.test.ts`
- Edge cases explicitly tested (empty inputs, invalid state, boundaries)
- Error paths covered

## When to Use

- All changes to this library (it's published to npm)
- Both packages: core and runtime
