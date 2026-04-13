Create an implementation plan using the architect+builder+validator team pattern.

## Process

1. **Architecture Phase** (`team/architect`):
   - Understand the request
   - Explore codebase, understand existing patterns and layers
   - Produce implementation spec at `.claude/specs/<date>-<kebab-case-name>.md`

2. **Review Phase** (`team/validator`):
   - Validator reviews the spec for completeness, correctness, conflicts, minimal scope
   - Incorporate feedback into the spec

3. **Build Phase** (`team/builder`):
   - Builder implements step by step following the finalized spec
   - TDD: tests first, then implementation
   - Runs `pnpm check` to verify all gates pass

4. **Validate Phase** (`team/validator`):
   - Validator runs quality gates
   - Checks architecture compliance
   - Reports any issues for the builder to fix

## Output

After the full cycle, report:
- What was planned
- What was built
- What the validator found
- Final status (PASS/FAIL)
