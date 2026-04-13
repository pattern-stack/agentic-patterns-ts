# Conventional Commits Primitive

Instructions for conventional commit message format.

## Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

## Types

| Type | When to Use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, no code change |
| `refactor` | Code change that neither fixes nor adds |
| `perf` | Performance improvement |
| `test` | Adding/updating tests |
| `chore` | Maintenance tasks |
| `ci` | CI/CD changes |

## Examples

```
feat(auth): add OAuth2 login support

fix(api): handle null response from upstream service

refactor(db): extract connection pooling logic

docs(readme): update installation instructions
```

## Breaking Changes

Use `!` after type/scope or `BREAKING CHANGE:` footer:

```
feat(api)!: change response format for /users endpoint

BREAKING CHANGE: Response now returns array instead of object
```

## Strategy Implications

When planning commits:
- Group related changes into logical commits
- One type per commit (don't mix feat + fix)
- Scope should match module/component affected
- Body explains "why", not "what"
