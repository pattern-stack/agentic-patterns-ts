/**
 * Contract: command-execution approval round-trips against a live app-server
 * (#321, design §5.4/§5.5). Every session uses an isolated CODEX_HOME.
 *
 * Facts pinned here (verified 2026-07-19 on codex-cli 0.144.6):
 * - `approvalPolicy: "untrusted"` forces an approval request for shell commands.
 * - Request params carry threadId/turnId/itemId/startedAtMs/command/cwd and
 *   proposal fields (proposedExecpolicyAmendment, proposedNetworkPolicyAmendments).
 * - `availableDecisions` is emitted on the wire (even without the experimentalApi
 *   capability) but is a UI ordering hint: replies NOT listed in it (decline,
 *   acceptForSession) are still honored. It must not be treated as an
 *   enforcement whitelist.
 * - decline → item status "declined", turn continues to "completed".
 * - cancel → turn status "interrupted".
 * - acceptForSession caches per THREAD: same thread re-runs don't re-prompt;
 *   a new thread on the same connection re-prompts.
 * - acceptWithExecpolicyAmendment persists DURABLY to CODEX_HOME/rules/*.rules
 *   (prefix_rule(...)) and suppresses prompts across a full process restart.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppServerClient } from "./driver.ts";
import {
  RUN_EXACT,
  assertPreconditions,
  cleanupTestRoot,
  freshHome,
  freshWorkspace,
  newThread,
  runTurn,
  startSession,
} from "./helpers.ts";

beforeAll(() => {
  assertPreconditions();
});
afterAll(() => {
  cleanupTestRoot();
});

interface ApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  command?: string | null;
  cwd?: string | null;
  proposedExecpolicyAmendment?: string[] | null;
  availableDecisions?: unknown[] | null;
}

function collectApprovals(
  client: AppServerClient,
  decide: (p: ApprovalParams) => unknown,
): ApprovalParams[] {
  const seen: ApprovalParams[] = [];
  client.onServerRequest("item/commandExecution/requestApproval", (params, respond) => {
    const p = params as ApprovalParams;
    seen.push(p);
    respond({ decision: decide(p) });
  });
  return seen;
}

describe("command approval round-trips", () => {
  it("accept: request carries pinned shape; command item completes", async () => {
    const home = freshHome("accept");
    const ws = freshWorkspace("accept");
    const { client, threadId } = await startSession({ home, cwd: ws });
    try {
      const approvals = collectApprovals(client, () => "accept");
      const end = await runTurn(client, threadId, RUN_EXACT("touch codex-contract-accept.txt"));

      expect(end.method).toBe("turn/completed");
      expect(approvals).toHaveLength(1);
      const req = approvals[0] as ApprovalParams;
      expect(req.threadId).toBe(threadId);
      expect(typeof req.turnId).toBe("string");
      expect(typeof req.itemId).toBe("string");
      expect(typeof req.startedAtMs).toBe("number");
      expect(req.command).toContain("touch codex-contract-accept.txt");
      // proposals ride the request itself
      expect(Array.isArray(req.proposedExecpolicyAmendment)).toBe(true);
      // availableDecisions is on the wire even though it's experimental-schema-only
      expect(Array.isArray(req.availableDecisions)).toBe(true);
      // ...and it does NOT list decline (which the server still honors — see below)
      expect(req.availableDecisions).not.toContain("decline");
      // command actually ran
      expect(existsSync(join(ws, "codex-contract-accept.txt"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("decline (not listed in availableDecisions) is honored; turn continues", async () => {
    const home = freshHome("decline");
    const ws = freshWorkspace("decline");
    const { client, threadId } = await startSession({ home, cwd: ws });
    try {
      const approvals = collectApprovals(client, () => "decline");
      const end = await runTurn(client, threadId, RUN_EXACT("touch codex-contract-decline.txt"));

      expect(approvals.length).toBeGreaterThanOrEqual(1);
      // decline does NOT kill the turn — the agent continues and finishes
      expect(end.method).toBe("turn/completed");
      const turn = (end.params as { turn: { status: string } }).turn;
      expect(turn.status).toBe("completed");
      const items = client.notifications
        .filter((n) => n.method === "item/completed")
        .map((n) => (n.params as { item: { type: string; status?: string } }).item);
      const exec = items.find((i) => i.type === "commandExecution");
      expect(exec?.status).toBe("declined");
      expect(existsSync(join(ws, "codex-contract-decline.txt"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("cancel interrupts the turn", async () => {
    const home = freshHome("cancel");
    const ws = freshWorkspace("cancel");
    const { client, threadId } = await startSession({ home, cwd: ws });
    try {
      collectApprovals(client, () => "cancel");
      const end = await runTurn(client, threadId, RUN_EXACT("touch codex-contract-cancel.txt"));
      expect(end.method).toBe("turn/completed");
      const turn = (end.params as { turn: { status: string } }).turn;
      expect(turn.status).toBe("interrupted");
      expect(existsSync(join(ws, "codex-contract-cancel.txt"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("acceptForSession caches per thread, not per connection", async () => {
    const home = freshHome("session");
    const ws = freshWorkspace("session");
    const { client, threadId } = await startSession({ home, cwd: ws });
    try {
      const approvals = collectApprovals(client, () => "acceptForSession");
      const prompt = RUN_EXACT("touch codex-contract-session.txt");

      await runTurn(client, threadId, prompt);
      expect(approvals).toHaveLength(1);

      // same thread, same command → no new prompt
      await runTurn(client, threadId, prompt);
      expect(approvals).toHaveLength(1);

      // new thread, same connection, same command → prompts again
      const thread2 = await newThread(client, ws);
      await runTurn(client, thread2, prompt);
      expect(approvals).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("acceptWithExecpolicyAmendment persists durably (rules file + survives restart)", async () => {
    const home = freshHome("execpolicy");
    const ws = freshWorkspace("execpolicy");
    const prompt = RUN_EXACT("touch codex-contract-amend.txt");

    const { client, threadId } = await startSession({ home, cwd: ws });
    let amendment: string[] | null | undefined;
    try {
      const approvals = collectApprovals(client, (p) => {
        amendment = p.proposedExecpolicyAmendment;
        return {
          acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment },
        };
      });
      await runTurn(client, threadId, prompt);
      expect(approvals).toHaveLength(1);
      expect(amendment?.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }

    // amendment is written under CODEX_HOME/rules/ as a prefix_rule
    const rulesFile = join(home, "rules", "default.rules");
    expect(existsSync(rulesFile), "expected CODEX_HOME/rules/default.rules to be written").toBe(
      true,
    );
    const rules = readFileSync(rulesFile, "utf8");
    expect(rules).toContain("prefix_rule");
    expect(rules).toContain('decision="allow"');

    // brand-new process + new thread against the same home → no prompt at all
    const { client: client2, threadId: thread2 } = await startSession({ home, cwd: ws });
    try {
      const approvals2 = collectApprovals(client2, () => "accept");
      const end = await runTurn(client2, thread2, prompt);
      expect(end.method).toBe("turn/completed");
      expect(approvals2).toHaveLength(0);
    } finally {
      await client2.close();
    }
  });
});
