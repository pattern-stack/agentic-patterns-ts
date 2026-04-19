/**
 * `ap init [--with-plugin] [--provider=anthropic|openai|ollama] [<project-name>]`
 *
 * Scaffolds a consumer project: package.json, .env.example, tsconfig.json, and
 * a working `agents/demo/agent.ts`. Optionally also drops a Claude Code plugin
 * (`.claude-plugin/` + `hooks/`) by copying from the monorepo root when the CLI
 * is being run from source.
 *
 * Project layout produced:
 *
 *   <target>/
 *   ├── package.json
 *   ├── .env.example
 *   ├── tsconfig.json
 *   ├── agents/
 *   │   └── demo/
 *   │       └── agent.ts
 *   └── [if --with-plugin]
 *       ├── .claude-plugin/plugin.json
 *       └── hooks/{hooks.json,emit.mjs}
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCancel, select, text } from "@clack/prompts";
import { DEFAULT_DASHBOARD_URL } from "../constants.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type Provider = "anthropic" | "openai" | "ollama";

export interface InitOptions {
  /**
   * Where to scaffold. If absent, prompt for a project name and create
   * `<cwd>/<name>/`. If present and equal to `"."`, scaffold into cwd directly.
   */
  targetDir?: string;
  /** Drop `.claude-plugin/` + `hooks/` next to the project. */
  withPlugin?: boolean;
  /** Which AI SDK provider to wire into the demo agent. */
  provider?: Provider;
  /**
   * Scaffold INTO the local monorepo's `examples/<name>/` with `workspace:*`
   * deps. Required for dogfooding until the `@agentic-patterns/*` packages
   * are published. Overrides `targetDir`.
   */
  link?: boolean;
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const VALID_PROVIDERS: readonly Provider[] = ["anthropic", "openai", "ollama"] as const;

/**
 * Entry point. Resolves missing options interactively, writes files, then
 * prints next-steps banner.
 */
export async function runInitCommand(opts: InitOptions): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Resolve target directory
  //
  // `--link` scaffolds into `<monorepoRoot>/examples/<name>/` so `workspace:*`
  // deps resolve — the only pre-publish path that actually produces a working
  // `pnpm install`. Otherwise, target is `<cwd>/<name>/` (or `.` for in-place).
  // -------------------------------------------------------------------------
  let targetDir: string;
  let projectName: string;
  let monorepoRoot: string | null = null;

  if (opts.link) {
    monorepoRoot = resolveMonorepoRoot();
    if (!monorepoRoot) {
      process.stderr.write(
        "error: --link requires the CLI to be run from the agentic-patterns-ts source tree\n",
      );
      process.exit(1);
    }
    const name = opts.targetDir ?? (await promptName());
    if (name === null) {
      process.stdout.write(`${DIM}cancelled.${RESET}\n`);
      return;
    }
    projectName = name;
    targetDir = path.join(monorepoRoot, "examples", projectName);
  } else if (opts.targetDir === undefined) {
    const name = await promptName();
    if (name === null) {
      process.stdout.write(`${DIM}cancelled.${RESET}\n`);
      return;
    }
    projectName = name;
    targetDir = path.resolve(process.cwd(), projectName);
  } else if (opts.targetDir === ".") {
    targetDir = process.cwd();
    projectName = path.basename(targetDir);
  } else {
    targetDir = path.resolve(process.cwd(), opts.targetDir);
    projectName = path.basename(targetDir);
  }

  // -------------------------------------------------------------------------
  // 2. Resolve provider
  // -------------------------------------------------------------------------
  let provider: Provider;
  if (opts.provider !== undefined) {
    if (!VALID_PROVIDERS.includes(opts.provider)) {
      process.stderr.write(
        `error: invalid --provider "${opts.provider}" (expected anthropic | openai | ollama)\n`,
      );
      process.exit(1);
    }
    provider = opts.provider;
  } else {
    const answer = await select({
      message: "provider",
      options: [
        { value: "anthropic" as const, label: "Anthropic (Claude)" },
        { value: "openai" as const, label: "OpenAI (GPT)" },
        { value: "ollama" as const, label: "Ollama (local)" },
      ],
      initialValue: "anthropic" as const,
    });
    if (isCancel(answer)) {
      process.stdout.write(`${DIM}cancelled.${RESET}\n`);
      return;
    }
    provider = answer as Provider;
  }

  // -------------------------------------------------------------------------
  // 3. Pre-flight: target dir must be empty (or not exist)
  // -------------------------------------------------------------------------
  if (fs.existsSync(targetDir)) {
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      process.stderr.write(`error: target ${targetDir} exists and is not a directory\n`);
      process.exit(1);
    }
    const conflicts = ["package.json", "agents", "tsconfig.json"].filter((n) =>
      fs.existsSync(path.join(targetDir, n)),
    );
    if (conflicts.length > 0) {
      process.stderr.write(
        `error: target ${targetDir} already contains: ${conflicts.join(", ")}\n`,
      );
      process.exit(1);
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // 4. Write project files
  // -------------------------------------------------------------------------
  const created: string[] = [];

  writeFile(
    targetDir,
    "package.json",
    renderPackageJson(projectName, provider, opts.link === true),
    created,
  );
  writeFile(targetDir, ".env.example", renderEnvExample(provider), created);
  writeFile(targetDir, "tsconfig.json", renderTsConfig(), created);
  writeFile(targetDir, path.join("agents", "demo", "agent.ts"), renderAgent(provider), created);

  // -------------------------------------------------------------------------
  // 5. Optional plugin
  // -------------------------------------------------------------------------
  let pluginNote: string | null = null;
  if (opts.withPlugin) {
    const pluginSrc = resolvePluginSource();
    if (pluginSrc) {
      copyDir(pluginSrc.pluginDir, path.join(targetDir, ".claude-plugin"));
      copyDir(pluginSrc.hooksDir, path.join(targetDir, "hooks"));
      created.push(".claude-plugin/", "hooks/");

      // Mirror hooks.json into .claude/settings.json so Claude Code activates
      // them immediately for sessions started in this directory. If the user
      // already has a settings.json, merge our hooks into it non-destructively
      // (preserve their other keys; skip events where our hook is already
      // registered so re-running `ap init` is idempotent).
      const settingsDir = path.join(targetDir, ".claude");
      const settingsPath = path.join(settingsDir, "settings.json");
      const hooksSource = fs.readFileSync(path.join(pluginSrc.hooksDir, "hooks.json"), "utf8");
      const ourHooks = JSON.parse(
        hooksSource.replaceAll("${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_PROJECT_DIR}"),
      ) as HookSettings;

      const mergeOutcome = mergeHookSettings(settingsPath, ourHooks);
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(mergeOutcome.merged, null, 2)}\n`);
      if (mergeOutcome.kind === "created") {
        created.push(".claude/settings.json");
      } else if (mergeOutcome.kind === "merged") {
        created.push(
          `.claude/settings.json ${DIM}(merged ${mergeOutcome.added} hook entries)${RESET}`,
        );
      } else {
        created.push(`.claude/settings.json ${DIM}(already up to date)${RESET}`);
      }
    } else {
      // TODO(phase-2): package the plugin template inside
      // packages/agent-cli/assets/plugin-template/ during build so this works
      // when the CLI is installed via npm.
      pluginNote = `${YELLOW}warning${RESET}: --with-plugin requested but plugin source not found.\n   ${DIM}Run from the agentic-patterns-ts source tree, or wait for plugin packaging (Phase 2).${RESET}`;
    }
  }

  // -------------------------------------------------------------------------
  // 6. Banner
  // -------------------------------------------------------------------------
  const rel = path.relative(process.cwd(), targetDir) || ".";
  process.stdout.write(`\n  ${GREEN}created${RESET} ${BOLD}${rel}${RESET}\n\n`);
  for (const f of created) {
    process.stdout.write(`    ${DIM}+ ${f}${RESET}\n`);
  }
  if (pluginNote) {
    process.stdout.write(`\n  ${pluginNote}\n`);
  }
  process.stdout.write(`\n  ${BOLD}next${RESET}\n`);

  if (opts.link && monorepoRoot) {
    // Install runs at the monorepo root so workspace:* resolves for every
    // transitive @agentic-patterns/* dep.
    const rootRel = path.relative(process.cwd(), monorepoRoot) || ".";
    const projRel = path.relative(monorepoRoot, targetDir);
    if (rootRel !== ".") {
      process.stdout.write(`    cd ${rootRel}\n`);
    }
    process.stdout.write(
      `    bun install                ${DIM}# picks up the new example${RESET}\n`,
    );
    process.stdout.write(`    cd ${projRel}\n`);
    process.stdout.write(
      `    cp .env.example .env       ${DIM}# fill in your ${envKeyFor(provider)}${RESET}\n`,
    );
    process.stdout.write(`    bun run dev                ${DIM}# launch playground${RESET}\n\n`);
  } else {
    if (rel !== ".") {
      process.stdout.write(`    cd ${rel}\n`);
    }
    process.stdout.write(
      `    cp .env.example .env       ${DIM}# fill in your ${envKeyFor(provider)}${RESET}\n`,
    );
    process.stdout.write("    bun install\n");
    process.stdout.write(`    bun run dev                ${DIM}# launch playground${RESET}\n\n`);
  }
}

async function promptName(): Promise<string | null> {
  const answer = await text({
    message: "project name",
    placeholder: "my-agents",
    validate: (v) => (v.trim().length === 0 ? "name is required" : undefined),
  });
  if (isCancel(answer)) return null;
  return String(answer).trim();
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

function renderPackageJson(name: string, provider: Provider, link: boolean): string {
  const providerDep = providerSdkPackage(provider);
  const apVersion = link ? "workspace:*" : "^0.1.0";

  const pkg = {
    name,
    private: true,
    version: "0.0.1",
    type: "module",
    scripts: {
      dev: "ap playground",
      start: "ap playground",
      agents: "ap agents",
    },
    dependencies: {
      "@agentic-patterns/core": apVersion,
      "@agentic-patterns/runtime": apVersion,
      "@agentic-patterns/cli": apVersion,
      ai: "^4.0.0",
      [providerDep]: "^1.0.0",
      zod: "^3.23.0",
    },
    devDependencies: {
      "@types/node": "^22.0.0",
      typescript: "^5.7.0",
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function renderEnvExample(provider: Provider): string {
  const lines = [
    "# Dashboard URL — used by the Claude Code plugin to ship lifecycle events",
    `AP_DASHBOARD_URL=${DEFAULT_DASHBOARD_URL}`,
    "",
    "# Default model tier — opus | sonnet | haiku (used by the agent runner)",
    "AGENT_TIER=sonnet",
    "",
  ];
  if (provider === "anthropic") {
    lines.push("# Anthropic API key (https://console.anthropic.com/)");
    lines.push("ANTHROPIC_API_KEY=sk-ant-...");
  } else if (provider === "openai") {
    lines.push("# OpenAI API key (https://platform.openai.com/api-keys)");
    lines.push("OPENAI_API_KEY=sk-...");
  } else {
    lines.push("# Ollama host (default http://localhost:11434)");
    lines.push("OLLAMA_HOST=http://localhost:11434");
  }
  return `${lines.join("\n")}\n`;
}

function renderTsConfig(): string {
  const cfg = {
    compilerOptions: {
      target: "es2022",
      module: "nodenext",
      moduleResolution: "nodenext",
      lib: ["es2022"],
      outDir: "dist",
      rootDir: "src",
      strict: true,
      noUncheckedIndexedAccess: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      declaration: true,
      sourceMap: true,
    },
    include: ["agents/**/*.ts", "src/**/*.ts"],
    exclude: ["node_modules", "dist"],
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

function renderAgent(provider: Provider): string {
  // The agent file conforms to the discovery contract: default-export an
  // AgentRegistration `{ id, name, description, agent }`. The CLI's playground
  // injects the runner — we don't need to construct one here, but we leave the
  // provider import wired up so users can graduate to a custom runner easily.
  return `/**
 * Demo agent — generated by \`ap init\`.
 *
 * The default export is an AgentRegistration. The \`ap\` CLI discovers this
 * file (via \`agents/**\\/agent.ts\`), builds a runner from your environment
 * (using ${provider}), and wires it into the playground dashboard.
 *
 *   bun run dev       # launch the dashboard at http://localhost:3456
 *   ap run demo       # chat with this agent in the terminal
 */

import {
  AgentBuilder,
  Capability,
  Judgment,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
  type ToolDefinition,
  Toolbox,
} from "@agentic-patterns/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// A tiny toolbox so the agent has something concrete to do.
// ---------------------------------------------------------------------------

class GreetingToolbox extends Toolbox {
  readonly name = "greeting_tools";
  readonly description = "Friendly greeting helpers";

  readonly tools: Record<string, ToolDefinition> = {
    greet: {
      description: "Produce a friendly greeting for a person",
      parameters: z.object({
        name: z.string().describe("Person's name"),
      }),
      execute: async (args) => {
        const { name } = args as { name: string };
        return { greeting: \`Hello, \${name}! Welcome to agentic-patterns.\` };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Build the agent.
// ---------------------------------------------------------------------------

const role = new RoleBuilder("demo-assistant")
  .withPersona(
    new Persona({
      identity: "A friendly demo assistant that greets people warmly",
      tone: "warm and concise",
      priorities: ["being helpful", "showing the framework off"],
      principles: ["Always use the greet tool when greeting someone"],
    }),
  )
  .withJudgment(
    new Judgment({
      domain: "greetings and small talk",
      heuristics: ["Use the greet tool for any name-based greeting"],
      constraints: ["Stay friendly and concise"],
    }),
  )
  .withCapability(
    new Capability("greeting_tools", "Friendly greeting helpers", new GreetingToolbox()),
  )
  .withResponsibility(
    new Responsibility({
      key: "greet",
      name: "Greet People",
      description: "Greet people warmly using the greet tool",
    }),
  )
  .withDefaultModel("sonnet")
  .build();

const mission = new Mission({
  objective: "Demonstrate the @agentic-patterns/core building blocks end-to-end",
  success_criteria: ["Greets users by name", "Uses the greet tool for every greeting"],
});

const agent = new AgentBuilder(role).withMission(mission).build();

// ---------------------------------------------------------------------------
// Default export — discovered by \`ap\`. The runner is injected by the CLI.
// ---------------------------------------------------------------------------

export default {
  id: "demo",
  name: "Demo",
  description: "A friendly demo assistant generated by \`ap init\`",
  agent,
};
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envKeyFor(provider: Provider): string {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "ollama":
      return "OLLAMA_HOST";
  }
}

function providerSdkPackage(provider: Provider): string {
  switch (provider) {
    case "anthropic":
      return "@ai-sdk/anthropic";
    case "openai":
      return "@ai-sdk/openai";
    case "ollama":
      return "ollama-ai-provider";
  }
}

function writeFile(root: string, rel: string, contents: string, log: string[]): void {
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents, "utf8");
  log.push(rel);
}

function copyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

// ---------------------------------------------------------------------------
// Hook settings merge
//
// Claude Code users frequently already have a `.claude/settings.json` with
// their own hooks, permissions, or model preferences. We must not clobber it.
// `mergeHookSettings` preserves existing top-level keys and adds our hook
// entries only where they don't already exist — same command string under the
// same event + matcher counts as "already registered", so re-running
// `ap init --with-plugin` is idempotent.
// ---------------------------------------------------------------------------

type HookEntry = { type: string; command: string; async?: boolean; timeout?: number };
type HookMatcher = { matcher: string; hooks: HookEntry[] };
type HookSettings = { hooks: Record<string, HookMatcher[]>; [key: string]: unknown };

type MergeOutcome =
  | { kind: "created"; merged: HookSettings }
  | { kind: "merged"; merged: HookSettings; added: number }
  | { kind: "unchanged"; merged: HookSettings };

function mergeHookSettings(settingsPath: string, ours: HookSettings): MergeOutcome {
  if (!fs.existsSync(settingsPath)) {
    return { kind: "created", merged: ours };
  }

  let existing: HookSettings;
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as HookSettings;
  } catch {
    // Malformed user file — back up and treat as fresh write, so we never
    // silently drop their content.
    const backup = `${settingsPath}.ap-backup-${Date.now()}`;
    fs.renameSync(settingsPath, backup);
    process.stdout.write(
      `${YELLOW}warning${RESET}: existing .claude/settings.json was malformed; moved to ${path.basename(backup)}\n`,
    );
    return { kind: "created", merged: ours };
  }

  const merged: HookSettings = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  let added = 0;

  for (const event of Object.keys(ours.hooks)) {
    const ourMatchers = ours.hooks[event] ?? [];
    const theirMatchers = merged.hooks[event] ?? [];
    const result = [...theirMatchers];

    for (const ourMatcher of ourMatchers) {
      const theirMatcher = result.find((m) => m.matcher === ourMatcher.matcher);
      if (!theirMatcher) {
        result.push(ourMatcher);
        added += ourMatcher.hooks.length;
        continue;
      }
      for (const ourHook of ourMatcher.hooks) {
        const duplicate = theirMatcher.hooks.some(
          (h) => h.type === ourHook.type && h.command === ourHook.command,
        );
        if (!duplicate) {
          theirMatcher.hooks.push(ourHook);
          added += 1;
        }
      }
    }

    merged.hooks[event] = result;
  }

  if (added === 0) return { kind: "unchanged", merged };
  return { kind: "merged", merged, added };
}

/**
 * Try to find `.claude-plugin/` and `hooks/`.
 *
 * Two possible locations:
 *   1. Bundled inside the published CLI tarball at
 *      `packages/agent-cli/assets/plugin-template/` (checked first — works
 *      when the CLI is installed via `npm install -g @agentic-patterns/cli`)
 *   2. The monorepo root (dogfood path — walks up from the running script)
 */
function resolvePluginSource(): { pluginDir: string; hooksDir: string } | null {
  const here = path.dirname(fileURLToPath(import.meta.url));

  // Candidate 1 (priority): bundled plugin-template inside the CLI package.
  // Source run:  src/commands/init.ts  → ../../assets/plugin-template/
  // Dist run:    dist/cli.js           → ../assets/plugin-template/
  const bundledCandidates = [
    path.resolve(here, "../assets/plugin-template"),
    path.resolve(here, "../../assets/plugin-template"),
  ];
  for (const base of bundledCandidates) {
    const pluginDir = path.join(base, ".claude-plugin");
    const hooksDir = path.join(base, "hooks");
    if (fs.existsSync(pluginDir) && fs.existsSync(hooksDir)) {
      return { pluginDir, hooksDir };
    }
  }

  // Candidate 2: monorepo root (for local `bun --filter` / tsx runs).
  const root = resolveMonorepoRoot();
  if (root) {
    return { pluginDir: path.join(root, ".claude-plugin"), hooksDir: path.join(root, "hooks") };
  }
  return null;
}

/**
 * Locate the monorepo root by walking up from this file. The root is
 * identified by having `packages/agent-core/` and a `workspaces` field in
 * package.json (bun workspace marker — replaces the old pnpm-workspace.yaml).
 */
function resolveMonorepoRoot(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let cur = here;
    for (let i = 0; i < 8; i++) {
      const rootPkgPath = path.join(cur, "package.json");
      if (fs.existsSync(rootPkgPath) && fs.existsSync(path.join(cur, "packages", "agent-core"))) {
        try {
          const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8")) as {
            workspaces?: string[];
          };
          if (rootPkg.workspaces && rootPkg.workspaces.length > 0) {
            return cur;
          }
        } catch {
          // malformed json — fall through
        }
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  } catch {
    return null;
  }
}
