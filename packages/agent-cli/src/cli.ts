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
import { runConfigSetCommand, runConfigStatusCommand } from "./commands/config.js";
import { type Provider, runInitCommand } from "./commands/init.js";
import { runPlaygroundCommand } from "./commands/playground.js";
import { runRunCommand } from "./commands/run.js";
import { runStatusCommand } from "./commands/status.js";
import { runToolsCommand } from "./commands/tools.js";
import { resolveProjectConfig } from "./helpers/config.js";
import { discoverAgents } from "./helpers/discover.js";

const USAGE = `
ap — agentic patterns

Usage:
  ap                              status dashboard
  ap <command> [options]

Commands:
  agents                          list discovered agents
  run <agent> [message]           chat in terminal — interactive or one-shot
  tools list <agent>              list every tool exposed by an agent
  tools call <agent> <tool> ...   invoke a tool directly (no LLM in the loop)
  playground [<dir>]              launch UI environment (server + dashboard);
                                    point <dir> at an agents root to discover
                                    every child agent recursively
  init [<dir>]                    scaffold a new agent project
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
  --with-plugin                   (init) drop the Claude Code plugin too
  --provider <p>                  (init) anthropic | openai | ollama
  --link                          (init) use file: deps against the local
                                    monorepo (dogfooding before publish)
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
      "with-plugin": { type: "boolean" },
      provider: { type: "string" },
      link: { type: "boolean" },
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

  // Project context — every other command needs it.
  const config = resolveProjectConfig();

  // Discovery override: `ap playground <dir>` (or `--agents-dir <dir>`)
  // treats <dir> AS the agents root and recursively finds every child agent
  // (`<domain>/agents/<name>/agent.ts` at any depth). Falls back to the project
  // root + the configured/`--agents` glob.
  const dirPositional = command === "playground" ? positionals[1] : undefined;
  const agentsDir = values["agents-dir"] ? String(values["agents-dir"]) : dirPositional;
  const explicitGlob = values.agents ? [String(values.agents)] : undefined;

  const discoveryRoot = agentsDir ? path.resolve(process.cwd(), agentsDir) : config.root;
  const globs =
    explicitGlob ??
    (agentsDir ? ["**/agent.{ts,js,mjs}", "**/*.agent.{ts,js,mjs}"] : config.agents);
  const { agents, errors } = await discoverAgents(discoveryRoot, globs);

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
      await runRunCommand({ agents, agentId, message });
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

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\x1b[31merror:\x1b[0m ${msg}\n`);
  process.exit(1);
});
