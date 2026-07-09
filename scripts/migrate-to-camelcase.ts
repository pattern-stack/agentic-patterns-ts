#!/usr/bin/env bun
/**
 * Migration helper for the 0.9.0 core rename: snake_case atom schema keys ->
 * camelCase, and the legacy prompt methods -> their replacements.
 *
 * Usage:
 *   bun scripts/migrate-to-camelcase.ts --keys [--methods] [--write] <path...>
 *
 * Modes (at least one required):
 *   --keys      rename the 21 atom schema keys (escalation_triggers -> escalationTriggers, ...)
 *   --methods   rename getSystemPrompt -> renderInitialPrompt, renderSystemPrompt -> toPrompt
 *
 * Dry-run by default: prints every match as `file:line: old -> new`. Pass
 * --write to apply in place. Targets may be files or directories; directories
 * are walked recursively for .ts/.tsx/.mjs/.md files, skipping node_modules,
 * dist, build, coverage, and .git.
 *
 * Deliberately NOT renamed: `input_schema` (Anthropic Messages API tool wire
 * format, see packages/agent-core/src/molecules/tool-schema.ts) — it is not in
 * the key map.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

const KEY_RENAMES: Record<string, string> = {
  nats_url: "natsUrl",
  agent_definition_id: "agentDefinitionId",
  max_turns: "maxTurns",
  is_coordinator: "isCoordinator",
  env_vars: "envVars",
  success_criteria: "successCriteria",
  output_schema: "outputSchema",
  strict_output: "strictOutput",
  escalation_triggers: "escalationTriggers",
  anti_patterns: "antiPatterns",
  access_method: "accessMethod",
  exploration_capabilities: "explorationCapabilities",
  team_context: "teamContext",
  project_context: "projectContext",
  current_state: "currentState",
  resource_profile: "resourceProfile",
  workspace_id: "workspaceId",
  inter_agency_transport: "interAgencyTransport",
  accumulated_context: "accumulatedContext",
  last_action: "lastAction",
  max_attempts: "maxAttempts",
};

const METHOD_RENAMES: Record<string, string> = {
  getSystemPrompt: "renderInitialPrompt",
  renderSystemPrompt: "toPrompt",
};

const EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".md"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
const SELF = basename(import.meta.path);

function collectFiles(target: string, out: string[]): void {
  const stat = statSync(target);
  if (stat.isFile()) {
    if (EXTENSIONS.has(extname(target)) && basename(target) !== SELF) {
      out.push(target);
    }
    return;
  }
  for (const entry of readdirSync(target)) {
    if (SKIP_DIRS.has(entry)) continue;
    collectFiles(join(target, entry), out);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const useKeys = args.includes("--keys");
  const useMethods = args.includes("--methods");
  const targets = args.filter((a) => !a.startsWith("--"));

  if ((!useKeys && !useMethods) || targets.length === 0) {
    console.error(
      "Usage: bun scripts/migrate-to-camelcase.ts --keys [--methods] [--write] <path...>",
    );
    process.exit(1);
  }

  const renames: Array<[RegExp, string, string]> = [];
  const active = {
    ...(useKeys ? KEY_RENAMES : {}),
    ...(useMethods ? METHOD_RENAMES : {}),
  };
  for (const [from, to] of Object.entries(active)) {
    renames.push([new RegExp(`\\b${from}\\b`, "g"), from, to]);
  }

  const files: string[] = [];
  for (const target of targets) {
    collectFiles(target, files);
  }

  let totalMatches = 0;
  let changedFiles = 0;
  for (const file of files) {
    const original = readFileSync(file, "utf8");
    let updated = original;
    const hits: string[] = [];
    for (const [pattern, from, to] of renames) {
      const lines = updated.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined && pattern.test(line)) {
          pattern.lastIndex = 0;
          hits.push(`  ${file}:${i + 1}: ${from} -> ${to}`);
        }
        pattern.lastIndex = 0;
      }
      updated = updated.replace(pattern, to);
    }
    if (updated === original) continue;
    changedFiles++;
    totalMatches += hits.length;
    console.log(hits.join("\n"));
    if (write) {
      writeFileSync(file, updated);
    }
  }

  const action = write ? "rewrote" : "would rewrite";
  console.log(`\n${action} ${totalMatches} line(s) across ${changedFiles} file(s).`);
  if (!write && changedFiles > 0) {
    console.log("Dry run — pass --write to apply.");
  }
}

main();
