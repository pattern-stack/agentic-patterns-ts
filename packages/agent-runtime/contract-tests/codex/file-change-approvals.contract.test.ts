/**
 * Contract: file-change approval round-trip (#321, design §5.4/§5.5).
 *
 * Facts pinned here (verified 2026-07-19 on codex-cli 0.144.6):
 * - Under `sandbox: "read-only"` + `approvalPolicy: "on-request"`, apply_patch
 *   triggers `item/fileChange/requestApproval`.
 * - The approval request carries ONLY {threadId, turnId, itemId, startedAtMs,
 *   reason, grantRoot} — NO diff and NO availableDecisions. The diff must be
 *   correlated via itemId against the fileChange item notifications
 *   (item.changes[].{path, kind, diff}).
 * - Decision vocabulary is the smaller set (accept/acceptForSession/decline/
 *   cancel) — no amendment decisions (asserted against the pinned schema in
 *   pinned-schema.contract.test.ts).
 */
import { existsSync, readFileSync } from "node:fs";
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

interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason?: string | null;
  grantRoot?: string | null;
}

describe("file-change approval round-trip", () => {
  it("read-only sandbox: apply_patch asks; request has no diff payload; accept applies the change", async () => {
    const home = freshHome("filechange");
    const ws = freshWorkspace("filechange");
    const { client, threadId } = await startSession({
      home,
      cwd: ws,
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
    try {
      const approvals: FileChangeApprovalParams[] = [];
      client.onServerRequest("item/fileChange/requestApproval", (params, respond) => {
        approvals.push(params as FileChangeApprovalParams);
        respond({ decision: "accept" });
      });
      // command approvals may also occur if the model tries shell first — accept them
      client.onServerRequest("item/commandExecution/requestApproval", (_params, respond) => {
        respond({ decision: "accept" });
      });

      const end = await runTurn(
        client,
        threadId,
        "Create a file named hello.txt in the workspace root containing exactly 'hello'. Use apply_patch. Then stop.",
      );
      expect(end.method).toBe("turn/completed");
      expect(approvals.length).toBeGreaterThanOrEqual(1);

      const req = approvals[0] as FileChangeApprovalParams;
      expect(req.threadId).toBe(threadId);
      expect(typeof req.itemId).toBe("string");
      // the request itself carries NO diff and NO availableDecisions
      expect(Object.keys(req).sort()).toEqual(
        ["grantRoot", "itemId", "reason", "startedAtMs", "threadId", "turnId"].sort(),
      );

      // the diff rides the fileChange ITEM, correlated by itemId
      const fileChangeItems = client.notifications
        .filter((n) => n.method === "item/completed" || n.method === "item/started")
        .map(
          (n) =>
            (
              n.params as {
                item: {
                  type: string;
                  id: string;
                  changes?: Array<{ path: string; diff?: string }>;
                };
              }
            ).item,
        )
        .filter((i) => i.type === "fileChange");
      const matched = fileChangeItems.find((i) => i.id === req.itemId);
      expect(matched, "fileChange item correlated by approval itemId").toBeDefined();
      expect(matched?.changes?.[0]?.path).toContain("hello.txt");

      expect(existsSync(join(ws, "hello.txt"))).toBe(true);
      expect(readFileSync(join(ws, "hello.txt"), "utf8")).toBe("hello\n");
    } finally {
      await client.close();
    }
  });
});
