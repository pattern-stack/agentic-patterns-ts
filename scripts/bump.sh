#!/usr/bin/env bash
#
# scripts/bump.sh — bump @agentic-patterns/* versions across two tracks.
#
# The published packages version on TWO independent tracks:
#   • lockstep — agent-runtime + agent-server + agent-cli MUST share a version
#                (they depend on each other via workspace:^; a split would ship
#                 incoherent pins).
#   • core     — agent-core FLOATS on its own version (lower-churn foundation;
#                bumped only when core's own API changes).
# agent-dashboard is private and never published, so it is not bumped here.
#
# Usage:
#   bash scripts/bump.sh --lockstep <patch|minor|major|X.Y.Z>   # runtime+server+cli
#   bash scripts/bump.sh --core     <patch|minor|major|X.Y.Z>   # core alone
#   bash scripts/bump.sh --lockstep minor --core minor          # both in one run
#
# At least one of --lockstep / --core is required; they may bump to different
# levels. bun.lock is refreshed once at the end — publish.sh's lockfile-sanity
# gate fails if disk and lock disagree.
#
# Touches only the top-level `"version":` field in each package.json.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

LOCKSTEP=(agent-runtime agent-server agent-cli)
CORE=(agent-core)

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$*"; exit 1; }

usage() {
  fail "usage: bash scripts/bump.sh [--lockstep <spec>] [--core <spec>]  (spec: patch|minor|major|X.Y.Z)"
}

# --- parse args -------------------------------------------------------------
LOCKSTEP_SPEC=""
CORE_SPEC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lockstep) [ $# -ge 2 ] || usage; LOCKSTEP_SPEC="$2"; shift 2 ;;
    --core)     [ $# -ge 2 ] || usage; CORE_SPEC="$2";     shift 2 ;;
    -h|--help)  usage ;;
    *)          fail "unknown arg: $1 (expected --lockstep / --core)" ;;
  esac
done
[ -n "$LOCKSTEP_SPEC" ] || [ -n "$CORE_SPEC" ] || usage

pkg_version() { node -e "console.log(require('$ROOT/packages/$1/package.json').version)"; }

# next_version <current> <spec>  ->  computed next version
next_version() {
  local current="$1" spec="$2"
  case "$spec" in
    patch|minor|major)
      node -e "
        const [maj,min,pat] = '$current'.split('.').map(Number);
        const k = '$spec';
        const v = k==='patch' ? [maj,min,pat+1]
               : k==='minor' ? [maj,min+1,0]
               :               [maj+1,0,0];
        console.log(v.join('.'));
      " ;;
    *)
      [[ "$spec" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail "invalid version: $spec"
      echo "$spec" ;;
  esac
}

# bump_group <spec> <pkg...>  — enforces the group shares a current version, bumps all to next
bump_group() {
  local spec="$1"; shift
  local pkgs=("$@")
  local current; current=$(pkg_version "${pkgs[0]}")
  for pkg in "${pkgs[@]}"; do
    local v; v=$(pkg_version "$pkg")
    [ "$v" = "$current" ] || fail "$pkg at $v, expected $current — ${pkgs[*]} out of lockstep, fix by hand first"
  done
  local next; next=$(next_version "$current" "$spec")
  bold "bump [${pkgs[*]}] $current -> $next"
  for pkg in "${pkgs[@]}"; do
    perl -i -pe 's/^(\s*"version":\s*")[^"]+(")/${1}'"$next"'${2}/ if $. < 6' "$ROOT/packages/$pkg/package.json"
    local v; v=$(pkg_version "$pkg")
    [ "$v" = "$next" ] || fail "$pkg post-bump version is $v, expected $next"
    ok "$pkg -> $next"
  done
}

# --- bump requested tracks --------------------------------------------------
[ -n "$CORE_SPEC" ]     && bump_group "$CORE_SPEC"     "${CORE[@]}"
[ -n "$LOCKSTEP_SPEC" ] && bump_group "$LOCKSTEP_SPEC" "${LOCKSTEP[@]}"

# --- refresh lockfile -------------------------------------------------------
bold "refresh bun.lock"
rm -f "$ROOT/bun.lock"
bun install >/dev/null
ok "bun.lock refreshed"

echo
bold "next steps"
echo "  git add packages/*/package.json bun.lock"
echo "  git commit -m 'chore(release): ...'"
echo "  bash scripts/publish.sh check"
