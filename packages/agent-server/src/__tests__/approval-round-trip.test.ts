/**
 * End-to-end approval round-trip through the REAL `createServer` + the REAL
 * `HumanApprovalGate`, wired exactly as `ap playground` wires it
 * (`eventBus.addGate(createHumanInputApprovalGate(...))` + `inputRegistry` on
 * the server config). A fake runner stands in for AgentRunner+LLM but drives
 * the gate through the bus the SAME way the real streaming runner does — an
 * observability `emit(intent)` then a block-detecting `emitIntent(intent)`
 * (the double gate-check the dedupe must survive).
 *
 * Proves the whole mechanism: a blocked tool call surfaces an inline
 * `input.request` on the chat stream, `POST /conversations/:id/input` resolves
 * it, and the run then either executes the tool (approve) or errors (deny).
 */

import type { AgentEvent, RunOptions } from "@agentic-patterns/runtime";
import {
  AgentEventBus,
  InMemoryAdminService,
  InMemoryEventCollector,
  PendingInputRegistry,
  SSEExporter,
  createEvent,
  createHumanInputApprovalGate,
} from "@agentic-patterns/runtime";
import { describe, expect, it } from "vitest";
import { createServer } from "../app.js";
import type { AgentRegistration } from "../config.js";

const mockAgent = {
  getModel: () => "test-model",
  getTools: () => [],
  renderInitialPrompt: () => "Test prompt",
  role: { name: "GatedAgent" },
};

/**
 * A runner that wants to call the gated tool `danger`. It replicates the real
 * AgentRunner.stream gate interaction: emit the intent (gate check #1, blocks
 * on approval), yield it, then emitIntent (gate check #2, listens for the
 * rejection). Approve → tool.start/tool.end; deny → error.
 */
function makeGatedRunner() {
  return {
    async run() {
      throw new Error("run() not used");
    },
    async *stream(
      _agent: unknown,
      _message: string,
      options?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      const traceId = options?.traceId ?? "t";
      const runId = "run-1";
      const bus = options?.eventBus as AgentEventBus;
      yield createEvent("agent.message.start", { traceId, runId, agentName: "gated" });

      const intent = createEvent("agent.tool.intent", {
        traceId,
        runId,
        toolCallId: "call-1",
        toolName: "danger",
        arguments: { payload: "x" },
      });

      // Gate check #1 (observability emit) — blocks until the human answers.
      await bus.publish(intent);
      yield intent;

      // Gate check #2 (block detection) — memoized, no second prompt.
      let blocked = false;
      const onRejected = (r: AgentEvent) => {
        const oi = (r as { originalIntent?: { toolCallId?: string } }).originalIntent;
        if (oi?.toolCallId === "call-1") blocked = true;
      };
      bus.subscribe("agent.tool.rejected", onRejected);
      await bus.publish(intent);
      bus.unsubscribe("agent.tool.rejected", onRejected);

      if (blocked) {
        yield createEvent("agent.error", {
          traceId,
          runId,
          errorType: "ToolCallBlocked",
          message: "Tool call 'danger' blocked by gate",
          recoverable: false,
          context: {},
        });
        yield createEvent("agent.conversation.end", {
          traceId,
          runId,
          conversationId: "c",
          reason: "error",
        });
        return;
      }

      yield createEvent("agent.tool.start", {
        traceId,
        runId,
        toolCallId: "call-1",
        toolName: "danger",
        arguments: { payload: "x" },
      });
      yield createEvent("agent.tool.end", {
        traceId,
        runId,
        toolCallId: "call-1",
        toolName: "danger",
        arguments: { payload: "x" },
        result: { ok: true },
        durationMs: 1,
        resultTokens: 0,
      });
      yield createEvent("agent.message.complete", {
        traceId,
        runId,
        content: "done",
        inputTokens: 1,
        outputTokens: 1,
        model: "test-model",
      });
    },
  };
}

function buildApp() {
  const eventBus = new AgentEventBus();
  const collector = new InMemoryEventCollector();
  collector.attach(eventBus);
  const sseExporter = new SSEExporter();
  sseExporter.attach(eventBus);
  const inputRegistry = new PendingInputRegistry();

  // Exactly the playground wiring: gate the tool `danger`.
  eventBus.addGate(
    createHumanInputApprovalGate({
      bus: eventBus,
      registry: inputRegistry,
      tools: new Set(["danger"]),
    }),
  );

  const reg: AgentRegistration = {
    id: "gated",
    name: "GatedAgent",
    agent: mockAgent,
    runner: makeGatedRunner(),
  };
  const app = createServer({
    agents: [reg],
    adminService: new InMemoryAdminService(collector),
    eventBus,
    sseExporter,
    inputRegistry,
  });
  return app;
}

/**
 * Drive one turn: start reading the SSE stream, and when the `input.request`
 * frame arrives, POST the given decision. Returns the full stream text.
 */
async function runTurnWithDecision(
  app: ReturnType<typeof createServer>,
  decision: "approve" | "deny",
): Promise<string> {
  const created = await app.request("/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: "gated" }),
  });
  const { id } = (await created.json()) as { id: string };

  const res = await app.request(`/conversations/${id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "do it" }),
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();

  let text = "";
  let answered = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += value;
    if (!answered && text.includes("event: input.request")) {
      answered = true;
      const ans = await app.request(`/conversations/${id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correlation_id: "call-1", decision }),
      });
      expect(ans.status).toBe(200);
    }
  }
  return text;
}

describe("approval round-trip (createServer + real gate)", () => {
  it("surfaces the prompt, and APPROVE lets the tool run", async () => {
    const app = buildApp();
    const text = await runTurnWithDecision(app, "approve");

    // Exactly one prompt (dedupe survived the double gate-check).
    const prompts = text.split("\n").filter((l) => l === "event: input.request");
    expect(prompts).toHaveLength(1);
    expect(text).toContain('"tool_name":"danger"');
    // Approved → the tool executed.
    expect(text).toContain("event: tool.end");
    expect(text).not.toContain("ToolCallBlocked");
  });

  it("DENY blocks the tool and errors the run", async () => {
    const app = buildApp();
    const text = await runTurnWithDecision(app, "deny");

    const prompts = text.split("\n").filter((l) => l === "event: input.request");
    expect(prompts).toHaveLength(1);
    // Denied → blocked, no tool execution.
    expect(text).toContain("ToolCallBlocked");
    expect(text).not.toContain("event: tool.end");
  });
});
