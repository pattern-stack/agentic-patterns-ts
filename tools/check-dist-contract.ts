/**
 * check-dist-contract — PR-time guard on the BUILT output.
 *
 * Why this exists: `providers/cc-shim.ts` calls `createRequire(import.meta.url)`.
 * esbuild does not shim `import.meta` for cjs unless tsup's `shims` is on, so the
 * cjs bundle emitted `var import_meta = {}` and threw ERR_INVALID_ARG_VALUE on the
 * first `require()`. That shipped-breaking bug sat on `main` for ~6 merges behind a
 * green `check`, because the only thing that actually loaded the built artifacts was
 * the tarball smoke — which runs in the PUBLISH job, after merge. `check` never
 * imported its own output, so it never noticed.
 *
 * This closes that window: it loads every built entry in BOTH formats and asserts a
 * non-empty namespace. Deliberately cheap — no pack, no install, no network — so it
 * can sit in the required `check` status without adding registry flake to every PR.
 *
 * It is NOT a replacement for `test/post-publish/run-tarball-smoke.ts`. That one
 * installs real tarballs into a throwaway consumer and additionally verifies the
 * `files` whitelist, the exports map, and the cli bin — packaging failures this
 * check cannot see. Keep both: this one guards the PR, that one guards the publish.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dir, "..");

/** Dual-format importable libraries — mirrors LIB_PKGS in run-tarball-smoke.ts. */
const LIB_PKGS = [
  { dir: "agent-core", name: "@agentic-patterns/core" },
  { dir: "agent-runtime", name: "@agentic-patterns/runtime" },
  { dir: "agent-server", name: "@agentic-patterns/server" },
] as const;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
function fail(s: string): never {
  console.error(`  \x1b[31m✗\x1b[0m ${s}`);
  process.exit(1);
}

console.log(bold("dist contract — built output loads in both formats"));

for (const pkg of LIB_PKGS) {
  const dist = join(ROOT, "packages", pkg.dir, "dist");
  if (!existsSync(dist)) fail(`${pkg.name}: dist/ missing — run \`bun run build\` first`);

  const esm = join(dist, "index.js");
  const cjs = join(dist, "index.cjs");
  for (const [label, entry] of [
    ["esm", esm],
    ["cjs", cjs],
  ] as const) {
    if (!existsSync(entry)) fail(`${pkg.name}: missing ${label} entry ${entry}`);
  }

  // Absolute entry paths: the bundle's own dependency resolution still walks up
  // from dist/, so the workspace node_modules resolve without an install step.
  const esmProbe = `
const m = await import(${JSON.stringify(pathToFileURL(esm).href)});
const n = Object.keys(m).length;
if (typeof m !== "object" || n === 0) throw new Error("ESM import exposed no exports");
console.log("  esm ${pkg.name}: " + n + " exports");`;

  const cjsProbe = `
const m = require(${JSON.stringify(cjs)});
const n = Object.keys(m).length;
if (typeof m !== "object" || n === 0) throw new Error("CJS require exposed no exports");
console.log("  cjs ${pkg.name}: " + n + " exports");`;

  try {
    execFileSync("node", ["--input-type=module", "-e", esmProbe], { stdio: "inherit" });
  } catch {
    fail(`${pkg.name}: ESM import contract failed`);
  }
  try {
    execFileSync("node", ["--input-type=commonjs", "-e", cjsProbe], { stdio: "inherit" });
  } catch {
    fail(`${pkg.name}: CJS require contract failed`);
  }
}

ok("ESM + CJS entries load with non-empty namespaces");
