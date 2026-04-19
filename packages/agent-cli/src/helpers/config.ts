/**
 * Project config — find the project root, load `.env`, read the optional
 * `agentic` field from package.json for overrides.
 *
 * Resolution rules:
 *   • Walk up from CWD looking for the first `package.json` — that's the root.
 *   • If `.env` exists at the root, parse it into `process.env`.
 *   • If `package.json` has an `agentic` field, return it as the project config.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DASHBOARD_PORT } from "../constants.js";

export interface ProjectConfig {
  /** Absolute path to the project root (where package.json was found). */
  readonly root: string;
  /** Glob(s) for agent file discovery. Default: `["agents/**\/agent.{ts,js,mjs}"]`. */
  readonly agents: readonly string[];
  /** Default port for `playground`. */
  readonly port: number;
  /** Whether the project package.json has an `agentic` block. */
  readonly hasManifest: boolean;
}

interface PackageManifest {
  agentic?: {
    agents?: string | string[];
    port?: number;
  };
}

const DEFAULT_AGENT_GLOBS = ["agents/**/agent.{ts,js,mjs}"];

/**
 * Walk up from `from` (default: CWD) looking for the nearest `package.json`.
 * Returns the directory containing it, or `null` if none found.
 */
export function findProjectRoot(from: string = process.cwd()): string | null {
  let dir = path.resolve(from);
  while (true) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Load `.env` at the given root (no-op if file missing). Idempotent. */
export function loadDotEnv(root: string): void {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf-8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Resolve project config. Walks up from CWD to find a project root, loads
 * `.env`, and reads the optional `agentic` block from package.json.
 */
export function resolveProjectConfig(from: string = process.cwd()): ProjectConfig {
  const root = findProjectRoot(from) ?? from;
  loadDotEnv(root);

  let manifest: PackageManifest = {};
  let hasManifest = false;
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as PackageManifest;
      manifest = parsed;
      hasManifest = Boolean(parsed.agentic);
    } catch {
      // Malformed package.json — fall through to defaults.
    }
  }

  const agents = normalizeGlobs(manifest.agentic?.agents) ?? DEFAULT_AGENT_GLOBS;
  const envPort = process.env.PORT;
  const port =
    manifest.agentic?.port ??
    (envPort !== undefined ? Number.parseInt(envPort, 10) : DEFAULT_DASHBOARD_PORT);

  return { root, agents, port, hasManifest };
}

function normalizeGlobs(value: string | string[] | undefined): readonly string[] | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value : [value];
}
