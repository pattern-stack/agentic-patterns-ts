#!/usr/bin/env node
/**
 * End-to-end verification of the Claude Code hook bridge.
 *
 *   1. Scaffold a throwaway project with `ap init --with-plugin`
 *   2. Start `ap playground` (the server) on a free port
 *   3. Open an SSE stream against /admin/events/stream
 *   4. Spawn `claude -p` with that project as cwd
 *   5. Assert that at minimum: SessionStart, UserPromptSubmit, SessionEnd arrive
 *   6. Report a pass/fail summary; non-zero exit on failure
 *
 * Intended to be invoked manually or from CI once CI has `claude` on PATH:
 *
 *     node scripts/verify-hooks.mjs
 *
 * Flags:
 *   --keep   leave the tmp project + server alive for inspection
 *   --port N bind the server to port N (default: 3999)
 *   --cli PATH use a specific CLI entry (default: packages/agent-cli/dist/cli.js)
 *
 * Requires: `claude` binary on PATH, ANTHROPIC_API_KEY in env (or any key
 * that Claude Code accepts — the prompt we send is deliberately trivial).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd"];
const PROMPT = "reply with just the word ready";

function parseArgs(argv) {
  const args = { keep: false, port: 3999, cli: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") args.keep = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--cli") args.cli = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cliPath = args.cli ?? path.join(REPO_ROOT, "packages/agent-cli/dist/cli.js");
  if (!fs.existsSync(cliPath)) {
    fail(
      `CLI build not found at ${cliPath} — run \`bun run --filter=@pattern-stack/agentic-cli build\` first.`,
    );
  }

  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "ap-verify-hooks-"));
  log(`scaffolding project: ${tmpProject}`);

  await run("node", [cliPath, "init", tmpProject, "--with-plugin", "--provider=anthropic"], {
    cwd: REPO_ROOT,
  });

  fs.writeFileSync(
    path.join(tmpProject, ".env"),
    [
      `AP_DASHBOARD_URL=http://localhost:${args.port}`,
      "AGENT_TIER=sonnet",
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? "sk-ant-dummy-not-used"}`,
      "",
    ].join("\n"),
  );

  log("installing deps (bun install)");
  await run("bun", ["install"], { cwd: tmpProject });

  log(`starting playground on :${args.port}`);
  const server = spawn("node", [cliPath, "playground"], {
    cwd: tmpProject,
    env: { ...process.env, PORT: String(args.port) },
    stdio: "pipe",
  });
  const serverLogs = [];
  server.stdout.on("data", (b) => serverLogs.push(b.toString()));
  server.stderr.on("data", (b) => serverLogs.push(b.toString()));

  await waitForPort(args.port, 15_000).catch(async (e) => {
    process.stderr.write(serverLogs.join(""));
    server.kill();
    fail(`server did not open port ${args.port}: ${e.message}`);
  });

  log("subscribing to /admin/events/stream");
  const received = new Set();
  const stream = await fetch(`http://localhost:${args.port}/admin/events/stream`);
  if (!stream.body) fail("SSE stream has no body");
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readerDone = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n")) {
        const m = line.match(/"hook_name":"([^"]+)"/);
        if (m) received.add(m[1]);
      }
      // keep tail for partial chunks
      const lastNl = buffer.lastIndexOf("\n");
      if (lastNl >= 0) buffer = buffer.slice(lastNl + 1);
    }
  })();

  log(`firing claude -p (prompt: "${PROMPT}")`);
  await run("claude", ["-p", "--permission-mode", "bypassPermissions", PROMPT], {
    cwd: tmpProject,
  }).catch((e) => log(`warning: claude exited non-zero: ${e.message}`));

  // let hooks drain
  await sleep(2_000);
  reader.cancel().catch(() => {});
  await readerDone.catch(() => {});

  log(`events received: ${[...received].join(", ") || "(none)"}`);
  const missing = REQUIRED_EVENTS.filter((e) => !received.has(e));

  if (!args.keep) {
    server.kill();
    fs.rmSync(tmpProject, { recursive: true, force: true });
  } else {
    log(`keep-alive: project=${tmpProject}, server pid=${server.pid}`);
  }

  if (missing.length > 0) {
    fail(`missing required events: ${missing.join(", ")}`);
  }
  log("PASS — hook bridge is live");
}

function log(msg) {
  process.stdout.write(`[verify-hooks] ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[verify-hooks] FAIL — ${msg}\n`);
  process.exit(1);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok || r.status < 500) return;
    } catch {
      // not ready yet
    }
    await sleep(250);
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

main().catch((e) => fail(e.stack ?? e.message));
