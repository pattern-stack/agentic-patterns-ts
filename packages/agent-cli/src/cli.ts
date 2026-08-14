/**
 * `ap` — agentic patterns CLI.
 *
 * Single-dispatch shape (mirrors codegen-patterns/cli.ts):
 *   parseArgs → switch(command) → run<Name>Command(...).
 *
 * Bare `ap` shows a status dashboard (mirrors `st`).
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { runAgentsCommand } from "./commands/agents.js";
import { runClaudeSkillCommand } from "./commands/claude-skill.js";
import { runConfigSetCommand, runConfigStatusCommand } from "./commands/config.js";
import { runEvalCommand } from "./commands/eval.js";
import { type Provider, runInitCommand } from "./commands/init.js";
import { runPlaygroundCommand } from "./commands/playground.js";
import { runRunCommand } from "./commands/run.js";
import { runStatusCommand } from "./commands/status.js";
import { runToolsCommand } from "./commands/tools.js";
import { runUpdateCommand } from "./commands/update.js";
import { findProjectRoot, resolveProjectConfig } from "./helpers/config.js";
import { discoverAgents } from "./helpers/discover.js";
import { attachProvenance } from "./helpers/provenance.js";
import { notifyIfOutdated } from "./helpers/versions.js";

const USAGE = `
ap — agentic patterns

Usage:
  ap                              status dashboard
  ap <command> [options]

Commands:
  agents                          list discovered agents
  run <agent> [message]           chat in terminal — interactive or one-shot
                                    (--context/AP_CONTEXT seed a hook-bearing
                                    agent's run-scope, #268)
  tools list <agent>              list every tool exposed by an agent
  tools call <agent> <tool> ...   invoke a tool directly (no LLM in the loop)
  playground [<dir>]              launch UI environment (server + dashboard);
                                    point <dir> at an agents root to discover
                                    every child agent recursively
  eval [<dir>] --set <path|id>    run a case bank suite against one agent,
                                    persist to EvalStore, gate exit code
  init [<dir>]                    scaffold a new agent project
  claude-skill [<name>]           install the bundled Claude Code skill(s)
                                    into .claude/skills (standalone)
  update [--check]                update @pattern-stack/agentic-* deps to latest
                                    (--check: report only, exit 1 if behind)
  config                          show env detection status
  config set                      interactive .env editor

Options:
  -h, --help                      show this help
  --port <port>                   server port for playground (default 3456)
  --no-dashboard                  playground without dashboard (API only)
  --no-open                       don't auto-open the browser
  --agents <glob>                 override agent discovery glob
  --agents-dir <dir>              discover agents recursively under <dir>
                                    (same as the playground positional)
  --context <json>                (run) context for the agent's instantiate
                                    hook — precedence: flag > AP_CONTEXT env
                                    > the registration's instantiateDefaults;
                                    errors pre-run on invalid JSON or on a
                                    hook-less agent
  --with-plugin                   (init) drop the Claude Code plugin too
  --provider <p>                  (init) anthropic | openai | ollama
  --link                          (init) use file: deps against the local
                                    monorepo (dogfooding before publish)
  --global                        (claude-skill) install into ~/.claude/skills
  --dir <path>                    (claude-skill) project root (default cwd)

Eval options:
  --set <path|id>                 (eval, required) jsonl case bank file, or a
                                    stored set id (requires persistence)
  --target <id>                   (eval) agent id; required when >1 discovered
  --variant <label>                (eval) free A/B label -> eval_run.variant
  --split <train|dev|test>        (eval) filter cases to one split
  --allow-test                    (eval) opt in to running the held-out "test"
                                    split deliberately
  --gold <path>                   (eval) gold overlay file (file --set only)
  --db <path>                     (eval) SQLite file (default: the playground's
                                    events.db — AP_DB_PATH or XDG state)
  --judge                         (eval) add answer-quality graders: the
                                    deterministic set-membership scorer + the
                                    LLM judge (5-axis rubric) on the same runner
  --judge-model <id>               (eval) judge model id (default: AGENT_MODEL
                                    or the AGENT_TIER tier); honored when the
                                    runner resolves per-agent models
  --judge-thresholds <list>        (eval) comma list axis=n (0-5), axes:
                                    accuracy|completeness|grounding|
                                    hazard-avoidance|calibration|mean
                                    e.g. accuracy=3,grounding=3,mean=3.5

Eval exit codes: 0 gate pass · 1 gate failure · 2 usage/config error
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
      "no-dashboard": { type: "boolean" },
      "no-open": { type: "boolean" },
      agents: { type: "string" },
      "agents-dir": { type: "string" },
      context: { type: "string" },
      "with-plugin": { type: "boolean" },
      provider: { type: "string" },
      link: { type: "boolean" },
      global: { type: "boolean" },
      dir: { type: "string" },
      set: { type: "string" },
      target: { type: "string" },
      variant: { type: "string" },
      split: { type: "string" },
      "allow-test": { type: "boolean" },
      gold: { type: "string" },
      db: { type: "string" },
      judge: { type: "boolean" },
      "judge-model": { type: "string" },
      "judge-thresholds": { type: "string" },
      check: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const command = positionals[0];

  // `init` scaffolds a NEW project — it must NOT require an existing
  // package.json upward of CWD, so dispatch it before project context.
  if (command === "init") {
    const targetDir = positionals[1];
    const providerRaw = values.provider ? String(values.provider) : undefined;
    await runInitCommand({
      targetDir,
      withPlugin: Boolean(values["with-plugin"]),
      provider: providerRaw as Provider | undefined,
      link: Boolean(values.link),
    });
    return;
  }

  // `claude-skill` installs the bundled Claude Code skill(s) standalone — no
  // project context required, so dispatch it before resolveProjectConfig().
  if (command === "claude-skill") {
    await runClaudeSkillCommand({
      name: positionals[1],
      global: Boolean(values.global),
      targetDir: values.dir ? String(values.dir) : undefined,
    });
    return;
  }

  // `update` operates on the project's package.json + npm; it needs the project
  // root but NOT agent discovery, so dispatch it before project context.
  if (command === "update") {
    await runUpdateCommand({ check: Boolean(values.check || values["dry-run"]) });
    return;
  }

  // Project context — every other command needs it.
  const config = resolveProjectConfig();

  // Discovery override: `ap playground <dir>` (or `--agents-dir <dir>`)
  // treats <dir> AS the agents root and recursively finds every child agent
  // (`<domain>/agents/<name>/agent.ts` at any depth). Falls back to the project
  // root + the configured/`--agents` glob.
  const dirPositional = command === "playground" || command === "eval" ? positionals[1] : undefined;
  const agentsDir = values["agents-dir"] ? String(values["agents-dir"]) : dirPositional;
  const explicitGlob = values.agents ? [String(values.agents)] : undefined;

  const discoveryRoot = agentsDir ? path.resolve(process.cwd(), agentsDir) : config.root;
  const globs =
    explicitGlob ??
    (agentsDir ? ["**/agent.{ts,js,mjs}", "**/*.agent.{ts,js,mjs}"] : config.agents);
  const { agents: discovered, errors } = await discoverAgents(discoveryRoot, globs);
  // Slot provenance (preset/library/local/inline chips) — ONLY for the
  // playground, its sole consumer. Computing it dynamic-imports every library/
  // sibling module (executing their top-level code), which no other command
  // should ever pay for. Failure-isolated — attachProvenance warns and returns
  // the agents untouched if it blows up.
  const agents =
    command === "playground"
      ? await attachProvenance(
          discovered,
          discoveryRoot,
          config.roles ? { libraryGlobs: config.roles } : {},
        )
      : discovered;

  switch (command) {
    case undefined: {
      runStatusCommand({ config, agents, loadErrors: errors });
      return;
    }

    case "agents": {
      runAgentsCommand({ agents, loadErrors: errors, root: config.root });
      return;
    }

    case "run": {
      const agentId = positionals[1];
      if (!agentId) {
        process.stderr.write(`error: ap run requires an agent id\n${USAGE}\n`);
        process.exit(1);
      }
      const message = positionals.slice(2).join(" ") || undefined;
      const context = values.context ? String(values.context) : undefined;
      await runRunCommand({ agents, agentId, message, configRoot: config.root, context });
      return;
    }

    case "tools": {
      const subcommand = positionals[1];
      // Everything after `ap tools <sub>` is fair game for the dispatcher;
      // the per-tool flag set is unbounded and dynamic, so we hand the raw
      // argv tail to runToolsCommand for arg-shape walking.
      const toolPositionals = positionals.slice(2);
      await runToolsCommand({
        agents,
        subcommand,
        positionals: toolPositionals,
        argv: process.argv.slice(2),
      });
      return;
    }

    case "playground": {
      const port = values.port ? Number.parseInt(String(values.port), 10) : config.port;
      await runPlaygroundCommand({
        agents,
        port,
        noDashboard: Boolean(values["no-dashboard"]),
        open: !values["no-open"],
        configRoot: config.root,
      });
      return;
    }

    case "eval": {
      await runEvalCommand({
        agents,
        configRoot: config.root,
        set: values.set ? String(values.set) : undefined,
        gold: values.gold ? String(values.gold) : undefined,
        target: values.target ? String(values.target) : undefined,
        variant: values.variant ? String(values.variant) : undefined,
        split: values.split ? String(values.split) : undefined,
        allowTest: Boolean(values["allow-test"]),
        db: values.db ? String(values.db) : undefined,
        judge: Boolean(values.judge),
        judgeModel: values["judge-model"] ? String(values["judge-model"]) : undefined,
        judgeThresholds: values["judge-thresholds"]
          ? String(values["judge-thresholds"])
          : undefined,
      });
      return;
    }

    case "config": {
      const sub = positionals[1];
      if (sub === "set") {
        await runConfigSetCommand({ config });
      } else if (sub === undefined) {
        runConfigStatusCommand({ config });
      } else {
        process.stderr.write(`error: unknown config subcommand "${sub}"\n${USAGE}\n`);
        process.exit(1);
      }
      return;
    }

    default: {
      process.stderr.write(`error: unknown command "${command}"\n${USAGE}\n`);
      process.exit(1);
    }
  }
}

main()
  .then(async () => {
    // Passive out-of-date notice, printed AFTER the command's own output.
    // Skipped for `update` (redundant) and `init` (fresh project). Cached
    // ~24h on disk and fully failure-isolated — never blocks or breaks a run.
    const cmd = process.argv.slice(2).find((a) => !a.startsWith("-"));
    if (cmd === "update" || cmd === "init") return;
    const root = findProjectRoot();
    if (root) await notifyIfOutdated(root);
  })
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\x1b[31merror:\x1b[0m ${msg}\n`);
    process.exit(1);
  });
