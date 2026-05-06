#!/usr/bin/env bash
#
# scripts/publish.sh — publish @agentic-patterns/* to npm.
#
# Usage:
#   bash scripts/publish.sh check       # pre-flight only (default) — no publish
#   bash scripts/publish.sh publish     # real publish, needs npm login + OTP
#   bash scripts/publish.sh publish --tag=latest   # override tag (default: next)
#
# bun handles monorepo specifics:
#   - rewrites `workspace:*` to concrete versions in published tarballs
#   - skips packages with `private: true` via the loop below
# Run `bun publish` per-package in topological order since bun 1.3's
# global --filter for publish is still maturing.

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

# Topological order: core → runtime → server → cli
PACKAGES=(agent-core agent-runtime agent-server agent-cli)

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }
ok()    { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m!\033[0m %s\n" "$*"; }
fail()  { printf "  \033[31m✗\033[0m %s\n" "$*"; exit 1; }

bold "pre-flight"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  warn "git tree has uncommitted modifications"
  git status --short --untracked-files=no
  [ "$MODE" = "publish" ] && fail "refusing to publish with modified tracked files"
else
  ok "git tree clean (ignoring untracked)"
fi

if [ "$MODE" = "publish" ]; then
  npm whoami >/dev/null 2>&1 || fail "not logged in to npm — run: npm login"
  ok "npm user: $(npm whoami)"
fi

bold "build + typecheck"
bun run --filter='*' build >/dev/null
ok "build"
bun run --filter='*' typecheck >/dev/null
ok "typecheck"

# Lockfile sanity: bun's `workspace:*` rewrite at publish time pins the
# version found in bun.lock, NOT the version on disk in package.json. If
# you bump versions and forget to refresh the lock, published tarballs
# end up pinning stale workspace deps (the 0.1.6 publish hit this — cli
# baked in runtime@0.1.4 because the lock predated the bump).
bold "lockfile sanity"
for pkg in "${PACKAGES[@]}"; do
  disk=$(node -e "console.log(require('$ROOT/packages/$pkg/package.json').version)")
  name=$(node -e "console.log(require('$ROOT/packages/$pkg/package.json').name)")
  lock=$(node -e "
    const fs=require('fs');
    const txt=fs.readFileSync('$ROOT/bun.lock','utf-8');
    // bun.lock workspace section: \"name\": \"<pkg>\", \"version\": \"<v>\"
    const re=new RegExp('\"name\":\\\\s*\"$name\"[^}]*?\"version\":\\\\s*\"([^\"]+)\"');
    const m=txt.match(re); console.log(m?m[1]:'?');
  ")
  if [ "$disk" = "$lock" ]; then
    ok "$name $disk (lock matches)"
  else
    fail "$name disk=$disk vs lock=$lock — run \`rm bun.lock && bun install\` to refresh"
  fi
done

bold "dry-run publish (what would ship)"
echo
for pkg in "${PACKAGES[@]}"; do
  name=$(node -e "console.log(require('$ROOT/packages/$pkg/package.json').name)")
  version=$(node -e "console.log(require('$ROOT/packages/$pkg/package.json').version)")
  echo "  + $name@$version"
done
echo

bold "versions on disk"
for pkg in "${PACKAGES[@]}"; do
  node -e "const p=require('$ROOT/packages/$pkg/package.json'); if(!p.private) console.log('  '+p.name.padEnd(32)+p.version);" 2>/dev/null || true
done

case "$MODE" in
  check)
    echo
    dim "run \`bash scripts/publish.sh publish\` to actually publish with tag=$TAG"
    ;;
  publish)
    echo
    bold "publishing to npm (tag=$TAG)"
    echo
    for pkg in "${PACKAGES[@]}"; do
      pkg_dir="$ROOT/packages/$pkg"
      private=$(node -e "console.log(require('$pkg_dir/package.json').private || false)")
      [ "$private" = "true" ] && { dim "skip (private): $pkg"; continue; }
      (cd "$pkg_dir" && bun publish --tag="$TAG" --access=public) || fail "publish failed for $pkg"
    done
    echo
    ok "done — verify at https://www.npmjs.com/~agentic-patterns"
    ;;
  *)
    fail "unknown mode: $MODE (expected: check | publish)"
    ;;
esac
