/**
 * Version helpers — discover the project's `@agentic-patterns/*` dependencies,
 * read what's installed, fetch what's latest on npm, and drive both the
 * `ap update` command and the passive out-of-date notifier.
 *
 * Motivated by real version-skew pain: the framework moves fast, and a consumer
 * silently sitting on an old `runtime` (e.g. `0.8.0` while `0.9.0` shipped the
 * eval surface) has no signal. `ap update` closes the loop; the notifier makes
 * the gap impossible to miss.
 *
 * Network is best-effort and bounded: `fetchLatest` has a short AbortController
 * timeout and returns `null` on any failure, so nothing here can slow down or
 * break the CLI when npm is unreachable.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The scope we manage. Any dep under this scope is an update candidate. */
export const AP_SCOPE = "@agentic-patterns/";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

/** One dependency's version picture. `installed`/`latest` are null when unknown. */
export interface DepStatus {
  readonly name: string;
  readonly range: string; // the spec in package.json (e.g. "^0.8.0")
  readonly installed: string | null; // node_modules/<pkg>/package.json version
  readonly latest: string | null; // npm dist-tag `latest`
  readonly behind: boolean; // installed < latest (semver), both known
}

// ---------------------------------------------------------------------------
// Dependency discovery
// ---------------------------------------------------------------------------

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** `@agentic-patterns/*` deps in the project's package.json (deps + devDeps), sorted. */
export function collectApDeps(root: string): Array<{ name: string; range: string }> {
  const pkgPath = path.join(root, "package.json");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Manifest;
  } catch {
    return [];
  }
  const all = { ...manifest.dependencies, ...manifest.devDependencies };
  return Object.entries(all)
    .filter(([name]) => name.startsWith(AP_SCOPE))
    .map(([name, range]) => ({ name, range }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Installed version from `node_modules/<pkg>/package.json`, or null if absent. */
export function readInstalledVersion(root: string, pkg: string): string | null {
  try {
    const p = path.join(root, "node_modules", ...pkg.split("/"), "package.json");
    return (JSON.parse(fs.readFileSync(p, "utf-8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// npm registry
// ---------------------------------------------------------------------------

/** Latest published version (the `latest` dist-tag), or null on any failure. */
export async function fetchLatest(pkg: string, timeoutMs = 2500): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Encode the scope slash; keep the leading `@`. Hit the lightweight
    // per-version endpoint rather than the full packument.
    const url = `https://registry.npmjs.org/${pkg.replace("/", "%2f")}/latest`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null; // network down / timeout / abort — silent, best-effort
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// semver (0.x-friendly; prerelease-agnostic — sufficient for our packages)
// ---------------------------------------------------------------------------

/** -1 | 0 | 1 comparing major.minor.patch (extra/prerelease segments ignored). */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const core = v.replace(/^[^\d]*/, "").split("-")[0] ?? "0"; // strip ^/~/v + prerelease
    const seg = core.split(".");
    const n = (i: number) => Number.parseInt(seg[i] ?? "0", 10) || 0;
    return [n(0), n(1), n(2)];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = pa[i]! - pb[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when `installed` is strictly older than `latest` (both parseable). */
export function isBehind(installed: string | null, latest: string | null): boolean {
  if (!installed || !latest) return false;
  return compareSemver(installed, latest) < 0;
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

/** Infer the package manager from the lockfile at `root` (default npm). */
export function detectPackageManager(root: string): PackageManager {
  if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb")))
    return "bun";
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

/** The `add <pkg>@latest …` argv for a manager (add = pin the new range). */
export function installLatestArgv(pm: PackageManager, specs: string[]): string[] {
  switch (pm) {
    case "bun":
      return ["add", ...specs];
    case "pnpm":
      return ["add", ...specs];
    case "yarn":
      return ["add", ...specs];
    default:
      return ["install", ...specs];
  }
}

// ---------------------------------------------------------------------------
// Combined status
// ---------------------------------------------------------------------------

/** Full picture for every `@agentic-patterns/*` dep: installed vs latest. */
export async function resolveDepStatuses(root: string): Promise<DepStatus[]> {
  const deps = collectApDeps(root);
  return Promise.all(
    deps.map(async ({ name, range }) => {
      const installed = readInstalledVersion(root, name);
      const latest = await fetchLatest(name);
      return { name, range, installed, latest, behind: isBehind(installed, latest) };
    }),
  );
}

// ---------------------------------------------------------------------------
// Passive out-of-date notifier (cached; best-effort; never blocks meaningfully)
// ---------------------------------------------------------------------------

interface CacheShape {
  checkedAt: number; // epoch ms
  latest: Record<string, string | null>;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // once/day

function cacheFile(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "agentic-patterns", "update-check.json");
}

function readCache(): CacheShape | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf-8")) as CacheShape;
  } catch {
    return null;
  }
}

function writeCache(latest: Record<string, string | null>): void {
  try {
    const file = cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ checkedAt: Date.now(), latest } satisfies CacheShape));
  } catch {
    /* cache is an optimization; failing to write it is non-fatal */
  }
}

/**
 * Print a one-line notice per behind `@agentic-patterns/*` dep, if any. Uses a
 * ~24h on-disk cache of npm `latest` so the common path does ZERO network. When
 * the cache is stale it refreshes (bounded fetch) and rewrites it.
 *
 * Silenced by `AP_NO_UPDATE_NOTIFIER=1` or when `CI` is set — a notice must
 * never pollute scripted output. Fully failure-isolated: any error → no notice.
 */
export async function notifyIfOutdated(root: string): Promise<void> {
  if (process.env.AP_NO_UPDATE_NOTIFIER === "1" || process.env.CI) return;
  try {
    const deps = collectApDeps(root);
    if (deps.length === 0) return;

    const cache = readCache();
    const fresh = cache !== null && Date.now() - cache.checkedAt < CACHE_TTL_MS;

    let latest: Record<string, string | null>;
    if (fresh && cache) {
      latest = cache.latest;
    } else {
      latest = Object.fromEntries(
        await Promise.all(deps.map(async (d) => [d.name, await fetchLatest(d.name)] as const)),
      );
      writeCache(latest);
    }

    const behind = deps
      .map((d) => ({
        name: d.name,
        installed: readInstalledVersion(root, d.name),
        latest: latest[d.name] ?? null,
      }))
      .filter((d) => isBehind(d.installed, d.latest));
    if (behind.length === 0) return;

    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
    const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
    process.stderr.write(`\n${yellow("⬆ @agentic-patterns update available")}\n`);
    for (const d of behind) {
      process.stderr.write(
        `  ${d.name}  ${dim(String(d.installed))} → ${yellow(String(d.latest))}\n`,
      );
    }
    process.stderr.write(
      `  ${dim("run")} ap update ${dim("to upgrade  ·  AP_NO_UPDATE_NOTIFIER=1 to silence")}\n`,
    );
  } catch {
    /* a notifier must never break the CLI */
  }
}
