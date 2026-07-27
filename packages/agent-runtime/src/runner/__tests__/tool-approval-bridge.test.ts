/**
 * Unit tests for `createGateToolApproval` (#389) — the bridge from the gate
 * chain to v7's native `toolApproval` callback on the `runStructured()`
 * capable path.
 */

import { describe, expect, it } from "vitest";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type {
  GateDecisionEvent,
  InputRequestEvent,
  ToolApprovalRequestEvent,
  ToolApprovalResponseEvent,
  ToolCallIntent,
} from "../../events/types.js";
import type { Gate, GateResult } from "../../gates/base.js";
import { createHumanInputApprovalGate } from "../../interaction/approval-gate.js";
import { PendingInputRegistry } from "../../interaction/pending-input-registry.js";
import { createGateToolApproval } from "../tool-approval-bridge.js";

function toolCall(toolCallId: string, toolName: string, input: Record<string, unknown> = {}) {
  return { toolCallId, toolName, input };
}

/**
 * Bounded microtask poll until `predicate()` is true — avoids brittleness
 * from guessing an exact `await Promise.resolve()` tick count across a
 * multi-hop async chain (bridge publish -> evaluateIntent -> gate.check ->
 * human approvalFn -> registry.create).
 */
async function waitUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i++) {
    await Promise.resolve();
  }
}

/** A minimal gate that always returns a fixed `GateResult`. */
function fixedGate(name: string, result: GateResult): Gate {
  return {
    category: 2,
    name,
    categoryName: "APPROVAL",
    check: async () => result,
    getBlockReason: () => "blocked",
  };
}

describe("createGateToolApproval", () => {
  it("allow: returns approved and publishes a response event with approved: true", async () => {
    const bus = new AgentEventBus();
    const requests: ToolApprovalRequestEvent[] = [];
    const responses: ToolApprovalResponseEvent[] = [];
    bus.subscribe("agent.tool.approval.request", (e) =>
      requests.push(e as ToolApprovalRequestEvent),
    );
    bus.subscribe("agent.tool.approval.response", (e) =>
      responses.push(e as ToolApprovalResponseEvent),
    );

    const { toolApproval } = createGateToolApproval({
      bus,
      traceId: "trace-1",
      runId: "run-1",
      parentSpanId: "root-span",
    });

    const outcome = await toolApproval({
      toolCall: toolCall("tc-1", "safe_tool", { x: 1 }),
    });

    expect(outcome).toEqual({ type: "approved" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      type: "agent.tool.approval.request",
      toolCallId: "tc-1",
      toolName: "safe_tool",
      arguments: { x: 1 },
    });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      type: "agent.tool.approval.response",
      toolCallId: "tc-1",
      toolName: "safe_tool",
      approved: true,
      settledBy: "gate",
    });
  });

  it("block: returns denied with the gate's reason, response event carries it", async () => {
    const bus = new AgentEventBus();
    bus.addGate(fixedGate("BlockAll", { action: "block", reason: "Not allowed" }));
    const responses: ToolApprovalResponseEvent[] = [];
    bus.subscribe("agent.tool.approval.response", (e) =>
      responses.push(e as ToolApprovalResponseEvent),
    );

    const { toolApproval } = createGateToolApproval({
      bus,
      traceId: "trace-1",
      runId: "run-1",
      parentSpanId: "root-span",
    });

    const outcome = await toolApproval({
      toolCall: toolCall("tc-2", "dangerous_tool"),
    });

    expect(outcome).toEqual({ type: "denied", reason: "Not allowed" });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ approved: false, reason: "Not allowed" });
  });

  it("modify: returns approved and the overlay delivers the rewritten args", async () => {
    const bus = new AgentEventBus();
    bus.addGate(
      fixedGate("Rewriter", {
        action: "modify",
        event: {
          type: "agent.tool.intent",
          traceId: "trace-1",
          runId: "run-1",
          spanId: "s",
          timestamp: new Date(),
          toolCallId: "tc-3",
          toolName: "edit_tool",
          arguments: { rewritten: true },
        } as ToolCallIntent,
        decision: { kind: "rewriteInput", updatedInput: { rewritten: true } },
      }),
    );

    const { toolApproval, overlay } = createGateToolApproval({
      bus,
      traceId: "trace-1",
      runId: "run-1",
      parentSpanId: "root-span",
    });

    const outcome = await toolApproval({
      toolCall: toolCall("tc-3", "edit_tool", { original: true }),
    });

    expect(outcome).toEqual({ type: "approved" });
    // execute() would call overlay.take(toolCallId) before dispatch.
    expect(overlay.take("tc-3")).toEqual({ rewritten: true });
    // One-shot: a second take() finds nothing.
    expect(overlay.take("tc-3")).toBeUndefined();
  });

  it("allow with no rewrite: overlay carries the same args back (harmless)", async () => {
    const bus = new AgentEventBus();
    const { toolApproval, overlay } = createGateToolApproval({
      bus,
      traceId: "trace-1",
      runId: "run-1",
      parentSpanId: "root-span",
    });

    await toolApproval({ toolCall: toolCall("tc-4", "safe_tool", { a: 1 }) });
    expect(overlay.take("tc-4")).toEqual({ a: 1 });
  });

  it("human-gate path: input.request published once (SDK toolCallId dedupe)", async () => {
    const bus = new AgentEventBus();
    const registry = new PendingInputRegistry();
    const requests: InputRequestEvent[] = [];
    bus.subscribe("agent.input.request", (e) => requests.push(e as InputRequestEvent));

    const humanGate = createHumanInputApprovalGate({
      bus,
      registry,
      tools: new Set(["risky_tool"]),
    });
    bus.addGate(humanGate);

    const { toolApproval } = createGateToolApproval({
      bus,
      traceId: "trace-1",
      runId: "run-1",
      parentSpanId: "root-span",
    });

    const outcomePromise = toolApproval({
      toolCall: toolCall("tc-5", "risky_tool"),
    });

    // The bridge calls `bus.evaluateIntent` exactly ONCE, so the human gate's
    // approvalFn is invoked exactly once — its own dedupe memo is a no-op
    // safety net here, never actually exercised twice.
    await waitUntil(() => registry.has("tc-5"));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ correlationId: "tc-5", toolName: "risky_tool" });

    registry.resolve("tc-5", { decision: "approve" });
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ type: "approved" });
    expect(requests).toHaveLength(1);
  });

  it("human-gate path, denied: returns denied and the tool never runs", async () => {
    const bus = new AgentEventBus();
    const registry = new PendingInputRegistry();
    const humanGate = createHumanInputApprovalGate({
      bus,
      registry,
      tools: new Set(["risky_tool"]),
    });
    bus.addGate(humanGate);

    const { toolApproval } = createGateToolApproval({
      bus,
      traceId: "trace-1",
      runId: "run-1",
      parentSpanId: "root-span",
    });

    const outcomePromise = toolApproval({ toolCall: toolCall("tc-6", "risky_tool") });
    await waitUntil(() => registry.has("tc-6"));
    registry.resolve("tc-6", { decision: "deny" });
    const outcome = await outcomePromise;
    expect(outcome.type).toBe("denied");
  });

  it("event ordering: approval.request -> gate.decision -> approval.response", async () => {
    const bus = new AgentEventBus();
    const order: string[] = [];
    bus.subscribe("agent.tool.approval.request", () => order.push("approval.request"));
    bus.subscribe("agent.gate.decision", () => order.push("gate.decision"));
    bus.subscribe("agent.tool.approval.response", () => order.push("approval.response"));

    const { toolApproval } = createGateToolApproval({
      bus,
      traceId: "trace-1",
      runId: "run-1",
      parentSpanId: "root-span",
    });

    await toolApproval({ toolCall: toolCall("tc-7", "safe_tool") });
    expect(order).toEqual(["approval.request", "gate.decision", "approval.response"]);
  });

  it("gate.decision still fires exactly once per call (audit phase unchanged)", async () => {
    const bus = new AgentEventBus();
    const decisions: GateDecisionEvent[] = [];
    bus.subscribe("agent.gate.decision", (e) => decisions.push(e as GateDecisionEvent));

    const { toolApproval } = createGateToolApproval({
      bus,
      traceId: "trace-1",
      runId: "run-1",
      parentSpanId: "root-span",
    });

    await toolApproval({ toolCall: toolCall("tc-8", "safe_tool") });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.outcome).toBe("allow");
  });
});
