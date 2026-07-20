/**
 * Seed one realistic eval run per family (renderer / sdc / curation) plus the
 * answer-bank + question-bundle sets — demo/dev data for the dashboard's
 * family screens. Deterministic and idempotent (re-running fully replaces the
 * same rows; see `src/eval-seed/seed-eval-families.ts`).
 *
 * Run from the REPO ROOT so the workspace runtime resolves (a stray external
 * runtime can write a wrong-schema db):
 *
 *   bun run packages/agent-cli/scripts/seed-eval-families.ts                # default db
 *   bun run packages/agent-cli/scripts/seed-eval-families.ts --db /tmp/e.db # explicit db
 *
 * Default db = `AP_DB_PATH` env override, else `XDG_STATE_HOME|~/.local/state`
 * + `/ap/events.db` (the same file `ap playground` reads). View the result:
 *
 *   bun run packages/agent-cli/src/cli.ts playground --db <db>
 *
 * Uses `loadEvalStore` (not better-sqlite3 directly): better-sqlite3 imports
 * under Bun but throws at `new Database()`, so the loader picks bun:sqlite
 * under Bun and better-sqlite3 under Node.
 */

import { loadEvalStore } from "@agentic-patterns/runtime";
import { seedEvalFamilies } from "../src/eval-seed/seed-eval-families.js";
import { ensureParentDir, resolveDbPath } from "../src/helpers/db.js";

function parseDbArg(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        console.error("--db requires a path argument");
        process.exit(1);
      }
      return value;
    }
  }
  return resolveDbPath();
}

const dbPath = parseDbArg(process.argv.slice(2));
ensureParentDir(dbPath);

const { store, unavailable, reason } = await loadEvalStore({ path: dbPath });
if (unavailable || !store) {
  console.error(`seed-eval-families: no SQLite driver available — ${reason}`);
  process.exit(1);
}

try {
  const summary = seedEvalFamilies(store);
  console.log(`seeded ${dbPath}`);
  for (const s of summary.sets) {
    console.log(`  set ${s.id} (${s.family}) — ${s.cases} cases`);
  }
  for (const r of summary.runs) {
    console.log(`  run ${r.id} (${r.family}) — ${r.results} results`);
  }
} finally {
  store.close();
}
