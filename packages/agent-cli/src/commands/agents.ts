/**
 * `ap agents` — full list of discovered agents.
 *
 * Verbose form of the bare `ap` status's `agents` row. Shows each agent's
 * id, name, source file, and (if present) description.
 */

import path from "node:path";
import type { DiscoveredAgent } from "../helpers/discover.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";

interface AgentsInput {
  agents: DiscoveredAgent[];
  loadErrors: { file: string; error: Error }[];
  root: string;
}

export function runAgentsCommand(input: AgentsInput): void {
  const { agents, loadErrors, root } = input;

  process.stdout.write("\n");

  if (agents.length === 0) {
    process.stdout.write(
      `  ${DIM}no agents discovered. Drop a file at ./agents/<name>/agent.ts that default-exports { id, name, agent }.${RESET}\n\n`,
    );
  } else {
    process.stdout.write(
      `  ${BOLD}${agents.length} agent${agents.length === 1 ? "" : "s"}${RESET}\n\n`,
    );
    const idCol = Math.max(...agents.map((a) => a.id.length), 8);
    for (const a of agents) {
      const rel = path.relative(root, a.file);
      process.stdout.write(`  ${a.id.padEnd(idCol)}  ${a.name}  ${DIM}${rel}${RESET}\n`);
      if (a.description) {
        process.stdout.write(`  ${"".padEnd(idCol)}  ${DIM}${a.description}${RESET}\n`);
      }
    }
    process.stdout.write("\n");
  }

  if (loadErrors.length > 0) {
    process.stdout.write(`  ${YELLOW}${loadErrors.length} load error(s):${RESET}\n`);
    for (const err of loadErrors) {
      process.stdout.write(`    ${YELLOW}!${RESET} ${err.file}: ${err.error.message}\n`);
    }
    process.stdout.write("\n");
  }
}
