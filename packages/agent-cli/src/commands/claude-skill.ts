/**
 * `ap claude-skill [<name>] [--global] [--dir <path>]`
 *
 * Installs the framework's bundled Claude Code skill(s) — the ones shipped in
 * the CLI's plugin-template `skills/` (today: `build-on-agentic-patterns`) —
 * into a `.claude/skills/` directory, WITHOUT scaffolding a project. This is the
 * standalone counterpart to `ap init --with-plugin`, which only installs skills
 * as a side effect of creating a new project.
 *
 * Targets:
 *   default      ./.claude/skills/      (project-local — picked up by Claude
 *                                        Code sessions started in this dir)
 *   --global     ~/.claude/skills/      (user-level — available everywhere)
 *   --dir <p>    <p>/.claude/skills/    (explicit project root)
 *
 * Name positional installs ONE skill; omit it to install all bundled skills.
 * Copies overwrite, so re-running upgrades an installed skill in place.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyDir, resolvePluginSource } from "./init.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export interface ClaudeSkillOptions {
  /** Install a single named skill; omit to install all bundled skills. */
  name?: string;
  /** Install into ~/.claude/skills instead of the project-local dir. */
  global?: boolean;
  /** Explicit project root (default: cwd). Ignored when `global` is set. */
  targetDir?: string;
}

export async function runClaudeSkillCommand(opts: ClaudeSkillOptions): Promise<void> {
  const src = resolvePluginSource();
  if (!src?.skillsDir || !fs.existsSync(src.skillsDir)) {
    process.stderr.write(
      `${YELLOW}error${RESET}: bundled skills not found.\n` +
        `   ${DIM}Install the published CLI (npm i -g @pattern-stack/agentic-cli) or run from the source tree.${RESET}\n`,
    );
    process.exit(1);
  }

  const available = fs
    .readdirSync(src.skillsDir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && fs.existsSync(path.join(src.skillsDir as string, d.name, "SKILL.md")),
    )
    .map((d) => d.name)
    .sort();

  if (available.length === 0) {
    process.stderr.write(`${YELLOW}error${RESET}: no skills available to install.\n`);
    process.exit(1);
  }

  let toInstall = available;
  if (opts.name) {
    if (!available.includes(opts.name)) {
      process.stderr.write(
        `${YELLOW}error${RESET}: unknown skill "${opts.name}".\n` +
          `   ${DIM}available:${RESET} ${available.join(", ")}\n`,
      );
      process.exit(1);
    }
    toInstall = [opts.name];
  }

  const skillsRoot = opts.global
    ? path.join(os.homedir(), ".claude", "skills")
    : path.join(path.resolve(process.cwd(), opts.targetDir ?? "."), ".claude", "skills");

  fs.mkdirSync(skillsRoot, { recursive: true });
  for (const name of toInstall) {
    copyDir(path.join(src.skillsDir, name), path.join(skillsRoot, name));
  }

  let where: string;
  if (opts.global) {
    where = "~/.claude/skills";
  } else {
    const rel = path.relative(process.cwd(), skillsRoot);
    // A `..`-escaping relative path is noisier than the absolute one.
    where = !rel || rel.startsWith("..") ? skillsRoot : rel;
  }
  process.stdout.write(
    `\n  ${GREEN}installed${RESET} ${BOLD}${toInstall.length}${RESET} skill(s) → ${BOLD}${where}${RESET}\n\n`,
  );
  for (const name of toInstall) {
    process.stdout.write(`    ${DIM}+ ${name}${RESET}\n`);
  }
  process.stdout.write(`\n  ${BOLD}next${RESET}\n`);
  if (opts.global) {
    process.stdout.write(
      `    ${DIM}available in every Claude Code session — invoke with /${toInstall[0]}${RESET}\n\n`,
    );
  } else {
    process.stdout.write(
      `    ${DIM}start Claude Code in this directory; invoke with /${toInstall[0]}${RESET}\n` +
        `    ${DIM}(use --global to install into ~/.claude/skills for all sessions)${RESET}\n\n`,
    );
  }
}
