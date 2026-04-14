# agentic-patterns-ts
# Usage: just <recipe>

set dotenv-load

default:
    @just --list

# ── Dev ──────────────────────────────────────

# Start server + dashboard
dev:
    pnpm dev

# Start with opus tier
dev-opus:
    AGENT_TIER=opus pnpm dev

# Start with haiku tier
dev-haiku:
    AGENT_TIER=haiku pnpm dev

# ── Checks ───────────────────────────────────

# Build + typecheck + lint + test
check:
    pnpm check

build:
    pnpm build

typecheck:
    pnpm typecheck

lint:
    pnpm lint

test:
    pnpm test

test-runtime:
    pnpm --filter @agentic-patterns/runtime test

test-server:
    pnpm --filter @agentic-patterns/server test

test-dashboard:
    pnpm --filter @agentic-patterns/dashboard test

# ── Live tests ───────────────────────────────

# Ollama live test (needs OLLAMA_HOST in .env)
test-live:
    pnpm --filter @agentic-patterns/runtime test

# Claude live test (needs claude CLI)
test-claude:
    RUN_LIVE_CLAUDE=1 pnpm --filter @agentic-patterns/runtime test

# ── Stack ────────────────────────────────────

stack:
    st status

submit:
    st submit

ship:
    st submit --ready

merge:
    st merge --all

sync:
    st sync
