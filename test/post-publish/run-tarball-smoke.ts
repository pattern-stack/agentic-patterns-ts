#!/usr/bin/env bun
/**
 * test/post-publish/run-tarball-smoke.ts
 *
 * Pre-publish consumer-contract gate. Packs each public package with
 * `bun pm pack` (which rewrites `workspace:^` -> concrete caret pins, exactly
 * as a real publish would), installs the tarballs into a throwaway project via
 * npm, and verifies the consumer contract:
 *
 *   - core / runtime / server import cleanly as ESM, expose a non-empty
 *     namespace, ship their .d.ts type entry, and carry no CJS artifacts.
 *   - cli installs its `ap` bin and the bin file parses (it is bin-only — no
 *     library `exports`, so it is checked, not imported).
 *
 * This catches the broken-tarball class the registry never can: unrewritten
 * workspace pins, missing dist files, broken `exports` maps, packaging
 * regressions. `scripts/publish.sh ci` runs it as a gate BEFORE upload, so a
 * bad tarball aborts the release instead of reaching npm and breaking
 * downstream installs (the 0.1.5 / 0.1.6 class — see scripts/publish.sh).
 *
 * Standalone:
 *   bun run build && bun test/post-publish/run-tarball-smoke.ts
 */
import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

// Importable ESM libraries.
const LIB_PKGS = [
  { dir: "agent-core", name: "@agentic-patterns/core" },
  { dir: "agent-runtime", name: "@agentic-patterns/runtime" },
  { dir: "agent-server", name: "@agentic-patterns/server" },
] as const;
// Bin-only package — no library `exports`, so verify the bin instead of importing.
const CLI_PKG = { dir: "agent-cli", name: "@agentic-patterns/cli" } as const;
const ALL_PKGS = [...LIB_PKGS, CLI_PKG];

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
function fail(s: string): never {
  console.error(`  \x1b[31m✗\x1b[0m ${s}`);
  process.exit(1);
}

// ── 0. Pre-flight: every package must be built ────────────────────────────────
console.log(bold("tarball smoke — pre-flight"));
for (const pkg of ALL_PKGS) {
  const dist = join(ROOT, "packages", pkg.dir, "dist");
  if (!existsSync(dist)) {
    fail(`${pkg.name}: dist/ missing — run \`bun run build\` first`);
  }
}
ok("all packages built");

const work = mkdtempSync(join(tmpdir(), "ap-smoke-"));
const consumer = join(work, "consumer");
mkdirSync(consumer, { recursive: true });
console.log(dim(`  workdir: ${work}`));

// ── 1. Pack each package (bun rewrites workspace:^ -> concrete pins) ──────────
console.log(bold("\npack tarballs"));
const tarballs: Record<string, string> = {};
for (const pkg of ALL_PKGS) {
  const outDir = join(work, "tarballs", pkg.dir);
  mkdirSync(outDir, { recursive: true });
  try {
    execFileSync("bun", ["pm", "pack", "--destination", outDir], {
      cwd: join(ROOT, "packages", pkg.dir),
      stdio: "pipe",
    });
  } catch (e) {
    fail(`pack failed for ${pkg.name}: ${(e as Error).message}`);
  }
  const tgz = readdirSync(outDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail(`no tarball produced for ${pkg.name}`);
  tarballs[pkg.name] = join(outDir, tgz);
  ok(`${pkg.name} → ${tgz}`);
}

// ── 2. Install all tarballs into a throwaway consumer ─────────────────────────
// file: deps point inter-package caret pins at the LOCAL tarballs, so the smoke
// passes even when the new version isn't on npm yet (the pre-publish case).
console.log(bold("\ninstall into throwaway consumer"));
writeFileSync(
  join(consumer, "package.json"),
  `${JSON.stringify(
    {
      name: "ap-smoke-consumer",
      version: "0.0.0",
      private: true,
      dependencies: Object.fromEntries(ALL_PKGS.map((p) => [p.name, `file:${tarballs[p.name]}`])),
    },
    null,
    2,
  )}\n`,
);
try {
  execSync("npm install --no-audit --no-fund --loglevel=error", {
    cwd: consumer,
    stdio: "inherit",
  });
} catch (e) {
  fail(`npm install of tarballs failed: ${(e as Error).message}`);
}
ok("installed");

// ── 3. Library contract: ESM import, non-empty namespace ──────────────────────
console.log(bold("\nconsumer contract — import"));
const esmChecks = LIB_PKGS.map(
  (p) => `
{
  const m = await import(${JSON.stringify(p.name)});
  if (typeof m !== "object" || Object.keys(m).length === 0)
    throw new Error("${p.name}: ESM import exposed no exports");
  console.log("  esm ${p.name}: " + Object.keys(m).length + " exports");
}`,
).join("\n");
writeFileSync(join(consumer, "esm-check.mjs"), `${esmChecks}\n`);

try {
  execFileSync("node", ["esm-check.mjs"], { cwd: consumer, stdio: "inherit" });
} catch {
  fail("ESM import contract failed");
}
ok("ESM imports resolve with non-empty namespaces");

// ── 4. Type contract: .d.ts shipped, no CJS artifacts ──────────────────────────
console.log(bold("\nconsumer contract — types"));
for (const pkg of LIB_PKGS) {
  const base = join(consumer, "node_modules", pkg.name, "dist");
  for (const f of ["index.d.ts"]) {
    if (!existsSync(join(base, f))) fail(`${pkg.name}: missing type entry dist/${f}`);
  }
  const cjsArtifacts = readdirSync(base).filter((f) => /\.cjs(\.map)?$|\.d\.cts$/.test(f));
  if (cjsArtifacts.length > 0) {
    fail(`${pkg.name}: found CJS artifacts in installed dist/ — ${cjsArtifacts.join(", ")}`);
  }
  ok(`${pkg.name} ships .d.ts; no CJS artifacts`);
}

// ── 5. CLI contract: bin installed + parses ──────────────────────────────────
console.log(bold("\nconsumer contract — cli bin"));
{
  const cliRoot = join(consumer, "node_modules", CLI_PKG.name);
  const cliPkg = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf-8"));
  const binField = cliPkg.bin;
  const binRel = typeof binField === "string" ? binField : binField?.ap;
  if (!binRel) fail(`${CLI_PKG.name}: package.json declares no \`ap\` bin`);
  const binPath = join(cliRoot, binRel);
  if (!existsSync(binPath)) fail(`${CLI_PKG.name}: bin file missing at ${binRel}`);
  try {
    execFileSync("node", ["--check", binPath], { stdio: "pipe" });
  } catch (e) {
    fail(`${CLI_PKG.name}: bin file failed to parse — ${(e as Error).message}`);
  }
  ok(`${CLI_PKG.name} installs \`ap\` bin (${binRel}) and it parses`);
}

console.log(bold("\n✓ tarball smoke passed — consumer contract intact"));
