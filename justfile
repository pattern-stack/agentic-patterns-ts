# agentic-patterns-ts — task recipes
# Usage: just <recipe>    (install: brew install just)

# Default recipe — show available commands
default:
    @just --list

# ---------------------------------------------------------------------------
# Dev environment
# ---------------------------------------------------------------------------

# Launch server + dashboard (auto-detects provider from env)
dev:
    pnpm dev

# Launch with Ollama (sonnet tier by default)
dev-ollama host="http://10.88.111.52:11434":
    OLLAMA_HOST={{host}} pnpm dev

# Launch with Ollama at a specific tier
dev-ollama-opus host="http://10.88.111.52:11434":
    OLLAMA_HOST={{host}} AGENT_TIER=opus pnpm dev

dev-ollama-haiku host="http://10.88.111.52:11434":
    OLLAMA_HOST={{host}} AGENT_TIER=haiku pnpm dev

# Launch with Anthropic API key
dev-claude:
    pnpm dev

# Launch with a custom agent demo file
dev-custom file:
    DEMO_FILE={{file}} pnpm dev

# ---------------------------------------------------------------------------
# Quality gates
# ---------------------------------------------------------------------------

# Run all checks (build + typecheck + lint + test)
check:
    pnpm check

build:
    pnpm build

typecheck:
    pnpm typecheck

lint:
    pnpm lint

lint-fix:
    pnpm lint:fix

test:
    pnpm test

# Run tests for a specific package
test-runtime:
    pnpm --filter @agentic-patterns/runtime test

test-server:
    pnpm --filter @agentic-patterns/server test

test-dashboard:
    pnpm --filter @agentic-patterns/dashboard test

# ---------------------------------------------------------------------------
# Live integration tests (require real infrastructure)
# ---------------------------------------------------------------------------

# Run Ollama live test against your GPU
test-ollama host="http://10.88.111.52:11434":
    OLLAMA_HOST={{host}} pnpm --filter @agentic-patterns/runtime test

# Run Claude live test (requires claude CLI + auth)
test-claude:
    RUN_LIVE_CLAUDE=1 pnpm --filter @agentic-patterns/runtime test

# ---------------------------------------------------------------------------
# Stack management (uses `st` CLI from pattern-stack)
# ---------------------------------------------------------------------------

# Show current stack status
stack:
    st status

# Push + create/update PRs
submit:
    st submit

# Push + mark ready for review
ship:
    st submit --ready

# Merge entire stack bottom-up
merge:
    st merge --all

# Clean up after merges
sync:
    st sync
