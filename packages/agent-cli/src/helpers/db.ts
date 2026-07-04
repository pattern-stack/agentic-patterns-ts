/**
 * Shared SQLite db-path discipline — `resolveDbPath()` / `ensureParentDir()`.
 *
 * Extracted verbatim from `commands/playground.ts` (spec `.ai-docs/stacks/
 * eval-surface/specs/135.md` § Step 5) so `ap eval` shares the exact same
 * default file location as the playground rather than forking it: one
 * `events.db`, three store layers (EventStore / RunStore / EvalStore) — eval
 * runs land in the SAME file the playground dashboard reads.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** `AP_DB_PATH` env override, else `XDG_STATE_HOME|~/.local/state` + `/ap/events.db`. */
export function resolveDbPath(): string {
  if (process.env.AP_DB_PATH) return process.env.AP_DB_PATH;
  const base = process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
  return path.join(base, "ap", "events.db");
}

/** Best-effort mkdir -p of the db file's parent directory. */
export function ensureParentDir(filePath: string): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // Best effort — EventStore will surface the real error if open fails.
  }
}
