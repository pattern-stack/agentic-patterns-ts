#!/usr/bin/env bash
#
# scripts/bump.sh — bump @agentic-patterns/* versions in lockstep.
#
# Usage:
#   bash scripts/bump.sh patch         # 0.1.9 -> 0.1.10
#   bash scripts/bump.sh minor         # 0.1.9 -> 0.2.0
#   bash scripts/bump.sh major         # 0.1.9 -> 1.0.0
#   bash scripts/bump.sh --to=0.2.0    # explicit
#
# Bumps the four published packages (core, runtime, server, cli) together
# so workspace pins stay coherent, then refreshes bun.lock — `publish.sh`'s
# lockfile-sanity gate fails if disk and lock disagree.
#
# Touches only the top-level `"version":` field in each package.json; does
# not reformat the rest of the file. The dashboard package is private and
# not bumped here.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PACKAGES=(agent-core agent-runtime agent-server agent-cli)

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$*"; exit 1; }

[ $# -ge 1 ] || fail "usage: bash scripts/bump.sh <patch|minor|major|--to=X.Y.Z>"
ARG="$1"

current=$(node -e "console.log(require('$ROOT/packages/agent-core/package.json').version)")

# Lockstep invariant — all four must share the current version before bumping.
for pkg in "${PACKAGES[@]}"; do
  v=$(node -e "console.log(require('$ROOT/packages/$pkg/package.json').version)")
  [ "$v" = "$current" ] || fail "$pkg at $v, expected $current — packages out of lockstep, fix by hand first"
done

case "$ARG" in
  patch|minor|major)
    next=$(node -e "
      const [maj,min,pat] = '$current'.split('.').map(Number);
      const k = '$ARG';
      const v = k==='patch' ? [maj,min,pat+1]
             : k==='minor' ? [maj,min+1,0]
             :               [maj+1,0,0];
      console.log(v.join('.'));
    ")
    ;;
  --to=*)
    next="${ARG#--to=}"
    [[ "$next" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail "invalid version: $next"
    ;;
  *)
    fail "unknown arg: $ARG (expected patch|minor|major|--to=X.Y.Z)"
    ;;
esac

bold "bump $current -> $next"
for pkg in "${PACKAGES[@]}"; do
  perl -i -pe 's/^(\s*"version":\s*")[^"]+(")/${1}'"$next"'${2}/' "$ROOT/packages/$pkg/package.json"
  v=$(node -e "console.log(require('$ROOT/packages/$pkg/package.json').version)")
  [ "$v" = "$next" ] || fail "$pkg post-bump version is $v, expected $next"
  ok "$pkg -> $next"
done

bold "refresh bun.lock"
rm -f "$ROOT/bun.lock"
bun install >/dev/null
ok "bun.lock refreshed"

echo
bold "next steps"
echo "  git add packages/*/package.json bun.lock"
echo "  git commit -m 'chore(release): v$next'"
echo "  bash scripts/publish.sh check"
