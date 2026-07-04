/**
 * `ap update` — bring the project's `@agentic-patterns/*` dependencies up to the
 * latest published versions.
 *
 *   ap update            update every behind @agentic-patterns/* dep to latest
 *   ap update --check    report only (no changes); exit 1 if any are behind
 *
 * Uses the project's own package manager (detected from the lockfile) so it
 * respects bun/pnpm/yarn/npm without imposing one. `--check` is CI-friendly:
 * a non-zero exit means "you're behind", the same contract as `npm outdated`.
 */

import { spawnSync } from "node:child_process";
import { findProjectRoot } from "../helpers/config.js";
import {
  type DepStatus,
  detectPackageManager,
  installLatestArgv,
  resolveDepStatuses,
} from "../helpers/versions.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function renderTable(statuses: readonly DepStatus[]): void {
  const nameW = Math.max(...statuses.map((s) => s.name.length), 8);
  const curW = Math.max(...statuses.map((s) => (s.installed ?? "—").length), 7);
  for (const s of statuses) {
    const cur = s.installed ?? "—";
    const latest = s.latest ?? "?";
    const mark = s.behind ? yellow("⬆ behind") : s.latest === null ? dim("? offline") : green("✓ latest");
    process.stdout.write(
      `  ${s.name.padEnd(nameW)}  ${dim(cur.padStart(curW))} → ${(s.behind ? yellow(latest) : dim(latest)).padEnd(6)}  ${mark}\n`,
    );
  }
}

export interface UpdateCommandOptions {
  /** Report only; make no changes. Exit 1 if any dep is behind. */
  readonly check?: boolean;
}

export async function runUpdateCommand(opts: UpdateCommandOptions = {}): Promise<void> {
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write(`${red("error:")} no package.json found up from the current directory\n`);
    process.exit(2);
  }

  process.stdout.write(`\nChecking ${green("@agentic-patterns/*")} versions…\n\n`);
  const statuses = await resolveDepStatuses(root);

  if (statuses.length === 0) {
    process.stdout.write(dim("  no @agentic-patterns/* dependencies in this project\n\n"));
    return;
  }

  renderTable(statuses);

  const behind = statuses.filter((s) => s.behind);
  const offline = statuses.some((s) => s.latest === null);

  if (behind.length === 0) {
    const tail = offline ? dim(" (some latest versions unknown — offline?)") : "";
    process.stdout.write(`\n${green("✓")} all up to date${tail}\n\n`);
    return;
  }

  // --check: report + CI-friendly exit code, no mutation.
  if (opts.check) {
    process.stdout.write(
      `\n${yellow(`${behind.length} package(s) behind`)} — run ${green("ap update")} to upgrade\n\n`,
    );
    process.exit(1);
  }

  // Mutate: hand the pinned specs to the project's package manager.
  const pm = detectPackageManager(root);
  const specs = behind.map((s) => `${s.name}@${s.latest}`);
  const argv = installLatestArgv(pm, specs);
  process.stdout.write(`\nUpdating ${behind.length} package(s) via ${green(pm)}:\n  ${dim(`${pm} ${argv.join(" ")}`)}\n\n`);

  const res = spawnSync(pm, argv, { cwd: root, stdio: "inherit" });
  if (res.status !== 0) {
    process.stderr.write(`\n${red("error:")} ${pm} exited with code ${res.status ?? "unknown"}\n`);
    process.exit(res.status ?? 1);
  }
  process.stdout.write(`\n${green("✓")} updated ${behind.map((s) => s.name.replace("@agentic-patterns/", "")).join(", ")} to latest\n\n`);
}
