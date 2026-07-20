/**
 * Contract: request settlement semantics — interrupt with a pending approval,
 * duplicate replies, late replies (#321, design §5.1/§5.4 "local settlement").
 *
 * Facts pinned here (verified 2026-07-19 on codex-cli 0.144.6):
 * - `turn/interrupt` params are `{threadId, turnId}` (turnId REQUIRED —
 *   omitting it is a -32600 "missing field `turnId`" error).
 * - Interrupting a turn with a pending approval settles it SERVER-side: the
 *   server emits `serverRequest/resolved {threadId, requestId}` and rejects
 *   the exec itself; the turn ends with status "interrupted".
 * - The wire does NOT enforce exactly-once settlement: a duplicate reply to an
 *   already-answered request id and a late reply to a server-resolved request
 *   are both silently ignored (no JSON-RPC error, no protocol breakage).
 *   Exactly-once *local* settlement is therefore the client's responsibility,
 *   exactly as §5.1 assigns it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RUN_EXACT,
  assertPreconditions,
  cleanupTestRoot,
  freshHome,
  freshWorkspace,
  startSession,
} from "./helpers.ts";

beforeAll(() => {
  assertPreconditions();
});
afterAll(() => {
  cleanupTestRoot();
});

describe("settlement semantics", () => {
  it("turn/interrupt requires turnId; pending approval is resolved server-side; late reply tolerated", async () => {
    const home = freshHome("settle-interrupt");
    const ws = freshWorkspace("settle-interrupt");
    const { client, threadId } = await startSession({ home, cwd: ws });
    try {
      // leave the approval pending
      client.onServerRequest("item/commandExecution/requestApproval", () => {});
      void client
        .request(
          "turn/start",
          { threadId, input: [{ type: "text", text: RUN_EXACT("touch settle.txt") }] },
          240_000,
        )
        .catch(() => undefined);
      const started = await client.waitForNotification(
        (n) => n.method === "turn/started",
        120_000,
        "turn started",
      );
      const turnId = (started.params as { turn: { id: string } }).turn.id;
      const approval = await client.waitForServerRequest(
        (r) => r.method === "item/commandExecution/requestApproval",
        180_000,
        "pending approval",
      );

      // interrupt WITHOUT turnId → protocol error
      await expect(client.request("turn/interrupt", { threadId }, 15_000)).rejects.toThrow(
        /turnId/,
      );

      // interrupt WITH turnId → succeeds
      await client.request("turn/interrupt", { threadId, turnId }, 30_000);

      // the server resolves the pending ask itself...
      const resolved = await client.waitForNotification(
        (n) =>
          n.method === "serverRequest/resolved" &&
          (n.params as { requestId: unknown }).requestId === approval.id,
        30_000,
        "serverRequest/resolved",
      );
      expect((resolved.params as { threadId: string }).threadId).toBe(threadId);

      // ...and the turn ends interrupted
      const end = await client.waitForNotification(
        (n) => n.method === "turn/completed",
        60_000,
        "turn end",
      );
      expect((end.params as { turn: { status: string } }).turn.status).toBe("interrupted");

      // a LATE reply to the already-resolved request is silently tolerated
      // (codex may log the interrupt's own rejection to stderr — that is not
      // a reply error; the contract is: no protocol error, server stays up)
      client.respond(approval.id, { decision: "accept" });
      await new Promise((r) => setTimeout(r, 1500));
      expect(client.proc.exitCode).toBeNull(); // server did not die
      const errorNotes = client.notifications.filter((n) =>
        n.method.toLowerCase().includes("error"),
      );
      expect(errorNotes).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("duplicate reply to an answered approval is silently ignored", async () => {
    const home = freshHome("settle-dup");
    const ws = freshWorkspace("settle-dup");
    const { client, threadId } = await startSession({ home, cwd: ws });
    try {
      let approvalId: number | string | undefined;
      client.onServerRequest("item/commandExecution/requestApproval", (_p, respond, raw) => {
        approvalId = raw.id;
        respond({ decision: "accept" });
        // contradictory second reply to the same id
        setTimeout(() => client.respond(raw.id, { decision: "decline" }), 100);
      });
      void client
        .request(
          "turn/start",
          { threadId, input: [{ type: "text", text: RUN_EXACT("touch settle-dup.txt") }] },
          240_000,
        )
        .catch(() => undefined);
      const end = await client.waitForNotification(
        (n) => n.method === "turn/completed" || n.method === "turn/failed",
        240_000,
        "turn end",
      );
      expect(approvalId).toBeDefined();
      // first answer won: the turn completed normally, no error surfaced
      expect(end.method).toBe("turn/completed");
      expect((end.params as { turn: { status: string } }).turn.status).toBe("completed");
      const errors = client.notifications.filter((n) => n.method.toLowerCase().includes("error"));
      expect(errors).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});
