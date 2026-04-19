Execute an implementation from a spec file or issue.

Usage: /build <path-to-spec-or-issue>

## Process

1. **Read the spec/issue** in full before writing any code
2. **Delegate to `team/builder`** with the spec
3. **Builder implements** each step sequentially (TDD, `bun run check`)
4. **Delegate to `team/validator`** to verify
5. **Report** what was done, what tests pass, and any issues found

## Rules

- Follow the spec exactly — don't add extras or skip steps
- If the spec is wrong or incomplete, stop and ask rather than guessing
- The builder runs `bun run check` before declaring done
- The validator produces a validation report
