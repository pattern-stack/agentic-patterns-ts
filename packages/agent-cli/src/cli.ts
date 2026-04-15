/**
 * `ap` — agentic patterns CLI.
 *
 * Single-dispatch shape (mirrors codegen-patterns/cli.ts):
 *   parseArgs → switch(command) → run<Name>Command(...).
 *
 * Bare `ap` shows a status dashboard (mirrors `st`).
 */

import { parseArgs } from "node:util";
import { runAgentsCommand } from "./commands/agents.js";
import { runConfigSetCommand, runConfigStatusCommand } from "./commands/config.js";
import { runPlaygroundCommand } from "./commands/playground.js";
import { runRunCommand } from "./commands/run.js";
import { runStatusCommand } from "./commands/status.js";
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
  playground                      launch UI environment (server + dashboard)
  config                          show env detection status
  config set                      interactive .env editor

Options:
  -h, --help                      show this help
  --port <port>                   server port for playground (default 3000)
  --no-dashboard                  playground without dashboard (API only)
  --no-open                       don't auto-open the browser
  --agents <glob>                 override agent discovery glob
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
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const command = positionals[0];

  // Project context — every command except --help needs it.
  const config = resolveProjectConfig();
  const globs = values.agents ? [String(values.agents)] : config.agents;
  const { agents, errors } = await discoverAgents(config.root, globs);

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
