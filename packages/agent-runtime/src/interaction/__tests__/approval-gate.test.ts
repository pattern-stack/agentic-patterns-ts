import { describe, expect, it } from "vitest";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import { createEvent } from "../../events/types.js";
import type { InputRequestEvent, ToolCallIntent } from "../../events/types.js";
import { createHumanInputApprovalGate } from "../approval-gate.js";
import { PendingInputRegistry } from "../pending-input-registry.js";

function intent(toolName: string, toolCallId: string): ToolCallIntent {
  return createEvent("agent.tool.intent", {
    traceId: "trace-1",
    runId: "run-1",
    toolCallId,
    toolName,
    arguments: { id: "def-1" },
  });
}

describe("createHumanInputApprovalGate", () => {
  it("publishes one input.request per tool call and allows on approve", async () => {
    const bus = new AgentEventBus();
    const registry = new PendingInputRegistry();
    const requests: InputRequestEvent[] = [];
    bus.subscribe("agent.input.request", (e) => requests.push(e as InputRequestEvent));

    const gate = createHumanInputApprovalGate({
      bus,
      registry,
      tools: new Set(["ratify_definition"]),
    });

    const result = gate.check(intent("ratify_definition", "call-1"));

    // The request was published synchronously with the correct shape.
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      type: "agent.input.request",
      correlationId: "call-1",
      kind: "approval",
      toolName: "ratify_definition",
      toolCallId: "call-1",
    });
    expect(registry.has("call-1")).toBe(true);

    // Human approves → the gate allows.
    registry.resolve("call-1", { decision: "approve" });
    await expect(result).resolves.toEqual({ action: "allow" });
  });

  it("blocks on deny", async () => {
    const bus = new AgentEventBus();
    const registry = new PendingInputRegistry();
    const gate = createHumanInputApprovalGate({
      bus,
      registry,
      tools: new Set(["retire_definition"]),
    });

    const result = gate.check(intent("retire_definition", "call-2"));
    registry.resolve("call-2", { decision: "deny" });
    const resolved = await result;
    expect(resolved.action).toBe("block");
  });

  it("dedupes the runner's double gate-check to one prompt", async () => {
    const bus = new AgentEventBus();
    const registry = new PendingInputRegistry();
    const requests: InputRequestEvent[] = [];
    bus.subscribe("agent.input.request", (e) => requests.push(e as InputRequestEvent));

    const gate = createHumanInputApprovalGate({
      bus,
      registry,
      tools: new Set(["ratify_definition"]),
    });

    // First check (the runner's observability `emit`): publishes + blocks.
    const first = gate.check(intent("ratify_definition", "call-3"));
    registry.resolve("call-3", { decision: "approve" });
    await expect(first).resolves.toEqual({ action: "allow" });

    // Second check (the runner's block-detecting `emitIntent`): reuses the
    // memoized decision — NO second prompt, NO new registry entry.
    const second = gate.check(intent("ratify_definition", "call-3"));
    await expect(second).resolves.toEqual({ action: "allow" });
    expect(requests).toHaveLength(1);
    expect(registry.has("call-3")).toBe(false);
  });

  it("passes non-gated tools through without prompting", async () => {
    const bus = new AgentEventBus();
    const registry = new PendingInputRegistry();
    const requests: InputRequestEvent[] = [];
    bus.subscribe("agent.input.request", (e) => requests.push(e as InputRequestEvent));

    const gate = createHumanInputApprovalGate({
      bus,
      registry,
      tools: new Set(["ratify_definition"]),
    });

    const result = await gate.check(intent("search_definitions", "call-4"));
    expect(result).toEqual({ action: "allow" });
    expect(requests).toHaveLength(0);
    expect(registry.size).toBe(0);
  });
});
