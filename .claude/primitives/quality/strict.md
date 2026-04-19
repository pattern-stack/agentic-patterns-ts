# Strict Quality Profile

Maximum quality gates for this library.

## Gates

All gates must pass before PR:

| Gate | Command | Blocking |
|------|---------|----------|
| Build | `bun run build` | Yes |
| Typecheck | `bun run typecheck` | Yes |
| Lint | `bun run lint` | Yes |
| Test | `bun run test` | Yes |
| All | `bun run check` | Yes (runs all above) |

## Per-Package Gates

```bash
# Run in a specific package
bun run --filter=@agentic-patterns/core test
bun run --filter=@agentic-patterns/runtime typecheck
```

## Testing Requirements

- Unit tests for all new public API surface
- Tests co-located at `src/**/__tests__/*.test.ts`
- Edge cases explicitly tested (empty inputs, invalid state, boundaries)
- Error paths covered

## When to Use

- All changes to this library (it's published to npm)
- Both packages: core and runtime
