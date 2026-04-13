import { describe, expect, it, vi } from "vitest";
import { createEvent } from "../../events/types.js";
import type { BaseEvent } from "../../events/types.js";
import { HumanApprovalGate } from "../approval.js";
import { AuditGate } from "../audit.js";
import { RateLimitGate } from "../rate-limit.js";
import { SafetyGate } from "../safety.js";

function makeToolIntent(toolName: string): BaseEvent {
  return createEvent("agent.tool.intent", {
    traceId: "t",
    runId: "r",
    toolCallId: "tc-1",
    toolName,
    arguments: {},
  });
}

function makeNonIntent(): BaseEvent {
  return createEvent("agent.tool.start", {
    traceId: "t",
    runId: "r",
    toolCallId: "tc-1",
    toolName: "test",
    arguments: {},
  });
}

describe("SafetyGate", () => {
  it("allows tools not in blocklist", async () => {
    const gate = new SafetyGate({
      blockedTools: new Set(["rm_rf"]),
    });

    const result = await gate.check(makeToolIntent("read_file"));
    expect(result.action).toBe("allow");
  });

  it("blocks tools in blocklist", async () => {
    const gate = new SafetyGate({
      blockedTools: new Set(["rm_rf", "drop_table"]),
    });

    const result = await gate.check(makeToolIntent("rm_rf"));
    expect(result.action).toBe("block");
  });

  it("blocks tools matching pattern", async () => {
    const gate = new SafetyGate({
      blockedPatterns: ["^dangerous_.*"],
    });

    const result = await gate.check(makeToolIntent("dangerous_operation"));
    expect(result.action).toBe("block");
  });

  it("allows non-matching patterns", async () => {
    const gate = new SafetyGate({
      blockedPatterns: ["^dangerous_.*"],
    });

    const result = await gate.check(makeToolIntent("safe_operation"));
    expect(result.action).toBe("allow");
  });

  it("allows non-intent events", async () => {
    const gate = new SafetyGate({
      blockedTools: new Set(["test"]),
    });

    const result = await gate.check(makeNonIntent());
    expect(result.action).toBe("allow");
  });

  it("provides block reason with tool name", async () => {
    const gate = new SafetyGate({
      blockedTools: new Set(["rm_rf"]),
      blockMessage: "Forbidden tool",
    });

    const event = makeToolIntent("rm_rf");
    const result = await gate.check(event);
    expect(result.action).toBe("block");
    if (result.action === "block") {
      expect(result.reason).toContain("rm_rf");
      expect(result.reason).toContain("Forbidden tool");
    }
  });
});

describe("RateLimitGate", () => {
  it("allows calls within limit", async () => {
    const gate = new RateLimitGate({ callsPerMinute: 60 });

    const result = await gate.check(makeToolIntent("test"));
    expect(result.action).toBe("allow");
  });

  it("blocks when tokens exhausted", async () => {
    // burstSize: 1 means only 1 token available
    const gate = new RateLimitGate({
      callsPerMinute: 60,
      burstSize: 1,
    });

    // First call succeeds
    const r1 = await gate.check(makeToolIntent("test"));
    expect(r1.action).toBe("allow");

    // Second call should be blocked (no tokens left, no time passed)
    const r2 = await gate.check(makeToolIntent("test"));
    expect(r2.action).toBe("block");
  });

  it("allows non-intent events", async () => {
    const gate = new RateLimitGate({ callsPerMinute: 0, burstSize: 0 });

    const result = await gate.check(makeNonIntent());
    expect(result.action).toBe("allow");
  });
});

describe("HumanApprovalGate", () => {
  it("auto-approves when configured", async () => {
    const gate = new HumanApprovalGate({ autoApprove: true });

    const result = await gate.check(makeToolIntent("test"));
    expect(result.action).toBe("allow");
  });

  it("calls approval callback", async () => {
    const approvalFn = vi.fn(() => true);
    const gate = new HumanApprovalGate({ approvalFn });

    const result = await gate.check(makeToolIntent("test"));
    expect(result.action).toBe("allow");
    expect(approvalFn).toHaveBeenCalledOnce();
  });

  it("blocks when callback returns false", async () => {
    const gate = new HumanApprovalGate({
      approvalFn: () => false,
    });

    const result = await gate.check(makeToolIntent("test"));
    expect(result.action).toBe("block");
  });

  it("supports async approval callback", async () => {
    const gate = new HumanApprovalGate({
      approvalFn: async () => false,
    });

    const result = await gate.check(makeToolIntent("test"));
    expect(result.action).toBe("block");
  });

  it("only checks specified tools", async () => {
    const gate = new HumanApprovalGate({
      tools: new Set(["dangerous_tool"]),
      approvalFn: () => false,
    });

    // Non-specified tool is auto-allowed
    const r1 = await gate.check(makeToolIntent("safe_tool"));
    expect(r1.action).toBe("allow");

    // Specified tool goes through approval
    const r2 = await gate.check(makeToolIntent("dangerous_tool"));
    expect(r2.action).toBe("block");
  });

  it("allows non-intent events", async () => {
    const gate = new HumanApprovalGate({
      approvalFn: () => false,
    });

    const result = await gate.check(makeNonIntent());
    expect(result.action).toBe("allow");
  });
});

describe("AuditGate", () => {
  it("always allows events", async () => {
    const gate = new AuditGate();

    const result = await gate.check(makeToolIntent("test"));
    expect(result.action).toBe("allow");
  });

  it("records entries", async () => {
    const gate = new AuditGate();

    await gate.check(makeToolIntent("tool_a"));
    await gate.check(makeToolIntent("tool_b"));

    expect(gate.entries).toHaveLength(2);
    expect(gate.entries[0]!.toolName).toBe("tool_a");
    expect(gate.entries[1]!.toolName).toBe("tool_b");
  });

  it("logs to provided logger", async () => {
    const logger = { info: vi.fn() };
    const gate = new AuditGate({ logger });

    await gate.check(makeToolIntent("test"));

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Intent"), expect.any(Object));
  });
});
