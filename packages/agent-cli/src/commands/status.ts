/**
 * `ap` (no args) — status dashboard.
 *
 * Mirrors `st`'s bare-command pattern: print a compact overview of what's
 * discovered, which runner the env will pick, and a few hint actions.
 */

import path from "node:path";
import type { ProjectConfig } from "../helpers/config.js";
import type { DiscoveredAgent } from "../helpers/discover.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

interface StatusInput {
  config: ProjectConfig;
  agents: DiscoveredAgent[];
  loadErrors: { file: string; error: Error }[];
}

interface RunnerHint {
  provider: string;
  detail: string;
}

/** Print the bare-`ap` dashboard. */
export function runStatusCommand(input: StatusInput): void {
  const { config, agents, loadErrors } = input;
  const runner = detectRunnerFromEnv();

  const lines: string[] = [];
  lines.push("");
  lines.push(`${BOLD}agentic-patterns${RESET}`);
  lines.push("");
  lines.push(formatAgentsRow(agents, config.root));
  for (const a of agents) {
    lines.push(`            ${GREEN}●${RESET} ${a.id}`);
  }
  if (loadErrors.length > 0) {
    for (const err of loadErrors) {
      lines.push(`            ${YELLOW}!${RESET} ${err.file}: ${err.error.message}`);
    }
  }
  lines.push(`  runner    ${runner.provider}  ${DIM}(${runner.detail})${RESET}`);
  lines.push(`  config    ${formatConfigRow(config)}`);
  lines.push("");
  lines.push(`  ${DIM}ap run <agent> · ap playground · ap -h${RESET}`);
  lines.push("");

  process.stdout.write(`${lines.join("\n")}\n`);
}

function formatAgentsRow(agents: DiscoveredAgent[], root: string): string {
  const count = agents.length;
  if (count === 0) {
    return `  agents    ${DIM}none discovered (looked in ${path.relative(process.cwd(), root) || "."}/agents/)${RESET}`;
  }
  return `  agents    ${count} discovered  ${DIM}(./agents/)${RESET}`;
}

function formatConfigRow(config: ProjectConfig): string {
  const parts: string[] = [];
  if (config.hasManifest) parts.push("package.json overrides");
  parts.push("see ap config");
  return parts.join(" · ");
}

function detectRunnerFromEnv(): RunnerHint {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", detail: "env ANTHROPIC_API_KEY → claude-sonnet-4-5" };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", detail: "env OPENAI_API_KEY → gpt-4o" };
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY) {
    return { provider: "google", detail: "env GOOGLE_*_API_KEY → gemini-2.5-flash" };
  }
  if (process.env.OLLAMA_HOST) {
    const tier = (process.env.AGENT_TIER ?? "sonnet") as "opus" | "sonnet" | "haiku";
    const model = tier === "opus" ? "qwen3:30b-a3b" : tier === "haiku" ? "qwen3:4b" : "qwen3:14b";
    return {
      provider: "ollama",
      detail: `env OLLAMA_HOST → ${model} (tier=${tier})`,
    };
  }
  return {
    provider: `${YELLOW}none${RESET}`,
    detail: "set ANTHROPIC_API_KEY, OLLAMA_HOST, or have `claude` CLI on PATH",
  };
}
