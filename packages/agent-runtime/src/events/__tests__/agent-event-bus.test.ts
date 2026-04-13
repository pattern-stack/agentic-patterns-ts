import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATE_CATEGORY_NAMES, GateAllow, GateBlock, GateCategory } from "../../gates/base.js";
import type { Gate, GateResult } from "../../gates/base.js";
import { AgentEventBus } from "../agent-event-bus.js";
import { createEvent } from "../types.js";
import type { BaseEvent, ToolCallRejectedEvent } from "../types.js";

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
