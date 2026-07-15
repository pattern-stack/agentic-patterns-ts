/**
 * Agent discovery — crawl the project for agent files, dynamic-import each,
 * and collect the Agent(s) each one exports.
 *
 * Discovery is "convention bounds the scan; type finds the agents":
 *   • A glob bounds WHICH files get imported (importing runs top-level code, so
 *     we only import intentional agent files — `agent.{ts,js,mjs}` or
 *     `*.agent.{ts,js,mjs}`, typically under an `agents/` dir).
 *   • Within each imported module we introspect EVERY export and keep the ones
 *     that ARE an Agent — by structural shape, so the export name is irrelevant:
 *       export default buildCalculatorAgent()        // bare default
 *       export const rootAgent = buildAgent()        // the conventional name
 *       export const reviewer = buildReviewer()      // any named export
 *       export const a = …, b = …                    // multiple per file
 *   • The legacy registration wrapper is still honored:
 *       export default { id, name, description?, agent }
 *       export default () => ({ id, name, agent })   // factory
 *
 * Identity is inferred when not given explicitly:
 *   • name  — a meaningful named export, else the agent's folder / filename.
 *   • id    — that local name, namespaced by `{domain}` when the file lives under
 *             a nested `{domain}/agents/…` (a top-level `agents/` gets no domain),
 *             so cross-domain collisions can't happen.
 *
 * The `runner` field is NOT defined by the user — the CLI injects it after
 * discovery via `createRunner()`.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { glob } from "tinyglobby";
import { register } from "tsx/esm/api";
import type { AgentProvenance } from "./provenance.js";

// Register tsx as the ESM loader globally — once per process. After this,
// Node's regular dynamic import() handles `.ts` files transparently AND
// resolves bare specifiers from the importing file's location like normal.
// Exported for provenance.ts, which dynamic-imports library/local modules
// through the same loader.
let _tsxRegistered = false;
export function ensureTsxRegistered(): void {
  if (_tsxRegistered) return;
  register();
  _tsxRegistered = true;
}

/** A discovered agent, normalized (sans runner — the CLI injects that). */
export interface DiscoveredAgent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  // biome-ignore lint/suspicious/noExplicitAny: agent shape comes from agent-core/server, kept loose at the discovery boundary
  readonly agent: any;
  /** Absolute path to the source file (for `ap agents` rendering). */
  readonly file: string;
  /** Per-slot provenance (preset/library/local/inline), attached post-discovery. */
  readonly provenance?: AgentProvenance;
  /**
   * Delivered-instance factory, taken verbatim from the registration wrapper —
   * the playground threads it into the server's AgentRegistration so the
   * composition lens can render the agent as an entrypoint would compose it
   * (live Background for a supplied context, e.g. `{ organizationId }`).
   */
  // biome-ignore lint/suspicious/noExplicitAny: returns an agent shape, kept loose at the discovery boundary
  readonly instantiate?: (context?: Record<string, unknown>) => Promise<any>;
  /** Seed context for `instantiate` (prefills the lens's context editor). */
  readonly instantiateDefaults?: Record<string, unknown>;
  /**
   * Top-level `instantiate` context keys whose values should be displayed as
   * `"[redacted]"` (#268 Decision 3) — taken verbatim from the registration
   * wrapper and threaded into the server's `AgentRegistration` (the playground)
   * / applied directly by `ap run` (the CLI's own conversation, #268 PR-3).
   */
  readonly contextRedactKeys?: readonly string[];
  /**
   * Declared eval↔agent mapping from the registration wrapper: the eval sets
   * that grade this agent (or one of its steps). Passed through to the
   * server's AgentRegistration; the Agent lens renders history + launch.
   */
  readonly evals?: ReadonlyArray<{
    setId: string;
    grades?: string;
    step?: string;
    scorer?: string;
  }>;
}

interface RegistrationWrapper {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  agent?: unknown;
  instantiate?: unknown;
  instantiateDefaults?: unknown;
  contextRedactKeys?: unknown;
  evals?: unknown;
}

/**
 * Structural Agent check. We intentionally duck-type rather than
 * `instanceof Agent`: agent files commonly import agent-core through a built
 * `dist/` entry that can resolve to a DIFFERENT module instance than the CLI's
 * copy, which makes `instanceof` silently false across that boundary. The
 * shape (`Agent = Role × Background × Awareness × Mission`) is stable and
 * bundle-proof.
 */
function isAgentShape(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  return (
    typeof a.role === "object" &&
    a.role !== null &&
    typeof a.mission === "object" &&
    a.mission !== null &&
    "awareness" in a &&
    "background" in a
  );
}

/**
 * Structural `AgentLike` check — recognizes a promoted `Node` (`asAgent()`,
 * `@agentic-patterns/runtime` `workflows/as-agent.ts`) alongside a full core
 * Agent. Same duck-type rationale as {@link isAgentShape}: `instanceof` is
 * unreliable across the built-`dist/` module boundary. `role:{name}` plus
 * `getModel`/`renderInitialPrompt` both being functions is a
 * fingerprint distinctive enough not to collide with a full core Agent (which
 * ALSO satisfies this — the two checks are non-exclusive, deliberately) or a
 * random object.
 */
export function isAgentLikeShape(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  return (
    typeof a.role === "object" &&
    a.role !== null &&
    typeof (a.role as Record<string, unknown>).name === "string" &&
    typeof a.getModel === "function" &&
    typeof a.renderInitialPrompt === "function"
  );
}

/** A registration wrapper is `{ agent: <Agent- or AgentLike-shaped>, … }` (not an Agent itself). */
function asWrapper(x: unknown): RegistrationWrapper | null {
  if (!x || typeof x !== "object") return null;
  const w = x as RegistrationWrapper;
  return isAgentShape(w.agent) || isAgentLikeShape(w.agent) ? w : null;
}

/**
 * Find agent files matching the given globs, rooted at `root`.
 * Returns absolute file paths sorted alphabetically.
 */
export async function findAgentFiles(root: string, globs: readonly string[]): Promise<string[]> {
  const matches = await glob([...globs], {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**"],
  });
  return matches.sort();
}

/**
 * Dynamically import an agent file and collect every Agent it exports
 * (introspecting all exports + the legacy registration/factory form).
 * `root` is used only to derive the `{domain}` id namespace.
 */
export async function loadAgentsFromFile(file: string, root: string): Promise<DiscoveredAgent[]> {
  const isTs = file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".mts");
  if (isTs) ensureTsxRegistered();
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;

  const found: DiscoveredAgent[] = [];
  const seenIds = new Set<string>();

  for (const [key, raw] of Object.entries(mod)) {
    // Only `default` / `rootAgent` are invoked as factories. Other named
    // exports are used as values — we don't call arbitrary exported functions
    // (they may be unrelated helpers with side effects).
    let value: unknown = raw;
    if (typeof value === "function") {
      if (key !== "default" && key !== "rootAgent") continue;
      value = await (value as () => unknown | Promise<unknown>)();
    }
    if (!value || typeof value !== "object") continue;

    const wrapper = asWrapper(value);
    const isAgent = wrapper === null && (isAgentShape(value) || isAgentLikeShape(value));
    if (!wrapper && !isAgent) continue; // not an agent, not a registration → skip

    const agent = wrapper ? wrapper.agent : value;
    const inferred = inferIdentity(file, key, root);
    const id = (wrapper && str(wrapper.id)) || inferred.id;
    const name = (wrapper && str(wrapper.name)) || inferred.name;
    const description = wrapper ? str(wrapper.description) : undefined;
    const instantiate =
      wrapper && typeof wrapper.instantiate === "function"
        ? (wrapper.instantiate as DiscoveredAgent["instantiate"])
        : undefined;
    const instantiateDefaults =
      wrapper &&
      typeof wrapper.instantiateDefaults === "object" &&
      wrapper.instantiateDefaults !== null &&
      !Array.isArray(wrapper.instantiateDefaults)
        ? (wrapper.instantiateDefaults as Record<string, unknown>)
        : undefined;
    // Same defensive style as `instantiateDefaults`: the whole value must
    // type-check (an array of strings) or it's dropped entirely — no partial
    // salvage of a malformed declaration.
    const contextRedactKeys =
      wrapper &&
      Array.isArray(wrapper.contextRedactKeys) &&
      wrapper.contextRedactKeys.every((k) => typeof k === "string")
        ? (wrapper.contextRedactKeys as string[])
        : undefined;
    const evals = wrapper ? normalizeEvalRefs(wrapper.evals) : undefined;

    if (seenIds.has(id)) continue; // e.g. a default + named export of the same agent
    seenIds.add(id);
    found.push({
      id,
      name,
      description,
      agent,
      file,
      instantiate,
      instantiateDefaults,
      contextRedactKeys,
      evals,
    });
  }

  if (found.length === 0) {
    throw new Error(
      `${file}: no Agent exports found — export an Agent (default, \`rootAgent\`, or any named export), or a registration { id, name, agent }`,
    );
  }
  return found;
}

/**
 * Discover all agents under the given root + globs. Returns successfully
 * loaded agents AND a separate list of load errors (so callers can choose
 * to surface failures without aborting discovery).
 */
export async function discoverAgents(
  root: string,
  globs: readonly string[],
): Promise<{
  agents: DiscoveredAgent[];
  errors: { file: string; error: Error }[];
}> {
  const files = await findAgentFiles(root, globs);
  const agents: DiscoveredAgent[] = [];
  const errors: { file: string; error: Error }[] = [];

  for (const file of files) {
    try {
      agents.push(...(await loadAgentsFromFile(file, root)));
    } catch (e) {
      errors.push({
        file: path.relative(root, file),
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  // Detect duplicate ids — first wins, others surface as errors.
  const seen = new Set<string>();
  const deduped: DiscoveredAgent[] = [];
  for (const a of agents) {
    if (seen.has(a.id)) {
      errors.push({
        file: path.relative(root, a.file),
        error: new Error(`duplicate agent id "${a.id}" (already registered)`),
      });
    } else {
      seen.add(a.id);
      deduped.push(a);
    }
  }

  return { agents: deduped, errors };
}

// ---------------------------------------------------------------------------
// Identity inference
// ---------------------------------------------------------------------------

/**
 * Derive an agent's `{ id, name }` from its file path + export key.
 *
 *   - local name: a meaningful named export wins (`reviewerAgent` → `reviewer`);
 *     `default`/`rootAgent` fall back to the filename (`foo.agent.ts` → `foo`)
 *     and then the folder (`foo/agent.ts` → `foo`).
 *   - domain: dirs between `root` and a nested `agents/` (`dealbrain/agents/x`
 *     → `dealbrain`). A top-level `agents/` (no dir above it) → no domain.
 *   - id: `domain/local` when there's a domain, else `local`.
 */
export function inferIdentity(
  file: string,
  exportKey: string,
  root: string,
): { id: string; name: string } {
  const folder = path.basename(path.dirname(file));
  // strip a trailing `.agent.<ext>` or plain `.<ext>` → bare filename stem
  const stem = path.basename(file).replace(/(\.agent)?\.[^.]+$/, "");

  let local: string;
  if (exportKey && exportKey !== "default" && exportKey !== "rootAgent") {
    local = exportKey.replace(/Agent$/, "");
  } else if (stem && stem !== "agent") {
    local = stem;
  } else {
    local = folder;
  }
  local = toKebab(local);

  const domain = domainOf(root, file);
  const id = domain ? `${domain}/${local}` : local;
  return { id, name: prettify(local) };
}

/** Dirs between `root` and a nested `agents/` segment, joined; undefined if top-level/absent. */
function domainOf(root: string, file: string): string | undefined {
  const rel = path.relative(root, file);
  const segs = rel.split(path.sep);
  const ai = segs.indexOf("agents");
  if (ai <= 0) return undefined; // `agents/` at the top (or absent) → no domain
  return segs.slice(0, ai).map(toKebab).join("/");
}

function toKebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

function prettify(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function str(x: unknown): string | undefined {
  return typeof x === "string" && x.length > 0 ? x : undefined;
}

/**
 * Normalize a registration wrapper's `evals` declaration: keep only entries
 * with a non-empty string `setId`, and only the known fields. A malformed
 * declaration degrades to the valid subset (or undefined) rather than failing
 * discovery — the agent itself is still perfectly loadable.
 */
function normalizeEvalRefs(raw: unknown): DiscoveredAgent["evals"] {
  if (!Array.isArray(raw)) return undefined;
  const refs = raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const setId = str(e.setId);
    if (!setId) return [];
    return [
      {
        setId,
        ...(str(e.grades) ? { grades: str(e.grades) } : {}),
        ...(str(e.step) ? { step: str(e.step) } : {}),
        ...(str(e.scorer) ? { scorer: str(e.scorer) } : {}),
      },
    ];
  });
  return refs.length > 0 ? refs : undefined;
}
