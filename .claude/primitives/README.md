# Primitives

Primitives are configurable context that customize how commands behave for this project. Think of them as dependency injection for AI workflows.

## How It Works

1. **Commands declare** which primitives they need
2. **You configure** which values to use (in `.claude/sdlc.yml`)
3. **Claude reads** the primitive file and follows its guidance

## Directory Structure

```
primitives/
├── language/           # Programming language conventions
│   └── typescript.md
├── quality/            # Quality gate profiles
│   └── strict.md
└── commit/             # Commit message styles
    └── conventional.md
```

## Adding Primitives

Create a markdown file in the appropriate category. Reference it from `.claude/sdlc.yml`.
