import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRunStore } from "../load.js";
import { RunStore } from "../run-store.js";

/**
 * Open-time orphan sweep (#495).
 *
 * `sweepRunning()` had exactly one call site — the CLI playground — so the
 * server and every other `load*` consumer left rows stuck `'running'` forever
 * after a crash, while three comments in the tree promised "the next boot's
 * sweepRunning()". The sweep now lives in the loaders, the seam every consumer
 * already goes through.
 */
describe("loadRunStore — open-time orphan sweep (#495)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ap-sweep-"));
    dbPath = join(dir, "events.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Leave one run stuck `'running'`, as a process that died mid-run would. */
  async function seedOrphan(): Promise<string> {
    const { default: Database } = await import("better-sqlite3");
    const store = new RunStore({ path: dbPath, Database: Database as never });
    const runId = store.startRun();
    store.close?.();
    return runId;
  }

  it("closes out an orphaned 'running' row and reports the count", async () => {
    const runId = await seedOrphan();

    const result = await loadRunStore({ path: dbPath });

    expect(result.unavailable).toBe(false);
    expect(result.swept).toBe(1);
    const run = result.store?.getRun(runId);
    expect(run?.status).toBe("error");
    expect(run?.error).toBeTruthy();
    result.store?.close?.();
  });

  it("sweepOnOpen: false leaves the orphan untouched", async () => {
    const runId = await seedOrphan();

    const result = await loadRunStore({ path: dbPath, sweepOnOpen: false });

    expect(result.swept).toBe(0);
    expect(result.store?.getRun(runId)?.status).toBe("running");
    result.store?.close?.();
  });

  it("reports 0 when there is nothing to sweep", async () => {
    const { default: Database } = await import("better-sqlite3");
    const seed = new RunStore({ path: dbPath, Database: Database as never });
    seed.close?.();

    const result = await loadRunStore({ path: dbPath });

    expect(result.swept).toBe(0);
    result.store?.close?.();
  });
});
