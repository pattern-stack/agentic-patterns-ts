/**
 * check-dist-contract — PR-time guard on the BUILT output.
 *
 * Origin: this used to also load a CJS build (`providers/cc-shim.ts`'s
 * `createRequire(import.meta.url)` broke under tsup's unshimmed cjs `import.meta`),
 * which is why a same-process loader check exists at all instead of relying solely
 * on the publish-time smoke.
 *
 * Now that packages are ESM-only, this guards two things: the built ESM entry
 * actually loads with a non-empty namespace, and no CJS artifacts are emitted.
 * Deliberately cheap — no pack, no install, no network — so it can sit in the
 * required `check` status without adding registry flake to every PR.
 *
 * It is NOT a replacement for `test/post-publish/run-tarball-smoke.ts`. That one
 * installs real tarballs into a throwaway consumer and additionally verifies the
 * `files` whitelist, the exports map, and the cli bin — packaging failures this
 * check cannot see. Keep both: this one guards the PR, that one guards the publish.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dir, "..");

/** Importable ESM libraries — mirrors LIB_PKGS in run-tarball-smoke.ts. */
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

/** Recursively collect files under `dir` whose name matches `.cjs`/`.cjs.map`/`.d.cts`. */
function findCjsArtifacts(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findCjsArtifacts(full));
    } else if (/\.cjs(\.map)?$|\.d\.cts$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

console.log(bold("dist contract — built ESM output loads; no CJS artifacts"));

for (const pkg of LIB_PKGS) {
  const dist = join(ROOT, "packages", pkg.dir, "dist");
  if (!existsSync(dist)) fail(`${pkg.name}: dist/ missing — run \`bun run build\` first`);

  const esm = join(dist, "index.js");
  if (!existsSync(esm)) fail(`${pkg.name}: missing esm entry ${esm}`);

  const cjsArtifacts = findCjsArtifacts(dist);
  if (cjsArtifacts.length > 0) {
    fail(`${pkg.name}: found CJS artifacts in dist/ — ${cjsArtifacts.join(", ")}`);
  }

  // Absolute entry paths: the bundle's own dependency resolution still walks up
  // from dist/, so the workspace node_modules resolve without an install step.
  const esmProbe = `
const m = await import(${JSON.stringify(pathToFileURL(esm).href)});
const n = Object.keys(m).length;
if (typeof m !== "object" || n === 0) throw new Error("ESM import exposed no exports");
console.log("  esm ${pkg.name}: " + n + " exports");`;

  try {
    execFileSync("node", ["--input-type=module", "-e", esmProbe], { stdio: "inherit" });
  } catch {
    fail(`${pkg.name}: ESM import contract failed`);
  }
}

ok("ESM entries load with non-empty namespaces; no CJS artifacts in dist");
