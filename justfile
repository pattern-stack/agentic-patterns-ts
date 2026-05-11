# agentic-patterns-ts
# Usage: just <recipe>

set dotenv-load

default:
    @just --list

# ── Dev ──────────────────────────────────────

# Start server + dashboard (kills stale port holders first)
dev:
    -kill $(lsof -ti :3456) 2>/dev/null
    bun x tsx tools/dev.ts

# Start with opus tier
dev-opus:
    AGENT_TIER=opus bun x tsx tools/dev.ts

# Start with haiku tier
dev-haiku:
    AGENT_TIER=haiku bun x tsx tools/dev.ts

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

# ── Release ──────────────────────────────────

# Bump @agentic-patterns/* versions in lockstep (patch|minor|major|--to=X.Y.Z)
bump level="patch":
    bash scripts/bump.sh {{level}}

# Publish pre-flight (build, typecheck, lockfile sanity, dry-run)
publish-check:
    bash scripts/publish.sh check

# Real publish to npm `latest` (needs npm login + OTP)
publish:
    bash scripts/publish.sh publish

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
