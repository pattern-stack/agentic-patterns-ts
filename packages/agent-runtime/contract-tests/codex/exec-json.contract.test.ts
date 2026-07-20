/**
 * Contract: `codex exec --json` speaks a DIFFERENT schema than the App Server
 * (#321, design §5.5) — output-only JSONL telemetry, no approval round-trips.
 *
 * Facts pinned here (verified 2026-07-19 on codex-cli 0.144.6):
 * - exec events are flat JSONL objects with a dotted snake_case `type`:
 *   thread.started / turn.started / turn.completed / item.started /
 *   item.completed / error — NOT JSON-RPC (no jsonrpc/method/id envelope).
 * - item payloads use snake_case types (agent_message, command_execution,
 *   file_change, todo_list, web_search, error) where the App Server v2 uses
 *   camelCase (agentMessage, commandExecution, fileChange, ...).
 * - empty CODEX_HOME (no auth.json): exec fails with 401 against
 *   api.openai.com — file credentials are NOT silently picked up from the
 *   host config or an OS keyring (fail-closed isolation is possible, D11).
 */
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertPreconditions,
  cleanupTestRoot,
  emptyHome,
  freshHome,
  freshWorkspace,
} from "./helpers.ts";

beforeAll(() => {
  assertPreconditions();
});
afterAll(() => {
  cleanupTestRoot();
});

const EXEC_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
]);

describe("codex exec --json", () => {
  it("emits dotted snake_case JSONL events, not JSON-RPC", () => {
    const home = freshHome("execjson");
    const ws = freshWorkspace("execjson");
    const res = spawnSync(
      "codex",
      [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "-C",
        ws,
        "Run the shell command: echo exec-json-probe. Then stop.",
      ],
      { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 240_000 },
    );
    expect(res.status).toBe(0);
    const events = res.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.length).toBeGreaterThan(3);

    for (const e of events) {
      // no JSON-RPC envelope
      expect(e.jsonrpc).toBeUndefined();
      expect(e.method).toBeUndefined();
      expect(
        EXEC_EVENT_TYPES.has(e.type as string),
        `unknown exec event type: ${String(e.type)}`,
      ).toBe(true);
    }
    expect(events.some((e) => e.type === "thread.started")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);

    // item types are snake_case (App Server uses camelCase for the same concepts)
    const itemTypes = events
      .filter((e) => e.item)
      .map((e) => (e.item as { type?: string }).type)
      .filter((t): t is string => typeof t === "string");
    expect(itemTypes).toContain("command_execution");
    expect(itemTypes).not.toContain("commandExecution");
  });

  it("empty CODEX_HOME fails closed with 401 (no keyring / host-config fallback)", () => {
    const home = emptyHome("execnoauth");
    const ws = freshWorkspace("execnoauth");
    const res = spawnSync(
      "codex",
      [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "-C",
        ws,
        "say hi",
      ],
      { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 240_000 },
    );
    expect(res.status).not.toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("401");
  });
});
