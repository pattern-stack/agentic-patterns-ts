/**
 * Agent discovery — crawl the project for agent files, dynamic-import each,
 * and normalize the export into an `AgentRegistration` shape.
 *
 * Convention: each agent is a file at `agents/<name>/agent.{ts,js,mjs}`
 * (or `agents/<name>.agent.ts`) that default-exports either:
 *   • an `AgentRegistration` object directly:
 *       export default { id, name, description?, agent }
 *   • a function that returns one (sync or async):
 *       export default () => ({ id, name, agent })
 *
 * The `runner` field is OPTIONAL: if the agent file exports one, it
 * overrides the shared runner the CLI would otherwise inject via
 * `createRunner()`. The value may be either a concrete `RunnerLike`
 * (with `run`/`stream`) or a `RunnerFactory` (with `forConversation`) —
 * see `@agentic-patterns/server` for the type definitions. Useful for
 * agents that need a non-default runner (e.g. the Claude Code agent
 * which must run through `ClaudeCodeAPIRunner` regardless of what env
 * detection picked).
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RunnerFactory, RunnerLike } from "@agentic-patterns/server";
import { glob } from "tinyglobby";
import { register } from "tsx/esm/api";

// Register tsx as the ESM loader globally — once per process. After this,
// Node's regular dynamic import() handles `.ts` files transparently AND
// resolves bare specifiers from the importing file's location like normal.
let _tsxRegistered = false;
function ensureTsxRegistered(): void {
  if (_tsxRegistered) return;
  register();
  _tsxRegistered = true;
}

/** What an agent file is expected to export. */
export interface DiscoveredAgent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  // biome-ignore lint/suspicious/noExplicitAny: agent shape comes from agent-core/server, kept loose at the discovery boundary
  readonly agent: any;
  /**
   * Optional runner exported from the agent file. If present, the playground
   * uses it instead of the shared `createRunner()` result.
   */
  readonly runner?: RunnerLike | RunnerFactory;
  /** Absolute path to the source file (for `ap agents` rendering). */
  readonly file: string;
}

interface AgentExport {
  id?: string;
  name?: string;
  description?: string;
  agent?: unknown;
  runner?: unknown;
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
 * Dynamically import an agent file and normalize the export into a
 * `DiscoveredAgent`. Throws a descriptive error on bad shape.
 */
export async function loadAgentFile(file: string): Promise<DiscoveredAgent> {
  // tsx's tsImport handles .ts at runtime via on-the-fly transpile.
  // Plain .js/.mjs files go through Node's native import.
  const isTs = file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".mts");
  if (isTs) ensureTsxRegistered();
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  let exported = mod.default;

  if (typeof exported === "function") {
    exported = await (exported as () => unknown | Promise<unknown>)();
  }

  if (!exported || typeof exported !== "object") {
    throw new Error(
      `${file}: default export must be an AgentRegistration object or a function returning one`,
    );
  }

  const { id, name, description, agent, runner } = exported as AgentExport;

  if (!id || typeof id !== "string") {
    throw new Error(`${file}: missing or invalid 'id' (must be a non-empty string)`);
  }
  if (!name || typeof name !== "string") {
    throw new Error(`${file}: missing or invalid 'name' (must be a non-empty string)`);
  }
  if (!agent || typeof agent !== "object") {
    throw new Error(`${file}: missing or invalid 'agent' (must be an Agent object)`);
  }

  // `runner` is optional. Accept anything that looks like a RunnerLike
  // (has `run`) OR a RunnerFactory (has `forConversation`). Anything else
  // is a configuration error — fail loudly rather than silently dropping.
  let discoveredRunner: RunnerLike | RunnerFactory | undefined;
  if (runner != null) {
    if (typeof runner !== "object") {
      throw new Error(`${file}: 'runner' must be a RunnerLike object or RunnerFactory`);
    }
    const r = runner as Partial<RunnerLike> & Partial<RunnerFactory>;
    const looksLikeFactory = typeof r.forConversation === "function";
    const looksLikeRunner = typeof r.run === "function";
    if (!looksLikeFactory && !looksLikeRunner) {
      throw new Error(
        `${file}: 'runner' must expose 'run' (RunnerLike) or 'forConversation' (RunnerFactory)`,
      );
    }
    discoveredRunner = runner as RunnerLike | RunnerFactory;
  }

  return {
    id,
    name,
    description,
    agent,
    runner: discoveredRunner,
    file,
  };
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
      const a = await loadAgentFile(file);
      agents.push(a);
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
