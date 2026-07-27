/**
 * `ap config` (no args) — show env detection status.
 * `ap config set` — interactive .env editor.
 *
 * Mirrors the noun-as-status pattern: bare `config` reports state,
 * `config set` performs the action.
 */

import fs from "node:fs";
import path from "node:path";
import { isCancel, password, select, text } from "@clack/prompts";
import type { ProjectConfig } from "../helpers/config.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";

interface ConfigInput {
  config: ProjectConfig;
}

export interface EnvVarSpec {
  key: string;
  label: string;
  /** Should the value be hidden when prompting? */
  secret: boolean;
}

export const TRACKED_ENV: readonly EnvVarSpec[] = [
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", secret: true },
  { key: "OPENAI_API_KEY", label: "OpenAI API key", secret: true },
  { key: "GOOGLE_GENERATIVE_AI_API_KEY", label: "Google API key", secret: true },
  { key: "GROQ_API_KEY", label: "Groq API key", secret: true },
  { key: "MISTRAL_API_KEY", label: "Mistral API key", secret: true },
  { key: "XAI_API_KEY", label: "xAI API key", secret: true },
  { key: "DEEPSEEK_API_KEY", label: "DeepSeek API key", secret: true },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API key", secret: true },
  { key: "OLLAMA_HOST", label: "Ollama host URL", secret: false },
  // Gateway (Bifrost / any OpenAI-compatible endpoint). Setting AP_GATEWAY_BASE_URL
  // routes EVERY agent's declared model through the one gateway — createRunner's
  // envGateway() reads these (see providers/model-resolver.ts GatewayConfig).
  { key: "AP_GATEWAY_BASE_URL", label: "Gateway base URL (Bifrost, …/v1)", secret: false },
  { key: "AP_GATEWAY_API_KEY", label: "Gateway bearer key", secret: true },
  { key: "AP_GATEWAY_BASIC_USER", label: "Gateway HTTP Basic user", secret: false },
  { key: "AP_GATEWAY_BASIC_PASS", label: "Gateway HTTP Basic password", secret: true },
  {
    key: "AP_GATEWAY_MODEL_PREFIX",
    label: 'Gateway model prefix — literal (e.g. anthropic/) or "auto" (per-id vendor)',
    secret: false,
  },
  {
    key: "AP_GATEWAY_TIER_PROVIDER",
    label: "Gateway tier map for opus|sonnet|haiku (default anthropic)",
    secret: false,
  },
  { key: "AP_GATEWAY_VIRTUAL_KEY", label: "Bifrost virtual key (x-bf-vk)", secret: true },
  { key: "AP_GATEWAY_GUARDRAIL_IDS", label: "Bifrost guardrail ids (comma list)", secret: false },
  { key: "AGENT_TIER", label: "Default tier (opus | sonnet | haiku)", secret: false },
  { key: "AGENT_MODEL", label: "Pinned model id (overrides tier)", secret: false },
];

/** Bare `ap config` — show status. */
export function runConfigStatusCommand(input: ConfigInput): void {
  const { config } = input;
  const envFile = path.join(config.root, ".env");
  const envExists = fs.existsSync(envFile);

  process.stdout.write("\n");
  process.stdout.write(`  ${BOLD}config${RESET}\n\n`);
  process.stdout.write(
    `  .env       ${envExists ? `${GREEN}loaded${RESET} ${DIM}from ${path.relative(process.cwd(), envFile)}${RESET}` : `${DIM}not present${RESET}`}\n`,
  );

  const longestKey = Math.max(...TRACKED_ENV.map((e) => e.key.length));
  for (const spec of TRACKED_ENV) {
    const value = process.env[spec.key];
    const padded = spec.key.padEnd(longestKey);
    if (value) {
      const display = spec.secret ? maskSecret(value) : value;
      process.stdout.write(`  ${padded}  ${GREEN}✓${RESET}  ${DIM}${display}${RESET}\n`);
    } else {
      process.stdout.write(`  ${padded}  ${DIM}—  not set${RESET}\n`);
    }
  }
  process.stdout.write("\n");
  process.stdout.write(`  ${DIM}ap config set to edit interactively${RESET}\n\n`);
}

/** `ap config set` — interactive editor that writes to `.env`. */
export async function runConfigSetCommand(input: ConfigInput): Promise<void> {
  const { config } = input;
  const envFile = path.join(config.root, ".env");

  // Pick which var to set
  const choice = await select({
    message: "Which env var?",
    options: TRACKED_ENV.map((spec) => {
      const current = process.env[spec.key];
      const hint = current ? (spec.secret ? maskSecret(current) : current) : "not set";
      return {
        value: spec.key,
        label: spec.key,
        hint,
      };
    }),
  });

  if (isCancel(choice)) {
    process.stdout.write(`\n${DIM}cancelled${RESET}\n`);
    return;
  }

  const spec = TRACKED_ENV.find((e) => e.key === choice);
  if (!spec) return;

  const prompt = spec.secret ? password : text;
  const value = await prompt({
    message: `${spec.label} (${spec.key}):`,
    placeholder: process.env[spec.key] ?? "",
  });

  if (isCancel(value)) {
    process.stdout.write(`\n${DIM}cancelled${RESET}\n`);
    return;
  }

  upsertEnvFile(envFile, spec.key, String(value));
  process.stdout.write(
    `\n  ${GREEN}✓${RESET} wrote ${BOLD}${spec.key}${RESET} to ${path.relative(process.cwd(), envFile)}\n\n`,
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function maskSecret(v: string): string {
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 4)}${"•".repeat(Math.min(8, v.length - 8))}${v.slice(-4)}`;
}

/** Insert or replace a single KEY=VALUE line in the .env file. Creates if missing. */
export function upsertEnvFile(file: string, key: string, value: string): void {
  let lines: string[] = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, "utf-8").split("\n");
  }
  const prefix = `${key}=`;
  const idx = lines.findIndex((l) => l.trim().startsWith(prefix));
  const formatted = `${key}=${value}`;
  if (idx === -1) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push(formatted);
  } else {
    lines[idx] = formatted;
  }
  fs.writeFileSync(
    file,
    `${lines.filter((l, i, arr) => !(l === "" && i === arr.length - 1)).join("\n")}\n`,
  );

  // Reflect immediately in the current process's env so subsequent commands see it.
  if (!process.env[key] || process.env[key] !== value) {
    process.env[key] = value;
  }
}
