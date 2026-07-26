/**
 * S5 follow-up — promoted-agent (NodeBackedRunner) runs must be bus-visible.
 *
 * Bug: a promoted pipeline (`asAgent()`) runs via `NodeBackedRunner`. Its
 * `stream()` synthesizes `agent.message.start` -> `.chunk` -> `.complete` and
 * YIELDS them to whatever iterates the generator (the SSE consumer in
 * `routes/conversations.ts`), but never PUBLISHED them anywhere else — the
 * shared `eventBus` `RunStoreExporter` is attached to never saw a
 * `message.start` to open a `runs` row. An `AgentRunner`-backed conversation
 * never had this problem: `AgentRunner.stream()` both emits (via its own
 * bus-or-`getAgentEventBus()` reference) AND yields every event.
 *
 * Fix (`workflows/as-agent.ts`): `NodeBackedRunner` now accepts an optional
 * `eventBus` at construction (mirrors `AgentRunner`'s own constructor-bound
 * bus) and `stream()` publishes everything it yields — `message.start`, any
 * relayed intra-run events, `message.chunk`, `message.complete` — to
 * `options?.eventBus ?? this.eventBus`, PLUS a publish-only (never yielded)
 * `agent.error` on failure so a failed run's row still finalizes instead of
 * lingering `'running'`. The yielded sequence itself (what SSE renders) is
 * unchanged — every new call is an ADDITIONAL `publish()` alongside an
 * existing `yield`.
 *
 * These tests exercise the real `Conversation` + `RunStoreExporter` +
 * `RunStore` stack (the `run-store-eval-doublewrite.test.ts` idiom) rather
 * than asserting on `as-agent.test.ts`'s already-existing event-shape
 * fixtures, because the bug was specifically about bus VISIBILITY, not the
 * yielded shape (which was already correct).
 */

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversation } from "../../conversation/conversation.js";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import { AgentRunner } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { AgentLike } from "../../runner/types.js";
import { RunStore } from "../../storage/run-store.js";
import { NodeBackedRunner, asAgent } from "../../workflows/as-agent.js";
import { FunctionStep } from "../../workflows/function-step.js";
import type { Node } from "../../workflows/node.js";
import { RunStoreExporter } from "../run-store.js";

async function drain<T>(gen: AsyncGenerator<T>): Promise<void> {
  for await (const _ of gen) {
    // discard — these tests only assert on the RunStore side effect
  }
}

function makePlainAgent(name: string): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    renderInitialPrompt: () => "system",
  };
}

function makeStreamingMockModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId: "mock-model",
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t0" });
          controller.enqueue({ type: "text-delta", id: "t0", delta: text });
          controller.enqueue({ type: "text-end", id: "t0" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 2, text: 2, reasoning: undefined },
            },
          });
          controller.close();
        },
      }),
    }),
  });
}

describe("RunStoreExporter + promoted-agent (NodeBackedRunner) conversations", () => {
  let store: RunStore;
  let bus: AgentEventBus;
  let exporter: RunStoreExporter;

  beforeEach(() => {
    store = new RunStore({ path: ":memory:", Database });
    bus = new AgentEventBus();
    exporter = new RunStoreExporter({ store });
    exporter.attach(bus);
  });

  afterEach(() => {
    exporter.detach(bus);
    store.close();
  });

  // ---------------------------------------------------------------------------
  // (a) promoted-agent (NodeBackedRunner) — exactly ONE row
  // ---------------------------------------------------------------------------

  it("a NodeBackedRunner-backed conversation, streamed on the shared bus (server-route shape), produces exactly ONE runs row", async () => {
    const pipeline = new FunctionStep<string, string>({
      name: "shout",
      fn: (s) => s.toUpperCase(),
    });
    const promoted = asAgent(pipeline, { role: { name: "PromotedPipe" } });
    // The fix: eventBus threaded at construction (mirrors `AgentRunner`'s own
    // constructor-bound bus, and `playground.ts`/`run.ts`'s updated call sites).
    const runner = new NodeBackedRunner(new MockRunner(), bus);
    const conversation = new Conversation(promoted, runner);

    // `routes/conversations.ts`'s exact shape: `conversation.stream(content, { eventBus, ... })`.
    await drain(conversation.stream("hello", { eventBus: bus }));

    const rows = store.listRuns();
    expect(rows).toHaveLength(1);
    const row = store.getRun(rows[0]!.runId);
    expect(row?.agentName).toBe("PromotedPipe");
    expect(row?.status).toBe("ok");
    expect(row?.finalAnswer).toBe("HELLO");
  });

  it("a NodeBackedRunner-backed conversation streamed with NO per-call eventBus still persists via the constructor-bound bus (the `ap run` CLI shape)", async () => {
    const pipeline = new FunctionStep<string, string>({ name: "echo", fn: (s) => s });
    const promoted = asAgent(pipeline, { role: { name: "CliPipe" } });
    const runner = new NodeBackedRunner(new MockRunner(), bus);
    const conversation = new Conversation(promoted, runner);

    // `commands/run.ts`'s shape: `conversation.stream(message)` — no options at all.
    await drain(conversation.stream("hi there"));

    const rows = store.listRuns();
    expect(rows).toHaveLength(1);
    const row = store.getRun(rows[0]!.runId);
    expect(row?.agentName).toBe("CliPipe");
    expect(row?.status).toBe("ok");
  });

  it("a promoted-agent run whose node REJECTS (violates the leaf try/catch contract) finalizes its row as 'error', not stuck 'running'", async () => {
    // A raw custom Node, deliberately NOT an AgentStep/FunctionStep (both of
    // which always catch and return `succeeded:false` per §5.3) — this is the
    // only way to exercise NodeBackedRunner.stream()'s `runError` branch,
    // which is where the publish-only `agent.error` lives.
    const failing: Node<string, string> = {
      name: "boom",
      run: async () => {
        throw new Error("kaboom");
      },
    };
    const promoted = asAgent(failing, { role: { name: "FailingPipe" } });
    const runner = new NodeBackedRunner(new MockRunner(), bus);
    const conversation = new Conversation(promoted, runner);

    await expect(drain(conversation.stream("go", { eventBus: bus }))).rejects.toThrow(/kaboom/);

    const rows = store.listRuns();
    expect(rows).toHaveLength(1);
    const row = store.getRun(rows[0]!.runId);
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("kaboom");
  });

  // ---------------------------------------------------------------------------
  // (b) guard — AgentRunner-backed (non-promoted) conversations still produce
  // exactly ONE row on the SAME shared bus (no double-publish introduced by
  // threading `eventBus` through NodeBackedRunner).
  // ---------------------------------------------------------------------------

  it("an AgentRunner-backed conversation on the same shared bus still produces exactly ONE runs row (no double-publish)", async () => {
    const model = makeStreamingMockModel("OK");
    const runner = new AgentRunner(model);
    const conversation = new Conversation(makePlainAgent("test-agent"), runner);

    await drain(conversation.stream("hi", { eventBus: bus }));

    const rows = store.listRuns();
    expect(rows).toHaveLength(1);
    const row = store.getRun(rows[0]!.runId);
    expect(row?.agentName).toBe("test-agent");
    expect(row?.status).toBe("ok");
  });

  it("a promoted-agent run and an AgentRunner-backed run on the SAME shared bus each get their own single row (2 total, not double-counted)", async () => {
    const pipeline = new FunctionStep<string, string>({
      name: "shout",
      fn: (s) => s.toUpperCase(),
    });
    const promoted = asAgent(pipeline, { role: { name: "PromotedPipe" } });
    const promotedRunner = new NodeBackedRunner(new MockRunner(), bus);
    const promotedConversation = new Conversation(promoted, promotedRunner);

    const model = makeStreamingMockModel("OK");
    const llmRunner = new AgentRunner(model);
    const llmConversation = new Conversation(makePlainAgent("llm-agent"), llmRunner);

    await drain(promotedConversation.stream("hello", { eventBus: bus }));
    await drain(llmConversation.stream("hi", { eventBus: bus }));

    const rows = store.listRuns();
    expect(rows).toHaveLength(2);
    const agentNames = rows.map((r) => r.agentName).sort();
    expect(agentNames).toEqual(["PromotedPipe", "llm-agent"].sort());
    for (const r of rows) {
      const row = store.getRun(r.runId);
      expect(row?.status).toBe("ok");
    }
  });
});
