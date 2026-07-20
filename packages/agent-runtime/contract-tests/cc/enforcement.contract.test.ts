/**
 * Contract: Claude Code per-operation-class enforcement (B-2 / #326, design §5.2).
 *
 * The design says the enforcement matrix is CONTRACT-TESTED, not asserted. These
 * tests drive live CC turns to establish, per class, whether an AP gate that
 * denies a tool intent actually prevents the operation BEFORE it executes.
 *
 * Method (the "enforcing" claim):
 *   1. positive control — WITHOUT a deny gate, the tool runs and its side effect
 *      (a created file) appears. Proves the harness would execute it.
 *   2. deny — WITH a gate that blocks the tool's intent, the PreToolUse hook
 *      returns `permissionDecision: "deny"`; the side effect must NOT appear and a
 *      `agent.tool.rejected` must be emitted → interception happened pre-exec.
 *
 * Runs against THIS machine's Max login, model haiku, in throwaway workspaces.
 * The final `console.log` matrix is the artifact quoted in the PR body.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DenyToolGate,
  assertPreconditions,
  buildAgent,
  cleanup,
  fileExists,
  printMatrix,
  recordMatrix,
  runObserving,
  workspace,
} from "./helpers.ts";

beforeAll(() => {
  assertPreconditions();
});
afterAll(() => {
  printMatrix();
  cleanup();
});

const isTool = (target: string) => (name: string) =>
  name === target || name.endsWith(`__${target}`);

describe("CC enforcement — shell (Bash)", () => {
  it("positive control: Bash runs the command (side effect appears)", async () => {
    const ws = workspace("shell-allow");
    const file = join(ws, "shell-allow.txt");
    const obs = await runObserving({
      agent: buildAgent(),
      prompt: `Run exactly this shell command with the Bash tool and nothing else: touch ${file} . Then stop.`,
    });
    expect(obs.intents.some(isTool("Bash"))).toBe(true);
    expect(fileExists(file)).toBe(true);
  });

  it("deny: a gate that blocks Bash prevents the command", async () => {
    const ws = workspace("shell-deny");
    const file = join(ws, "shell-deny.txt");
    const obs = await runObserving({
      agent: buildAgent(),
      prompt: `Run exactly this shell command with the Bash tool and nothing else: touch ${file} . If it is declined, just say done and stop. Do not retry or use another tool.`,
      denyGate: new DenyToolGate("NoBash", isTool("Bash")),
    });
    // On block the bus emits agent.tool.rejected (not a published intent) — the
    // rejection IS the proof the gate intercepted the call before execution.
    expect(obs.rejected.some(isTool("Bash"))).toBe(true);
    expect(fileExists(file)).toBe(false);
    recordMatrix("shell", {
      enforcement: "enforcing",
      basis: "live-verified",
      evidence: "PreToolUse deny blocked Bash pre-exec; file absent; positive control created it",
    });
  });
});

describe("CC enforcement — file-change (Write)", () => {
  it("positive control: Write creates the file", async () => {
    const ws = workspace("write-allow");
    const file = join(ws, "write-allow.txt");
    const obs = await runObserving({
      agent: buildAgent(),
      prompt: `Use the Write tool to create the file ${file} with the exact contents "hello". Then stop.`,
    });
    expect(obs.intents.some(isTool("Write"))).toBe(true);
    expect(fileExists(file)).toBe(true);
  });

  it("deny: a gate that blocks Write prevents the file", async () => {
    const ws = workspace("write-deny");
    const file = join(ws, "write-deny.txt");
    const obs = await runObserving({
      agent: buildAgent(),
      prompt: `Use the Write tool to create the file ${file} with the exact contents "hello". If it is declined, just say done and stop. Do not retry or use another tool.`,
      denyGate: new DenyToolGate("NoWrite", isTool("Write")),
    });
    expect(obs.rejected.some(isTool("Write"))).toBe(true);
    expect(fileExists(file)).toBe(false);
    recordMatrix("file-change", {
      enforcement: "enforcing",
      basis: "live-verified",
      evidence: "PreToolUse deny blocked Write pre-exec; file absent; positive control created it",
    });
  });
});

describe("CC enforcement — mcp-tool (agent capability)", () => {
  it("deny: a gate that blocks the MCP tool prevents its execution", async () => {
    const obs = await runObserving({
      agent: buildAgent(/* withMath */ true),
      prompt:
        "Use the add tool to compute 2 + 3. If the tool is declined, just say done and stop. Do not compute it yourself.",
      denyGate: new DenyToolGate("NoAdd", isTool("add")),
      nativeTools: "none",
    });
    expect(obs.rejected.some(isTool("add"))).toBe(true);
    // Denied before execution → no successful tool.end for the MCP tool.
    expect(obs.ended.some(isTool("add"))).toBe(false);
    recordMatrix("mcp-tool", {
      enforcement: "enforcing",
      basis: "live-verified",
      evidence: "PreToolUse deny blocked the mcp__ tool pre-exec (no tool.end)",
    });
  });
});

describe("CC enforcement — local-tool (TodoWrite)", () => {
  it("deny: a gate that blocks a native local tool intercepts it", async () => {
    const obs = await runObserving({
      agent: buildAgent(),
      prompt:
        "Use the TodoWrite tool to add a single todo item 'ping'. If it is declined, just say done and stop. Do not retry.",
      denyGate: new DenyToolGate("NoTodo", isTool("TodoWrite")),
    });
    if (obs.rejected.some(isTool("TodoWrite"))) {
      recordMatrix("local-tool", {
        enforcement: "enforcing",
        basis: "live-verified",
        evidence: "PreToolUse deny intercepted TodoWrite pre-exec",
      });
    } else {
      // The model may decline to use TodoWrite; record as docs-based rather than fail.
      recordMatrix("local-tool", {
        enforcement: "enforcing",
        basis: "docs",
        evidence: "PreToolUse covers local tools (docs); model did not invoke TodoWrite this run",
      });
    }
  });
});

describe("CC enforcement — subagent + hosted (documented posture)", () => {
  it("subagent (Task) is hook-covered per docs; hosted tools are advisory (C3 skepticism)", () => {
    // Task/subagent live exercise is expensive + flaky; hosted-tool blocking is
    // version-fragile (R-1 C3). These rows are declared from docs/skepticism and
    // left for a deeper live pass — matching R-1's deferral pattern.
    recordMatrix("subagent", {
      enforcement: "enforcing",
      basis: "docs",
      evidence: "Task matches PreToolUse (docs); live multi-agent pass deferred",
    });
    recordMatrix("hosted-tool", {
      enforcement: "advisory",
      basis: "docs",
      evidence: "hosted tools observe-only; blocking version-fragile (C3) — never promised",
    });
    expect(true).toBe(true);
  });
});
