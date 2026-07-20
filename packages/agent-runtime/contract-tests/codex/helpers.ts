/**
 * Shared helpers for the Codex contract tests (#321).
 *
 * Every test runs against an ISOLATED CODEX_HOME under a temp dir: the host's
 * ~/.codex is only ever read (auth.json copied), never written.
 */
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerClient } from "./driver.ts";

export const FIXTURES = join(import.meta.dirname, "__fixtures__");

let root: string | undefined;
function testRoot(): string {
  if (!root) root = mkdtempSync(join(tmpdir(), "codex-contract-"));
  return root;
}

export function assertPreconditions(): { cliVersion: string } {
  let version: string;
  try {
    version = execSync("codex --version").toString().trim();
  } catch {
    throw new Error(
      "codex binary not found on PATH — the contract suite requires the pinned Codex CLI (see __fixtures__/manifest.json)",
    );
  }
  const hostAuth = join(homedir(), ".codex", "auth.json");
  if (!existsSync(hostAuth)) {
    throw new Error(
      "~/.codex/auth.json not found — the contract suite requires a logged-in Codex CLI (file-based credentials)",
    );
  }
  return { cliVersion: version };
}

/** Isolated CODEX_HOME seeded with a COPY of the host's auth.json. */
export function freshHome(name: string): string {
  const dir = join(testRoot(), "homes", `${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  cpSync(join(homedir(), ".codex", "auth.json"), join(dir, "auth.json"));
  writeFileSync(join(dir, "config.toml"), 'model_reasoning_effort = "low"\n');
  return dir;
}

/** Empty CODEX_HOME — no credentials at all. */
export function emptyHome(name: string): string {
  const dir = join(testRoot(), "homes", `${name}-empty-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), 'model_reasoning_effort = "low"\n');
  return dir;
}

export function freshWorkspace(name: string): string {
  const dir = join(testRoot(), "workspaces", `${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# contract-test workspace\n");
  return dir;
}

export function cleanupTestRoot(): void {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
}

export async function startSession(opts: {
  home: string;
  cwd: string;
  approvalPolicy?: unknown;
  sandbox?: unknown;
}): Promise<{ client: AppServerClient; threadId: string }> {
  const client = new AppServerClient({ codexHome: opts.home, cwd: opts.cwd });
  await client.initialize();
  const thread = (await client.request("thread/start", {
    cwd: opts.cwd,
    approvalPolicy: opts.approvalPolicy ?? "untrusted",
    sandbox: opts.sandbox ?? "workspace-write",
  })) as { thread: { id: string } };
  return { client, threadId: thread.thread.id };
}

export async function newThread(client: AppServerClient, cwd: string): Promise<string> {
  const thread = (await client.request("thread/start", {
    cwd,
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
  })) as { thread: { id: string } };
  return thread.thread.id;
}

/** Start a turn and wait for its terminal notification. */
export async function runTurn(
  client: AppServerClient,
  threadId: string,
  text: string,
  timeoutMs = 240_000,
): Promise<{ method: string; params: unknown }> {
  const before = client.notifications.length;
  void client
    .request("turn/start", { threadId, input: [{ type: "text", text }] }, timeoutMs)
    .catch(() => undefined); // terminal state is read from notifications
  return client.waitForNotification(
    (n) =>
      (n.method === "turn/completed" || n.method === "turn/failed") &&
      client.notifications.indexOf(n) >= before &&
      (n.params as { threadId?: string }).threadId === threadId,
    timeoutMs,
    `turn end for ${threadId}`,
  );
}

/** Non-recursive dir listing helper for persistence checks. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export const RUN_EXACT = (cmd: string): string =>
  `Run exactly this shell command and nothing else: ${cmd} . After it runs (or if it is declined), just say done and stop. Do not retry, do not try alternatives.`;
