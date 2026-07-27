/**
 * Project config — find the project root, load the env files, read the
 * optional `agentic` field from package.json for overrides.
 *
 * Resolution rules:
 *   • Walk up from CWD looking for the first `package.json` — that's the root.
 *   • Parse `.env.local` then `.env` at the root into `process.env`.
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
  /**
   * Glob(s) for role LIBRARY module enumeration (provenance's "configured
   * glob", docs/playground-redesign.md §5). Undefined → provenance default.
   */
  readonly roles?: readonly string[];
  /** Default port for `playground`. */
  readonly port: number;
  /** Whether the project package.json has an `agentic` block. */
  readonly hasManifest: boolean;
}

interface PackageManifest {
  agentic?: {
    agents?: string | string[];
    roles?: string | string[];
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

/**
 * Env files read at startup, in precedence order. Loading is first-wins (a key
 * already present in `process.env` is never overwritten), so `.env.local` —
 * the chmod-600 file secret managers generate — outranks the hand-edited
 * `.env`. Matches how bun/vite/next layer the two.
 */
const ENV_FILES = [".env.local", ".env"] as const;

/**
 * True for a value that is still a secret-manager *reference* rather than a
 * resolved value (`secret://NAME`, `op://vault/item/field`). These appear in a
 * `.env` that feeds a resolver such as `pts secrets env`, and must never reach
 * `process.env`: a literal "secret://OPENAI_API_KEY" is a non-empty string, so
 * credential preflight would report a working provider and the request would
 * then fail upstream with a confusing 401.
 */
function isUnresolvedSecretRef(value: string): boolean {
  return value.startsWith("secret://") || value.startsWith("op://");
}

/** Load `.env.local` then `.env` at the given root. Idempotent. */
export function loadDotEnv(root: string): void {
  for (const name of ENV_FILES) {
    loadEnvFile(path.join(root, name));
  }
}

/** Parse one env file into `process.env` (no-op if missing). */
function loadEnvFile(file: string): void {
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
    if (isUnresolvedSecretRef(value)) continue;
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
  const roles = normalizeGlobs(manifest.agentic?.roles);
  const envPort = process.env.PORT;
  const port =
    manifest.agentic?.port ??
    (envPort !== undefined ? Number.parseInt(envPort, 10) : DEFAULT_DASHBOARD_PORT);

  return { root, agents, ...(roles ? { roles } : {}), port, hasManifest };
}

function normalizeGlobs(value: string | string[] | undefined): readonly string[] | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value : [value];
}
