#!/usr/bin/env bash
#
# scripts/publish.sh — publish @agentic-patterns/* to npm.
#
# Usage:
#   bash scripts/publish.sh check       # pre-flight only (default) — no publish
#   bash scripts/publish.sh publish     # real publish to `latest`, needs npm login + OTP
#   bash scripts/publish.sh publish --tag=next   # override tag (default: latest)
#   bash scripts/publish.sh ci          # non-interactive publish via npm OIDC trusted
#                                        # publishing (no login/token) — used by ci.yml
#   bash scripts/publish.sh ci --dry-run # pack + validate every tarball, no upload
#
# Default tag is `latest` because that's what `npm install` resolves
# without an explicit tag. Earlier versions defaulted to `next`, which
# silently published broken pins (0.1.5/0.1.6) without anyone seeing
# them on `latest` — broke downstream installs that use `^0.1.x`.
# Use `--tag=next` for genuine pre-releases.
#
# bun handles monorepo specifics:
#   - rewrites `workspace:*` to concrete versions in published tarballs
#   - skips packages with `private: true` via the loop below
#
# `publish` mode runs `bun publish` per-package (interactive: needs npm login
# + OTP). `ci` mode instead `bun pm pack`s each package — which performs the
# SAME `workspace:^` → concrete-version rewrite — then `npm publish`es the
# tarball, because only the npm CLI (>= 11.5.1) speaks OIDC trusted publishing
# and emits provenance. Both run in topological order since bun 1.3's global
# --filter for publish is still maturing.

set -euo pipefail

MODE="${1:-check}"
shift || true
TAG="latest"
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --tag=*) TAG="${arg#--tag=}" ;;
    --dry-run) DRY_RUN=true ;;
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

bold "publish plan (what would actually ship)"
echo
for pkg in "${PACKAGES[@]}"; do
  name=$(node -e "console.log(require('$ROOT/packages/$pkg/package.json').name)")
  version=$(node -e "console.log(require('$ROOT/packages/$pkg/package.json').version)")
  if npm view "$name@$version" version >/dev/null 2>&1; then
    dim "  · $name@$version (already on npm — will skip)"
  else
    ok "$name@$version (NEW — will publish)"
  fi
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
      name=$(node -e "console.log(require('$pkg_dir/package.json').name)")
      version=$(node -e "console.log(require('$pkg_dir/package.json').version)")
      private=$(node -e "console.log(require('$pkg_dir/package.json').private || false)")
      [ "$private" = "true" ] && { dim "skip (private): $name"; continue; }
      # Idempotent lockstep: `bun publish` refuses to republish an existing
      # version, which would otherwise abort the whole run on the first
      # already-published package (the core-only-bump trap). Skip versions
      # already on npm so `just publish` ships exactly what changed — and is
      # safe to re-run if it dies partway (e.g. a mistyped OTP).
      if npm view "$name@$version" version >/dev/null 2>&1; then
        dim "skip (already on npm): $name@$version"
        continue
      fi
      (cd "$pkg_dir" && bun publish --tag="$TAG" --access=public) || fail "publish failed for $name@$version"
    done
    echo
    ok "done — verify at https://www.npmjs.com/~agentic-patterns"
    ;;
  ci)
    echo
    if [ "$DRY_RUN" = "true" ]; then
      bold "ci dry-run (pack tarballs via bun, validate, no upload)"
    else
      bold "ci publish via npm OIDC trusted publishing (tag=$TAG)"
    fi
    echo
    # Gate: tarball smoke — packs every package, installs the tarballs into a
    # throwaway consumer, and verifies the import/type/bin contract. A broken
    # tarball aborts HERE, before anything uploads — so the broken-pin class
    # (0.1.5/0.1.6) can never reach npm.
    bun "$ROOT/test/post-publish/run-tarball-smoke.ts" || fail "tarball smoke failed — nothing published"
    echo
    published=0
    for pkg in "${PACKAGES[@]}"; do
      pkg_dir="$ROOT/packages/$pkg"
      name=$(node -e "console.log(require('$pkg_dir/package.json').name)")
      version=$(node -e "console.log(require('$pkg_dir/package.json').version)")
      private=$(node -e "console.log(require('$pkg_dir/package.json').private || false)")
      [ "$private" = "true" ] && { dim "skip (private): $name"; continue; }
      # Idempotent: a merge without a version bump is a no-op, and a re-run
      # after a mid-publish failure skips whatever already reached npm.
      if npm view "$name@$version" version >/dev/null 2>&1; then
        dim "skip (already on npm): $name@$version"
        continue
      fi
      # bun packs the tarball, rewriting `workspace:^` deps to concrete caret
      # pins (npm cannot do that rewrite). npm then uploads the tarball — which
      # is what speaks OIDC trusted publishing and emits provenance.
      outdir="$(mktemp -d)"
      (cd "$pkg_dir" && bun pm pack --destination "$outdir" >/dev/null) || fail "pack failed for $name@$version"
      tarball="$(ls "$outdir"/*.tgz)"
      if [ "$DRY_RUN" = "true" ]; then
        ok "packed $name@$version → $(basename "$tarball") (not uploaded)"
      else
        npm publish "$tarball" --access public --tag "$TAG" || fail "publish failed for $name@$version"
        ok "$name@$version"
        published=$((published + 1))
      fi
      rm -rf "$outdir"
    done
    echo
    if [ "$DRY_RUN" = "true" ]; then
      ok "dry-run complete — nothing uploaded"
    elif [ "$published" -eq 0 ]; then
      ok "nothing to publish — every version already on npm"
    else
      ok "published $published package(s) — verify at https://www.npmjs.com/~agentic-patterns"
    fi
    ;;
  *)
    fail "unknown mode: $MODE (expected: check | publish | ci)"
    ;;
esac
