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

# Companion demo (#445): build, then playground with the memory-wired
# companion. Durable memories persist at $AP_MEMORY_DB_PATH | ~/.local/state/ap/memory.db —
# tell it something, restart, ask again in a fresh conversation.
companion:
    bun run build
    node packages/agent-cli/dist/cli.js playground

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

# ── Worktrees ────────────────────────────────

# Remove stale Claude Code agent worktrees under .claude/worktrees/ (created when the
# Agent tool spawns with isolation:"worktree"; harness auto-cleanup misses dirty ones).
# Refuses to remove worktrees with uncommitted changes; prunes the registry at the end.
clean-worktrees:
    #!/usr/bin/env bash
    set -euo pipefail
    paths=$(git worktree list --porcelain | awk '/^worktree.*\.claude\/worktrees\// {print $2}')
    if [[ -z "$paths" ]]; then
      echo "No worktrees under .claude/worktrees/ to clean."
      git worktree prune
      exit 0
    fi
    while IFS= read -r path; do
      echo "→ $path"
      if git -C "$path" diff --quiet && git -C "$path" diff --cached --quiet && [[ -z $(git -C "$path" status --porcelain) ]]; then
        git worktree remove "$path" && echo "  removed"
      else
        echo "  SKIPPED — has uncommitted changes (run \`git worktree remove --force '$path'\` to force)"
      fi
    done <<< "$paths"
    git worktree prune
    echo "done."

# ── Release ──────────────────────────────────

# Bump runtime+server+cli lockstep versions (patch|minor|major|X.Y.Z)
bump-lockstep level="patch":
    bash scripts/bump.sh --lockstep {{level}}

# Bump core version (floats independently of the lockstep trio)
bump-core level="patch":
    bash scripts/bump.sh --core {{level}}

# Bump both tracks at once (e.g. a change touching core + runtime)
bump-both lockstep="minor" core="minor":
    bash scripts/bump.sh --lockstep {{lockstep}} --core {{core}}

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
