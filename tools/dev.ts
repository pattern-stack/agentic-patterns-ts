#!/usr/bin/env tsx
/**
 * Dev orchestrator — pts-shape lifecycle for this monorepo.
 *
 * Ported in spirit from pattern-stack/tools/cli's `AppManager`:
 *   • Each app is spawned as a child process, stdout/stderr piped back
 *     through a colored per-process prefix so logs interleave cleanly.
 *   • A single SIGINT/SIGTERM handler kicks off graceful shutdown:
 *     SIGTERM to every child, wait up to 1s, SIGKILL any survivors.
 *   • If any child exits on its own, we shut down the siblings too so
 *     the user never has a half-dead dev environment.
 *
 * Kept minimal on purpose — no PID file, no project registry, no port
 * offsetting. Add those if we grow beyond "server + dashboard".
 *
 * Run:  pnpm dev  (from repo root — see root package.json)
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";

interface AppSpec {
  readonly name: string;
  /** ANSI color code, e.g. "36" for cyan. */
  readonly color: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

interface ProcessInfo {
  readonly spec: AppSpec;
  readonly proc: ChildProcess;
  readonly pid: number;
}

// ---------------------------------------------------------------------------
// Configuration — which processes `pnpm dev` launches.
// Kept inline; graduates to patterns.yaml-style config if the list grows.
// ---------------------------------------------------------------------------

const APPS: readonly AppSpec[] = [
  {
    name: "server",
    color: "36", // cyan
    command: "pnpm",
    args: ["--silent", "--filter", "@agentic-patterns/server", "dev"],
  },
  {
    name: "dashboard",
    color: "35", // magenta
    command: "pnpm",
    args: ["--silent", "--filter", "@agentic-patterns/dashboard", "dev"],
  },
];

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

class Orchestrator {
  private readonly processes: ProcessInfo[] = [];
  private cleanedUp = false;

  start(apps: readonly AppSpec[]): void {
    this.installSignalHandlers();

    // Build workspace packages so dist/ is current before tsx resolves
    // @agentic-patterns/* imports. Fast if nothing changed (tsup caches).
    process.stdout.write("\x1b[2mbuilding packages...\x1b[0m\n");
    execSync("pnpm --silent build", { stdio: "inherit" });

    for (const app of apps) {
      this.processes.push(this.spawnApp(app));
    }
    this.printBanner();
  }

  private spawnApp(spec: AppSpec): ProcessInfo {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk) => this.writeLines(spec, chunk));
    child.stderr?.on("data", (chunk) => this.writeLines(spec, chunk));

    child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this.log(spec, `exited (${reason})`);
      if (!this.cleanedUp) {
        // Any single app dying brings the environment down — don't leave
        // a half-dead dev session to debug later.
        this.cleanup(`${spec.name} exited`).then(() => process.exit(code ?? 1));
      }
    });

    return { spec, proc: child, pid: child.pid ?? -1 };
  }

  private writeLines(spec: AppSpec, chunk: Buffer): void {
    const prefix = `\x1b[${spec.color}m[${spec.name.padEnd(9)}]\x1b[0m `;
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      if (line.length > 0) process.stdout.write(`${prefix}${line}\n`);
    }
  }

  private log(spec: AppSpec, msg: string): void {
    process.stdout.write(`\x1b[${spec.color}m[${spec.name.padEnd(9)}]\x1b[0m ${msg}\n`);
  }

  private printBanner(): void {
    process.stdout.write("\n\x1b[1magentic-patterns-ts — dev environment\x1b[0m\n\n");
    for (const p of this.processes) {
      this.log(p.spec, `running (pid ${p.pid})`);
    }
    process.stdout.write("\n  \x1b[2mCtrl+C to stop all services\x1b[0m\n\n");
  }

  private installSignalHandlers(): void {
    const handler = (signal: NodeJS.Signals) => {
      process.stdout.write(`\n\x1b[33mreceived ${signal}, stopping…\x1b[0m\n`);
      this.cleanup(signal).then(() => process.exit(0));
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  }

  private async cleanup(reason: string): Promise<void> {
    if (this.cleanedUp) return;
    this.cleanedUp = true;

    // Phase 1: SIGTERM to everyone still alive.
    for (const { proc, spec } of this.processes) {
      if (proc.exitCode === null) {
        this.log(spec, `terminating (${reason})`);
        proc.kill("SIGTERM");
      }
    }

    // Phase 2: wait up to 1s, then SIGKILL stragglers.
    await new Promise((r) => setTimeout(r, 1000));
    for (const { proc, spec } of this.processes) {
      if (proc.exitCode === null) {
        this.log(spec, "still alive, killing");
        proc.kill("SIGKILL");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

new Orchestrator().start(APPS);
