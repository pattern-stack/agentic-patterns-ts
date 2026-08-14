Think deeply and create an implementation spec for the requested feature or change.

## Process

1. **Understand the request**: Clarify what the user wants. Ask questions if ambiguous.
2. **Research the codebase**: Read relevant files, understand existing patterns, find related code.
3. **Design the solution**: Consider trade-offs, pick the simplest approach that works.
4. **Write the spec**: Create a detailed implementation plan.

## Spec Format

Write the spec to `.claude/specs/<date>-<kebab-case-name>.md`:

```markdown
# <Feature Name>

## Goal
<1-2 sentences describing what this achieves>

## Context
<Relevant existing code, patterns, and constraints>

## Plan

### Step 1: <Description>
- Package: `@pattern-stack/agentic-core` or `@pattern-stack/agentic-runtime`
- Files: `path/to/file`
- Changes: <What to add/modify/remove>
- Why: <Reasoning>

### Step 2: <Description>
...

## Acceptance Criteria
- [ ] <Concrete, testable criterion>
- [ ] <Another criterion>
- [ ] `bun run check` passes

## Open Questions
- <Anything unresolved>
```

## Rules

- Think hard before writing — the spec is the blueprint
- Reference specific files and line numbers
- Keep it minimal — don't over-specify implementation details
- Flag risks and open questions explicitly
- Identify which package(s) are affected
- Use `extended thinking` for complex architectural decisions
