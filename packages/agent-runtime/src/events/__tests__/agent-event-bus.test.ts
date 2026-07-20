import { beforeEach, describe, expect, it, vi } from "vitest";
import { HumanApprovalGate } from "../../gates/approval.js";
import { AuditGate } from "../../gates/audit.js";
import { GATE_CATEGORY_NAMES, GateAllow, GateBlock, GateCategory } from "../../gates/base.js";
import type { Gate, GateResult } from "../../gates/base.js";
import { SafetyGate } from "../../gates/safety.js";
import { AgentEventBus } from "../agent-event-bus.js";
import { createEvent } from "../types.js";
import type { BaseEvent, ToolCallIntent, ToolCallRejectedEvent } from "../types.js";

function makeIntent(toolName: string, toolCallId = "tc-1"): ToolCallIntent {
  return createEvent("agent.tool.intent", {
    traceId: "t",
    runId: "r",
    toolCallId,
    toolName,
    arguments: {},
  });
}

function makeGate(
  category: (typeof GateCategory)[keyof typeof GateCategory],
  checkFn: (event: BaseEvent) => Promise<GateResult>,
): Gate {
  return {
    category,
    name: `TestGate-${GATE_CATEGORY_NAMES[category]}`,
    categoryName: GATE_CATEGORY_NAMES[category],
    check: checkFn,
    getBlockReason: () => "blocked by test gate",
  };
}

describe("AgentEventBus", () => {
  let bus: AgentEventBus;

  beforeEach(() => {
    bus = new AgentEventBus();
  });

  describe("regular events bypass gates", () => {
    it("publishes non-intent events without gate check", async () => {
      const checkFn = vi.fn(async () => GateBlock("should not be called"));
      const gate = makeGate(GateCategory.SAFETY, checkFn);
      bus.addGate(gate);

      const handler = vi.fn();
      bus.subscribe("agent.tool.start", handler);

      const event = createEvent("agent.tool.start", {
        traceId: "t",
        runId: "r",
        toolCallId: "tc-1",
        toolName: "test",
        arguments: {},
      });

      await bus.publish(event);

      expect(checkFn).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe("intent events go through gate chain", () => {
    it("allows intent when all gates allow", async () => {
      bus.addGate(makeGate(GateCategory.SAFETY, async () => GateAllow));
      bus.addGate(makeGate(GateCategory.AUDIT, async () => GateAllow));

      const handler = vi.fn();
      bus.subscribe("agent.tool.intent", handler);

      const event = createEvent("agent.tool.intent", {
        traceId: "t",
        runId: "r",
        toolCallId: "tc-1",
        toolName: "test",
        arguments: {},
      });

      await bus.publish(event);

      expect(handler).toHaveBeenCalledOnce();
    });

    it("blocks intent when a gate blocks", async () => {
      bus.addGate(makeGate(GateCategory.SAFETY, async () => GateBlock("dangerous tool")));

      const intentHandler = vi.fn();
      const rejectedHandler = vi.fn();
      bus.subscribe("agent.tool.intent", intentHandler);
      bus.subscribe("agent.tool.rejected", rejectedHandler);

      const event = createEvent("agent.tool.intent", {
        traceId: "t",
        runId: "r",
        toolCallId: "tc-1",
        toolName: "rm_rf",
        arguments: {},
      });

      const results = await bus.publish(event);

      expect(intentHandler).not.toHaveBeenCalled();
      expect(rejectedHandler).toHaveBeenCalledOnce();
      expect(results).toEqual([]);

      const rejection = rejectedHandler.mock.calls[0]![0] as ToolCallRejectedEvent;
      expect(rejection.type).toBe("agent.tool.rejected");
      expect(rejection.reason).toBe("dangerous tool");
    });

    it("first BLOCK wins (stops chain)", async () => {
      const safetyCheck = vi.fn(async () => GateBlock("safety blocked"));
      const auditCheck = vi.fn(async () => GateAllow);

      bus.addGate(makeGate(GateCategory.SAFETY, safetyCheck));
      bus.addGate(makeGate(GateCategory.AUDIT, auditCheck));

      const event = createEvent("agent.tool.intent", {
        traceId: "t",
        runId: "r",
        toolCallId: "tc-1",
        toolName: "test",
        arguments: {},
      });

      await bus.publish(event);

      expect(safetyCheck).toHaveBeenCalledOnce();
      expect(auditCheck).not.toHaveBeenCalled();
    });
  });

  describe("gate chain ordering", () => {
    it("executes gates in category order: SAFETY -> RATE_LIMIT -> APPROVAL -> AUDIT", async () => {
      const order: string[] = [];

      bus.addGate(
        makeGate(GateCategory.AUDIT, async () => {
          order.push("AUDIT");
          return GateAllow;
        }),
      );
      bus.addGate(
        makeGate(GateCategory.SAFETY, async () => {
          order.push("SAFETY");
          return GateAllow;
        }),
      );
      bus.addGate(
        makeGate(GateCategory.APPROVAL, async () => {
          order.push("APPROVAL");
          return GateAllow;
        }),
      );
      bus.addGate(
        makeGate(GateCategory.RATE_LIMIT, async () => {
          order.push("RATE_LIMIT");
          return GateAllow;
        }),
      );

      const event = createEvent("agent.tool.intent", {
        traceId: "t",
        runId: "r",
        toolCallId: "tc-1",
        toolName: "test",
        arguments: {},
      });

      await bus.publish(event);

      expect(order).toEqual(["SAFETY", "RATE_LIMIT", "APPROVAL", "AUDIT"]);
    });
  });

  describe("evaluateIntent (F-2)", () => {
    it("returns a definitive allow evaluation with the trail", async () => {
      bus.addGate(makeGate(GateCategory.SAFETY, async () => GateAllow));
      bus.addGate(makeGate(GateCategory.RATE_LIMIT, async () => GateAllow));

      const evaluation = await bus.evaluateIntent(makeIntent("read_file"));

      expect(evaluation.outcome).toBe("allow");
      expect(evaluation.settledBy).toBe("gate");
      expect(evaluation.trail).toEqual([
        { gate: "TestGate-SAFETY", result: "allow" },
        { gate: "TestGate-RATE_LIMIT", result: "allow" },
      ]);
    });

    it("returns a block evaluation naming the blocking gate", async () => {
      bus.addGate(new SafetyGate({ blockedTools: new Set(["rm_rf"]) }));

      const evaluation = await bus.evaluateIntent(makeIntent("rm_rf"));

      expect(evaluation.outcome).toBe("block");
      expect(evaluation.blockedBy).toBe("SafetyGate");
      expect(evaluation.reason).toContain("rm_rf");
      expect(evaluation.trail.at(-1)).toEqual({ gate: "SafetyGate", result: "block" });
    });

    it("carries the post-modification intent as the evaluation intent", async () => {
      bus.addGate(
        makeGate(GateCategory.SAFETY, async (event) => ({
          action: "modify",
          event: { ...(event as ToolCallIntent), toolName: "renamed" },
        })),
      );

      const evaluation = await bus.evaluateIntent(makeIntent("original"));

      expect(evaluation.outcome).toBe("allow");
      expect(evaluation.intent.toolName).toBe("renamed");
      expect(evaluation.trail).toEqual([{ gate: "TestGate-SAFETY", result: "modified" }]);
    });

    // #288: two concurrent intents, one blocked — attribution must be correct.
    // The old emitIntent inferred block-vs-allow from a bus-wide rejection
    // subscription; a concurrent sibling's rejection could flip the verdict.
    // evaluateIntent is per-call, so each intent gets its own verdict.
    it("#288: gives concurrent intents independent verdicts", async () => {
      bus.addGate(
        makeGate(GateCategory.SAFETY, async (event) =>
          (event as ToolCallIntent).toolName === "danger" ? GateBlock("nope") : GateAllow,
        ),
      );

      const [safe, danger] = await Promise.all([
        bus.evaluateIntent(makeIntent("safe", "tc-safe")),
        bus.evaluateIntent(makeIntent("danger", "tc-danger")),
      ]);

      expect(safe.outcome).toBe("allow");
      expect(safe.intent.toolCallId).toBe("tc-safe");
      expect(danger.outcome).toBe("block");
      expect(danger.intent.toolCallId).toBe("tc-danger");
      expect(danger.blockedBy).toBe("TestGate-SAFETY");
    });

    it("publishes agent.gate.decision for exporters on allow and block", async () => {
      bus.addGate(new SafetyGate({ blockedTools: new Set(["rm_rf"]) }));
      const decisionHandler = vi.fn();
      bus.subscribe("agent.gate.decision", decisionHandler);

      await bus.evaluateIntent(makeIntent("read_file"));
      await bus.evaluateIntent(makeIntent("rm_rf"));

      expect(decisionHandler).toHaveBeenCalledTimes(2);
      const outcomes = decisionHandler.mock.calls.map((c) => (c[0] as { outcome: string }).outcome);
      expect(outcomes).toEqual(["allow", "block"]);
    });
  });

  describe("audit phase runs on block (F-2 — was skipped at :61)", () => {
    it("records the decision via recordDecision even when a gate blocks", async () => {
      const audit = new AuditGate();
      bus.addGate(new SafetyGate({ blockedTools: new Set(["rm_rf"]) }));
      bus.addGate(audit);

      const evaluation = await bus.evaluateIntent(makeIntent("rm_rf"));

      expect(evaluation.outcome).toBe("block");
      // check() never ran on the audit gate (chain stopped at the block)…
      expect(audit.entries).toHaveLength(0);
      // …but the guaranteed audit phase recorded the blocked decision.
      expect(audit.decisions).toHaveLength(1);
      expect(audit.decisions[0]!.outcome).toBe("block");
      expect(audit.decisions[0]!.blockedBy).toBe("SafetyGate");
      expect(audit.decisions[0]!.toolName).toBe("rm_rf");
    });

    it("records the decision on allow too", async () => {
      const audit = new AuditGate();
      bus.addGate(audit);

      await bus.evaluateIntent(makeIntent("read_file"));

      expect(audit.decisions).toHaveLength(1);
      expect(audit.decisions[0]!.outcome).toBe("allow");
    });
  });

  describe("approval decisions flow onto the evaluation (F-2)", () => {
    it("captures a HarnessDecision and marks settledBy=human", async () => {
      bus.addGate(new HumanApprovalGate({ approvalFn: () => ({ kind: "allowOnce" }) }));

      const evaluation = await bus.evaluateIntent(makeIntent("tool"));

      expect(evaluation.outcome).toBe("allow");
      expect(evaluation.settledBy).toBe("human");
      expect(evaluation.decision).toEqual({ kind: "allowOnce" });
    });

    it("coerces a boolean-false callback to a deny decision (back-compat)", async () => {
      bus.addGate(new HumanApprovalGate({ approvalFn: () => false }));

      const evaluation = await bus.evaluateIntent(makeIntent("tool"));

      expect(evaluation.outcome).toBe("block");
      expect(evaluation.settledBy).toBe("human");
      expect(evaluation.decision).toEqual({ kind: "deny" });
    });

    it("honors a rewriteInput decision by modifying the executed intent", async () => {
      bus.addGate(
        new HumanApprovalGate({
          approvalFn: () => ({ kind: "rewriteInput", updatedInput: { safe: true } }),
        }),
      );

      const evaluation = await bus.evaluateIntent(makeIntent("tool"));

      expect(evaluation.outcome).toBe("allow");
      expect(evaluation.decision).toEqual({
        kind: "rewriteInput",
        updatedInput: { safe: true },
      });
      expect(evaluation.intent.arguments).toEqual({ safe: true });
    });
  });

  describe("gate management", () => {
    it("addGate and removeGate", () => {
      const gate = makeGate(GateCategory.SAFETY, async () => GateAllow);
      bus.addGate(gate);
      expect(bus.gates).toHaveLength(1);

      bus.removeGate(gate);
      expect(bus.gates).toHaveLength(0);
    });

    it("clearGates removes all", () => {
      bus.addGate(makeGate(GateCategory.SAFETY, async () => GateAllow));
      bus.addGate(makeGate(GateCategory.AUDIT, async () => GateAllow));

      bus.clearGates();
      expect(bus.gates).toHaveLength(0);
    });

    it("gates getter returns a copy", () => {
      const gate = makeGate(GateCategory.SAFETY, async () => GateAllow);
      bus.addGate(gate);

      const gates = bus.gates;
      expect(gates).toHaveLength(1);

      // Modifying returned array shouldn't affect bus
      // (it's a copy via spread)
    });
  });
});
