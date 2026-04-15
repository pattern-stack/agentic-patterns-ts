#!/usr/bin/env bash
#
# scripts/publish.sh — publish @agentic-patterns/* to npm.
#
# Usage:
#   bash scripts/publish.sh check       # pre-flight only (default) — no publish
#   bash scripts/publish.sh publish     # real publish, needs npm login + OTP
#   bash scripts/publish.sh publish --tag=latest   # override tag (default: next)
#
# pnpm handles monorepo specifics automatically:
#   - skips packages with `private: true` (dashboard)
#   - rewrites `workspace:*` to concrete versions in published tarballs
#   - publishes in topological order (core → runtime → server/cli)
#   - skips versions already on registry (safe to rerun)

set -euo pipefail

MODE="${1:-check}"
shift || true
TAG="next"
for arg in "$@"; do
  case "$arg" in
    --tag=*) TAG="${arg#--tag=}" ;;
    *) ;;
  esac
done

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }
ok()    { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m!\033[0m %s\n" "$*"; }
fail()  { printf "  \033[31m✗\033[0m %s\n" "$*"; exit 1; }

bold "pre-flight"

# -- Git tree -----------------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  warn "git tree is dirty — commit or stash before publishing"
  git status --short
  [ "$MODE" = "publish" ] && fail "refusing to publish with uncommitted changes"
else
  ok "git tree clean"
fi

# -- npm auth (only needed for real publish) ----------------------------------
if [ "$MODE" = "publish" ]; then
  if ! npm whoami >/dev/null 2>&1; then
    fail "not logged in to npm — run: npm login"
  fi
  ok "npm user: $(npm whoami)"
fi

# -- Build + typecheck --------------------------------------------------------
bold "build + typecheck"
pnpm -r build >/dev/null
ok "build"
pnpm -r typecheck >/dev/null
ok "typecheck"

# -- Dry-run publish ----------------------------------------------------------
bold "dry-run publish (what would ship)"
echo
pnpm -r publish --tag="$TAG" --access=public --dry-run --no-git-checks 2>&1 | \
  grep -E "^(Publishing|\+ @agentic-patterns|  [a-z])" || true
echo

# -- Summary ------------------------------------------------------------------
bold "versions on disk"
for dir in packages/*/; do
  pkg="$dir/package.json"
  [ -f "$pkg" ] || continue
  node -e "const p=require('$ROOT/$pkg'); if(!p.private) console.log('  '+p.name.padEnd(32)+p.version);" 2>/dev/null || true
done

# -- Either stop here or do the real thing ------------------------------------
case "$MODE" in
  check)
    echo
    dim "run \`bash scripts/publish.sh publish\` to actually publish with tag=$TAG"
    dim "(skipped: npm login check in check mode)"
    ;;
  publish)
    echo
    bold "publishing to npm (tag=$TAG)"
    dim "you may be prompted for an OTP — have your authenticator ready"
    echo
    pnpm -r publish --tag="$TAG" --access=public --no-git-checks
    echo
    ok "done — verify at https://www.npmjs.com/~agentic-patterns"
    ;;
  *)
    fail "unknown mode: $MODE (expected: check | publish)"
    ;;
esac
