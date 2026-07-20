/**
 * Regression lock for the v5 bank-mirror defense: `ap eval` file mode mirrors
 * the bank via create-if-missing, NOT a bare upsert — since schema v5,
 * `upsertEvalSet` rewrites `meta_json` on conflict (undefined -> NULL), so a
 * bare per-run upsert would silently wipe family meta set through the API
 * (`meta.family` is the load-bearing family identity per
 * `agent-dashboard/docs/eval-family-contract.md`).
 *
 * Lives in `agent-cli` because the hazard is the CLI's mirror call site
 * (`commands/eval.ts`), not the store: the store's full-replace semantics are
 * documented and separately tested in `agent-runtime`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentLike, EvalStore, MockRunner } from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runEvalCommand } from "../eval.js";

const MODEL = "meta-preserve-model";

function makeTarget(id: string): AgentLike {
  return {
    role: { name: id },
    getModel: () => MODEL,
    getTools: () => [],
    getSystemPrompt: () => "meta-preserve target",
    renderInitialPrompt: () => "meta-preserve target",
  };
}

function stubStdout() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

let dir: string;
let stdoutSpy: ReturnType<typeof stubStdout>;
let savedModel: string | undefined;

beforeEach(() => {
  savedModel = process.env.AGENT_MODEL;
  process.env.AGENT_MODEL = MODEL;
  process.exitCode = undefined;
  dir = mkdtempSync(join(tmpdir(), "ap-eval-meta-preserve-"));
  stdoutSpy = stubStdout();
});

afterEach(() => {
  stdoutSpy.mockRestore();
  process.exitCode = undefined;
  if (savedModel === undefined) delete process.env.AGENT_MODEL;
  else process.env.AGENT_MODEL = savedModel;
  rmSync(dir, { recursive: true, force: true });
});

it("file-mode bank mirror preserves eval_set meta set via the API (create-if-missing, no clobber)", async () => {
  const dbFile = join(dir, "events.db");
  // setId in file mode = the file's basename.
  const bankPath = join(dir, "meta-bank.jsonl");
  writeFileSync(
    bankPath,
    `${JSON.stringify({ id: "c1", input: "hello-input", expected: "hello-output" })}\n`,
  );

  // The set already exists WITH family meta (as PATCH /eval/sets/:id would leave it).
  const seed = new EvalStore({ path: dbFile, Database });
  seed.upsertEvalSet({ id: "meta-bank", name: "meta-bank", meta: { family: "answer-bank" } });
  seed.close();

  await runEvalCommand({
    agents: [{ id: "t", name: "t", agent: makeTarget("t"), file: "/virtual/t.ts" }],
    set: bankPath,
    db: dbFile,
    runner: new MockRunner().addResponse("hello-input", { content: "hello-output" }),
  });

  const store = new EvalStore({ path: dbFile, Database });
  try {
    const set = store.listEvalSets().find((s) => s.id === "meta-bank");
    expect(set).toBeDefined();
    // The regression: a bare per-run upsert would have rewritten meta_json to NULL.
    expect(set?.meta).toEqual({ family: "answer-bank" });
    // The mirror still did its job — the bank case landed in the store.
    expect(store.listEvalCases("meta-bank").map((c) => c.caseId)).toEqual(["c1"]);
    // And the run itself persisted.
    expect(store.listEvalRuns()).toHaveLength(1);
  } finally {
    store.close();
  }
});
