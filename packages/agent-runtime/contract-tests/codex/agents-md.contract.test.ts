/**
 * Contract: AGENTS.md composition order (#321, design §5.5).
 *
 * Facts pinned here (verified 2026-07-19 on codex-cli 0.144.6):
 * - Global `CODEX_HOME/AGENTS.md` loads FIRST; project files from repo root
 *   down to cwd load after (closer files later). The composed text is recorded
 *   deterministically in the thread's rollout file (`thread.path` from
 *   thread/start) as a `world_state` entry: `payload.state.agents_md.text`,
 *   with a `--- project-doc ---` separator between the global part and the
 *   project chain.
 * - Because repository AGENTS.md files are discovered below the working tree
 *   regardless of CODEX_HOME, CODEX_HOME is NOT a complete isolation boundary
 *   (workspace control is part of "fresh session" semantics).
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertPreconditions,
  cleanupTestRoot,
  freshHome,
  freshWorkspace,
  runTurn,
  startSession,
} from "./helpers.ts";

beforeAll(() => {
  assertPreconditions();
});
afterAll(() => {
  cleanupTestRoot();
});

describe("AGENTS.md composition", () => {
  it("global loads first, then repo-root, then cwd-closest", async () => {
    const home = freshHome("agentsmd");
    const ws = freshWorkspace("agentsmd");
    execSync("git init -q .", { cwd: ws });
    writeFileSync(join(home, "AGENTS.md"), "MARKER-GLOBAL-A7: global instructions.\n");
    writeFileSync(join(ws, "AGENTS.md"), "MARKER-ROOT-B8: repo-root instructions.\n");
    mkdirSync(join(ws, "sub"));
    writeFileSync(join(ws, "sub", "AGENTS.md"), "MARKER-SUB-C9: subdir instructions.\n");

    const client = new (await import("./driver.ts")).AppServerClient({
      codexHome: home,
      cwd: join(ws, "sub"),
    });
    try {
      await client.initialize();
      const started = (await client.request("thread/start", {
        cwd: join(ws, "sub"),
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      })) as { thread: { id: string; path: string } };

      // a turn must run for the world_state to be recorded
      await runTurn(
        client,
        started.thread.id,
        "Reply with the single word: ok. Do not run any commands.",
      );

      const rollout = readFileSync(started.thread.path, "utf8");
      const worldState = rollout
        .split("\n")
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as {
              type: string;
              payload?: { state?: { agents_md?: { text: string } } };
            },
        )
        .find((e) => e.type === "world_state" && e.payload?.state?.agents_md);
      expect(worldState, "world_state entry with agents_md in rollout").toBeDefined();

      const text = worldState?.payload?.state?.agents_md?.text ?? "";
      const posGlobal = text.indexOf("MARKER-GLOBAL-A7");
      const posRoot = text.indexOf("MARKER-ROOT-B8");
      const posSub = text.indexOf("MARKER-SUB-C9");
      expect(posGlobal).toBeGreaterThanOrEqual(0);
      expect(posRoot).toBeGreaterThan(posGlobal);
      expect(posSub).toBeGreaterThan(posRoot);
      // global vs project chain separator
      expect(text).toContain("--- project-doc ---");
      // repo AGENTS.md leaked into an isolated CODEX_HOME session — CODEX_HOME
      // alone is not an isolation boundary
      expect(posRoot).toBeGreaterThan(-1);
    } finally {
      await client.close();
    }
  });
});
