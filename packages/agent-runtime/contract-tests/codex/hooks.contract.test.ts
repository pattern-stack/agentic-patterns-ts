/**
 * Contract: PreToolUse/PostToolUse hook coverage — Codex's inspection seam for
 * AP gates (#321, design §5.2/§5.4 "PreToolUse mechanism as the inspection seam").
 *
 * Facts pinned here (verified 2026-07-19 on codex-cli 0.144.6):
 * - Hook config: `CODEX_HOME/hooks.json` (user layer). Non-managed command
 *   hooks require interactive trust; `codex exec --dangerously-bypass-hook-trust`
 *   is the automation seam. `codex app-server` does NOT accept that flag —
 *   programmatic app-server hook use requires pre-established trust (R1b).
 * - PreToolUse fires for: shell (tool_name "Bash"), apply_patch, local
 *   function tools (update_plan), and — in 0.144.6 — web search via local
 *   tool "webrun" (the docs' hosted-tool exclusion did not hold for the
 *   web_search item in this build).
 * - PreToolUse deny (hookSpecificOutput.permissionDecision: "deny") blocks
 *   execution BEFORE it happens (enforcing, not advisory).
 * - PreToolUse allow + updatedInput rewrites the command (inputRewrite seam).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPreconditions, cleanupTestRoot, freshHome, freshWorkspace } from "./helpers.ts";

beforeAll(() => {
  assertPreconditions();
});
afterAll(() => {
  cleanupTestRoot();
});

function setupHookedHome(name: string): { home: string; hookLog: string } {
  const home = freshHome(name);
  const hookLog = join(home, "hooklog.jsonl");
  const script = join(home, "hookscript.py");
  writeFileSync(
    script,
    `import sys, json
data = json.load(sys.stdin)
with open(${JSON.stringify(hookLog)}, "a") as f:
    f.write(json.dumps(data) + "\\n")
cmd = ""
ti = data.get("tool_input") or {}
if isinstance(ti, dict):
    cmd = str(ti.get("command", ""))
if data.get("hook_event_name") == "PreToolUse":
    if "BLOCKME" in cmd:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "blocked by contract-test hook"}}))
        sys.exit(0)
    if "REWRITEME" in cmd:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": {"command": "echo REWRITTEN-BY-HOOK"}}}))
        sys.exit(0)
sys.exit(0)
`,
  );
  const hook = { type: "command", command: `python3 ${script}`, timeout: 30 };
  writeFileSync(
    join(home, "hooks.json"),
    JSON.stringify(
      { hooks: { PreToolUse: [{ hooks: [hook] }], PostToolUse: [{ hooks: [hook] }] } },
      null,
      2,
    ),
  );
  return { home, hookLog };
}

function execCodex(home: string, ws: string, prompt: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    "codex",
    [
      "exec",
      "--dangerously-bypass-hook-trust",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      ws,
      prompt,
    ],
    { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 240_000 },
  );
}

function readHookLog(
  hookLog: string,
): Array<{ hook_event_name: string; tool_name?: string; tool_input?: Record<string, unknown> }> {
  let raw = "";
  try {
    raw = readFileSync(hookLog, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("PreToolUse/PostToolUse hook coverage (via codex exec)", () => {
  it("covers shell, apply_patch, and local function tools", () => {
    const { home, hookLog } = setupHookedHome("hooks-cover");
    const ws = freshWorkspace("hooks-cover");
    mkdirSync(join(ws, ".keep-dir"), { recursive: true });
    const res = execCodex(
      home,
      ws,
      "First run the shell command: echo hook-coverage-probe. Then create a file called hooked.txt containing 'hi' using apply_patch. Then use the update_plan tool to record a one-step plan. Then stop.",
    );
    expect(res.status).toBe(0);
    const log = readHookLog(hookLog);
    const preTools = log.filter((e) => e.hook_event_name === "PreToolUse").map((e) => e.tool_name);
    expect(preTools).toContain("Bash");
    expect(preTools).toContain("apply_patch");
    expect(preTools).toContain("update_plan");
    const postTools = log
      .filter((e) => e.hook_event_name === "PostToolUse")
      .map((e) => e.tool_name);
    expect(postTools).toContain("Bash");
    expect(postTools).toContain("apply_patch");
  });

  it("PreToolUse deny blocks the command before execution (enforcing)", () => {
    const { home, hookLog } = setupHookedHome("hooks-deny");
    const ws = freshWorkspace("hooks-deny");
    const res = execCodex(
      home,
      ws,
      "Run exactly this shell command: echo BLOCKME-token . If the command is blocked, say blocked and stop; do not retry.",
    );
    expect(res.status).toBe(0);
    const events = String(res.stdout)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; item?: { type: string } });
    // the blocked command never became a command_execution item
    const execItems = events.filter((e) => e.item?.type === "command_execution");
    expect(execItems).toHaveLength(0);
    // but the hook saw it
    const pre = readHookLog(hookLog).filter((e) => e.hook_event_name === "PreToolUse");
    expect(pre.some((e) => String(e.tool_input?.command ?? "").includes("BLOCKME"))).toBe(true);
  });

  it("PreToolUse allow + updatedInput rewrites the command (inputRewrite seam)", () => {
    const { home, hookLog } = setupHookedHome("hooks-rewrite");
    const ws = freshWorkspace("hooks-rewrite");
    const res = execCodex(
      home,
      ws,
      "Run exactly this shell command: echo REWRITEME-token . Report the command output verbatim, then stop.",
    );
    expect(res.status).toBe(0);
    // PostToolUse sees the REWRITTEN command — proof the rewrite took effect
    const post = readHookLog(hookLog).filter((e) => e.hook_event_name === "PostToolUse");
    expect(
      post.some((e) => String(e.tool_input?.command ?? "").includes("REWRITTEN-BY-HOOK")),
    ).toBe(true);
    expect(post.some((e) => String(e.tool_input?.command ?? "").includes("REWRITEME"))).toBe(false);
  });
});
